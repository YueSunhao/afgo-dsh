import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { rankCandidates, visualizationManifest } from "./visualization.js";
import { renderStructure } from "./structure-renderer.js";

const LIMIT = 4 * 1024 * 1024;

export function reportCandidates(taskId, files) {
  const ranked = rankCandidates(visualizationManifest(taskId, files).entries, LIMIT);
  return [ranked.structure, ranked.image].filter(Boolean);
}

export async function createResultReport({ taskId, files, detail, attachments, call, signal, browserExecutable,
  renderer = renderStructure }) {
  const report = { taskId: String(taskId), outcome: detail?.outcome ?? null, images: [], warnings: [], markdown: "" };
  if (!attachments?.saveImage || !attachments?.imageHostPath) {
    report.warnings.push("当前 DSH 宿主没有图片附件服务，无法保存对话图片。请启用宿主附件服务后重试 afg_results。");
    return report;
  }
  const candidates = reportCandidates(taskId, files);
  if (!candidates.length) report.warnings.push("任务根目录没有可生成图片的受支持结构或结果图，可在工作台查看数值表或下载原文件。");
  else {
    if (!candidates.some((file) => file.visualization.kind === "structure")) report.warnings.push("任务根目录没有可渲染的受支持结构文件。");
    if (!candidates.some((file) => file.visualization.kind === "image")) report.warnings.push("任务根目录没有现成的 PNG/JPEG/WebP 结果图。");
  }
  for (const file of candidates) {
    signal?.throwIfAborted();
    const directory = await mkdtemp(join(tmpdir(), "afgo-report-"));
    try {
      const path = join(directory, "artifact");
      await call(["cloud", "download", file.id, "-o", path, "--max-bytes", String(LIMIT)]);
      const bytes = await readFile(path);
      if (bytes.byteLength > LIMIT) throw new Error("文件超过 4 MiB 图片生成上限");
      const source = { taskId: String(taskId), fileId: file.id, name: basename(file.name.replaceAll("\\", "/")),
        sha256: createHash("sha256").update(bytes).digest("hex"), fetchedAt: new Date().toISOString() };
      let png = bytes;
      let scene = source;
      let name = source.name;
      let mediaType = "image/" + file.visualization.format.replace("jpg", "jpeg");
      const isStructure = file.visualization.kind === "structure";
      if (isStructure) {
        const rendered = await renderer({ ...source, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
          format: file.visualization.format }, { signal, browserExecutable });
        png = rendered.png;
        scene = rendered.manifest;
        name = `task-${taskId}-${source.name}.png`;
        mediaType = "image/png";
      }
      signal?.throwIfAborted();
      const attachment = await attachments.saveImage({ data: png, name, mediaType });
      const image = { kind: isStructure ? "structure" : "result", caption: isStructure ? `任务 #${taskId} 结构文件 · ${source.name}` : `任务 #${taskId} 原始结果图 · ${source.name}`,
        attachment, path: attachments.imageHostPath(attachment), source };
      if (attachments.saveFile && attachments.fileHostPath) {
        const savedScene = await attachments.saveFile({ data: Buffer.from(JSON.stringify(scene, null, 2)),
          name: `task-${taskId}-${source.name}-source.json`, mediaType: "application/json" });
        image.provenancePath = attachments.fileHostPath(savedScene);
      }
      report.images.push(image);
    } catch (error) {
      signal?.throwIfAborted();
      report.warnings.push(`${file.name}：${error.message}`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  report.markdown = report.images.map((image) => `![${image.caption.replace(/[\[\]\r\n]/g, " ")}](<${image.path}>)`
    + (image.provenancePath ? `\n\n[来源记录](<${image.provenancePath}>)` : "")).join("\n\n");
  report.instruction = "向用户汇报时将 markdown 中的图片直接放在最终回复里，并说明任务结果与文件角色；图片已持久保存。结构图来自任务文件，可能是输入或中间文件，科学解释以原始数据和任务报告为准。";
  return report;
}
