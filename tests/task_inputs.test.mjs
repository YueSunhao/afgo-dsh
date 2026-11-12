import assert from "node:assert/strict";
import { test } from "node:test";
import { inputsOf } from "../lib/task-inputs.js";

test("inputsOf keeps plain values and reduces argFile references to the display name", () => {
  const args = {
    fmax: 0.05, steps: 500, device: "cuda", task_type: "surface_energy", slab_layers: 3, miller_indices: "1,1,0",
    structure_file: "argFile:L2hvbWUvZ2FsaWxlby1ncm91cC9zaGFyZS9kYXRhL2FkYW0tZGF0YS8xMzExOC84NTI0NC9UaU8yLmNpZg==|TiO2.cif|cif|1364",
    write_other: false, nested: { a: 1 }, empty: "  "
  };
  const inputs = inputsOf(args);
  assert.deepEqual(inputs.find((entry) => entry.key === "structure_file"), { key: "structure_file", kind: "file", value: "TiO2.cif", bytes: 1364 });
  assert.deepEqual(inputs.find((entry) => entry.key === "fmax"), { key: "fmax", kind: "value", value: "0.05" });
  assert.deepEqual(inputs.find((entry) => entry.key === "write_other"), { key: "write_other", kind: "value", value: "否" });
  assert.equal(inputs.some((entry) => entry.key === "nested" || entry.key === "empty"), false);
  assert.ok(!JSON.stringify(inputs).includes("L2hvbWUv"), "server paths never reach the page");
});

test("inputsOf tolerates missing or malformed args and caps long values", () => {
  for (const bad of [null, undefined, "x", [], 3]) assert.deepEqual(inputsOf(bad), []);
  const long = inputsOf({ smiles: "C".repeat(200) })[0];
  assert.equal(long.value.length, 81);
  assert.ok(long.value.endsWith("…"));
  assert.equal(inputsOf(Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, i]))).length, 12);
  assert.deepEqual(inputsOf({ f: "argFile:abc" })[0], { key: "f", kind: "file", value: "文件", bytes: null });
});
