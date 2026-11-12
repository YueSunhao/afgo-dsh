import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFile, access } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createResultReport, reportCandidates } from "../lib/result-report.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aEXsAAAAASUVORK5CYII=", "base64");
const files = [
  { id: "input", name: "input.cif", size: 30 },
  { id: "structure", name: "slab_final.cif", size: 30 },
  { id: "plot", name: "energy_rank.png", size: png.length }
];

function store() {
  return {
    async saveImage({ data, mediaType, name }) { return { attachmentId: "sha256:" + createHash("sha256").update(data).digest("hex"), mediaType, name, bytes: data.length, width: 1, height: 1 }; },
    imageHostPath(ref) { return "/persistent/" + ref.attachmentId.slice(7) + ".png"; },
    async saveFile(input) { return { name: input.name }; },
    fileHostPath(ref) { return "/persistent/" + ref.name; }
  };
}

test("report selects one final structure and one result image without accepting unsupported or oversized files", () => {
  assert.deepEqual(reportCandidates("85244", [...files, { id: "huge", name: "a_final.cif", size: 5000000 }]).map((file) => file.id), ["structure", "plot"]);
});

test("report persists both image references, source hashes, and final-response Markdown, and removes temporary downloads", async () => {
  const paths = [];
  const report = await createResultReport({ taskId: "85244", files, attachments: store(),
    call: async (args) => { const path = args[args.indexOf("-o") + 1]; paths.push(path); await writeFile(path, args[2] === "plot" ? png : "actual coordinates"); },
    renderer: async (payload) => { assert.equal(payload.name, "slab_final.cif"); return { png, manifest: { ...payload, text: undefined } }; }
  });
  assert.equal(report.images.length, 2);
  assert.deepEqual(report.images.map((image) => image.kind), ["structure", "result"]);
  assert.equal(report.images[0].source.sha256, createHash("sha256").update("actual coordinates").digest("hex"));
  assert.equal((report.markdown.match(/!\[/g) ?? []).length, 2);
  assert.ok(report.images.every((image) => image.provenancePath));
  for (const path of paths) await assert.rejects(access(path));
});

test("a rendering failure preserves the original result image and reports the failed source", async () => {
  const report = await createResultReport({ taskId: "85244", files, attachments: store(),
    call: async (args) => writeFile(args[args.indexOf("-o") + 1], args[2] === "plot" ? png : "actual coordinates"),
    renderer: async () => { throw new Error("WebGL unavailable"); }
  });
  assert.equal(report.images.length, 1);
  assert.equal(report.images[0].kind, "result");
  assert.match(report.warnings[0], /slab_final.cif.*WebGL/);
});

test("missing attachment service avoids downloads and cancellation propagates", async () => {
  const absent = await createResultReport({ taskId: "85244", files,
    call: async () => { throw new Error("must not download"); } });
  assert.equal(absent.images.length, 0);
  assert.match(absent.warnings[0], /附件服务/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(createResultReport({ taskId: "85244", files, attachments: store(), signal: controller.signal }));
});
