/**
 * afgo-dsh — AsterFire Go（星使智算）插件 for DeepSeek Harness.
 *
 * Registers five native tools that drive the platform's Galileo Open API v1
 * through the bundled, dependency-free Python client (`scripts/afg.py`).
 * No token lives in this file: the client reads it from ~/.afg/config.json or
 * the AFG_TOKEN environment variable.
 *
 * Bundled with the same repository as a portable Agent Skill (SKILL.md), so a
 * user can either install this bundle into a DSH profile or clone the repo into
 * any agent's skills directory.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { visualizationManifest } from "./visualization.js";

const name = "afgo-dsh";
const inject = ["tools"];

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const CLI = join(ROOT, "scripts", "afg.py");
const DEFAULT_BASE = "https://sidereus-ai.com/api";

// ---------------------------------------------------------------------------
// python discovery
// ---------------------------------------------------------------------------

let cachedPython = null;

/** Candidate interpreters, in preference order. */
function candidates(explicit) {
  const list = [];
  if (explicit) list.push([explicit, []]);
  if (process.platform === "win32") {
    list.push(["python", []], ["py", ["-3"]], ["python3", []]);
  } else {
    list.push(["python3", []], ["python", []]);
  }
  return list;
}

/**
 * Prove an interpreter actually runs Python 3. Windows ships an app-execution
 * alias named `python3` that exists on PATH yet refuses to run, so presence is
 * not enough — every candidate is executed once.
 */
function probe(exe, prefix, timeoutMs = 5000) {
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(exe, [...prefix, "-c", "import sys; sys.exit(0 if sys.version_info[0] == 3 else 1)"], {
      windowsHide: true,
      stdio: "ignore"
    });
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { child.kill(); } catch { /* already gone */ }
        resolve(false);
      }
    }, timeoutMs);
    child.on("error", () => {
      if (!settled) { settled = true; clearTimeout(timer); resolve(false); }
    });
    child.on("close", (code) => {
      if (!settled) { settled = true; clearTimeout(timer); resolve(code === 0); }
    });
  });
}

async function resolvePython(explicit) {
  if (cachedPython !== null) return cachedPython;
  for (const [exe, prefix] of candidates(explicit)) {
    if (await probe(exe, prefix)) {
      cachedPython = [exe, prefix];
      return cachedPython;
    }
  }
  throw new Error(
    "afgo-dsh: no working Python 3 found. Install Python 3.8+ or set `python` in the plugin config " +
      "(cordis patch) to an absolute interpreter path."
  );
}

// ---------------------------------------------------------------------------
// client invocation
// ---------------------------------------------------------------------------

function parseMaybeJson(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try { return JSON.parse(trimmed); } catch { return null; }
  }
  return null;
}

/**
 * Structured failure metadata. The workbench has to tell an expired key (401),
 * a catalog entry this account may not call (403), a deleted task (404) and a
 * dropped connection apart; the one-line message alone cannot.
 */
function failureMeta(r) {
  const payload = parseMaybeJson(r.stderr);
  const err = payload?.error;
  const message = typeof err === "string"
    ? err
    : err?.message || payload?.message || String(r.stderr || r.stdout || "").trim() || `exit code ${r.exit_code}`;
  return {
    statusCode: Number(payload?.status_code) || null,
    code: payload?.error_code || (err && typeof err === "object" ? err.code : null) || null,
    requestId: payload?.request_id || (err && typeof err === "object" ? err.request_id : null) || null,
    message
  };
}

function explainFailure(r) {
  const payload = parseMaybeJson(r.stderr);
  if (payload) {
    const err = payload.error;
    const code = payload.error_code || (err && typeof err === "object" ? err.code : undefined);
    const requestId = payload.request_id || (err && typeof err === "object" ? err.request_id : undefined);
    let message = null;
    if (typeof err === "string") message = err;
    else if (err && typeof err === "object") message = err.message || err.code || JSON.stringify(err);
    else if (payload.message) message = payload.message;
    if (message) {
      const meta = [];
      if (code && String(code) !== String(message)) meta.push(`code=${code}`);
      if (requestId) meta.push(`request_id=${requestId}`);
      return meta.length ? `${message}（${meta.join("，")}）` : message;
    }
  }
  return r.stderr || r.stdout || `exit code ${r.exit_code}`;
}

function runAfg(argv, opts = {}) {
  return new Promise((resolve, reject) => {
    let child;
    void (async () => {
      try {
        if (!existsSync(CLI)) {
          throw new Error(`afgo-dsh: bundled client missing at ${CLI}`);
        }
        const [exe, prefix] = await resolvePython(opts.python);
        const full = [...prefix, "-X", "utf8", CLI, ...argv];
        if (opts.baseUrl && (opts.enforceBase || opts.baseUrl !== DEFAULT_BASE)) {
          full.push("--base-url", opts.baseUrl);
        }

        child = spawn(exe, full, {
          windowsHide: true,
          env: {
            ...process.env,
            ...(opts.token ? { AFG_TOKEN: opts.token } : {}),
            PYTHONIOENCODING: "utf-8"
          }
        });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (d) => { stdout += d; });
        child.stderr.on("data", (d) => { stderr += d; });

        const timer = setTimeout(() => {
          try { child.kill(); } catch { /* ignore */ }
        }, opts.timeoutMs ?? 120000);
        const onAbort = () => { try { child.kill(); } catch { /* ignore */ } };
        if (opts.signal) opts.signal.addEventListener("abort", onAbort, { once: true });

        child.on("error", (e) => { clearTimeout(timer); reject(e); });
        child.on("close", (code) => {
          clearTimeout(timer);
          if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
          const result = {
            ok: code === 0,
            exit_code: code,
            command: `afg ${argv.join(" ")}`,
            data: parseMaybeJson(stdout),
            stdout: String(stdout).trim(),
            stderr: String(stderr).trim()
          };
          if (!result.ok) {
            // `wf validate` exits non-zero when the platform reports
            // blocks_execute, yet the body is a normal result, not a transport
            // error. Hand it back so the caller reads the issues instead of a
            // one-line string.
            if (result.data && typeof result.data === "object" && result.data.valid === false) {
              resolve(result);
              return;
            }
            const failure = new Error(explainFailure(result));
            failure.afg = failureMeta(result);
            reject(failure);
            return;
          }
          resolve(result);
        });
      } catch (e) {
        reject(e);
      }
    })();
  });
}

// ---------------------------------------------------------------------------
// tool helpers
// ---------------------------------------------------------------------------

function outputSpec() {
  return {
    schema: { type: "object", additionalProperties: true },
    render: (_args, value) => {
      const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
      return [{ type: "text", text }];
    }
  };
}

function pushFlag(target, flag, value) {
  if (value === undefined || value === null || value === "") return;
  target.push(flag, String(value));
}

// ---------------------------------------------------------------------------
// plugin
// ---------------------------------------------------------------------------

function apply(ctx, config = {}) {
  const cfg = {
    python: config.python || "",
    baseUrl: config.baseUrl || DEFAULT_BASE,
    token: config.token || "",
    timeoutMs: Number.isFinite(config.timeoutMs) ? config.timeoutMs : 120000
  };
  const credential = "AFGO_" + createHash("sha256").update(cfg.baseUrl.replace(/\/$/, "")).digest("hex");
  const saved = async () => (await ctx.get?.("credentials")?.resolve(credential))?.value;
  const run = async (argv, exec) => {
    const stored = await saved();
    return runAfg(argv, {
      ...cfg, token: stored || cfg.token, enforceBase: Boolean(stored), signal: exec?.signal
    });
  };
  ctx.inject?.(["credentials", "typert"], async (scoped) => {
    const { installWorkbench } = await import("./workbench.js");
    await installWorkbench(scoped, {
      credential,
      baseUrl: cfg.baseUrl,
      call: async (args, token) => {
        const result = await runAfg([...args, "--json"], {
          ...cfg, token: token || await saved() || cfg.token, enforceBase: true
        });
        return result.data ?? result.stdout;
      }
    });
  });

  ctx.tools.register(
    defineTool({
      name: "afg_platform",
      description:
        "查询 AsterFire Go / 星使智算 / AFGO 平台本身：当前账号、可用大模型、Agent 工具箱目录、Kit 工具目录与输入 schema、" +
        "以及连通性。当用户问『星使上有什么能跑』『平台里有没有蛋白质设计 / 分子动力学 / 分子对接 / 蛋白质结构预测 / " +
        "生物信息学 / DFT 密度泛函 / 量子化学 / 第一性原理 计算的工具』『列出可用的 Kit』时，先用它检索目录。" +
        " actions: info（账号）· models（模型）· health · agents（Agent 目录，可 filter）· kits（Kit 目录，可 filter）· " +
        "kit_schema（某个 Kit 需要的输入字段，提交前必看）。" +
        " AsterFire Go platform catalog: account, models, agents, kits, kit input schema, health.",
      parameters: {
        action: {
          type: "string",
          description: "info | models | health | agents | kits | kit_schema",
          required: true
        },
        query: {
          type: "string",
          description: "按注册名、展示名、描述或标签搜索 agents 或 kits"
        },
        limit: { type: "number", description: "最多返回条数（默认不限制，建议 10-30）" },
        full: { type: "boolean", description: "agents/kits：返回完整目录字段及样例" },
        all_versions: { type: "boolean", description: "agents/kits：逐条返回同注册名的目录版本" },
        kit: { type: "string", description: "kit_schema 时必填：Kit 的精确注册名" },
        version: { type: "string", description: "kit_schema：查看指定目录版本的 schema" }
      },
      output: outputSpec(),
      presentCall: (args) => ({ card: "generic", title: `afg_platform ${args.action}`, kind: "execute" }),
      async execute(args, exec) {
        const argv = [];
        switch (args.action) {
          case "info": argv.push("info", "--json"); break;
          case "models": argv.push("models", "--json"); break;
          case "health": argv.push("raw", "GET", "/health", "--json"); break;
          case "agents":
          case "kits":
            if (args.action === "agents") argv.push("agents");
            else argv.push("kits", "list");
            pushFlag(argv, "--query", args.query);
            pushFlag(argv, "--limit", args.limit);
            if (args.full) argv.push("--full");
            if (args.all_versions) argv.push("--all-versions");
            argv.push("--json");
            break;
          case "kit_schema":
            if (!args.kit) throw new Error("afg_platform kit_schema: `kit` is required");
            argv.push("kits", "schema", String(args.kit), "--json");
            pushFlag(argv, "--version", args.version);
            break;
          default:
            throw new Error(`afg_platform: unknown action ${args.action}`);
        }
        const r = await run(argv, exec);
        return { action: args.action, result: r.data ?? r.stdout };
      }
    })
  );

  ctx.tools.register(
    defineTool({
      name: "afg_files",
      description:
        "AsterFire Go 云盘文件操作：列举、上传、下载。上传后拿到平台 file_id，供 Agent 任务或 Kit 使用；" +
        "下载用于取回计算结果（报告、轨迹、结构、图表）。适用于蛋白质结构（PDB/CIF）、分子结构、轨迹、材料结构等任何文件。" +
        " `upload` 返回文件对象，其 `id` 就是 file_id（注意在 `data.file.id` 这一层，本工具已压平）。" +
        " actions: list · upload · download。" +
        " AsterFire Go cloud disk: list, upload (returns file_id), download results.",
      parameters: {
        action: { type: "string", description: "list | upload | download", required: true },
        path: { type: "string", description: "upload：本地文件路径（绝对路径最稳）" },
        file_id: { type: "string", description: "download：平台文件 ID；文件 ID 也可能是 base64 长串，原样传入" },
        out: { type: "string", description: "download：保存到本地的路径，省略则用服务端文件名" },
        parent_id: { type: "number", description: "list/upload：云盘目录 ID" },
        workspace_id: { type: "number", description: "团队 ID（个人账号可省略）" },
        q: { type: "string", description: "list：按文件名搜索" },
        page: { type: "number", description: "list：页码" },
        per_page: { type: "number", description: "list：每页条数" }
      },
      output: outputSpec(),
      presentCall: (args) => ({ card: "generic", title: `afg_files ${args.action}`, kind: "execute" }),
      async execute(args, exec) {
        const argv = [];
        switch (args.action) {
          case "list":
            argv.push("cloud", "list");
            pushFlag(argv, "--parent-id", args.parent_id);
            pushFlag(argv, "--workspace-id", args.workspace_id);
            pushFlag(argv, "--q", args.q);
            pushFlag(argv, "--page", args.page);
            pushFlag(argv, "--per-page", args.per_page);
            argv.push("--json");
            break;
          case "upload":
            if (!args.path) throw new Error("afg_files upload: `path` is required");
            argv.push("cloud", "upload", String(args.path));
            pushFlag(argv, "--workspace-id", args.workspace_id);
            pushFlag(argv, "--parent-id", args.parent_id);
            argv.push("--json");
            break;
          case "download":
            if (!args.file_id) throw new Error("afg_files download: `file_id` is required");
            argv.push("cloud", "download", String(args.file_id));
            pushFlag(argv, "-o", args.out);
            pushFlag(argv, "--workspace-id", args.workspace_id);
            argv.push("--json");
            break;
          default:
            throw new Error(`afg_files: unknown action ${args.action}`);
        }
        const r = await run(argv, exec);
        return { action: args.action, result: r.data ?? r.stdout };
      }
    })
  );

  ctx.tools.register(
    defineTool({
      name: "afg_tasks",
      description:
        "在 AsterFire Go / 星使智算 上提交并跟踪计算任务。Agent 任务用于对话式科研流程（蛋白质设计、结构预测、分子动力学、对接、" +
        "自由能、DFT/量子化学 等耗时计算都可以交给它，多轮追问补充参数）；Kit 任务是固定输入的单次计算。" +
        " 关键语义：创建成功只代表请求被受理，不代表算完；`is_thinking=false` 也不代表成功，要结合 steps 和 afg_files 的产物判断。" +
        " actions: create（建 Agent 任务，需 toolbox+message）· send（继续对话）· list · get（步骤与消息，信息最多）· " +
        "status · files（产物清单）· stop · rename · delete · kit_submit（新 Kit 任务）· kit_run（在已有任务里跑 Kit）。" +
        " visualizations（只读识别结构、图片和数值表；在工作台结果可视化中打开，报告中附实际预览或图片及任务来源）。" +
        " Submit and track AsterFire Go agent/kit jobs: create, send, list, get, status, files, visualizations, stop, kit_submit, kit_run.",
      parameters: {
        action: { type: "string", description: "create | send | list | get | status | files | visualizations | stop | rename | delete | kit_submit | kit_run", required: true },
        task_id: { type: "string", description: "任务 ID（send/get/status/files/visualizations/stop/rename/delete/kit_run 必填）" },
        toolbox: { type: "string", description: "create：Agent 名称，先用 afg_platform agents 查" },
        message: { type: "string", description: "create/send：用自然语言描述要算什么（越具体越好）" },
        file_ids: { type: "array", description: "create/send：附件 file_id 数组（来自 afg_files upload），不是本地路径" },
        llm_model: { type: "string", description: "可选模型名，来自 afg_platform models" },
        kit: { type: "string", description: "kit_submit/kit_run：Kit 名称" },
        input: { type: "object", additionalProperties: true, description: "kit_submit/kit_run：Kit 输入对象，字段必须符合 afg_platform kit_schema 返回的 input_schema" },
        step_id: { type: "number", description: "status：查某个步骤的状态" },
        subpath: { type: "string", description: "files：任务目录内的相对子路径" },
        keyword: { type: "string", description: "list：按标题搜索" },
        type: { type: "string", description: "list：agent | kit" },
        page: { type: "number", description: "list：页码" },
        per_page: { type: "number", description: "list：每页条数（上限 100）" },
        name: { type: "string", description: "rename：新名称" },
        workspace_id: { type: "number", description: "团队 ID（个人账号可省略）" },
        yes: { type: "boolean", description: "delete：确认删除（不可逆）" }
      },
      output: outputSpec(),
      presentCall: (args) => ({ card: "generic", title: `afg_tasks ${args.action}`, kind: "execute" }),
      async execute(args, exec) {
        const argv = [];
        const needTask = () => {
          if (!args.task_id) throw new Error(`afg_tasks ${args.action}: \`task_id\` is required`);
          return String(args.task_id);
        };
        switch (args.action) {
          case "create": {
            if (!args.toolbox || !args.message) throw new Error("afg_tasks create: `toolbox` and `message` are required");
            argv.push("tasks", "create", "--toolbox", String(args.toolbox), "--message", String(args.message));
            for (const id of args.file_ids ?? []) argv.push("--file", String(id));
            pushFlag(argv, "--llm-model", args.llm_model);
            pushFlag(argv, "--workspace-id", args.workspace_id);
            argv.push("--json");
            break;
          }
          case "send": {
            const task = needTask();
            if (!args.message) throw new Error("afg_tasks send: `message` is required");
            argv.push("tasks", "send", task, "--message", String(args.message));
            for (const id of args.file_ids ?? []) argv.push("--file", String(id));
            pushFlag(argv, "--llm-model", args.llm_model);
            argv.push("--json");
            break;
          }
          case "list":
            argv.push("tasks", "list");
            pushFlag(argv, "--type", args.type);
            pushFlag(argv, "--keyword", args.keyword);
            pushFlag(argv, "--page", args.page);
            pushFlag(argv, "--per-page", args.per_page);
            pushFlag(argv, "--workspace-id", args.workspace_id);
            argv.push("--json");
            break;
          case "get":
            argv.push("tasks", "get", needTask(), "--json");
            break;
          case "status":
            argv.push("tasks", "status", needTask());
            pushFlag(argv, "--step-id", args.step_id);
            argv.push("--json");
            break;
          case "visualizations":
          case "files": {
            const task = needTask();
            argv.push("tasks", "files", task);
            if (args.subpath) argv.push(String(args.subpath));
            pushFlag(argv, "--workspace-id", args.workspace_id);
            argv.push("--json");
            break;
          }
          case "stop":
            argv.push("tasks", "stop", needTask(), "--json");
            break;
          case "rename": {
            const task = needTask();
            if (!args.name) throw new Error("afg_tasks rename: `name` is required");
            argv.push("tasks", "rename", task, String(args.name));
            pushFlag(argv, "--workspace-id", args.workspace_id);
            argv.push("--json");
            break;
          }
          case "delete":
            argv.push("tasks", "delete", needTask());
            if (args.yes) argv.push("--yes");
            argv.push("--json");
            break;
          case "kit_submit": {
            if (!args.kit || !args.input) throw new Error("afg_tasks kit_submit: `kit` and `input` are required");
            // node spawns without a shell, so inline JSON is safe here
            argv.push("kits", "submit", "--kit", String(args.kit), "--input", JSON.stringify(args.input));
            pushFlag(argv, "--workspace-id", args.workspace_id);
            argv.push("--json");
            break;
          }
          case "kit_run": {
            const task = needTask();
            if (!args.kit || !args.input) throw new Error("afg_tasks kit_run: `kit` and `input` are required");
            argv.push("kits", "run", task, "--kit", String(args.kit), "--input", JSON.stringify(args.input));
            argv.push("--json");
            break;
          }
          default:
            throw new Error(`afg_tasks: unknown action ${args.action}`);
        }
        const r = await run(argv, exec);
        if (["get", "files", "visualizations"].includes(args.action)) {
          const result = r.data ?? r.stdout;
          let manifest;
          try {
            const filesResult = args.action === "get" ? (await run(["tasks", "files", String(args.task_id), "--json"], exec)).data : r.data;
            manifest = visualizationManifest(args.task_id, Array.isArray(filesResult) ? filesResult : filesResult?.files ?? []);
          } catch {
            manifest = { taskId: String(args.task_id), entries: [], unavailable: true,
              note: "产物清单暂不可读，可重试 afg_tasks visualizations；任务详情仍可使用。" };
          }
          if (args.action === "visualizations") return { action: args.action, result: manifest };
          return { action: args.action, result, visualizations: manifest };
        }
        return { action: args.action, result: r.data ?? r.stdout };
      }
    })
  );

  ctx.tools.register(
    defineTool({
      name: "afg_workflows",
      description:
        "AsterFire Go 多步科学计算工作流（DAG）：把结构预测、分子动力学、对接、自由能、DFT 等步骤串成一条流程并复跑。" +
        " 六种 ID 不要混：plan_id（流程定义）、execution_id（某次运行）、node_id（节点）、task_id、step_id、file_id。" +
        " 节点级查询必须同时给 plan_id + node_id + execution_id。" +
        " 典型顺序：create → get（检查节点）→ validate → execute（拿 execution_id）→ status → node_outputs。" +
        " actions: list · get · create · validate · execute · status · executions · execution · node_outputs · node_logs · export · delete。" +
        " 智算会话：session_plan_create → session_create → session_send → session_messages。也可 session_list、session_events 或 session_abort。" +
        " AsterFire Go workflows: define, validate, execute, inspect node outputs.",
      parameters: {
        action: {
          type: "string",
          description: "list | get | create | validate | execute | status | executions | execution | node_outputs | node_logs | export | delete | session_plan_create | session_create | session_list | session_send | session_messages | session_events | session_abort",
          required: true
        },
        plan_id: { type: "string", description: "工作流方案 ID（session_create / session_list 也使用此 ID）" },
        execution_id: { type: "string", description: "执行记录 ID（execute 之后返回）" },
        node_id: { type: "string", description: "节点 ID（来自 workflows get）" },
        step_id: { type: "string", description: "node_logs 必填：步骤 ID" },
        title: { type: "string", description: "create / session_plan_create：流程标题" },
        prompt: { type: "string", description: "create / session_plan_create：初始需求" },
        workspace_id: { type: "number", description: "session_plan_create：团队 ID" },
        file_ids: { type: "array", description: "session_plan_create：关联的云盘文件 ID 数组" },
        auto_mode: { type: "boolean", description: "session_plan_create：允许平台自动推进，默认关闭" },
        session_id: { type: "string", description: "会话 ID，取 session_create 返回的 opencode_session_id" },
        message: { type: "string", description: "session_send：文本消息，与 parts 二选一" },
        parts: { type: "array", description: "session_send：消息 parts 数组，与 message 二选一" },
        llm_model: { type: "string", description: "session_send：可选平台模型名" },
        limit: { type: "number", description: "session_messages：消息页大小；session_events：本次读取的事件数上限" },
        seconds: { type: "number", description: "session_events：读取窗口秒数，默认 10" },
        before: { type: "string", description: "session_messages：前一页返回的 next_cursor" },
        out: { type: "string", description: "export：保存到本地的路径" },
        no_cache: { type: "boolean", description: "execute：跳过缓存复用" },
        use_default_inputs: { type: "boolean", description: "execute：是否使用默认输入（默认 true）" },
        yes: { type: "boolean", description: "delete：确认删除" }
      },
      output: outputSpec(),
      presentCall: (args) => ({ card: "generic", title: `afg_workflows ${args.action}`, kind: "execute" }),
      async execute(args, exec) {
        const argv = ["wf"];
        const needPlan = () => {
          if (!args.plan_id) throw new Error(`afg_workflows ${args.action}: \`plan_id\` is required`);
          return String(args.plan_id);
        };
        const needSession = () => {
          if (!args.session_id) throw new Error(`afg_workflows ${args.action}: \`session_id\` is required`);
          return String(args.session_id);
        };
        switch (args.action) {
          case "session_plan_create":
            argv.push("session", "plan-create");
            pushFlag(argv, "--title", args.title);
            pushFlag(argv, "--prompt", args.prompt);
            pushFlag(argv, "--workspace-id", args.workspace_id);
            for (const id of args.file_ids ?? []) pushFlag(argv, "--file", id);
            if (args.auto_mode === true) argv.push("--auto-mode");
            argv.push("--json");
            break;
          case "session_create":
          case "session_list":
            argv.push("session", args.action === "session_create" ? "create" : "list", needPlan(), "--json");
            break;
          case "session_send":
            if ((args.message === undefined) === (args.parts === undefined)) {
              throw new Error("afg_workflows session_send: provide exactly one of message or parts");
            }
            argv.push("session", "send", needSession());
            if (args.message !== undefined) argv.push(`--message=${args.message}`);
            else argv.push("--parts", JSON.stringify(args.parts));
            pushFlag(argv, "--llm-model", args.llm_model);
            argv.push("--json");
            break;
          case "session_messages":
            argv.push("session", "messages", needSession());
            pushFlag(argv, "--limit", args.limit);
            pushFlag(argv, "--before", args.before);
            argv.push("--json");
            break;
          case "session_events":
            argv.push("session", "events", needSession());
            pushFlag(argv, "--limit", args.limit);
            pushFlag(argv, "--seconds", args.seconds);
            argv.push("--json");
            break;
          case "session_abort":
            argv.push("session", "abort", needSession(), "--json");
            break;
          case "list":
            argv.push("list", "--json");
            break;
          case "create":
            if (!args.title) throw new Error("afg_workflows create: `title` is required");
            argv.push("create", "--title", String(args.title));
            pushFlag(argv, "--prompt", args.prompt);
            argv.push("--json");
            break;
          case "get": argv.push("get", needPlan(), "--json"); break;
          case "validate": argv.push("validate", needPlan(), "--json"); break;
          case "delete":
            argv.push("delete", needPlan());
            if (args.yes === true) argv.push("--yes");
            argv.push("--json");
            break;
          case "execute":
            argv.push("execute", needPlan());
            if (args.no_cache) argv.push("--no-cache");
            if (args.use_default_inputs === false) argv.push("--use-default-inputs", "false");
            argv.push("--json");
            break;
          case "status":
            argv.push("status", needPlan());
            pushFlag(argv, "--execution-id", args.execution_id);
            argv.push("--json");
            break;
          case "executions": argv.push("executions", needPlan(), "--json"); break;
          case "execution":
            if (!args.execution_id) throw new Error("afg_workflows execution: `execution_id` is required");
            argv.push("execution", needPlan(), String(args.execution_id), "--json");
            break;
          case "node_outputs":
            if (!args.node_id || !args.execution_id) throw new Error("afg_workflows node_outputs: `node_id` and `execution_id` are required");
            argv.push("node-outputs", needPlan(), String(args.node_id), "--execution-id", String(args.execution_id), "--json");
            break;
          case "node_logs":
            if (!args.node_id || !args.execution_id || !args.step_id) {
              throw new Error("afg_workflows node_logs: `node_id`, `execution_id` and `step_id` are required");
            }
            argv.push("node-logs", needPlan(), String(args.node_id), String(args.step_id), "--execution-id", String(args.execution_id), "--json");
            break;
          case "export":
            argv.push("export", needPlan());
            pushFlag(argv, "-o", args.out);
            argv.push("--json");
            break;
          default:
            throw new Error(`afg_workflows: unknown action ${args.action}`);
        }
        const r = await run(argv, exec);
        return { action: args.action, result: r.data ?? r.stdout };
      }
    })
  );

  ctx.tools.register(
    defineTool({
      name: "afg_raw",
      description:
        "直接调用 AsterFire Go 的任意 Open API v1 端点，作为兜底手段。当上面四个工具没覆盖某个操作、" +
        "或需要看平台原始返回（含 request_id）时使用。路径相对 /api/open/v1，例如 GET /tasks、GET /toolboxes?type=kit、" +
        "POST /kits/submit。完整 74 个操作见仓库 reference/api.md。" +
        " Escape hatch: call any Galileo Open API v1 endpoint directly.",
      parameters: {
        method: { type: "string", description: "GET | POST | PUT | PATCH | DELETE", required: true },
        path: { type: "string", description: "以 / 开头的端点路径，例如 /tasks", required: true },
        query: { type: "object", additionalProperties: true, description: "查询参数对象，例如 {\"type\":\"kit\",\"page\":1}" },
        body: { type: "object", additionalProperties: true, description: "JSON 请求体（POST/PATCH/PUT）" }
      },
      output: outputSpec(),
      presentCall: (args) => ({ card: "generic", title: `afg_raw ${args.method} ${args.path}`, kind: "execute" }),
      async execute(args, exec) {
        const argv = ["raw", String(args.method).toUpperCase(), String(args.path)];
        for (const [k, v] of Object.entries(args.query ?? {})) {
          if (v !== undefined && v !== null) argv.push("--query", `${k}=${v}`);
        }
        if (args.body !== undefined) argv.push("--body", JSON.stringify(args.body));
        argv.push("--json");
        const r = await run(argv, exec);
        return { method: args.method, path: args.path, result: r.data ?? r.stdout };
      }
    })
  );
}

export { apply, inject, name };
