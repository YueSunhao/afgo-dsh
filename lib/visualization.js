/** Result classification shared by the host workbench and model-facing tools. */
const STRUCTURES = new Set(["cif", "mmcif", "mcif", "pdb", "ent", "xyz", "extxyz", "sdf", "mol", "mol2", "gro"]);
const IMAGES = new Set(["png", "jpg", "jpeg", "webp"]);

export function visualizationOf(file) {
  const name = String(file?.name ?? "");
  const extension = name.toLowerCase().split(".").pop();
  if (STRUCTURES.has(extension)) return { kind: "structure", format: extension, renderer: "molstar" };
  if (IMAGES.has(extension)) return { kind: "image", format: extension };
  if (extension === "csv" || extension === "tsv") return { kind: "table", format: extension };
  return null;
}

export function visualizationManifest(id, files) {
  const entries = (files ?? []).filter((file) => file?.id != null && file.type !== "directory" && !file.is_directory)
    .map((file) => ({ id: String(file.id), name: String(file.name ?? file.id),
      size: file.size ?? null, visualization: visualizationOf(file) }))
    .filter((file) => file.visualization);
  return {
    taskId: String(id), entries,
    reportTool: { name: "afg_results", arguments: { task_id: String(id) } },
    openIn: "DSH → 插件 → afgo-dsh → 我的任务 → 打开任务编号 → 结果",
    note: "来源为任务文件清单，可能包含输入、中间文件和输出。展示候选不代表计算成功；结构按原文件读取，键线为查看器的可视化推断。"
  };
}

// One ranking for "which file represents this task", shared by the
// workbench (file list order, summary) and the conversation report, so both
// show the same structure and image. Name hints only: the platform does not
// tag outputs, so this is an ordering, never a claim that a file is the result.
const IMAGE_HINT = /rank|plot|summary|composition|energ|result|score/i;

export function structureRank(name) {
  const text = String(name ?? "");
  if (/final/i.test(text) && /slab|complex/i.test(text)) return 0;
  if (/final|complex/i.test(text)) return 1;
  return 2;
}

/**
 * Order visualizable files: structures (final+slab/complex first), then
 * images (result-looking names first), then tables; ties by name. Files over
 * `limit` bytes keep their place in `ordered` but are never representative.
 * @returns {{ ordered: object[], structure: object|null, image: object|null }}
 */
export function rankCandidates(files, limit = 4 * 1024 * 1024) {
  const kindRank = { structure: 0, image: 1, table: 2 };
  const within = (file) => file.visualization.kind === "structure" ? structureRank(file.name)
    : file.visualization.kind === "image" ? Number(!IMAGE_HINT.test(file.name)) : 0;
  const ordered = (files ?? []).filter((file) => file?.visualization && kindRank[file.visualization.kind] != null)
    .slice()
    .sort((a, b) => kindRank[a.visualization.kind] - kindRank[b.visualization.kind]
      || within(a) - within(b) || String(a.name).localeCompare(String(b.name), "en"));
  const fits = (file) => file.size == null || file.size <= limit;
  return {
    ordered,
    structure: ordered.find((file) => file.visualization.kind === "structure" && fits(file)) ?? null,
    image: ordered.find((file) => file.visualization.kind === "image" && fits(file)) ?? null
  };
}
