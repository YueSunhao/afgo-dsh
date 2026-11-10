import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";

const TOOL = "MACE-Flow-SurfaceInterface-Kit";
const SAMPLE = "表面能计算（TiO2 110）";
const MAX_DOWNLOAD = 4 * 1024 * 1024;
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

function taskId(value) {
  const id = String(value ?? "");
  if (!/^[1-9]\d{0,18}$/.test(id)) throw new Error("请输入有效的任务编号。");
  return id;
}

function account(data) {
  if (data?.id == null) throw new Error("平台未返回账号信息。");
  return { id: String(data.id), name: data.nickname || data.username || String(data.id),
    tier: typeof data.tier === "string" ? data.tier : data.tier?.name ?? "" };
}

function filesOf(data) {
  const files = Array.isArray(data) ? data : data?.files ?? data?.items ?? [];
  return files.filter((f) => f?.id != null && f.type !== "directory" && !f.is_directory)
    .map((f) => ({ id: String(f.id), name: String(f.name ?? f.id), size: f.size ?? null }));
}

class Workbench extends TypertRemoteService {
  constructor(ctx, options) {
    super(ctx, "afgoWorkbench");
    this.options = options;
  }

  async dispatch(input) {
    if (this.ctx.invocation?.peer.principal.kind !== "owner") {
      throw new Error("只有本 DSH 宿主的所有者可以操作星使智算。");
    }
    const { call, credential, baseUrl } = this.options;
    const credentials = this.ctx.credentials;
    switch (input.action) {
      case "connection":
        return { baseUrl, ...(await credentials.describe(credential)) };
      case "connect": {
        const key = typeof input.key === "string" ? input.key.trim() : "";
        if (!key || key.length > 4096 || /\s/.test(key)) throw new Error("请输入有效的 API Key。");
        const result = await this.verify(key);
        await credentials.set(credential, key);
        return result;
      }
      case "verify":
        return this.verify();
      case "disconnect":
        await credentials.unset(credential);
        return { removed: true };
      case "search": {
        const query = typeof input.query === "string" ? input.query.trim().slice(0, 160) : "";
        const flags = query ? [`--query=${query}`] : [];
        const [kits, agents] = await Promise.all([
          call(["kits", "list", ...flags, "--limit", "12"]),
          call(["agents", ...flags, "--limit", "12"])
        ]);
        return { kits: kits.kits ?? [], agents: agents.agents ?? [] };
      }
      case "sample":
        return this.sample();
      case "submitSample": {
        if (input.confirmed !== true) throw new Error("请先确认样例参数和生产提交。");
        const owner = await this.verify();
        if (input.accountId !== owner.id) throw new Error("账号已切换，请重新核对样例后提交。");
        const sample = await this.sample();
        if (input.fingerprint !== sample.fingerprint) throw new Error("样例参数已更新，请重新打开预览。");
        const result = await call(["kits", "submit", "--kit", TOOL, "--input", JSON.stringify(sample.input)]);
        return { id: taskId(result?.task_id ?? result?.taskId ?? result?.id) };
      }
      case "tasks": {
        const data = await call(["tasks", "list", "--type", "kit", "--per-page", "15"]);
        return (data?.tasks ?? []).map((t) => ({
          id: String(t.id ?? t.task_id ?? t.taskId ?? ""),
          title: String(t.title ?? t.name ?? t.toolbox ?? "Kit 任务"),
          createdAt: t.created_at ?? null
        })).filter((t) => /^[1-9]\d{0,18}$/.test(t.id));
      }
      case "task": {
        const id = taskId(input.id);
        const [detail, status, files] = await Promise.all([
          call(["tasks", "get", id]),
          call(["tasks", "status", id]),
          call(["tasks", "files", id]).then(filesOf, () => null)
        ]);
        return {
          id, outcome: detail.outcome ?? null,
          active: status.is_thinking ?? detail.is_thinking ?? null,
          steps: (detail.steps ?? []).map((s) => ({
            id: String(s.id ?? ""), state: s.slurm_job_status ?? s.status ?? null
          })),
          files
        };
      }
      case "download":
        return this.download(taskId(input.id), input.fileId);
      default:
        throw new Error("未知的工作台操作。");
    }
  }

  async verify(key) {
    try {
      return account(await this.options.call(["info"], key));
    } catch (error) {
      const message = String(error.message);
      if (/invalid_token|expired|令牌无效|HTTP 401/i.test(message)) {
        throw new Error("API Key 无效或已过期，请在星使智算账户中心检查。");
      }
      if (/403|permission|scope/i.test(message)) throw new Error("当前 Key 无权读取账号信息。");
      throw new Error("账号验证失败，请检查 API Key、平台环境和网络连接。");
    }
  }

  async sample() {
    const schema = await this.options.call(["kits", "schema", TOOL]);
    const demo = schema.demos?.find((entry) => entry.name === SAMPLE);
    const input = demo?.value;
    const asset = input?.structure_file;
    if (input?.task_type !== "surface_energy" || input.miller_indices !== "1,1,0" ||
        typeof asset !== "string" ||
        !/^https:\/\/galileo\.obs\.cn-north-4\.myhuaweicloud\.com\/toolbox-demos\/prod\/MACE-Flow-SurfaceInterface-Kit\/[\w.-]+\/TiO2\.cif$/.test(asset)) {
      throw new Error("当前目录没有可验证的 TiO₂ 官方样例，请刷新后重试。");
    }
    const fingerprint = createHash("sha256").update(JSON.stringify(input, Object.keys(input).sort())).digest("hex");
    return { tool: TOOL, title: SAMPLE, version: schema.version ?? null, input, fingerprint };
  }

  async download(id, fileId) {
    const { call } = this.options;
    const files = filesOf(await call(["tasks", "files", id]));
    const file = files.find((f) => f.id === fileId);
    if (!file || !/^[a-zA-Z0-9_+=-]{1,300}$/.test(file.id)) throw new Error("文件不在此任务的产物清单中。");
    if (Number(file.size) > MAX_DOWNLOAD) throw new Error("此产物超过 4 MiB，请在星使智算网页端下载。");
    const dir = await mkdtemp(join(tmpdir(), "afgo-download-"));
    try {
      const path = join(dir, "artifact");
      await call(["cloud", "download", file.id, "-o", path, "--max-bytes", String(MAX_DOWNLOAD)]);
      return { name: basename(file.name.replaceAll("\\", "/")), content: (await readFile(path)).toString("base64") };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

export async function installWorkbench(ctx, options) {
  await ctx.plugin(Workbench, options);
  ctx.effect(() => ctx.typert.register({
    package: "afgo-dsh",
    face: "host",
    schemas: [],
    model: { services: [], events: [], objects: [] },
    invocations: [DESCRIPTOR]
  }));
}
