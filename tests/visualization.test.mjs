import assert from "node:assert/strict";
import { test } from "node:test";
import { visualizationOf, visualizationManifest } from "../lib/visualization.js";

test("structure detection covers task CIF, macromolecules and coordinates without guessing unsupported binary trajectories", () => {
  for (const name of ["slab_final.cif", "protein.MMCIF", "fold.pdb", "water.xyz", "relax.extxyz", "ligand.sdf", "model.gro"]) {
    assert.equal(visualizationOf({ name }).kind, "structure", name);
  }
  for (const name of ["run.traj", "run.xtc", "archive.zip", "picture.svg", "file.cif.exe", "justpng"]) {
    assert.equal(visualizationOf({ name }), null, name);
  }
});

test("model output includes only supported task files and keeps original identities", () => {
  const result = visualizationManifest("85244", [
    { id: "folder", name: "structures.cif", type: "directory" },
    { id: "structure", name: "slab_final.cif", size: 2755 },
    { id: "plot", name: "rank.png" },
    { id: "table", name: "energy.csv" },
    { id: "log", name: "run.log" }
  ]);
  assert.equal(result.taskId, "85244");
  assert.deepEqual(result.entries.map((file) => file.id), ["structure", "plot", "table"]);
  assert.deepEqual(result.entries.map((file) => file.visualization.kind), ["structure", "image", "table"]);
  assert.match(result.note, /输入、中间文件和输出/);
  assert.match(result.openIn, /结果可视化/);
  assert.equal(visualizationManifest("84052", []).entries.length, 0);
});
