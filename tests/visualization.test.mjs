import assert from "node:assert/strict";
import { test } from "node:test";
import { rankCandidates, structureRank, visualizationOf, visualizationManifest } from "../lib/visualization.js";

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
  assert.match(result.openIn, /打开任务编号 → 结果$/);
  assert.equal(visualizationManifest("84052", []).entries.length, 0);
});

test("rankCandidates gives one shared order: final slab/complex structures, result-looking images, then tables", () => {
  const files = visualizationManifest("85244", [
    { id: "table", name: "surface_energies.csv", size: 1180 },
    { id: "cell", name: "cell.png", size: 10 },
    { id: "rank", name: "surface_energy_rank.png", size: 10 },
    { id: "bulk", name: "bulk.cif", size: 10 },
    { id: "final", name: "slab_term_000_final.cif", size: 10 },
    { id: "huge", name: "a_final_slab.cif", size: 5 * 1024 * 1024 }
  ]).entries;
  const ranked = rankCandidates(files);
  assert.deepEqual(ranked.ordered.map((file) => file.id), ["huge", "final", "bulk", "rank", "cell", "table"]);
  assert.equal(ranked.structure.id, "final", "over-limit files keep their place but are never representative");
  assert.equal(ranked.image.id, "rank");
  assert.deepEqual(rankCandidates([]), { ordered: [], structure: null, image: null });
  assert.equal(structureRank("complex_final.pdb"), 0);
  assert.equal(structureRank("final.xyz"), 1);
  assert.equal(structureRank("input.cif"), 2);
});
