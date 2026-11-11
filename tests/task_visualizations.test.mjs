import assert from "node:assert/strict";
import { createServer } from "node:http";
import { registerHooks } from "node:module";
import { test } from "node:test";

// Keep the actual tool entry point and Python HTTP client. Only the DSH tool
// descriptor factory is replaced, because these tests do not boot a DSH host.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@deepseek-ai/dsh-tools") {
      return { url: "data:text/javascript,export const defineTool = value => value", shortCircuit: true };
    }
    return next(specifier, context);
  }
});
const { apply } = await import("../lib/index.js");

test("native task tool preserves get/files result and adds visualization candidates, including unavailable artifacts", async () => {
  let forbidden = false;
  const files = [{ id: "model", name: "final.cif", size: 123 }, { id: "report", name: "report.md" }];
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.url.startsWith("/open/v1/tasks/files") && forbidden) {
      response.statusCode = 403;
      response.end(JSON.stringify({ success: false, error: { code: "permission_denied", message: "not authorized" } }));
      return;
    }
    const data = request.url.startsWith("/open/v1/tasks/files") ? { files } : {
      toolbox: { name: "test-kit", version: "1.0.0" }, is_thinking: false, steps: [], messages: []
    };
    response.end(JSON.stringify({ success: true, data }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const tools = new Map();
    apply({ tools: { register(tool) { tools.set(tool.name, tool); } } }, {
      python: "python3", baseUrl: `http://127.0.0.1:${server.address().port}`, token: "local-test-only"
    });
    const tool = tools.get("afg_tasks");
    const detail = await tool.execute({ action: "get", task_id: "85244" });
    assert.equal(detail.result.toolbox.name, "test-kit");
    assert.equal(detail.visualizations.entries[0].id, "model");
    const listed = await tool.execute({ action: "files", task_id: "85244" });
    assert.deepEqual(listed.result.files, files);
    assert.equal(listed.visualizations.entries.length, 1);
    const direct = await tool.execute({ action: "visualizations", task_id: "85244" });
    assert.equal(direct.result.taskId, "85244");
    assert.equal(direct.result.entries[0].name, "final.cif");
    forbidden = true;
    const preserved = await tool.execute({ action: "get", task_id: "85244" });
    assert.equal(preserved.result.toolbox.version, "1.0.0");
    assert.equal(preserved.visualizations.unavailable, true);
    await assert.rejects(tool.execute({ action: "visualizations", task_id: "85244" }), /403|authorized|权限/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
