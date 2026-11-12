/**
 * afgo-dsh workbench — host half.
 *
 * One Typert remote service (`afgoWorkbench`) backs the settings page. Every
 * action returns an explicit envelope:
 *
 *   { ok: true,  data: ... }
 *   { ok: false, error: { code, message, retryable?, ...extra } }
 *
 * Expected failures (a lost key, a 403 on one catalog entry, a file over the
 * download cap) are values, not exceptions, because the page has to tell those
 * three apart and offer a different next step for each. Programming mistakes
 * still throw.
 *
 * The service never caches a credential: it delegates to the DSH credential
 * service that already owns the key, and hands the token to the bundled Python
 * client only for the duration of one child process.
 */

import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { visualizationOf } from "./visualization.js";
import { inputsOf } from "./task-inputs.js";

const MAX_DOWNLOAD = 4 * 1024 * 1024;
const MAX_PREVIEW = 256 * 1024;
const CATALOG_TTL_MS = 10 * 60 * 1000;
const WEB_ENTRY = "https://sidereus-ai.com";
const TASK_ID = /^[1-9]\d{0,18}$/;
const CODEC = { mode: "src-json" };
const INPUT_CODEC = {
  mode: "strict",
  typeSymbol: "afgo-dsh#WorkbenchInput",
  create: () => ({ parse(input) {
    if (!input || typeof input !== "object" || Array.isArray(input) || typeof input.action !== "string") {
      throw new Error("无效的工作台请求。");
    }
    return input;
  } })
};
const DESCRIPTOR = {
  id: "afgo-dsh#afgoWorkbench/dispatch",
  service: "afgoWorkbench",
  namespace: "afgoWorkbench",
  method: "dispatch",
  invocation: { kind: "direct" },
  parameters: [{ name: "input", wire: "input", source: "json", codec: INPUT_CODEC }],
  result: CODEC
};

// ---------------------------------------------------------------------------
// envelopes
// ---------------------------------------------------------------------------

function ok(data) { return { ok: true, data }; }
function fail(code, message, extra) { return { ok: false, error: { code, message, ...extra } }; }

/**
 * Classify a rejected bundled-client call. `error.afg` is attached by the
 * plugin's `runAfg`; a bare network failure arrives as a plain Error.
 */
function classify(error) {
  const meta = error?.afg ?? {};
  const message = String(meta.message || error?.message || error);
  const status = Number(meta.statusCode) || null;
  const apiCode = String(meta.code || "");

  if (/invalid_token|expired|令牌无效|auth\.invalid/i.test(apiCode + " " + message) || status === 401) {
    return fail("invalid_key", "API Key 无效或已过期，请在星使智算账户中心检查。");
  }
  if (status === 403 || /not authorized|permission|scope|无权/i.test(apiCode + " " + message)) {
    return fail("forbidden", "当前账号无法访问该项（平台返回 403）。", { status });
  }
  if (status === 404 || /not_found/i.test(apiCode)) {
    return fail("not_found", "平台没有返回该项，可能已删除或不属于当前账号。", { status });
  }
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|socket hang up|TLS|network|fetch failed|timed? ?out/i.test(message)) {
    return fail("network", "网络连接失败，已保留上次读到的内容。", { retryable: true });
  }
  return fail("platform", message, { status, retryable: true });
}

function taskId(value) {
  const id = String(value ?? "").trim();
  if (!TASK_ID.test(id)) throw new Error("请输入有效的任务编号。");
  return id;
}

function accountOf(data) {
  if (data?.id == null) throw new Error("平台未返回账号信息。");
  return {
    id: String(data.id),
    name: String(data.nickname || data.username || data.id),
    tier: typeof data.tier === "string" ? data.tier : String(data.tier?.name ?? ""),
    userType: typeof data.user_type === "string" ? data.user_type : "",
    verifiedAt: new Date().toISOString()
  };
}

// ---------------------------------------------------------------------------
// normalisation
// ---------------------------------------------------------------------------

/** Parse an ISO timestamp or a seconds/ms epoch into ISO; null when absent or invalid. */
function iso(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return null;
    const ms = value < 1e12 ? value * 1000 : value;
    return new Date(ms).toISOString();
  }
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function cleanTitle(raw, id) {
  let title = String(raw ?? "").trim();
  if (id && title.startsWith(id + "-")) title = title.slice(String(id).length + 1).trim();
  title = title.replace(/\s*任务$/, "").trim();
  return title || `任务 #${id}`;
}

function textOf(value, limit = 4000) {
  if (typeof value !== "string") return "";
  const text = value.trim();
  return text.length > limit ? text.slice(0, limit) + "…" : text;
}

function typeOf(value) {
  const type = String(value ?? "").toLowerCase();
  return type === "agent" || type === "kit" ? type : "unknown";
}

function toolboxOf(list = {}, detail = {}) {
  const raw = detail.toolbox;
  const record = raw && typeof raw === "object" ? raw : {};
  return {
    name: String(record.name ?? list.toolbox ?? list.toolbox_name ?? "") || null,
    displayName: String(
      record.display_name ?? list.toolbox_display_name ?? list.toolbox ?? ""
    ) || null,
    version: typeof record.version === "string" && record.version.trim() ? record.version.trim() : null,
    icon: typeof (list.toolbox_icon ?? record.icon) === "string" && (list.toolbox_icon ?? record.icon)
      ? String(list.toolbox_icon ?? record.icon)
      : null
  };
}

/**
 * Normalise one task row. Accepts both the platform payload and the client's
 * own list shape, because opening a row echoes that row back as `meta` and the
 * detail must not lose its creation time on the way.
 */
function listItem(task) {
  const id = String(task.task_id ?? task.id ?? "");
  if (!TASK_ID.test(id)) return null;
  const rawToolbox = task.toolbox && typeof task.toolbox === "object" ? task.toolbox : null;
  return {
    id,
    title: cleanTitle(task.title ?? task.name, id),
    type: typeOf(task.type),
    toolbox: rawToolbox
      ? {
          name: String(rawToolbox.name ?? "") || null,
          displayName: String(rawToolbox.displayName ?? rawToolbox.display_name ?? rawToolbox.name ?? "") || null,
          version: typeof rawToolbox.version === "string" && rawToolbox.version.trim() ? rawToolbox.version.trim() : null,
          icon: typeof rawToolbox.icon === "string" ? rawToolbox.icon : null
        }
      : toolboxOf(task),
    createdAt: iso(task.created_at ?? task.createdAt ?? task.timestamp),
    updatedAt: iso(task.updated_at ?? task.updatedAt),
    isThinking: typeof task.is_thinking === "boolean" ? task.is_thinking
      : typeof task.isThinking === "boolean" ? task.isThinking : null,
    diskUsed: typeof task.disk_used === "number" ? task.disk_used : null
  };
}

function stepError(step) {
  const candidates = [step.error, step.error_message, step.tool_data?.error, step.tool_data?.message];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return textOf(candidate, 800);
    if (candidate && typeof candidate === "object" && typeof candidate.message === "string" && candidate.message.trim()) {
      return textOf(candidate.message, 800);
    }
  }
  const job = String(step.slurm_job_status ?? "").toUpperCase();
  if (["FAILED", "CANCELLED", "TIMEOUT", "NODE_FAIL", "OUT_OF_MEMORY"].includes(job)) {
    return `Slurm 任务状态 ${job}`;
  }
  if (Number.isInteger(step.status) && step.status < 0) return `步骤状态 ${step.status}`;
  return null;
}

function stepOf(step) {
  const toolData = step.tool_data && typeof step.tool_data === "object" ? step.tool_data : null;
  const output = toolData?.structured_output;
  return {
    id: String(step.id ?? ""),
    name: String(step.display_name ?? step.tool_name ?? step.name ?? "步骤"),
    toolName: typeof step.tool_name === "string" ? step.tool_name : null,
    pipelineId: step.pipeline_id == null ? null : String(step.pipeline_id),
    statusRaw: Number.isInteger(step.status) ? step.status : null,
    jobStatus: typeof step.slurm_job_status === "string" ? step.slurm_job_status : null,
    createdAt: iso(step.created_at),
    startedAt: iso(step.started_at),
    endedAt: iso(step.ended_at),
    error: stepError(step),
    hasOutput: Boolean(output && typeof output === "object" && Object.keys(output).length)
  };
}

/**
 * A Kit task's only assistant message is the structured-output JSON blob. That
 * is machine output, not a readable reply, so it must not turn 「结果待核实」
 * into 「已有可读回复」. Only prose counts.
 */
function messagesOf(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const usable = list.filter((m) => m && typeof m === "object");
  const assistants = usable.filter((m) => m.role === "assistant" && textOf(m.content, 1).length > 0);
  const readable = assistants.filter((m) => {
    const text = textOf(m.content, 1).trimStart();
    return !text.startsWith("{") && !text.startsWith("[");
  });
  const last = readable.at(-1) ?? null;
  return {
    count: usable.length,
    assistantCount: assistants.length,
    lastAssistant: last
      ? {
          text: textOf(last.content, 4000),
          preview: textOf(last.content, 280),
          createdAt: iso(last.created_at)
        }
      : null,
    hasReadableReply: Boolean(last)
  };
}

/** Task files arrive as a list; directories are dropped, never downloaded. */
function filesOf(data) {
  const files = Array.isArray(data) ? data : data?.files ?? data?.items ?? [];
  return files
    .filter((file) => file?.id != null && file.type !== "directory" && !file.is_directory)
    .map((file) => ({
      id: String(file.id),
      name: String(file.name ?? file.id),
      visualization: visualizationOf(file),
      size: Number.isFinite(Number(file.size)) ? Number(file.size) : null,
      type: String(file.type ?? file.canonical_type ?? "").toLowerCase() || "file",
      path: typeof file.path === "string" ? file.path : null,
      createdAt: iso(file.created_at),
      updatedAt: iso(file.updated_at)
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
}

function versionSourceOf(source) {
  if (source === "version" || source === "current_version" || source === "toolbox_version") return "platform";
  if (source === "icon" || source === "demo") return source;
  return null;
}

function catalogEntry(item, type) {
  const version = typeof item.version === "string" && item.version.trim() ? item.version.trim() : null;
  return {
    name: String(item.name ?? ""),
    displayName: String(item.display_name ?? item.name ?? ""),
    type,
    version,
    versionSource: version ? versionSourceOf(item.version_source) : null,
    description: textOf(item.description, 240),
    tags: Array.isArray(item.tags) ? item.tags.filter((tag) => typeof tag === "string").slice(0, 12) : [],
    hasSchema: Boolean(item.has_schema ?? item.input_schema),
    demos: Number.isInteger(item.demos) ? item.demos : Array.isArray(item.demos) ? item.demos.length : 0
  };
}

function demosOf(schema) {
  const demos = Array.isArray(schema?.demos) ? schema.demos : [];
  return demos.slice(0, 12).map((demo) => ({
    name: String(demo?.name ?? "官方样例"),
    description: textOf(demo?.description, 200)
  }));
}

function schemaSummary(schema) {
  const input = schema?.input_schema ?? {};
  const fields = Array.isArray(input.fields) ? input.fields : [];
  return {
    formName: typeof input.formName === "string" ? input.formName : null,
    fields: fields.slice(0, 40).map((field) => ({
      name: String(field?.name ?? ""),
      label: String(field?.label ?? field?.name ?? ""),
      type: String(field?.type ?? ""),
      required: field?.validation?.required === true,
      options: Array.isArray(field?.options)
        ? field.options.slice(0, 12).map((option) => ({ label: String(option?.label ?? ""), value: option?.value }))
        : null
    })),
    demos: demosOf(schema)
  };
}

// ---------------------------------------------------------------------------
// service
// ---------------------------------------------------------------------------

class Workbench extends TypertRemoteService {
  constructor(ctx, options) {
    super(ctx, "afgoWorkbench");
    this.options = options;
    this.catalogCache = new Map();
  }

  async dispatch(input) {
    if (this.ctx.invocation?.peer.principal.kind !== "owner") {
      throw new Error("只有本 DSH 宿主的所有者可以操作星使智算。");
    }
    const { call, credential, baseUrl } = this.options;
    const credentials = this.ctx.credentials;
    switch (input.action) {
      case "connection":
        return ok({ baseUrl, env: environmentOf(baseUrl), ...(await credentials.describe(credential)) });
      case "connect": {
        const key = typeof input.key === "string" ? input.key.trim() : "";
        if (!key || key.length > 4096 || /\s/.test(key)) return fail("invalid_input", "请输入有效的 API Key。");
        const verified = await this.verify(key);
        if (!verified.ok) return verified;
        await credentials.set(credential, key);
        return verified;
      }
      case "verify":
        return this.verify();
      case "disconnect":
        await credentials.unset(credential);
        return ok({ removed: true });
      case "tasks":
        return this.tasks(input);
      case "task":
        return this.task(input);
      case "files":
        return this.files(input);
      case "download":
        return this.download(input);
      case "viewer":
        return ok({ html: await readFile(new URL("./structure-viewer.html", import.meta.url), "utf8") });
      case "catalog":
        return this.catalog(input);
      case "catalogEntry":
        return this.catalogEntry(input);
      case "sample":
        return this.sample();
      case "submitSample":
        return this.submitSample(input);
      default:
        return fail("unknown_action", "未知的工作台操作。");
    }
  }

  async verify(key) {
    try {
      return ok(accountOf(await this.options.call(["info"], key)));
    } catch (error) {
      const parsed = classify(error);
      if (parsed.error.code === "network") {
        return fail("network", "账号验证失败，请检查平台环境和网络连接。", { retryable: true });
      }
      return parsed;
    }
  }

  async tasks(input) {
    const type = typeOf(input.type) === "unknown" ? null : typeOf(input.type);
    const page = Number.isInteger(input.page) && input.page > 0 ? input.page : 1;
    const perPage = Number.isInteger(input.perPage) ? Math.min(Math.max(input.perPage, 5), 50) : 20;
    const keyword = typeof input.keyword === "string" ? input.keyword.trim().slice(0, 80) : "";
    const flags = [];
    if (type) flags.push("--type", type);
    if (keyword) flags.push("--keyword", keyword);
    flags.push("--page", String(page), "--per-page", String(perPage));
    try {
      const data = await this.options.call(["tasks", "list", ...flags]);
      const raw = Array.isArray(data?.tasks) ? data.tasks : [];
      const items = raw.map(listItem).filter(Boolean);
      const total = Number.isFinite(Number(data?.total)) ? Number(data.total) : null;
      const pages = Number.isFinite(Number(data?.pages)) ? Number(data.pages) : null;
      const hasMore = typeof data?.has_more === "boolean"
        ? data.has_more
        : pages != null ? page < pages : items.length >= perPage;
      return ok({ items, total, page, perPage, pages, hasMore, keyword, fetchedAt: new Date().toISOString() });
    } catch (error) {
      return classify(error);
    }
  }

  async task(input) {
    const id = taskId(input.id);
    try {
      // The detail endpoint carries steps and messages; the status endpoint is
      // the only place the scheduler object and its two timestamps can appear.
      const [detail, status] = await Promise.all([
        this.options.call(["tasks", "get", id]),
        this.options.call(["tasks", "status", id]).catch(() => null)
      ]);
      const meta = input.meta && typeof input.meta === "object" ? listItem(input.meta) : null;
      const resolvedMeta = meta ?? (await this.lookup(id));
      const steps = (Array.isArray(detail?.steps) ? detail.steps : []).map(stepOf);
      return ok({
        id,
        type: typeOf(detail?.type),
        isThinking: typeof detail?.is_thinking === "boolean" ? detail.is_thinking : null,
        toolbox: toolboxOf({}, detail),
        inputs: inputsOf(detail?.args),
        steps,
        messages: messagesOf(detail?.messages),
        scheduler: status && typeof status === "object"
          ? {
              jobStatus: typeof status.job_status === "string" ? status.job_status : null,
              submittedAt: iso(status.job_submitted_at),
              startedAt: iso(status.job_started_at),
              partition: typeof status.partition_info === "string" ? status.partition_info : null
            }
          : null,
        meta: resolvedMeta,
        fetchedAt: new Date().toISOString()
      });
    } catch (error) {
      const parsed = classify(error);
      if (parsed.error.code === "not_found") {
        return fail("not_found", `平台没有返回任务 #${id}：可能编号不存在、已被删除，或不属于当前账号。`);
      }
      return parsed;
    }
  }

  /**
   * Metadata for a manually typed id. Kit titles start with the id, so the
   * keyword lookup usually resolves in one call; agent titles do not, so fall
   * back to scanning the two most recent pages before giving up.
   */
  async lookup(id) {
    try {
      const byKeyword = await this.options.call(["tasks", "list", "--keyword", id, "--per-page", "5"]);
      const hit = (byKeyword?.tasks ?? []).map(listItem).find((task) => task?.id === id);
      if (hit) return hit;
    } catch { /* fall through to the page scan */ }
    for (const page of [1, 2]) {
      try {
        const data = await this.options.call(["tasks", "list", "--page", String(page), "--per-page", "100"]);
        const hit = (data?.tasks ?? []).map(listItem).find((task) => task?.id === id);
        if (hit) return hit;
        if (data?.has_more === false) break;
      } catch {
        break;
      }
    }
    return null;
  }

  async files(input) {
    const id = taskId(input.id);
    try {
      return ok({ files: filesOf(await this.options.call(["tasks", "files", id])), fetchedAt: new Date().toISOString() });
    } catch (error) {
      const parsed = classify(error);
      if (parsed.error.code === "not_found") {
        return fail("not_found", "平台没有返回这个任务的产物目录。", { taskId: id });
      }
      return parsed;
    }
  }

  async download(input) {
    const id = taskId(input.id);
    const fileId = typeof input.fileId === "string" ? input.fileId : "";
    try {
      const files = filesOf(await this.options.call(["tasks", "files", id]));
      const file = files.find((entry) => entry.id === fileId);
      if (!file) return fail("not_in_task", "该文件不在这个任务的产物清单里。");
      if (file.size != null && file.size > MAX_DOWNLOAD) {
        return fail("too_large", `此产物 ${formatBytes(file.size)}，超过当前 ${formatBytes(MAX_DOWNLOAD)} 的下载上限。`, {
          size: file.size, limit: MAX_DOWNLOAD, taskId: id, webUrl: WEB_ENTRY
        });
      }
      const dir = await mkdtemp(join(tmpdir(), "afgo-download-"));
      try {
        const path = join(dir, "artifact");
        await this.options.call([
          "cloud", "download", file.id, "-o", path, "--max-bytes", String(MAX_DOWNLOAD)
        ]);
        const buffer = await readFile(path);
        if (buffer.byteLength > MAX_DOWNLOAD) {
          return fail("too_large", "此产物超过当前下载上限。", {
            size: buffer.byteLength, limit: MAX_DOWNLOAD, taskId: id, webUrl: WEB_ENTRY
          });
        }
        return ok({
          name: basename(file.name.replaceAll("\\", "/")),
          type: file.type,
          size: buffer.byteLength,
          provenance: { taskId: id, fileId: file.id,
            sha256: createHash("sha256").update(buffer).digest("hex"), fetchedAt: new Date().toISOString() },
          previewable: buffer.byteLength <= MAX_PREVIEW && isPreviewType(file),
          content: buffer.toString("base64")
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    } catch (error) {
      if (error?.code === "ETIMEDOUT" || /max-bytes|too large|超过/i.test(String(error?.message))) {
        return fail("too_large", "此产物超过当前下载上限。", { limit: MAX_DOWNLOAD, taskId: id, webUrl: WEB_ENTRY });
      }
      return classify(error);
    }
  }

  async catalog(input) {
    const refresh = input.refresh === true;
    const cached = this.catalogCache.get("index");
    if (!refresh && cached && Date.now() - cached.at < CATALOG_TTL_MS) {
      return ok({ ...cached.value, cached: true });
    }
    try {
      const [kits, agents] = await Promise.all([
        this.options.call(["kits", "list"]),
        this.options.call(["agents"])
      ]);
      const entries = [
        ...(Array.isArray(kits?.kits) ? kits.kits : []).map((item) => catalogEntry(item, "kit")),
        ...(Array.isArray(agents?.agents) ? agents.agents : []).map((item) => catalogEntry(item, "agent"))
      ].filter((entry) => entry.name);
      // Same registered name can appear as both a Kit and an Agent (PySCF,
      // DSSP…); keep both, ordered by type then name.
      entries.sort((a, b) => a.name.localeCompare(b.name, "en") || a.type.localeCompare(b.type));
      const value = { entries, counts: countByType(entries), fetchedAt: new Date().toISOString() };
      this.catalogCache.set("index", { at: Date.now(), value });
      return ok({ ...value, cached: false });
    } catch (error) {
      return classify(error);
    }
  }

  async catalogEntry(input) {
    const name = typeof input.name === "string" ? input.name.trim().slice(0, 200) : "";
    const type = typeOf(input.type);
    if (!name || type === "unknown") return fail("invalid_input", "请选择要核对的目录条目。");
    const index = this.catalogCache.get("index")?.value;
    const entry = index?.entries?.find((item) => item.name === name && item.type === type) ?? null;
    if (type === "agent") {
      return ok({ entry, access: { state: "unknown", message: "Agent 目录无法在提交前核对调用权限，以实际提交结果为准。" }, schema: null });
    }
    try {
      const schema = await this.options.call(["kits", "schema", name]);
      return ok({ entry, access: { state: "granted", message: "当前账号可以读取该 Kit 的输入 schema。这只证明目录可读；提交权限仍由平台在提交时校验。" }, schema: schemaSummary(schema) });
    } catch (error) {
      const parsed = classify(error);
      if (parsed.error.code === "forbidden") {
        return ok({ entry, access: { state: "forbidden", message: "当前账号无法访问该项（平台返回 403）。目录会保留该条目，但调用会被拒绝。" }, schema: null });
      }
      if (parsed.error.code === "not_found") {
        return ok({ entry, access: { state: "missing", message: "平台没有注册这个 Kit，目录可能需要刷新。" }, schema: null });
      }
      return parsed;
    }
  }

  async sample() {
    try {
      const schema = await this.options.call(["kits", "schema", this.options.sampleTool]);
      const demo = (schema?.demos ?? []).find((entry) => entry?.name === this.options.sampleName);
      const input = demo?.value;
      const asset = input?.structure_file;
      if (input?.task_type !== "surface_energy" || input.miller_indices !== "1,1,0" ||
          typeof asset !== "string" ||
          !/^https:\/\/galileo\.obs\.cn-north-4\.myhuaweicloud\.com\/toolbox-demos\/prod\/[^/]+\/[\w.-]+\/TiO2\.cif$/.test(asset)) {
        return fail("sample_missing", "当前目录没有可验证的 TiO₂ 官方样例，请刷新后重试。");
      }
      const fingerprint = createHash("sha256")
        .update(JSON.stringify(input, Object.keys(input).sort()))
        .digest("hex");
      return ok({
        tool: this.options.sampleTool,
        title: this.options.sampleName,
        version: typeof schema.version === "string" ? schema.version : null,
        input,
        fingerprint,
        summary: Object.entries(input).map(([key, value]) => ({ key, value: String(value) }))
      });
    } catch (error) {
      return classify(error);
    }
  }

  async submitSample(input) {
    if (input.confirmed !== true) return fail("unconfirmed", "请先确认样例参数和生产提交。");
    const owner = await this.verify();
    if (!owner.ok) return owner;
    if (String(input.accountId ?? "") !== owner.data.id) {
      return fail("account_changed", "账号已切换，请重新核对样例后提交。");
    }
    const sample = await this.sample();
    if (!sample.ok) return sample;
    if (input.fingerprint !== sample.data.fingerprint) return fail("stale", "样例参数已更新，请重新打开预览。");
    try {
      const result = await this.options.call([
        "kits", "submit", "--kit", this.options.sampleTool, "--input", JSON.stringify(sample.data.input)
      ]);
      return ok({ id: taskId(result?.task_id ?? result?.taskId ?? result?.id) });
    } catch (error) {
      return fail("submit_unknown", `提交结果不明：${classify(error).error.message}`, {
        hint: "请先回到任务列表核对是否已有提交记录，再决定是否重新提交。"
      });
    }
  }
}

function environmentOf(baseUrl) {
  try {
    const host = new URL(baseUrl).host;
    if (/^sidereus-ai\.com$/i.test(host)) return { id: "production", label: "生产环境", host };
    if (/dev\./i.test(host)) return { id: "development", label: "开发环境", host };
    if (/^localhost|^127\./i.test(host)) return { id: "local", label: "本地环境", host };
    return { id: "custom", label: "自定义环境", host };
  } catch {
    return { id: "unknown", label: "未知环境", host: String(baseUrl) };
  }
}

function isPreviewType(file) {
  return ["csv", "tsv", "json", "md", "txt", "log", "yaml", "yml"].includes(file.type) ||
    /\.(csv|tsv|json|md|txt|log|ya?ml)$/i.test(file.name);
}

function formatBytes(value) {
  const size = Number(value);
  if (!Number.isFinite(size) || size < 0) return "未知大小";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MiB`;
}

function countByType(entries) {
  return entries.reduce((acc, entry) => {
    acc[entry.type] = (acc[entry.type] ?? 0) + 1;
    return acc;
  }, { kit: 0, agent: 0 });
}

export async function installWorkbench(ctx, options) {
  await ctx.plugin(Workbench, {
    sampleTool: options.sampleTool ?? "MACE-Flow-SurfaceInterface-Kit",
    sampleName: options.sampleName ?? "表面能计算（TiO2 110）",
    ...options
  });
  ctx.effect(() => ctx.typert.register({
    package: "afgo-dsh",
    face: "host",
    schemas: [],
    model: { services: [], events: [], objects: [] },
    invocations: [DESCRIPTOR]
  }));
}
