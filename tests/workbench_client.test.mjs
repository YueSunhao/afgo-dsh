/**
 * Unit tests for the workbench client's pure helpers.
 *
 * The client file is a browser script that registers a factory with DSH's
 * module loader. This test loads it with a two-line loader stub and a React
 * stub, then exercises the `__test` surface directly — no DOM, no network.
 *
 * Run: node --test tests/workbench_client.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";

let registration = null;
globalThis.window = {
  __ModuleLoader__: {
    load(definition) { registration = definition; }
  }
};
globalThis.localStorage = {
  values: new Map(),
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; },
  setItem(key, value) { this.values.set(key, String(value)); },
  removeItem(key) { this.values.delete(key); }
};

await import("../lib/client.js");

const ReactStub = {
  createElement: () => null,
  useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
  useEffect: () => {},
  useMemo: (factory) => factory(),
  useRef: (value) => ({ current: value }),
  useCallback: (fn) => fn
};

assert.ok(registration, "client module registered with the loader");
const exported = registration.factory((specifier) => {
  if (specifier === "react") return ReactStub;
  throw new Error(`unexpected require: ${specifier}`);
});
const api = exported.__test;

const CATALOG = [
  { name: "PySCF", displayName: "PySCF", type: "agent", version: "1.0.5", versionSource: "demo", description: "quantum chemistry", tags: ["beta"] },
  { name: "GPU4PySCF", displayName: "GPU4PySCF", type: "agent", version: "1.0.1", versionSource: "icon", description: "", tags: [] },
  { name: "PySCF-SP", displayName: "PySCF-SP", type: "kit", version: "0.0.7", versionSource: "demo", description: "", tags: [] },
  { name: "PySCF-Single-Point-Energy", displayName: "PySCF Single Point", type: "kit", version: "0.0.1", versionSource: "icon", description: "", tags: [] },
  { name: "pyscf-cneo", displayName: "PySCF cneo", type: "kit", version: "0.4.0", versionSource: "demo", description: "", tags: [] },
  { name: "original-pyscf", displayName: "original-pyscf", type: "kit", version: null, versionSource: null, description: "", tags: [] },
  { name: "DSSP", displayName: "DSSP", type: "kit", version: "1.0.1", versionSource: "demo", description: "secondary structure", tags: ["protein"] },
  { name: "MACE-Flow-SurfaceInterface-Kit", displayName: "MACE-Flow-SurfaceInterface-Kit", type: "kit", version: "1.0.6", versionSource: "demo", description: "", tags: ["mace"] },
  { name: "MACE-Flow-RelaxMD-Kit", displayName: "MACE-Flow-RelaxMD-Kit", type: "kit", version: "1.1.5", versionSource: "demo", description: "", tags: [] },
  { name: "mace-agent", displayName: "mace-agent", type: "agent", version: null, versionSource: null, description: "", tags: ["mace"] },
  { name: "admet", displayName: "ADMET-AI KIT", type: "kit", version: null, versionSource: null, description: "toxicity", tags: [] }
];

function names(entries) { return entries.map((entry) => `${entry.type}:${entry.name}`); }

test("normalizeSearch folds width, case and whitespace", () => {
  assert.equal(api.normalizeSearch("ＰｙＳＣＦ"), "pyscf");
  assert.equal(api.normalizeSearch("  PySCF  "), "pyscf");
  assert.equal(api.normalizeSearch("DSSP"), "dssp");
  assert.equal(api.normalizeSearch("ＭＡＣＥ"), "mace");
});

test("PySCF / pyscf / fullwidth ＰｙＳＣＦ return the same ranking", () => {
  const a = names(api.searchCatalog(CATALOG, "PySCF"));
  const b = names(api.searchCatalog(CATALOG, "pyscf"));
  const c = names(api.searchCatalog(CATALOG, "ＰｙＳＣＦ"));
  assert.deepEqual(a, b);
  assert.deepEqual(a, c);
  // The registered name `PySCF` is the exact hit and must come first; GPU4PySCF
  // is a suffix hit and must not outrank the shorter exact match.
  assert.equal(a[0], "agent:PySCF");
  assert.ok(a.indexOf("agent:GPU4PySCF") === -1 || a.indexOf("agent:GPU4PySCF") > a.indexOf("kit:PySCF-SP"));
  assert.ok(a.includes("kit:pyscf-cneo"));
  assert.ok(a.includes("kit:PySCF-SP"));
  assert.ok(a.includes("kit:original-pyscf"));
});

test("prefix hits outrank contains hits", () => {
  const ranked = names(api.searchCatalog(CATALOG, "pyscf"));
  const prefix = ranked.indexOf("kit:PySCF-SP");
  const contains = ranked.indexOf("kit:original-pyscf");
  assert.ok(prefix < contains, `${ranked.join(",")}`);
});

test("DSSP and MACE resolve without case sensitivity; display-name hits count", () => {
  assert.equal(names(api.searchCatalog(CATALOG, "DSSP"))[0], "kit:DSSP");
  assert.equal(names(api.searchCatalog(CATALOG, "dssp"))[0], "kit:DSSP");
  const mace = names(api.searchCatalog(CATALOG, "MACE"));
  assert.ok(mace.includes("kit:MACE-Flow-SurfaceInterface-Kit"));
  assert.ok(mace.includes("kit:MACE-Flow-RelaxMD-Kit"));
  assert.ok(mace.includes("agent:mace-agent"));
  assert.equal(names(api.searchCatalog(CATALOG, "ADMET-AI"))[0], "kit:admet");
  assert.deepEqual(api.searchCatalog(CATALOG, "no-such-tool"), []);
});

test("kind filter keeps one catalog type", () => {
  const kits = api.searchCatalog(CATALOG, "pyscf", "kit");
  const agents = api.searchCatalog(CATALOG, "pyscf", "agent");
  assert.ok(kits.every((entry) => entry.type === "kit"));
  assert.ok(agents.every((entry) => entry.type === "agent"));
  assert.deepEqual(names(agents), ["agent:PySCF", "agent:GPU4PySCF"]);
});

const step = (overrides) => ({
  id: "1", name: "runner", pipelineId: "1", statusRaw: 1, jobStatus: "COMPLETED",
  createdAt: "2026-11-10T10:41:06.000Z", startedAt: "2026-11-10T10:41:08.000Z",
  endedAt: "2026-11-10T10:41:37.000Z", error: null, hasOutput: true, ...overrides
});

test("execution state separates completed, stopped and running", () => {
  assert.equal(api.executionOf({ isThinking: false, steps: [step()] }).state, "done");
  const stopped = api.executionOf({
    isThinking: false,
    steps: [step({ jobStatus: "PENDING", hasOutput: false }), step({ id: "2" })]
  });
  assert.equal(stopped.state, "stopped");
  assert.match(stopped.detail, /未成功结束/);
  assert.equal(api.executionOf({ isThinking: true, steps: [step({ jobStatus: "PENDING", startedAt: null, endedAt: null })] }).state, "queued");
  assert.equal(api.executionOf({ isThinking: true, steps: [step()] }).state, "running");
  assert.equal(api.executionOf({ isThinking: null, steps: [] }).state, "unknown");
});

test("verdict: structured output is success, no signal is 待核实 with a readable reply", () => {
  const success = api.verdictOf({ isThinking: false, steps: [step({ hasOutput: true })] });
  assert.equal(success.state, "success");

  const unknown = api.verdictOf({
    isThinking: false,
    steps: [step({ hasOutput: false, jobStatus: "PENDING" })],
    messages: { hasReadableReply: true, lastAssistant: { text: "-76.462958 Hartree", createdAt: null } }
  });
  assert.equal(unknown.state, "unknown");
  assert.equal(unknown.label, "待核实");
  assert.match(unknown.reason, /可读回复/);

  const failed = api.verdictOf({ isThinking: false, steps: [step({ jobStatus: "FAILED", hasOutput: false })] });
  assert.equal(failed.state, "failed");
  assert.match(failed.reason, /slurm=FAILED/);

  const partial = api.verdictOf({
    isThinking: false,
    steps: [step({ id: "1", hasOutput: true }), step({ id: "2", jobStatus: "CANCELLED", hasOutput: false })]
  });
  assert.equal(partial.state, "partial");

  assert.equal(api.verdictOf({ isThinking: true, steps: [step()] }).state, "running");
});

test("timeline positions parallel steps by time and degrades without timestamps", () => {
  const parallel = api.timelineOf({
    steps: [
      step({ id: "a", createdAt: "2026-11-10T10:00:00.000Z", startedAt: "2026-11-10T10:00:10.000Z", endedAt: "2026-11-10T10:00:20.000Z" }),
      step({ id: "b", createdAt: "2026-11-10T10:00:05.000Z", startedAt: "2026-11-10T10:00:12.000Z", endedAt: "2026-11-10T10:00:30.000Z" })
    ]
  });
  assert.equal(parallel.mode, "scale");
  const [a, b] = parallel.rows;
  assert.ok(b.left > a.left, "later step starts to the right");
  assert.ok(a.runLeft < b.runLeft);
  assert.equal(a.queueMs, 10000);
  assert.equal(a.runMs, 10000);
  // Two different pipelines (default pipelineId "1" would be shared) — force
  // separate pipelines and verify the total is withheld.
  const twoPipelines = api.timelineOf({ steps: [step({ id: "a", pipelineId: "1" }), step({ id: "b", pipelineId: "2" })] });
  assert.equal(twoPipelines.totalMs, null);
  const onePipeline = api.timelineOf({ steps: [step({ id: "a" })] });
  assert.ok(onePipeline.totalMs > 0);

  const missing = api.timelineOf({ steps: [step({ createdAt: null, startedAt: null, endedAt: null, hasOutput: false })] });
  assert.equal(missing.mode, "list");
  assert.equal(missing.rows[0].hasTime, false);

  const onlyPoint = api.timelineOf({ steps: [step({ startedAt: null, endedAt: null })] });
  assert.ok(onlyPoint.rows[0].point != null);
  assert.equal(onlyPoint.rows[0].run, null);

  const inverted = api.timelineOf({ steps: [step({ startedAt: "2026-11-10T10:05:00.000Z", endedAt: "2026-11-10T10:00:00.000Z" })] });
  assert.ok(inverted.rows[0].warnings.some((warning) => warning.includes("结束时间早于开始时间")));
  assert.equal(inverted.rows[0].run, null);

  const missingStart = api.timelineOf({ steps: [step({ createdAt: "2026-11-10T10:00:00.000Z", startedAt: null, endedAt: "2026-11-10T10:01:00.000Z" })] });
  assert.equal(missingStart.rows[0].run, null);
  assert.equal(missingStart.rows[0].queue, null);
});

test("events list only uses platform timestamps and keeps them ordered", () => {
  const events = api.eventsOf({
    steps: [step()],
    messages: { lastAssistant: { text: "done", createdAt: "2026-11-10T10:41:40.000Z" } }
  });
  assert.deepEqual(events.map((event) => event.kind), ["提交", "开始", "结束", "回复"]);
  assert.deepEqual(events.map((event) => event.source),
    ["step.created_at", "step.started_at", "step.ended_at", "message.created_at"]);
});

test("primary artifact rules are explicit and typed by tool", () => {
  const files = [
    { id: "1", name: "report.md", size: 10, type: "md" },
    { id: "2", name: "surface_energies.csv", size: 20, type: "csv" }
  ];
  assert.equal(api.primaryFileOf("MACE-Flow-SurfaceInterface-Kit", files).id, "2");
  assert.equal(api.primaryFileOf("Unknown-Kit", files), null);
  assert.equal(api.primaryFileName("DSSP"), "dssp_summary.json");
  assert.equal(api.fileKind(files[1]), "table");
  assert.equal(api.fileKind({ name: "a.json", type: "json" }), "json");
  assert.equal(api.fileKind({ name: "a.png", type: "png" }), "binary");
  assert.equal(api.primaryFileOf("MACE-Flow-SurfaceInterface-Kit", [
    { id: "3", name: "surface_energies.csv" }
  ]).id, "3");
});

test("CSV parser handles quotes, CRLF, BOM and embedded newlines", () => {
  const text = "\uFEFFname,value,note\r\n\"a,1\",2,\"line\nbreak\"\r\nb,\"quote \"\"inside\"\"\",3\r\n";
  const parsed = api.parseCsv(text);
  assert.deepEqual(parsed.rows, [
    ["name", "value", "note"],
    ["a,1", "2", "line\nbreak"],
    ["b", "quote \"inside\"", "3"]
  ]);
  assert.equal(parsed.truncated, false);

  const truncated = api.parseCsv("h\n1\n2\n3\n4\n", 3);
  assert.equal(truncated.truncated, true);
  assert.ok(truncated.rows.length <= 3);

  const empty = api.parseCsv("");
  assert.deepEqual(empty.rows, []);
});

test("version provenance never invents a number", () => {
  assert.deepEqual(api.versionText({ version: "1.0.6", versionSource: "platform" }), { text: "v1.0.6", source: "平台返回" });
  assert.deepEqual(api.versionText({ version: "1.0.6", versionSource: "demo" }), { text: "v1.0.6", source: "样例路径推断" });
  assert.deepEqual(api.versionText({ version: "0.0.6", versionSource: "icon" }), { text: "v0.0.6", source: "图标路径推断" });
  assert.deepEqual(api.versionText({ version: null }, "1.0.5"), { text: "v1.0.5", source: "历史任务" });
  assert.deepEqual(api.versionText({ version: null }, null), { text: "版本未知", source: "目录未返回" });
});

test("status rows mark unread tasks 待查询 and reuse cached verdicts", () => {
  assert.deepEqual(api.statusOfRow({ isThinking: true }, null), { state: "running", label: "执行中" });
  assert.deepEqual(api.statusOfRow({ isThinking: false }, null), { state: "unresolved", label: "待查询" });
  assert.deepEqual(api.statusOfRow({ isThinking: false }, { verdict: "success", verdictLabel: "成功" }), { state: "success", label: "成功" });
});

test("format helpers are stable for the sizes and durations used in the UI", () => {
  assert.equal(api.formatBytes(1180), "1.2 KiB");
  assert.equal(api.formatBytes(0), "0 B");
  assert.equal(api.formatBytes(null), "大小未知");
  assert.equal(api.formatDuration(36800), "37 秒");
  assert.equal(api.formatDuration(473000), "7 分 53 秒");
  assert.equal(api.formatDuration(31000), "31 秒");
  assert.equal(api.formatDuration(900), "900 毫秒");
});

test("scoped keys separate API environment and account", () => {
  const a = api.scopedKey({ baseUrl: "https://sidereus-ai.com/api" }, { id: "13118" }, "last");
  const b = api.scopedKey({ baseUrl: "https://dev.sidereus-ai.com/api" }, { id: "13118" }, "last");
  const c = api.scopedKey({ baseUrl: "https://sidereus-ai.com/api" }, { id: "99" }, "last");
  assert.notEqual(a, b);
  assert.notEqual(a, c);
  assert.match(a, /sidereus-ai\.com\/api/);
  assert.match(a, /13118/);
});

test("base64 preview decodes UTF-8 text", () => {
  const text = "表面能,1.610369\n";
  const base64 = Buffer.from(text, "utf8").toString("base64");
  assert.equal(api.decodeBase64Text(base64), text);
});
