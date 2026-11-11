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
    openIn: "DSH → 插件 → afgo-dsh → 我的任务 → 打开任务编号 → 结果可视化",
    note: "来源为任务文件清单，可能包含输入、中间文件和输出。展示候选不代表计算成功；结构按原文件读取，键线为查看器的可视化推断。"
  };
}
