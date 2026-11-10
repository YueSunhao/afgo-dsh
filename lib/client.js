/**
 * afgo-dsh workbench — client half (AsterFire Go 工作台 v2).
 *
 * Rendered inside the plugin detail page through `plugins.bundle.config`. The
 * page answers four questions in order: which account is connected, what the
 * last task was, where it is stuck, and where the result is.
 *
 * Three rules shape this file:
 *
 *  1. The platform never shows a task list with a result verdict, so a row that
 *     has not been opened says 「待查询」 — the list never fans out one detail
 *     request per row.
 *  2. Execution state, result verdict and sync state are three separate
 *     signals, and each one degrades on its own.
 *  3. Only timestamps the platform actually returned are drawn. A missing
 *     field shows a dash; nothing is inferred from step counts or from a list
 *     `updated_at`.
 *
 * The pure helpers at the top are exported through `__test` so Node can verify
 * search ranking, verdict logic, timeline degradation and CSV parsing without a
 * browser (tests/workbench_client.test.mjs).
 */
window.__ModuleLoader__.load({
  id: "afgo-dsh",
  factory(require) {
    const React = require("react");
    const {
      createElement: h, useCallback, useEffect, useMemo, useRef, useState
    } = React;

    const PLUGIN_VERSION = "1.3.0";
    const SAMPLE_TOOL = "MACE-Flow-SurfaceInterface-Kit";
    const SAMPLE_NAME = "表面能计算（TiO2 110）";
    const CREDENTIAL_GUIDE = "https://sidereus-ai.feishu.cn/wiki/X5BEw6SoqiKm8Yko5CtcgnBVnzk#doxcnenOw78qn5uYgkJnfACUw6b";
    const WEB_ENTRY = "https://sidereus-ai.com";
    const MAX_DOWNLOAD = 4 * 1024 * 1024;
    const POLL_ACTIVE_MS = 6000;
    const POLL_ERROR_MS = 12000;
    const CATALOG_TTL_MS = 10 * 60 * 1000;
    const LAST_TASK_LIMIT = 100;
    const PREVIEW_LIMIT = 256 * 1024;

    // ------------------------------------------------------------------
    // storage (all optional: a blocked localStorage must not break the page)
    // ------------------------------------------------------------------

    const store = {
      read(key, fallback) {
        try {
          const raw = localStorage.getItem(key);
          return raw == null ? fallback : JSON.parse(raw);
        } catch {
          return fallback;
        }
      },
      write(key, value) {
        try {
          localStorage.setItem(key, JSON.stringify(value));
          return true;
        } catch {
          return false;
        }
      },
      remove(key) {
        try { localStorage.removeItem(key); } catch { /* storage is optional */ }
      }
    };

    function scopedKey(connection, account, name) {
      const env = String(connection?.baseUrl ?? "env");
      const who = String(account?.id ?? "anonymous");
      return `afgo.v2.${name}.${env}.${who}`;
    }

    // ------------------------------------------------------------------
    // time / formatting
    // ------------------------------------------------------------------

    function parseTime(value) {
      if (typeof value !== "string" || !value.trim()) return null;
      const ms = Date.parse(value);
      return Number.isNaN(ms) ? null : ms;
    }

    function formatBytes(value) {
      if (value == null || value === "") return "大小未知";
      const size = Number(value);
      if (!Number.isFinite(size) || size < 0) return "大小未知";
      if (size < 1024) return `${size} B`;
      if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
      return `${(size / (1024 * 1024)).toFixed(1)} MiB`;
    }

    function formatDuration(ms) {
      if (!Number.isFinite(ms) || ms < 0) return "—";
      if (ms < 1000) return `${Math.round(ms)} 毫秒`;
      const seconds = ms / 1000;
      if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} 秒`;
      const minutes = Math.floor(seconds / 60);
      const rest = Math.round(seconds % 60);
      if (minutes < 60) return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分`;
      const hours = Math.floor(minutes / 60);
      return `${hours} 小时 ${minutes % 60} 分`;
    }

    function pad2(value) { return String(value).padStart(2, "0"); }

    function clockOf(ms) {
      if (!Number.isFinite(ms)) return "—";
      const date = new Date(ms);
      return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
    }

    function dateTimeOf(iso) {
      const ms = parseTime(iso);
      if (ms == null) return "未返回";
      const date = new Date(ms);
      return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ` +
        `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
    }

    function shortDateOf(iso) {
      const ms = parseTime(iso);
      if (ms == null) return "时间未返回";
      const date = new Date(ms);
      const today = new Date();
      const sameDay = date.toDateString() === today.toDateString();
      const time = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
      if (sameDay) return time;
      const sameYear = date.getFullYear() === today.getFullYear();
      const day = `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
      return sameYear ? `${day} ${time}` : `${date.getFullYear()}-${day} ${time}`;
    }

    function relativeOf(iso, now = Date.now()) {
      const ms = parseTime(iso);
      if (ms == null) return "时间未返回";
      const diff = now - ms;
      if (diff < 0) return "刚刚";
      if (diff < 45 * 1000) return "刚刚";
      if (diff < 60 * 60 * 1000) return `${Math.round(diff / 60000)} 分钟前`;
      if (diff < 24 * 60 * 60 * 1000) return `${Math.round(diff / 3600000)} 小时前`;
      if (diff < 30 * 24 * 60 * 60 * 1000) return `${Math.round(diff / 86400000)} 天前`;
      return shortDateOf(iso);
    }

    // ------------------------------------------------------------------
    // search (NFKC + case folding, exact match first)
    // ------------------------------------------------------------------

    function normalizeSearch(value) {
      return String(value ?? "")
        .normalize("NFKC")
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim();
    }

    /**
     * Rank one catalog entry against a query. 0/1 are the exact registered and
     * display names, so `PySCF` outranks `GPU4PySCF`; null means no hit.
     * Mirrors the ranking the bundled CLI applies on the host.
     */
    function rankCatalog(entry, query) {
      const q = normalizeSearch(query);
      if (!q) return 0;
      const name = normalizeSearch(entry.name);
      const display = normalizeSearch(entry.displayName);
      if (q === name) return 0;
      if (q === display) return 1;
      if (name.startsWith(q) || display.startsWith(q)) return 2;
      if (name.includes(q) || display.includes(q)) return 3;
      const haystack = normalizeSearch([entry.description, ...(entry.tags ?? [])].join(" "));
      return haystack.includes(q) ? 4 : null;
    }

    function searchCatalog(entries, query, kind = "all") {
      const pool = kind === "all" ? entries : entries.filter((entry) => entry.type === kind);
      const ranked = [];
      for (const entry of pool) {
        const rank = rankCatalog(entry, query);
        if (rank != null) ranked.push({ entry, rank });
      }
      ranked.sort((a, b) => a.rank - b.rank ||
        a.entry.displayName.length - b.entry.displayName.length ||
        a.entry.name.localeCompare(b.entry.name, "en") ||
        a.entry.type.localeCompare(b.entry.type));
      return ranked.map((item) => item.entry);
    }

    // ------------------------------------------------------------------
    // task signals: execution, verdict, sync
    // ------------------------------------------------------------------

    function executionOf(task) {
      const steps = Array.isArray(task?.steps) ? task.steps : [];
      const ended = steps.filter((step) => parseTime(step.endedAt) != null).length;
      if (task?.isThinking === true) {
        const queued = steps.some((step) => !parseTime(step.startedAt) && String(step.jobStatus ?? "").toUpperCase() === "PENDING");
        return queued
          ? { state: "queued", label: "排队中", detail: `${steps.length - ended}/${steps.length} 个步骤等待开始` }
          : { state: "running", label: "运行中", detail: `${ended}/${steps.length || 1} 个步骤已结束` };
      }
      if (task?.isThinking === false) {
        if (!steps.length) return { state: "stopped", label: "已停止", detail: "平台没有返回步骤记录" };
        const allEnded = ended === steps.length;
        const allCompleted = steps.every((step) => String(step.jobStatus ?? "").toUpperCase() === "COMPLETED");
        if (allEnded && allCompleted) return { state: "done", label: "已完成", detail: `${steps.length}/${steps.length} 个步骤结束` };
        if (allEnded) {
          const unsuccessful = steps.filter((step) => String(step.jobStatus ?? "").toUpperCase() !== "COMPLETED").length;
          return { state: "stopped", label: "已停止", detail: `${unsuccessful} 个步骤未成功结束` };
        }
        return { state: "stopped", label: "已停止", detail: `${ended}/${steps.length} 个步骤结束` };
      }
      return { state: "unknown", label: "未知", detail: "平台没有返回执行状态" };
    }

    /**
     * Result verdict, derived from step evidence only. `unknown` is not a
     * failure: a PySCF agent can answer −76.46 Hartree while the platform
     * returns no structured success flag, so the UI must say 「待核实」 and
     * point at the readable reply.
     */
    function verdictOf(task) {
      const steps = Array.isArray(task?.steps) ? task.steps : [];
      const evidence = [];
      let successReason = null;
      for (const step of steps) {
        const failures = [];
        const job = String(step.jobStatus ?? "").toUpperCase();
        if (["FAILED", "CANCELLED", "TIMEOUT", "NODE_FAIL", "OUT_OF_MEMORY"].includes(job)) failures.push(`slurm=${job}`);
        if (Number.isInteger(step.statusRaw) && step.statusRaw < 0) failures.push(`step_status=${step.statusRaw}`);
        if (step.error) failures.push(step.error);
        if (failures.length) evidence.push(...failures);
        else if (step.hasOutput) successReason = successReason ?? `步骤 ${step.id || step.name} 返回结构化输出`;
      }
      const running = task?.isThinking === true;
      if (running) return { state: "running", label: "运行中", reason: "任务仍在执行，还没有结果判定。", evidence };
      if (evidence.length) {
        return {
          state: successReason ? "partial" : "failed",
          label: successReason ? "部分完成" : "失败",
          reason: successReason ? `部分步骤有成功证据，但存在失败步骤：${evidence.join("、")}` : evidence.join("、"),
          evidence
        };
      }
      if (successReason) return { state: "success", label: "成功", reason: successReason, evidence };
      return {
        state: "unknown",
        label: "待核实",
        reason: task?.messages?.hasReadableReply
          ? "平台没有返回结构化成功信号，但已有可读回复；结论请以回复为准。"
          : "平台没有返回结构化成功信号，也没有可读回复。",
        evidence
      };
    }

    function statusOfRow(item, summary) {
      if (item?.isThinking === true) return { state: "running", label: "执行中" };
      if (summary?.verdict) return { state: summary.verdict, label: summary.verdictLabel ?? "已结束" };
      return { state: "unresolved", label: "待查询" };
    }

    // ------------------------------------------------------------------
    // timeline
    // ------------------------------------------------------------------

    function segment(fromIso, toIso) {
      const from = parseTime(fromIso);
      const to = parseTime(toIso);
      if (from == null || to == null) return null;
      if (to < from) return { invalid: true, from, to, ms: null };
      return { from, to, ms: to - from };
    }

    /**
     * Build a proportional timeline from the timestamps that exist.
     *
     * Each step can carry a queue segment (created_at → started_at) and an
     * execution segment (started_at → ended_at). A step with one timestamp is
     * a point; a step with none is listed without a bar. `totalMs` is only
     * offered when every step belongs to one pipeline, i.e. there is a
     * same-level start and end to subtract.
     */
    function timelineOf(task) {
      const steps = Array.isArray(task?.steps) ? task.steps : [];
      const rows = steps.map((step, index) => {
        const queue = segment(step.createdAt, step.startedAt);
        const run = segment(step.startedAt, step.endedAt);
        const created = parseTime(step.createdAt);
        const started = parseTime(step.startedAt);
        const ended = parseTime(step.endedAt);
        const warnings = [];
        if (queue?.invalid) warnings.push("开始时间早于提交时间");
        if (run?.invalid) warnings.push("结束时间早于开始时间");
        const stamps = [created, started, ended].filter((value) => value != null);
        const point = !run && !queue ? (stamps.length ? Math.min(...stamps) : null) : null;
        return {
          step,
          index,
          queue: queue && !queue.invalid && queue.ms > 500 ? queue : null,
          run: run && !run.invalid && run.ms >= 0 ? run : null,
          point,
          queueMs: queue && !queue.invalid ? queue.ms : null,
          runMs: run && !run.invalid ? run.ms : null,
          startMs: started ?? created,
          endMs: ended ?? started,
          warnings,
          hasTime: stamps.length > 0
        };
      });
      const stamps = rows.flatMap((row) => [
        row.queue?.from, row.run?.from, row.run?.to, row.point
      ]).filter((value) => Number.isFinite(value));
      const hasTime = stamps.length > 0;
      const from = hasTime ? Math.min(...stamps) : null;
      const to = hasTime ? Math.max(...stamps) : null;
      const span = hasTime && to > from ? to - from : 0;
      for (const row of rows) {
        const start = row.queue?.from ?? row.run?.from ?? row.point;
        const end = row.run?.to ?? row.queue?.to ?? row.point;
        row.left = span && start != null ? ((start - from) / span) * 100 : 0;
        row.width = span && start != null && end != null && end > start
          ? Math.max(1.2, ((end - start) / span) * 100)
          : 0;
        row.queueLeft = span && row.queue ? ((row.queue.from - from) / span) * 100 : 0;
        row.queueWidth = span && row.queue ? Math.max(1.2, (row.queue.ms / span) * 100) : 0;
        row.runLeft = span && row.run ? ((row.run.from - from) / span) * 100 : 0;
        row.runWidth = span && row.run ? Math.max(1.2, Math.min(100, (row.run.ms / span) * 100)) : 0;
        row.pointLeft = span && row.point != null ? ((row.point - from) / span) * 100 : 0;
      }
      const ticks = span
        ? [0, 1 / 3, 2 / 3, 1].map((ratio) => ({ ratio, at: from + span * ratio }))
        : [];
      const pipelines = new Set(steps.map((step) => step.pipelineId).filter(Boolean));
      const totalMs = span && pipelines.size <= 1 ? span : null;
      return { rows, hasTime, span, from, to, ticks, totalMs, mode: span ? "scale" : "list" };
    }

    function eventsOf(task) {
      const rows = Array.isArray(task?.steps) ? task.steps : [];
      const events = [];
      for (const step of rows) {
        const label = step.name || `步骤 ${step.id}`;
        if (step.createdAt) events.push({ at: step.createdAt, kind: "提交", text: `${label} 提交`, source: "step.created_at" });
        if (step.startedAt) events.push({ at: step.startedAt, kind: "开始", text: `${label} 开始执行`, source: "step.started_at" });
        if (step.endedAt) events.push({ at: step.endedAt, kind: "结束", text: `${label} 结束`, source: "step.ended_at" });
      }
      if (task?.messages?.lastAssistant?.createdAt) {
        events.push({ at: task.messages.lastAssistant.createdAt, kind: "回复", text: "最后一条可读回复", source: "message.created_at" });
      }
      return events
        .filter((event) => parseTime(event.at) != null)
        .sort((a, b) => parseTime(a.at) - parseTime(b.at));
    }

    // ------------------------------------------------------------------
    // artifacts
    // ------------------------------------------------------------------

    const PRIMARY_RULES = [
      { tool: "MACE-Flow-SurfaceInterface-Kit", file: "surface_energies.csv", note: "表面能主表" },
      { tool: "DSSP", file: "dssp_summary.json", note: "二级结构汇总" }
    ];

    function primaryFileName(toolboxName) {
      const name = String(toolboxName ?? "");
      const rule = PRIMARY_RULES.find((entry) => entry.tool === name);
      return rule ? rule.file : null;
    }

    function primaryFileOf(toolboxName, files) {
      const target = primaryFileName(toolboxName);
      if (!target) return null;
      return (files ?? []).find((file) => file.name === target) ?? null;
    }

    function fileKind(file) {
      const type = String(file?.type ?? "").toLowerCase();
      if (type === "csv" || type === "tsv") return "table";
      if (type === "json") return "json";
      if (["md", "txt", "log"].includes(type)) return "text";
      return "binary";
    }

    /** Minimal RFC4180 parser: quotes, doubled quotes, CRLF, BOM. */
    function parseCsv(text, limitRows = 40) {
      let input = String(text ?? "");
      if (input.charCodeAt(0) === 0xfeff) input = input.slice(1);
      const rows = [];
      let row = [];
      let field = "";
      let quoted = false;
      let index = 0;
      let truncated = false;
      while (index < input.length) {
        const char = input[index];
        if (quoted) {
          if (char === "\"") {
            if (input[index + 1] === "\"") { field += "\""; index += 2; continue; }
            quoted = false; index += 1; continue;
          }
          field += char; index += 1; continue;
        }
        if (char === "\"") { quoted = true; index += 1; continue; }
        if (char === ",") { row.push(field); field = ""; index += 1; continue; }
        if (char === "\r") { index += 1; continue; }
        if (char === "\n") {
          row.push(field); rows.push(row); row = []; field = ""; index += 1;
          if (rows.length >= limitRows) { truncated = true; break; }
          continue;
        }
        field += char; index += 1;
      }
      if (!truncated && (field.length || row.length)) { row.push(field); rows.push(row); }
      return { rows, truncated };
    }

    function decodeBase64Text(content) {
      const binary = atob(String(content ?? ""));
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    }

    function saveDownload(file) {
      const binary = atob(String(file.content ?? ""));
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      const blob = new Blob([bytes], { type: file.mime || "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = file.name || "asterfire-result";
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    }

    // ------------------------------------------------------------------
    // version provenance
    // ------------------------------------------------------------------

    function versionText(entry, historyVersion) {
      if (entry?.version) {
        const source = entry.versionSource;
        if (source === "platform") return { text: `v${entry.version}`, source: "平台返回" };
        if (source === "demo") return { text: `v${entry.version}`, source: "样例路径推断" };
        if (source === "icon") return { text: `v${entry.version}`, source: "图标路径推断" };
        return { text: `v${entry.version}`, source: "来源未知" };
      }
      if (historyVersion) return { text: `v${historyVersion}`, source: "历史任务" };
      return { text: "版本未知", source: "目录未返回" };
    }

    // ------------------------------------------------------------------
    // styles
    // ------------------------------------------------------------------

    const styles = `
      .afgo2 { display:flex; flex-direction:column; gap:16px; margin:12px 0; min-width:0;
        color:var(--dsw-alias-label-primary, #0f1115);
        font-family:var(--dsh-font-family-text, inherit); font-size:14px; line-height:1.55; }
      .afgo2 *, .afgo2 *::before, .afgo2 *::after { box-sizing:border-box; }
      .afgo2 h2, .afgo2 h3, .afgo2 h4, .afgo2 p { margin:0; }
      .afgo2 ul, .afgo2 ol { margin:0; padding:0; list-style:none; }
      .afgo2 button, .afgo2 input, .afgo2 select { font:inherit; color:inherit; }
      .afgo2 button { background:transparent; border:1px solid var(--dsw-alias-border-l3, #0000001f);
        border-radius:8px; min-height:32px; padding:5px 12px; cursor:pointer; }
      .afgo2 button:hover:not(:disabled) { background:var(--dsw-alias-interactive-bg-hover, #2631480f); }
      .afgo2 button:disabled { opacity:.5; cursor:not-allowed; }
      .afgo2 button[data-variant=primary] { background:var(--dsw-alias-button-primary-fill, #0f1115);
        border-color:transparent; color:var(--dsw-alias-label-primary-foreground, #fff); }
      .afgo2 button[data-variant=ghost] { border-color:transparent; }
      .afgo2 button[data-variant=link] { border:0; padding:0; min-height:0; color:var(--dsw-alias-link, #4176e6); text-decoration:underline; }
      .afgo2 a { color:var(--dsw-alias-link, #4176e6); }
      .afgo2 a:focus-visible, .afgo2 button:focus-visible, .afgo2 input:focus-visible,
      .afgo2 select:focus-visible, .afgo2 [tabindex]:focus-visible {
        outline:2px solid var(--dsw-alias-link, #4176e6); outline-offset:2px; }
      .afgo2 input, .afgo2 select { background:var(--dsw-alias-bg-base, #fff);
        border:1px solid var(--dsw-alias-border-l3, #0000001f); border-radius:8px;
        min-height:32px; padding:5px 10px; min-width:0; max-width:100%; }
      .afgo2-muted { color:var(--dsw-alias-label-secondary, #61666b); }
      .afgo2-caption { color:var(--dsw-alias-label-caption, #9aa0a6); font-size:12px; }
      .afgo2-mono { font-family:var(--dsh-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace); }
      .afgo2-wrap { overflow-wrap:anywhere; word-break:break-word; min-width:0; }
      .afgo2-card { background:var(--dsw-alias-bg-layer-1, transparent);
        border:1px solid var(--dsw-alias-border-l2, #0000001a); border-radius:12px; min-width:0; }
      .afgo2-chip { display:inline-flex; align-items:center; gap:6px; padding:1px 8px; border-radius:999px;
        font-size:12px; line-height:18px; white-space:nowrap; border:1px solid var(--dsw-alias-border-l2, #0000001a);
        background:var(--dsw-alias-bg-layer-2, #f7f8fa); color:var(--dsw-alias-label-secondary, #61666b); }
      .afgo2-chip[data-tone=ok] { background:var(--dsw-alias-state-success-tertiary, #e6faed); border-color:transparent;
        color:var(--dsw-alias-state-success-primary, #12863c); }
      .afgo2-chip[data-tone=warn] { background:var(--dsw-alias-state-warn-tertiary, #fef5e7); border-color:transparent;
        color:var(--dsw-alias-state-warn-label, #a35b0b); }
      .afgo2-chip[data-tone=err] { background:var(--dsw-alias-state-error-tertiary, #fee2e2); border-color:transparent;
        color:var(--dsw-alias-state-error-primary, #ec1313); }
      .afgo2-chip[data-tone=plain] { background:transparent; }
      .afgo2-dot { width:8px; height:8px; border-radius:50%; flex:none; background:var(--dsw-alias-label-caption, #adb2b8); }
      .afgo2-dot[data-tone=ok] { background:var(--dsw-alias-state-success-primary, #22c55e); }
      .afgo2-dot[data-tone=warn] { background:var(--dsw-alias-state-warn-primary, #f59e0b); }
      .afgo2-dot[data-tone=err] { background:var(--dsw-alias-state-error-primary, #ec1313); }
      .afgo2-notice { display:flex; gap:8px; align-items:flex-start; padding:8px 12px; border-radius:8px;
        font-size:13px; border:1px solid transparent; }
      .afgo2-notice[data-tone=warn] { background:var(--dsw-alias-state-warn-tertiary, #fef5e7);
        color:var(--dsw-alias-state-warn-label, #a35b0b); }
      .afgo2-notice[data-tone=err] { background:var(--dsw-alias-state-error-tertiary, #fee2e2);
        color:var(--dsw-alias-state-error-primary, #ec1313); }
      .afgo2-notice[data-tone=info] { background:var(--dsw-alias-bg-layer-2, #f7f8fa);
        color:var(--dsw-alias-label-secondary, #61666b); }
      .afgo2-conn { display:flex; align-items:center; gap:10px; flex-wrap:wrap; padding:10px 12px;
        border-radius:10px; background:var(--dsw-alias-bg-layer-2, #f7f8fa);
        border:1px solid var(--dsw-alias-border-l1, #0000000a); }
      .afgo2-conn .afgo2-who { font-weight:600; min-width:0; }
      .afgo2-conn .afgo2-spacer { flex:1 1 24px; }
      .afgo2-env { display:flex; gap:6px; align-items:center; flex-wrap:wrap; font-size:12px;
        color:var(--dsw-alias-label-tertiary, #81858c); }
      .afgo2-actions { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
      .afgo2-topbar { position:sticky; top:0; z-index:8; display:flex; flex-direction:column; gap:10px;
        background:var(--dsw-alias-bg-base, #fff); padding:2px 0 8px; }
      #afgo-task-list-anchor { scroll-margin-top:120px; }
      .afgo2-tabs { display:flex; gap:2px; border-bottom:1px solid var(--dsw-alias-border-l2, #0000001a); }
      .afgo2-tab { border:0 !important; border-radius:0 !important; border-bottom:2px solid transparent !important;
        padding:8px 12px !important; color:var(--dsw-alias-label-secondary, #61666b); background:transparent; min-height:36px; }
      .afgo2-tab[aria-selected=true] { color:var(--dsw-alias-label-primary, #0f1115) !important;
        border-bottom-color:var(--dsw-alias-label-primary, #0f1115) !important; font-weight:600; }
      .afgo2-tab:hover { background:transparent !important; color:var(--dsw-alias-label-primary, #0f1115) !important; }
      .afgo2-head { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; flex-wrap:wrap; }
      .afgo2-title { font-size:16px; font-weight:600; line-height:1.4; overflow-wrap:anywhere; }
      .afgo2-detail-head .afgo2-title { display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden; }
      .afgo2-sub { font-size:12px; color:var(--dsw-alias-label-tertiary, #81858c); }
      .afgo2-tasks { display:grid; grid-template-columns:minmax(280px, 360px) minmax(0, 1fr);
        gap:16px; align-items:start; min-width:0; }
      .afgo2-listpane, .afgo2-detailpane { display:flex; flex-direction:column; gap:10px; min-width:0; }
      .afgo2-filters { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
      .afgo2-filters input { flex:1 1 140px; }
      .afgo2-list { display:flex; flex-direction:column; gap:2px; padding:4px;
        max-height:min(64vh, 620px); overflow:auto; }
      .afgo2-row { display:grid; grid-template-columns:auto minmax(0,1fr); gap:10px; text-align:left;
        align-items:flex-start; border:1px solid transparent !important; background:transparent;
        border-radius:10px; padding:10px; min-height:0; }
      .afgo2-row[aria-current=true] { background:var(--dsw-alias-bg-layer-2, #f7f8fa);
        border-color:var(--dsw-alias-border-l2, #0000001a) !important; }
      .afgo2-row-title { font-weight:600; font-size:13px; line-height:1.45; overflow-wrap:anywhere;
        display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
      .afgo2-row-meta { display:flex; gap:6px; align-items:center; flex-wrap:wrap; margin-top:4px;
        font-size:12px; color:var(--dsw-alias-label-tertiary, #81858c); min-width:0; }
      .afgo2-row-meta .afgo2-mono { overflow-wrap:anywhere; }
      .afgo2-status-strip { display:grid; grid-template-columns:repeat(auto-fit, minmax(150px, 1fr));
        gap:8px; padding:12px 16px; border-top:1px solid var(--dsw-alias-border-l1, #0000000a); }
      .afgo2-status { display:flex; flex-direction:column; gap:2px; padding:8px 10px; border-radius:8px;
        background:var(--dsw-alias-bg-layer-2, #f7f8fa); min-width:0; }
      .afgo2-status .k { font-size:11px; color:var(--dsw-alias-label-caption, #9aa0a6); }
      .afgo2-status .v { font-weight:600; display:flex; align-items:center; gap:6px; font-size:13px; }
      .afgo2-status .h { font-size:12px; color:var(--dsw-alias-label-tertiary, #81858c); overflow-wrap:anywhere; }
      .afgo2-detail-head { display:flex; flex-direction:column; gap:8px; padding:14px 16px; }
      .afgo2-meta { display:grid; grid-template-columns:repeat(auto-fit, minmax(170px, 1fr)); gap:8px 16px; }
      .afgo2-meta div { min-width:0; }
      .afgo2-meta b { display:block; font-size:11px; font-weight:500; color:var(--dsw-alias-label-caption, #9aa0a6); }
      .afgo2-meta span { display:block; font-size:12px; color:var(--dsw-alias-label-secondary, #61666b); overflow-wrap:anywhere; }
      .afgo2-section { display:flex; flex-direction:column; min-width:0; }
      .afgo2-section-head { display:flex; align-items:center; justify-content:space-between; gap:8px;
        padding:10px 16px; border-bottom:1px solid var(--dsw-alias-border-l1, #0000000a); flex-wrap:wrap; }
      .afgo2-section-head h3 { font-size:13px; font-weight:600; }
      .afgo2-body { padding:12px 16px; display:flex; flex-direction:column; gap:10px; min-width:0; }
      .afgo2-kv { display:grid; grid-template-columns:minmax(120px, 38%) minmax(0,1fr); gap:4px 12px; font-size:13px; }
      .afgo2-kv dt { color:var(--dsw-alias-label-tertiary, #81858c); }
      .afgo2-kv dd { margin:0; overflow-wrap:anywhere; }
      .afgo2-tl { display:flex; flex-direction:column; padding:8px 16px 12px; gap:2px; }
      .afgo2-axis { display:grid; grid-template-columns:minmax(140px, 38%) minmax(0,1fr) 96px; gap:12px;
        padding:4px 0; font-size:11px; color:var(--dsw-alias-label-caption, #9aa0a6); }
      .afgo2-ticks { display:flex; justify-content:space-between; gap:4px; }
      .afgo2-tl-row { display:grid; grid-template-columns:minmax(140px, 38%) minmax(0,1fr) 96px;
        gap:12px; align-items:center; padding:8px 0; border-top:1px solid var(--dsw-alias-border-l1, #0000000a); }
      .afgo2-tl-name { display:flex; flex-direction:column; gap:1px; min-width:0; }
      .afgo2-tl-name b { font-size:13px; overflow-wrap:anywhere; }
      .afgo2-tl-name span { font-size:11px; color:var(--dsw-alias-label-caption, #9aa0a6); overflow-wrap:anywhere; }
      .afgo2-track { position:relative; height:26px; border-radius:6px;
        background:var(--dsw-alias-bg-layer-2, #f7f8fa); overflow:hidden; }
      .afgo2-track .tick { position:absolute; top:0; bottom:0; width:1px;
        background:var(--dsw-alias-border-l2, #0000001a); }
      .afgo2-bar { position:absolute; top:7px; height:12px; border-radius:3px;
        background:var(--dsw-alias-state-success-secondary, #4ed17e); }
      .afgo2-bar[data-kind=queue] { top:8px; height:10px; background:transparent;
        border:1px dashed var(--dsw-alias-border-l4, #00000029); }
      .afgo2-bar[data-tone=warn] { background:var(--dsw-alias-state-warn-primary, #f59e0b); }
      .afgo2-bar[data-tone=err] { background:var(--dsw-alias-state-error-primary, #ec1313); }
      .afgo2-point { position:absolute; top:9px; width:8px; height:8px; border-radius:50%;
        background:var(--dsw-alias-label-secondary, #61666b); transform:translateX(-4px); }
      .afgo2-tl-dur { font-size:12px; text-align:right; color:var(--dsw-alias-label-secondary, #61666b);
        font-variant-numeric:tabular-nums; overflow-wrap:anywhere; }
      .afgo2-expand { grid-column:1 / -1; }
      .afgo2-expand .afgo2-kv { font-size:12px; }
      .afgo2-events { display:flex; flex-direction:column; gap:2px; }
      .afgo2-event { display:grid; grid-template-columns:76px minmax(0,1fr) auto; gap:10px;
        font-size:12px; padding:3px 0; align-items:baseline; }
      .afgo2-event .t { color:var(--dsw-alias-label-caption, #9aa0a6); font-variant-numeric:tabular-nums; }
      .afgo2-event .s { color:var(--dsw-alias-label-caption, #9aa0a6); }
      .afgo2-files { display:flex; flex-direction:column; gap:6px; }
      .afgo2-file { display:grid; grid-template-columns:minmax(0,1fr) 64px 72px auto; gap:10px;
        align-items:center; padding:8px; border:1px solid var(--dsw-alias-border-l1, #0000000a); border-radius:8px; }
      .afgo2-file[data-primary=true] { background:var(--dsw-alias-state-success-tertiary, #e6faed);
        border-color:transparent; }
      .afgo2-file-name { display:flex; align-items:center; gap:8px; min-width:0; font-size:13px; }
      .afgo2-file-meta { font-size:12px; color:var(--dsw-alias-label-tertiary, #81858c); text-align:right; }
      .afgo2-file-actions { text-align:right; display:flex; gap:6px; justify-content:flex-end; }
      .afgo2-preview { max-height:280px; overflow:auto; border:1px solid var(--dsw-alias-border-l2, #0000001a);
        border-radius:8px; padding:8px; background:var(--dsw-alias-bg-base, #fff); }
      .afgo2-preview pre { margin:0; white-space:pre-wrap; overflow-wrap:anywhere; font-size:12px;
        font-family:var(--dsh-font-family-code, ui-monospace, monospace); }
      .afgo2-table { border-collapse:collapse; width:100%; font-size:12px; }
      .afgo2-table th, .afgo2-table td { text-align:left; padding:3px 6px;
        border-bottom:1px solid var(--dsw-alias-border-l1, #0000000a); overflow-wrap:anywhere; }
      .afgo2-table th { color:var(--dsw-alias-label-tertiary, #81858c); font-weight:500; }
      .afgo2-discover { display:grid; grid-template-columns:minmax(260px, 380px) minmax(0,1fr); gap:16px; }
      .afgo2-results { display:flex; flex-direction:column; gap:2px; padding:4px; max-height:min(60vh, 560px); overflow:auto; }
      .afgo2-result { display:flex; flex-direction:column; gap:3px; text-align:left; border:1px solid transparent !important;
        border-radius:10px; padding:9px 10px; min-height:0; align-items:stretch; }
      .afgo2-result[aria-current=true] { background:var(--dsw-alias-bg-layer-2, #f7f8fa);
        border-color:var(--dsw-alias-border-l2, #0000001a) !important; }
      .afgo2-result .n { font-weight:600; font-size:13px; overflow-wrap:anywhere; }
      .afgo2-result .r { font-size:12px; color:var(--dsw-alias-label-secondary, #61666b); overflow-wrap:anywhere; }
      .afgo2-result .m { display:flex; gap:6px; flex-wrap:wrap; font-size:12px; color:var(--dsw-alias-label-caption, #9aa0a6); }
      .afgo2-empty { display:flex; flex-direction:column; gap:6px; align-items:flex-start;
        padding:20px 16px; border:1px dashed var(--dsw-alias-border-l3, #0000001f); border-radius:10px; }
      .afgo2-empty b { font-size:13px; }
      .afgo2-settings { display:grid; gap:12px; }
      .afgo2-form { display:flex; gap:8px; flex-wrap:wrap; align-items:flex-end; }
      .afgo2-form label { display:flex; flex-direction:column; gap:4px; font-size:12px;
        color:var(--dsw-alias-label-secondary, #61666b); flex:1 1 240px; min-width:0; }
      .afgo2-check { display:flex; gap:8px; align-items:flex-start; font-size:13px; }
      .afgo2-check input { min-height:0; margin-top:3px; }
      .afgo2-sr { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden;
        clip:rect(0 0 0 0); white-space:nowrap; border:0; }
      .afgo2-back { display:none; }
      @media (max-width: 860px) {
        .afgo2-tasks, .afgo2-discover { grid-template-columns:minmax(0,1fr); }
        .afgo2-tasks[data-pane=list] .afgo2-detailpane { display:none; }
        .afgo2-tasks[data-pane=detail] .afgo2-listpane { display:none; }
        .afgo2-back { display:inline-flex; }
        .afgo2-axis { display:none; }
        .afgo2-tl-row { grid-template-columns:minmax(0,1fr) 92px; grid-template-areas:"name dur" "track track"; gap:6px; }
        .afgo2-tl-name { grid-area:name; }
        .afgo2-tl-dur { grid-area:dur; }
        .afgo2-tl .afgo2-track, .afgo2-tl-row > .afgo2-track { grid-area:track; }
        .afgo2-file { grid-template-columns:minmax(0,1fr) auto; grid-template-areas:"name actions" "type size"; }
        .afgo2-file-name { grid-area:name; }
        .afgo2-file-actions { grid-area:actions; }
        .afgo2-file-type { grid-area:type; text-align:left; }
        .afgo2-file-size { grid-area:size; }
        .afgo2-status-strip { grid-template-columns:minmax(0,1fr); }
        .afgo2-event { grid-template-columns:64px minmax(0,1fr); }
        .afgo2-event .s { display:none; }
      }
      @media (prefers-reduced-motion: reduce) {
        .afgo2 * { transition:none !important; animation:none !important; }
      }
      @media (forced-colors: active) {
        .afgo2-bar, .afgo2-point, .afgo2-dot { forced-color-adjust:none; }
      }
    `;

    // ------------------------------------------------------------------
    // small view atoms
    // ------------------------------------------------------------------

    function cx(...values) { return values.filter(Boolean).join(" "); }

    function Chip({ tone, children, plain }) {
      return h("span", { className: "afgo2-chip", "data-tone": tone ?? (plain ? "plain" : undefined) }, children);
    }

    function Dot({ tone }) {
      return h("span", { className: "afgo2-dot", "data-tone": tone, "aria-hidden": "true" });
    }

    function Notice({ tone = "info", role, children }) {
      return h("p", { className: "afgo2-notice", "data-tone": tone, role: role ?? (tone === "info" ? "status" : "alert") }, children);
    }

    function EmptyState({ title, hint, action }) {
      return h("div", { className: "afgo2-empty" },
        h("b", null, title),
        hint ? h("span", { className: "afgo2-caption afgo2-wrap" }, hint) : null,
        action ?? null);
    }

    function Section({ title, meta, actions, children, id }) {
      return h("section", { className: "afgo2-section afgo2-card", id },
        h("div", { className: "afgo2-section-head" },
          h("h3", null, title),
          h("div", { className: "afgo2-actions" }, meta ? h("span", { className: "afgo2-caption" }, meta) : null, actions ?? null)),
        children);
    }

    function Field({ id, label, hint, children }) {
      return h("label", { htmlFor: id },
        h("span", null, label),
        children,
        hint ? h("span", { className: "afgo2-caption afgo2-wrap" }, hint) : null);
    }

    function Tabs({ items, value, onChange, label }) {
      const refs = useRef([]);
      function onKeyDown(event, index) {
        if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
        event.preventDefault();
        const delta = event.key === "ArrowRight" ? 1 : -1;
        const next = (index + delta + items.length) % items.length;
        onChange(items[next].id);
        refs.current[next]?.focus();
      }
      return h("div", { className: "afgo2-tabs", role: "tablist", "aria-label": label },
        ...items.map((item, index) => h("button", {
          key: item.id,
          type: "button",
          role: "tab",
          className: "afgo2-tab",
          "aria-selected": value === item.id,
          tabIndex: value === item.id ? 0 : -1,
          ref: (node) => { refs.current[index] = node; },
          onClick: () => onChange(item.id),
          onKeyDown: (event) => onKeyDown(event, index)
        }, item.label)));
    }

    // ------------------------------------------------------------------
    // request helper: one call envelope, cancellable per account generation
    // ------------------------------------------------------------------

    function useRequester(request, scope) {
      const alive = useRef(true);
      const cache = useRef(new Map());
      useEffect(() => () => { alive.current = false; }, []);
      const send = useCallback(async (action, params) => {
        const value = await request(action, params);
        return value;
      }, [request]);
      const cached = useCallback(async (action, params, ttlMs) => {
        const key = JSON.stringify([scope, action, params ?? null]);
        const hit = cache.current.get(key);
        if (hit && Date.now() - hit.at < ttlMs) return hit.value;
        const value = await send(action, params);
        if (value?.ok) cache.current.set(key, { at: Date.now(), value });
        return value;
      }, [send, scope]);
      return { send, cached, isAlive: () => alive.current };
    }

    // ------------------------------------------------------------------
    // connection / account
    // ------------------------------------------------------------------

    function ConnectionBar({ connection, account, syncedAt, syncError, onOpenSettings, tab }) {
      const online = Boolean(account);
      const tone = !online ? "idle" : syncError ? "warn" : "ok";
      return h("div", { className: "afgo2-conn" },
        h(Dot, { tone }),
        h("span", { className: "afgo2-who afgo2-wrap" },
          online ? `已连接 · ${account.name}` : connection ? "未连接" : "正在读取连接…"),
        online && account.tier ? h(Chip, { plain: true }, account.tier) : null,
        h("span", { className: "afgo2-env afgo2-wrap" },
          h("span", null, connection?.env?.label ?? "环境未知"),
          h("span", { "aria-hidden": "true" }, "·"),
          h("span", { className: "afgo2-mono" }, connection?.env?.host ?? connection?.baseUrl ?? "—")),
        h("span", { className: "afgo2-spacer" }),
        h("span", { className: "afgo2-caption", role: "status" },
          syncError ? "同步延迟" : syncedAt ? `${clockOf(syncedAt)} 同步` : online ? "尚未同步" : "本机保存的 Key"),
        onOpenSettings
          ? h("button", { type: "button", "data-variant": "ghost", onClick: onOpenSettings,
              "aria-current": tab === "settings" ? "true" : undefined }, "账号设置")
          : null);
    }

    function ApiKeyForm({ connection, busy, onConnect, onRemove, compact }) {
      const [key, setKey] = useState("");
      const [error, setError] = useState(null);
      const inputId = compact ? "afgo2-key-compact" : "afgo2-key";
      async function submit(event) {
        event.preventDefault();
        setError(null);
        if (!key && !connection?.configured) { setError("请粘贴 API Key。"); return; }
        try {
          await onConnect(key);
          setKey("");
        } catch (problem) {
          setError(problem.message || String(problem));
        }
      }
      return h("form", { className: "afgo2-form", onSubmit: submit },
        h(Field, {
          id: inputId,
          label: "AsterFire Go API Key",
          hint: connection?.configured
            ? "留空点击「验证账号」可复用已保存的 Key；Key 由 DSH 宿主保存，页面不读取明文。"
            : "Key 由 DSH 宿主保存，页面不读取明文。"
        }, h("input", {
          id: inputId,
          type: "password",
          autoComplete: "off",
          value: key,
          onChange: (event) => setKey(event.target.value),
          placeholder: connection?.configured ? "留空验证已保存的 Key" : "粘贴你的 API Key"
        })),
        h("div", { className: "afgo2-actions" },
          h("button", { type: "submit", "data-variant": "primary", disabled: busy },
            key ? "验证并保存" : connection?.configured ? "验证账号" : "连接账号"),
          connection?.source === "file" && connection?.writable
            ? h("button", { type: "button", disabled: busy, onClick: () => onRemove() }, "移除保存的 Key")
            : null,
          h("a", { href: CREDENTIAL_GUIDE, target: "_blank", rel: "noreferrer" }, "获取 API Key")),
        error ? h(Notice, { tone: "err" }, error) : null);
    }

    // ------------------------------------------------------------------
    // task list
    // ------------------------------------------------------------------

    const TYPE_FILTERS = [
      { id: "all", label: "全部类型" },
      { id: "kit", label: "Kit" },
      { id: "agent", label: "Agent" }
    ];

    const STATUS_FILTERS = [
      { id: "all", label: "全部状态" },
      { id: "running", label: "执行中" },
      { id: "success", label: "成功" },
      { id: "partial", label: "部分完成" },
      { id: "failed", label: "失败" },
      { id: "unknown", label: "待核实" },
      { id: "unresolved", label: "待查询" }
    ];

    function rowMatchesStatus(item, summary, status) {
      if (status === "all") return true;
      return statusOfRow(item, summary).state === status;
    }

    function TaskRow({ item, summary, selected, onSelect }) {
      const status = statusOfRow(item, summary);
      const tone = status.state === "success" ? "ok"
        : status.state === "running" || status.state === "partial" || status.state === "unknown" ? "warn"
        : status.state === "failed" ? "err"
        : undefined;
      return h("button", {
        type: "button",
        className: "afgo2-row",
        "aria-current": selected ? "true" : undefined,
        onClick: () => onSelect(item),
        "data-task-id": item.id
      },
        h("span", { style: { display: "flex", flexDirection: "column", gap: "4px", alignItems: "flex-start" } },
          h(Chip, { tone, plain: status.state === "unresolved" }, status.label)),
        h("span", { style: { minWidth: 0, display: "flex", flexDirection: "column" } },
          h("span", { className: "afgo2-row-title" }, item.title),
          h("span", { className: "afgo2-row-meta" },
            h("span", { className: "afgo2-mono" }, `#${item.id}`),
            h(Chip, { plain: true }, item.type === "agent" ? "Agent" : item.type === "kit" ? "Kit" : "类型未知"),
            item.toolbox?.name ? h("span", { className: "afgo2-mono afgo2-wrap" }, item.toolbox.name) : null),
          h("span", { className: "afgo2-row-meta" },
            h("span", null, `创建 ${shortDateOf(item.createdAt)}`),
            summary?.stepCount ? h("span", null, `· ${summary.stepCount} 个步骤`) : null,
            summary?.totalMs ? h("span", null, `· 耗时 ${formatDuration(summary.totalMs)}`) : null,
            summary?.filesCount ? h("span", null, `· ${summary.filesCount} 个产物`) : null,
            !summary && status.state === "unresolved" ? h("span", null, "· 状态未读取") : null)));
    }

    function TaskList({ items, summaries, selectedId, onSelect, loading, error, hasMore, onMore, emptyHint, onDiscover }) {
      const listRef = useRef(null);
      function onKeyDown(event) {
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        const buttons = Array.from(listRef.current?.querySelectorAll("[data-task-id]") ?? []);
        if (!buttons.length) return;
        event.preventDefault();
        const index = buttons.indexOf(document.activeElement);
        const next = index === -1 ? 0 : Math.max(0, Math.min(buttons.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
        buttons[next].focus();
      }
      return h("div", { className: "afgo2-card afgo2-listpane" },
        error ? h("div", { className: "afgo2-body" }, h(Notice, { tone: "err" }, error)) : null,
        !items.length && !loading && !error
          ? h("div", { className: "afgo2-body" },
              h(EmptyState, {
                title: emptyHint?.title ?? "当前筛选没有任务",
                hint: emptyHint?.hint ?? "换一个类型或状态，或直接输入任务编号。",
                action: onDiscover ? h("button", { type: "button", onClick: onDiscover }, "发现工具") : null
              }))
          : null,
        items.length
          ? h("ul", { className: "afgo2-list", "aria-label": "我的任务", onKeyDown, ref: listRef },
              ...items.map((item) => h("li", { key: item.id },
                h(TaskRow, { item, summary: summaries[item.id], selected: item.id === selectedId, onSelect }))))
          : null,
        loading ? h("p", { className: "afgo2-caption", style: { padding: "8px 16px" }, role: "status" }, "正在读取任务…") : null,
        hasMore && !loading
          ? h("div", { className: "afgo2-body" }, h("button", { type: "button", onClick: onMore }, "加载更多"))
          : null);
    }

    // ------------------------------------------------------------------
    // task detail
    // ------------------------------------------------------------------

    function StatusStrip({ task, syncedAt, syncError, polling }) {
      const execution = executionOf(task);
      const verdict = verdictOf(task);
      const startMs = (task.steps ?? [])
        .map((step) => parseTime(step.startedAt))
        .filter((value) => value != null);
      const runningFor = execution.state === "running" && startMs.length
        ? Math.max(0, Date.now() - Math.min(...startMs))
        : null;
      const execTone = execution.state === "done" ? "ok" : execution.state === "running" || execution.state === "queued" ? "warn" : undefined;
      const verdictTone = verdict.state === "success" ? "ok" : verdict.state === "failed" ? "err" : verdict.state === "running" ? "warn" : "warn";
      const syncTone = syncError ? "warn" : syncedAt ? "ok" : undefined;
      return h("div", { className: "afgo2-status-strip" },
        h("div", { className: "afgo2-status" },
          h("span", { className: "k" }, "执行状态"),
          h("span", { className: "v" }, h(Dot, { tone: execTone }), execution.label),
          h("span", { className: "h afgo2-wrap" },
            runningFor != null ? `已运行 ${formatDuration(runningFor)}` : execution.detail)),
        h("div", { className: "afgo2-status" },
          h("span", { className: "k" }, "结果判定"),
          h("span", { className: "v" }, h(Chip, { tone: verdictTone }, verdict.label)),
          h("span", { className: "h afgo2-wrap" }, verdict.reason)),
        h("div", { className: "afgo2-status" },
          h("span", { className: "k" }, "同步状态"),
          h("span", { className: "v" }, h(Dot, { tone: syncTone }),
            syncError ? "延迟" : polling ? "自动刷新" : syncedAt ? "正常" : "未同步"),
          h("span", { className: "h afgo2-wrap" },
            syncError ?? (syncedAt ? `${dateTimeOf(new Date(syncedAt).toISOString())}${polling ? " · 每 6 秒" : ""}` : "打开详情后读取"))));
    }

    function OverviewPanel({ task, timeline, onOpenTimeline, onOpenFiles, versionInfo }) {
      const execution = executionOf(task);
      const verdict = verdictOf(task);
      const events = eventsOf(task).slice(0, 6);
      const single = (task.steps ?? []).length === 1;
      return h("div", { className: "afgo2-section" },
        h("div", { className: "afgo2-section-head" },
          h("h3", null, "总览"),
          timeline.totalMs ? h("span", { className: "afgo2-caption" }, `任务跨度 ${formatDuration(timeline.totalMs)}`)
            : h("span", { className: "afgo2-caption" }, "总耗时：缺少同层级起止依据")),
        h("div", { className: "afgo2-body" },
          h("dl", { className: "afgo2-kv" },
            h("dt", null, "任务类型"), h("dd", null, task.type === "agent" ? "Agent（对话式）" : task.type === "kit" ? "Kit（固定输入）" : "类型未返回"),
            h("dt", null, "工具注册名"), h("dd", { className: "afgo2-mono afgo2-wrap" }, task.toolbox?.name ?? "平台未返回"),
            h("dt", null, "任务实际版本"), h("dd", null, task.toolbox?.version
              ? h("span", null, `v${task.toolbox.version}`)
              : h("span", { className: "afgo2-muted" }, "版本未返回（任务详情没有 toolbox.version）")),
            h("dt", null, "目录版本参考"), h("dd", null, versionInfo
              ? h("span", null, `${versionInfo.text} · ${versionInfo.source}`)
              : h("span", { className: "afgo2-muted" }, "目录未收录该工具")),
            h("dt", null, "创建时间"), h("dd", null, task.meta?.createdAt ? dateTimeOf(task.meta.createdAt) : "列表未返回创建时间"),
            h("dt", null, "步骤"), h("dd", null, `${task.steps?.length ?? 0} 个 · ${execution.detail}`)),
          verdict.evidence.length
            ? h("div", null,
                h("p", { className: "afgo2-caption" }, "判定依据"),
                h("ul", { className: "afgo2-events" }, ...verdict.evidence.map((entry, index) =>
                  h("li", { className: "afgo2-event", key: `ev-${index}` },
                    h("span", { className: "t" }, "证据"),
                    h("span", { className: "l afgo2-mono afgo2-wrap" }, entry)))))
            : null,
          task.messages?.lastAssistant
            ? h("div", { className: "afgo2-card", style: { padding: "10px 12px", display: "grid", gap: "4px" } },
                h("div", { className: "afgo2-caption" },
                  `最后一条可读回复 · ${dateTimeOf(task.messages.lastAssistant.createdAt)}`),
                h("pre", { className: "afgo2-wrap",
                  style: { margin: 0, whiteSpace: "pre-wrap", fontSize: "12px", fontFamily: "inherit" } },
                  task.messages.lastAssistant.preview ?? task.messages.lastAssistant.text),
                (task.messages.lastAssistant.text?.length ?? 0) > (task.messages.lastAssistant.preview?.length ?? 0)
                  ? h("details", null,
                      h("summary", { className: "afgo2-caption", style: { cursor: "pointer" } }, "展开全文"),
                      h("pre", { className: "afgo2-wrap",
                        style: { margin: "6px 0 0", whiteSpace: "pre-wrap", fontSize: "12px", fontFamily: "inherit" } },
                        task.messages.lastAssistant.text))
                  : null)
            : null,
          h("div", { className: "afgo2-actions" },
            h("button", { type: "button", onClick: onOpenTimeline },
              single ? "查看提交 / 开始 / 完成" : "查看步骤时间线"),
            h("button", { type: "button", onClick: onOpenFiles }, "查看产物")),
          events.length
            ? h("div", null,
                h("p", { className: "afgo2-caption" }, "关键时间（仅平台返回的字段）"),
                h("ul", { className: "afgo2-events" }, ...events.map((event, index) =>
                  h("li", { className: "afgo2-event", key: `ov-${index}` },
                    h("span", { className: "t" }, clockOf(parseTime(event.at))),
                    h("span", { className: "l afgo2-wrap" }, `${event.kind} · ${event.text}`),
                    h("span", { className: "s afgo2-mono" }, event.source)))))
            : h("p", { className: "afgo2-caption" }, "平台没有返回任何步骤时间，时间线将只显示步骤顺序。")));
    }

    function TimelinePanel({ task }) {
      const timeline = useMemo(() => timelineOf(task), [task]);
      const [expanded, setExpanded] = useState(null);
      const events = eventsOf(task);
      if (!timeline.rows.length) {
        return h("div", { className: "afgo2-body" },
          h(EmptyState, { title: "没有步骤记录", hint: "平台返回的 steps 为空；详情只保留任务级状态。" }));
      }
      if (timeline.mode === "list") {
        return h("div", { className: "afgo2-section" },
          h("div", { className: "afgo2-section-head" },
            h("h3", null, "步骤时间线"),
            h("span", { className: "afgo2-caption" }, "时间字段全部缺失：按平台返回顺序显示")),
          h("div", { className: "afgo2-body" },
            h("ol", { className: "afgo2-events" }, ...timeline.rows.map((row) =>
              h("li", { key: row.step.id || row.index, className: "afgo2-event", style: { gridTemplateColumns: "28px minmax(0,1fr) auto" } },
                h("span", { className: "t" }, row.index + 1),
                h("span", { className: "l afgo2-wrap" }, row.step.name),
                h("span", { className: "s" }, row.step.jobStatus ?? "状态未返回")))),
            h("p", { className: "afgo2-caption" }, "缺失时间不做推算：没有耗时条，也没有百分比。")));
      }
      return h("div", { className: "afgo2-section" },
        h("div", { className: "afgo2-section-head" },
          h("h3", null, "步骤时间线"),
          h("span", { className: "afgo2-caption" },
            timeline.totalMs ? `跨 ${formatDuration(timeline.totalMs)}` : "并行或跨 pipeline：不显示总耗时")),
        h("div", { className: "afgo2-tl" },
          h("div", { className: "afgo2-axis", "aria-hidden": "true" },
            h("span", null, "步骤 · 名称"),
            h("span", { className: "afgo2-ticks" }, ...timeline.ticks.map((tick, index) =>
              h("span", { key: `tick-${index}` }, clockOf(tick.at)))),
            h("span", { style: { textAlign: "right" } }, "耗时")),
          ...timeline.rows.map((row) => {
            const key = row.step.id || String(row.index);
            const open = expanded === key;
            const queueText = row.queueMs != null && row.queueMs > 500 ? `排队 ${formatDuration(row.queueMs)}` : null;
            const runText = row.runMs != null ? formatDuration(row.runMs) : null;
            const tone = String(row.step.jobStatus ?? "").toUpperCase() === "COMPLETED" ? undefined
              : ["FAILED", "CANCELLED", "TIMEOUT", "NODE_FAIL"].includes(String(row.step.jobStatus ?? "").toUpperCase()) ? "err"
              : "warn";
            return h("div", { className: "afgo2-tl-row", key },
              h("button", {
                type: "button",
                className: "afgo2-tl-name",
                style: { border: 0, padding: 0, textAlign: "left", minHeight: 0, background: "transparent" },
                "aria-expanded": open,
                onClick: () => setExpanded(open ? null : key)
              },
                h("b", null, row.step.name),
                h("span", null, `步骤 ${row.step.id || "—"} · ${row.step.jobStatus ?? "状态未返回"}${row.warnings.length ? " · 时间异常" : ""}`)),
              h("div", {
                className: "afgo2-track",
                role: "img",
                "aria-label": row.hasTime
                  ? `${row.step.name}：${row.queueMs != null ? `排队 ${formatDuration(row.queueMs)}，` : ""}执行 ${row.runMs != null ? formatDuration(row.runMs) : "时间不足"}`
                  : `${row.step.name}：没有时间字段`
              },
                ...timeline.ticks.slice(1, -1).map((tick, index) => h("span", {
                  key: `grid-${index}`, className: "tick", style: { left: `${tick.ratio * 100}%` }
                })),
                row.queue ? h("span", { className: "afgo2-bar", "data-kind": "queue",
                  style: { left: `${row.queueLeft}%`, width: `${row.queueWidth}%` } }) : null,
                row.run ? h("span", { className: "afgo2-bar", "data-tone": tone,
                  style: { left: `${row.runLeft}%`, width: `${row.runWidth}%` } }) : null,
                row.point != null ? h("span", { className: "afgo2-point", style: { left: `${row.pointLeft}%` } }) : null,
                !row.hasTime ? h("span", { className: "afgo2-caption", style: { position: "absolute", left: "8px", top: "4px" } }, "无时间") : null),
              h("span", { className: "afgo2-tl-dur" },
                runText ?? "—",
                queueText ? h("span", { style: { display: "block" }, className: "afgo2-caption" }, queueText) : null),
              open ? h("div", { className: "afgo2-expand" },
                h("dl", { className: "afgo2-kv" },
                  h("dt", null, "步骤编号"), h("dd", { className: "afgo2-mono" }, row.step.id || "未返回"),
                  h("dt", null, "pipeline_id"), h("dd", { className: "afgo2-mono" }, row.step.pipelineId ?? "未返回"),
                  h("dt", null, "原始状态"), h("dd", { className: "afgo2-mono" },
                    `status=${row.step.statusRaw ?? "—"} · slurm=${row.step.jobStatus ?? "—"}`),
                  h("dt", null, "提交 / 开始 / 结束"), h("dd", { className: "afgo2-wrap" },
                    `${dateTimeOf(row.step.createdAt)} · ${dateTimeOf(row.step.startedAt)} · ${dateTimeOf(row.step.endedAt)}`),
                  h("dt", null, "错误信息"), h("dd", { className: "afgo2-wrap" },
                    row.step.error ?? "无（平台没有返回 error 字段）"),
                  row.warnings.length ? h("dt", null, "时间异常") : null,
                  row.warnings.length ? h("dd", { className: "afgo2-wrap" }, row.warnings.join("；")) : null))
                : null);
          })),
        h("div", { className: "afgo2-body" },
          h("h4", { style: { fontSize: "12px", fontWeight: 600 } }, "事件列表"),
          events.length
            ? h("ul", { className: "afgo2-events" }, ...events.map((event, index) =>
                h("li", { className: "afgo2-event", key: `tl-ev-${index}` },
                  h("span", { className: "t" }, clockOf(parseTime(event.at))),
                  h("span", { className: "l afgo2-wrap" }, `${event.kind} · ${event.text}`),
                  h("span", { className: "s afgo2-mono" }, event.source))))
            : h("p", { className: "afgo2-caption" }, "没有可用的事件时间。"),
          h("p", { className: "afgo2-caption" },
            "耗时口径：排队 = 同一步骤的 created_at → started_at（调度对象返回 job_submitted_at / job_started_at 时改用调度时间）；执行 = 同一步骤的 started_at → ended_at。字段缺失或顺序异常时降级显示，不推算百分比。")));
    }

    function ArtifactsPanel({ task, files, loading, error, onRetry, onDownload, downloadState, onPreview, preview }) {
      const [filter, setFilter] = useState("");
      const primary = primaryFileOf(task.toolbox?.name, files);
      const query = normalizeSearch(filter);
      const visible = useMemo(() => {
        const list = [...files]
          .sort((a, b) => (primary && a.id === primary.id ? -1 : primary && b.id === primary.id ? 1 : a.name.localeCompare(b.name, "en")));
        if (!query) return list;
        return list.filter((file) => normalizeSearch(`${file.name} ${file.type}`).includes(query));
      }, [files, primary, query]);
      if (loading) return h("div", { className: "afgo2-body" }, h("p", { className: "afgo2-caption", role: "status" }, "正在读取产物清单…"));
      if (error) {
        const tone = error.code === "forbidden" ? "warn" : "err";
        return h("div", { className: "afgo2-body" },
          h(Notice, { tone }, error.code === "forbidden"
            ? "当前账号无权访问这个任务的产物。"
            : error.code === "not_found"
              ? "平台没有返回产物目录（任务可能已删除或不属于当前账号）。"
              : `产物读取失败：${error.message}`),
          error.retryable !== false ? h("button", { type: "button", onClick: onRetry }, "重试读取") : null);
      }
      if (!files.length) {
        return h("div", { className: "afgo2-body" },
          h(EmptyState, { title: "暂无产物", hint: "平台返回的产物目录为空。任务完成前这里通常为空，稍后刷新再看。" }),
          h("button", { type: "button", onClick: onRetry }, "刷新产物"));
      }
      return h("div", { className: "afgo2-section" },
        h("div", { className: "afgo2-section-head" },
          h("h3", null, `产物 · ${files.length} 个`),
          h("div", { className: "afgo2-actions" },
            h("input", {
              type: "search", value: filter, "aria-label": "按文件名或类型筛选产物",
              placeholder: "筛选文件名 / 类型", onChange: (event) => setFilter(event.target.value)
            }),
            h("button", { type: "button", onClick: onRetry }, "刷新"))),
        h("div", { className: "afgo2-body" },
          primary ? h("p", { className: "afgo2-caption" }, `主结果规则：${task.toolbox?.name} → ${primary.name}（已标为主结果）`) : null,
          h("ul", { className: "afgo2-files" }, ...visible.map((file) => {
            const state = downloadState[file.id];
            const isPrimary = primary && file.id === primary.id;
            const tooLarge = file.size != null && file.size > MAX_DOWNLOAD;
            return h("li", { className: "afgo2-file", key: file.id, "data-primary": isPrimary ? "true" : undefined },
              h("span", { className: "afgo2-file-name afgo2-wrap" },
                isPrimary ? h(Chip, { tone: "ok" }, "主结果") : null,
                h("span", { className: "afgo2-mono" }, file.name)),
              h("span", { className: "afgo2-file-meta afgo2-file-type" }, file.type.toUpperCase()),
              h("span", { className: "afgo2-file-meta afgo2-file-size" }, formatBytes(file.size)),
              h("span", { className: "afgo2-file-actions" },
                h("button", {
                  type: "button",
                  "data-variant": isPrimary ? "primary" : undefined,
                  disabled: state?.busy === true || tooLarge,
                  onClick: () => onDownload(file)
                }, state?.busy ? "下载中…" : state?.error ? "重试下载" : "下载"),
                ["table", "json", "text"].includes(fileKind(file)) && file.size != null && file.size <= PREVIEW_LIMIT
                  ? h("button", { type: "button", "data-variant": "ghost", onClick: () => onPreview(file) }, "预览")
                  : null),
              state?.error
                ? h("span", { className: "afgo2-expand" },
                    h(Notice, { tone: state.error.code === "too_large" ? "warn" : "err" },
                      state.error.code === "too_large"
                        ? `文件 ${formatBytes(state.error.size ?? file.size)} 超过 ${formatBytes(MAX_DOWNLOAD)} 下载上限。请到星使智算网页端下载，任务编号 #${task.id}。`
                        : state.error.code === "forbidden"
                          ? "当前账号无权下载该文件。"
                          : `下载失败：${state.error.message}`),
                    state.error.code === "too_large"
                      ? h("a", { href: WEB_ENTRY, target: "_blank", rel: "noreferrer", style: { marginLeft: "8px" } },
                          `打开星使智算网页端（任务 #${task.id}）`)
                      : null)
                : null);
          })),
          !visible.length ? h("p", { className: "afgo2-caption" }, "没有匹配的产物。") : null,
          preview ? h("div", { className: "afgo2-card", style: { padding: "10px 12px", display: "grid", gap: "6px" } },
            h("div", { className: "afgo2-head" },
              h("b", { style: { fontSize: "12px" } }, `预览 · ${preview.name}`),
              h("button", { type: "button", "data-variant": "ghost", onClick: preview.onClose }, "关闭预览")),
            preview.error ? h(Notice, { tone: "err" }, preview.error) : null,
            preview.loading ? h("p", { className: "afgo2-caption" }, "正在下载并读取文本…") : null,
            preview.table ? h("div", { className: "afgo2-preview" },
              h("table", { className: "afgo2-table" },
                h("thead", null, h("tr", null, ...preview.table.header.map((cell, index) => h("th", { key: `h-${index}` }, cell)))),
                h("tbody", null, ...preview.table.rows.map((row, rowIndex) =>
                  h("tr", { key: `r-${rowIndex}` }, ...row.map((cell, cellIndex) => h("td", { key: `c-${rowIndex}-${cellIndex}` }, cell))))))) : null,
            preview.text && !preview.table ? h("div", { className: "afgo2-preview" }, h("pre", null, preview.text)) : null,
            preview.table ? h("p", { className: "afgo2-caption" }, "CSV 以文本渲染；表格只做分列展示，不改变单元格内容。") : null)
            : null,
          h("p", { className: "afgo2-caption" },
            `下载上限 ${formatBytes(MAX_DOWNLOAD)}。超过上限的文件给出网页端入口与任务编号。`)));
    }

    function TaskDetail({
      task, loading, error, onRetry, onBack, syncedAt, syncError, polling,
      files, filesLoading, filesError, onFilesRetry, onDownload, downloadState, onPreview, preview,
      catalogEntry, onOpenDiscover
    }) {
      const [tab, setTab] = useState("overview");
      useEffect(() => { setTab("overview"); }, [task?.id]);
      if (loading && !task) {
        return h("div", { className: "afgo2-card afgo2-detailpane", id: "afgo-task-detail" },
          h("div", { className: "afgo2-body" }, h("p", { className: "afgo2-caption", role: "status" }, "正在读取任务详情…")));
      }
      if (error && !task) {
        return h("div", { className: "afgo2-card afgo2-detailpane", id: "afgo-task-detail" },
          h("div", { className: "afgo2-body" },
            h("button", { type: "button", "data-variant": "ghost", className: "afgo2-back", onClick: onBack }, "← 返回任务列表"),
            h(Notice, { tone: "err" }, error.message),
            h("p", { className: "afgo2-caption" },
              "如果这个编号是工作流方案（plan_id）而不是任务，本阶段只提供任务视图；只读工作流视图在后续阶段。"),
            h("div", { className: "afgo2-actions" },
              h("button", { type: "button", onClick: onRetry }, "重试"),
              h("button", { type: "button", onClick: onOpenDiscover }, "发现工具"))));
      }
      if (!task) {
        return h("div", { className: "afgo2-card afgo2-detailpane", id: "afgo-task-detail" },
          h("div", { className: "afgo2-body" },
            h(EmptyState, {
              title: "选择一个任务查看详情",
              hint: "左侧列表按最近活动排序；也可以直接输入任务编号打开。详情会分别显示执行状态、结果判定和同步状态。"
            })));
      }
      const timeline = timelineOf(task);
      const versionInfo = catalogEntry ? versionText(catalogEntry, task.toolbox?.version) : null;
      return h("div", { className: "afgo2-card afgo2-detailpane", id: "afgo-task-detail" },
        h("div", { className: "afgo2-detail-head" },
          h("div", { className: "afgo2-actions" },
            h("button", { type: "button", "data-variant": "ghost", className: "afgo2-back", onClick: onBack }, "← 返回任务列表"),
            h("span", { className: "afgo2-caption afgo2-mono" }, `#${task.id}`),
            h(Chip, { plain: true }, task.type === "agent" ? "Agent" : task.type === "kit" ? "Kit" : "类型未知")),
          h("div", { className: "afgo2-head" },
            h("h2", { className: "afgo2-title" }, task.meta?.title ?? `任务 #${task.id}`),
            h("span", { className: "afgo2-caption" }, task.meta?.updatedAt ? `最近活动 ${relativeOf(task.meta.updatedAt)}` : "")),
          h("div", { className: "afgo2-meta" },
            h("div", null, h("b", null, "任务编号"), h("span", { className: "afgo2-mono" }, `#${task.id}`)),
            h("div", null, h("b", null, "工具注册名"), h("span", { className: "afgo2-mono afgo2-wrap" }, task.toolbox?.name ?? "平台未返回")),
            h("div", null, h("b", null, "任务实际版本"), h("span", null,
              task.toolbox?.version ? `v${task.toolbox.version}` : "版本未返回")),
            h("div", null, h("b", null, "创建时间"), h("span", null,
              task.meta?.createdAt ? dateTimeOf(task.meta.createdAt) : "列表未返回")))),
        h(StatusStrip, { task, syncedAt, syncError, polling }),
        syncError ? h("div", { className: "afgo2-body" },
          h(Notice, { tone: "warn" }, `同步延迟：${syncError}。下面保留的是上次成功读取的内容。`)) : null,
        h("div", { style: { padding: "8px 16px 0" } },
          h(Tabs, {
            label: "任务详情视图",
            value: tab,
            onChange: setTab,
            items: [
              { id: "overview", label: "总览" },
              { id: "timeline", label: "步骤时间线" },
              { id: "files", label: `产物${files?.length ? ` · ${files.length}` : ""}` }
            ]
          })),
        tab === "overview"
          ? h(OverviewPanel, {
              task, timeline, versionInfo,
              onOpenTimeline: () => setTab("timeline"),
              onOpenFiles: () => setTab("files")
            })
          : null,
        tab === "timeline" ? h(TimelinePanel, { task }) : null,
        tab === "files"
          ? h(ArtifactsPanel, {
              task, files: files ?? [], loading: filesLoading, error: filesError, onRetry: onFilesRetry,
              onDownload, downloadState, onPreview, preview
            })
          : null);
    }

    // ------------------------------------------------------------------
    // tasks section (list + detail, persistence, polling)
    // ------------------------------------------------------------------

    function TasksSection({ request, connection, account, onDiscover, initialTaskId, focusNonce, onSelectionChange }) {
      const { cached } = useRequester(request, `${connection?.baseUrl}|${account.id}`);
      const storage = useMemo(() => ({
        last: scopedKey(connection, account, "last"),
        summaries: scopedKey(connection, account, "summaries")
      }), [connection, account]);

      const [items, setItems] = useState([]);
      const [page, setPage] = useState(1);
      const [hasMore, setHasMore] = useState(false);
      const [listLoading, setListLoading] = useState(false);
      const [listError, setListError] = useState(null);
      const [typeFilter, setTypeFilter] = useState("all");
      const [statusFilter, setStatusFilter] = useState("all");
      const [query, setQuery] = useState("");
      const [serverKeyword, setServerKeyword] = useState("");
      const [summaries, setSummaries] = useState(() => store.read(storage.summaries, {}));
      const [selectedId, setSelectedId] = useState(null);
      const [pane, setPane] = useState("list");
      const [task, setTask] = useState(null);
      const [taskError, setTaskError] = useState(null);
      const [taskLoading, setTaskLoading] = useState(false);
      const [syncedAt, setSyncedAt] = useState(null);
      const [syncError, setSyncError] = useState(null);
      const [files, setFiles] = useState([]);
      const [filesLoading, setFilesLoading] = useState(false);
      const [filesError, setFilesError] = useState(null);
      const [downloadState, setDownloadState] = useState({});
      const [preview, setPreview] = useState(null);
      const [catalogEntry, setCatalogEntry] = useState(null);
      const generation = useRef(0);
      const itemsRef = useRef([]);
      itemsRef.current = items;
      const wanted = useRef(initialTaskId);
      wanted.current = initialTaskId;
      const searchRef = useRef(null);

      const rememberSummary = useCallback((detail, extra = {}) => {
        setSummaries((previous) => {
          const verdict = verdictOf(detail);
          const previousEntry = previous[detail.id] ?? {};
          const next = {
            ...previous,
            [detail.id]: {
              title: detail.meta?.title ?? previousEntry.title ?? `任务 #${detail.id}`,
              type: detail.type,
              toolbox: detail.toolbox,
              createdAt: detail.meta?.createdAt ?? previousEntry.createdAt ?? null,
              updatedAt: detail.meta?.updatedAt ?? previousEntry.updatedAt ?? null,
              stepCount: detail.steps?.length ?? 0,
              filesCount: extra.filesCount ?? previousEntry.filesCount ?? 0,
              totalMs: timelineOf(detail).totalMs,
              verdict: verdict.state,
              verdictLabel: verdict.label,
              at: new Date().toISOString()
            }
          };
          const keys = Object.keys(next);
          if (keys.length > LAST_TASK_LIMIT) {
            const drop = keys.sort((a, b) => String(next[a].at).localeCompare(String(next[b].at)))[0];
            delete next[drop];
          }
          store.write(storage.summaries, next);
          return next;
        });
      }, [storage.summaries]);

      const loadList = useCallback(async (options = {}) => {
        const nextPage = options.page ?? 1;
        const append = options.append === true;
        const keyword = options.keyword ?? serverKeyword;
        setListLoading(true);
        setListError(null);
        const result = await cached("tasks", {
          type: typeFilter === "all" ? undefined : typeFilter,
          page: nextPage,
          perPage: 20,
          keyword: keyword || undefined
        });
        setListLoading(false);
        if (!result.ok) { setListError(result.error.message); return; }
        setItems((previous) => {
          const merged = append ? [...previous] : [];
          for (const item of result.data.items) {
            if (!merged.some((entry) => entry.id === item.id)) merged.push(item);
          }
          return merged.sort((a, b) =>
            Date.parse(b.updatedAt ?? b.createdAt ?? 0) - Date.parse(a.updatedAt ?? a.createdAt ?? 0));
        });
        setPage(nextPage);
        setHasMore(result.data.hasMore);
      }, [cached, serverKeyword, typeFilter]);

      const loadFiles = useCallback(async (id, token) => {
        setFilesLoading(true);
        setFilesError(null);
        const result = await request("files", { id });
        if (token != null && generation.current !== token) return;
        setFilesLoading(false);
        if (!result.ok) {
          setFiles([]);
          setFilesError(result.error);
          return;
        }
        setFiles(result.data.files);
        setSummaries((previous) => {
          const entry = previous[id];
          if (!entry) return previous;
          const next = { ...previous, [id]: { ...entry, filesCount: result.data.files.length } };
          store.write(storage.summaries, next);
          return next;
        });
      }, [request, storage.summaries]);

      const loadCatalogEntry = useCallback(async (name, type) => {
        if (!name) { setCatalogEntry(null); return; }
        const result = await cached("catalog", undefined, CATALOG_TTL_MS);
        if (!result.ok) return;
        const candidates = result.data.entries.filter((entry) => entry.name === name);
        setCatalogEntry(candidates.find((entry) => entry.type === type) ?? candidates[0] ?? null);
      }, [cached]);

      const openTask = useCallback(async (id, meta = null) => {
        const next = String(id ?? "").trim();
        if (!/^[1-9]\d{0,18}$/.test(next)) {
          setTaskError({ code: "invalid_input", message: "请输入有效的任务编号。" });
          setTask(null);
          return;
        }
        generation.current += 1;
        const token = generation.current;
        setSelectedId(next);
        setPane("detail");
        setTaskLoading(true);
        setTaskError(null);
        setSyncError(null);
        setPreview(null);
        setFiles([]);
        setFilesError(null);
        setDownloadState({});
        onSelectionChange?.(next);
        store.write(storage.last, next);
        // A manually typed id is usually already on the loaded page; echoing
        // that row back keeps the title and creation time without another call.
        const local = meta ?? itemsRef.current.find((item) => item.id === next) ?? null;
        const result = await request("task", { id: next, meta: local ?? undefined });
        if (generation.current !== token) return;
        setTaskLoading(false);
        if (!result.ok) {
          setTask(null);
          setTaskError(result.error);
          return;
        }
        setTask(result.data);
        setSyncedAt(Date.now());
        rememberSummary(result.data);
        void loadFiles(next, token);
        void loadCatalogEntry(result.data.toolbox?.name, result.data.type === "agent" ? "agent" : "kit");
      }, [loadCatalogEntry, loadFiles, onSelectionChange, rememberSummary, request, storage.last]);

      useEffect(() => { void loadList({ page: 1 }); }, [loadList]);

      useEffect(() => {
        if (wanted.current) void openTask(wanted.current);
        // Runs once on mount and again whenever the page asks for a task
        // (primary action / discover → task history). Selection changes from
        // inside the list update the same prop but not the nonce.
      }, [focusNonce]); // eslint-disable-line react-hooks/exhaustive-deps

      // Poll only while the platform says the task is still thinking. Switching
      // task or account invalidates the generation, so a late response can
      // never paint the old view.
      const taskId = task?.id ?? null;
      const thinking = task?.isThinking === true;
      const metaRef = useRef(null);
      metaRef.current = task?.meta ?? null;
      useEffect(() => {
        if (!taskId || !thinking) return undefined;
        const token = generation.current;
        let timer = null;
        let cancelled = false;
        async function tick() {
          const result = await request("task", { id: taskId, meta: metaRef.current ?? undefined });
          if (cancelled || generation.current !== token) return;
          if (result.ok) {
            setTask(result.data);
            setSyncedAt(Date.now());
            setSyncError(null);
            rememberSummary(result.data);
            timer = setTimeout(tick, POLL_ACTIVE_MS);
          } else {
            setSyncError(result.error.message);
            timer = setTimeout(tick, POLL_ERROR_MS);
          }
        }
        timer = setTimeout(tick, POLL_ACTIVE_MS);
        return () => { cancelled = true; if (timer) clearTimeout(timer); };
      }, [request, taskId, thinking, rememberSummary]);

      useEffect(() => {
        function onVisible() {
          if (document.visibilityState !== "visible" || !taskId || !thinking) return;
          void request("task", { id: taskId, meta: metaRef.current ?? undefined }).then((result) => {
            if (!result.ok) return;
            setTask(result.data);
            setSyncedAt(Date.now());
            setSyncError(null);
          });
        }
        document.addEventListener("visibilitychange", onVisible);
        return () => document.removeEventListener("visibilitychange", onVisible);
      }, [request, taskId, thinking]);

      const download = useCallback(async (file) => {
        setDownloadState((previous) => ({ ...previous, [file.id]: { busy: true } }));
        const result = await request("download", { id: task.id, fileId: file.id });
        if (!result.ok) {
          setDownloadState((previous) => ({ ...previous, [file.id]: { error: result.error } }));
          return;
        }
        setDownloadState((previous) => ({ ...previous, [file.id]: {} }));
        saveDownload(result.data);
      }, [request, task?.id]);

      const previewFile = useCallback(async (file) => {
        setPreview({ name: file.name, loading: true, onClose: () => setPreview(null) });
        const result = await request("download", { id: task.id, fileId: file.id });
        if (!result.ok) {
          setPreview({ name: file.name, error: result.error.message, onClose: () => setPreview(null) });
          return;
        }
        let text = "";
        try { text = decodeBase64Text(result.data.content); }
        catch { setPreview({ name: file.name, error: "文件内容不是可读文本。", onClose: () => setPreview(null) }); return; }
        let table = null;
        if (fileKind(file) === "table") {
          const parsed = parseCsv(text, 40);
          const width = Math.max(0, ...parsed.rows.map((row) => row.length));
          // A 41-column surface table is unreadable as an HTML table; keep the
          // wide ones as monospace text and only tabulate narrow CSVs.
          const consistent = parsed.rows.length > 1 && parsed.rows.every((row) => row.length === width) && width > 1 && width <= 12;
          if (consistent) table = { header: parsed.rows[0], rows: parsed.rows.slice(1) };
        }
        setPreview({ name: file.name, text: table ? null : text, table, onClose: () => setPreview(null) });
      }, [request, task?.id]);

      const visibleRows = useMemo(() => {
        const q = normalizeSearch(query);
        return items.filter((item) => {
          if (!rowMatchesStatus(item, summaries[item.id], statusFilter)) return false;
          if (!q) return true;
          return normalizeSearch(`${item.id} ${item.title} ${item.toolbox?.name ?? ""} ${item.type}`).includes(q);
        });
      }, [items, query, statusFilter, summaries]);

      const openByNumber = useCallback(() => {
        const id = String(query).trim();
        if (/^[1-9]\d{0,18}$/.test(id)) {
          // Opening by number must not leave a filter that hides every other
          // row: clear the box so the status/type filters still have a list.
          setQuery("");
          void openTask(id);
          return;
        }
        if (!id) { searchRef.current?.focus(); return; }
        setServerKeyword(id);
        void loadList({ page: 1, keyword: id });
      }, [loadList, openTask, query]);

      return h("div", { className: "afgo2-tasks", "data-pane": pane },
        h("div", { className: "afgo2-listpane" },
          h("div", { className: "afgo2-head" },
            h("h2", { className: "afgo2-title", style: { fontSize: "15px" } }, "我的任务"),
            h("button", { type: "button", "data-variant": "ghost",
              onClick: () => void loadList({ page: 1 }), disabled: listLoading }, "刷新")),
          h("div", { className: "afgo2-filters" },
            h("input", {
              type: "search", id: "afgo-task-query", ref: searchRef, value: query,
              "aria-label": "按任务编号、标题或工具筛选",
              placeholder: "编号 / 标题 / 工具", onChange: (event) => setQuery(event.target.value),
              onKeyDown: (event) => { if (event.key === "Enter") openByNumber(); }
            }),
            h("select", { value: typeFilter, "aria-label": "按类型筛选",
              onChange: (event) => { setTypeFilter(event.target.value); setServerKeyword(""); } },
              ...TYPE_FILTERS.map((option) => h("option", { key: option.id, value: option.id }, option.label))),
            h("select", { value: statusFilter, "aria-label": "按状态筛选",
              onChange: (event) => setStatusFilter(event.target.value) },
              ...STATUS_FILTERS.map((option) => h("option", { key: option.id, value: option.id }, option.label))),
            h("button", { type: "button", "data-variant": "ghost", onClick: openByNumber }, "打开 / 搜索")),
          listError ? h("div", { className: "afgo2-body" }, h(Notice, { tone: "err" }, listError)) : null,
          h(TaskList, {
            items: visibleRows, summaries, selectedId, loading: listLoading, hasMore, error: null,
            onSelect: (item) => void openTask(item.id, item),
            onMore: () => void loadList({ page: page + 1, append: true }),
            emptyHint: query || statusFilter !== "all" || typeFilter !== "all"
              ? { title: "当前筛选没有任务", hint: "清空筛选，或换一个状态。" }
              : { title: "还没有任务", hint: "从「发现工具」打开官方样例，或直接输入任务编号。" },
            onDiscover
          }),
          h("p", { className: "afgo2-caption" },
            "列表按最近活动排序。「待查询」表示这一行还没有读取过详情；打开任务后状态才会补上，并写入本机缓存。")),
        h(TaskDetail, {
          task, loading: taskLoading, error: taskError,
          onRetry: () => void openTask(selectedId),
          onBack: () => setPane("list"),
          syncedAt, syncError, polling: thinking,
          files, filesLoading, filesError,
          onFilesRetry: () => void loadFiles(selectedId, generation.current),
          onDownload: download, downloadState, onPreview: previewFile, preview,
          onOpenDiscover: onDiscover, catalogEntry
        }));
    }

    // ------------------------------------------------------------------
    // discover
    // ------------------------------------------------------------------

    function CatalogEntryDetail({ entry, detail, access, loading, history, onCheck, onOpenSample, onUseTask }) {
      if (!entry) {
        return h("div", { className: "afgo2-card" },
          h("div", { className: "afgo2-body" },
            h(EmptyState, { title: "选择一个工具", hint: "搜索注册名或展示名；精确命中会排在最前。" })));
      }
      const version = versionText(entry, history?.version);
      return h("div", { className: "afgo2-card", style: { minWidth: 0 } },
        h("div", { className: "afgo2-detail-head" },
          h("div", { className: "afgo2-actions" },
            h(Chip, { plain: true }, entry.type === "agent" ? "Agent" : "Kit"),
            h(Chip, { plain: true }, version.text),
            h("span", { className: "afgo2-caption" }, version.source)),
          h("h2", { className: "afgo2-title" }, entry.displayName || entry.name),
          h("p", { className: "afgo2-mono afgo2-wrap afgo2-muted" }, entry.name),
          entry.description && entry.description !== entry.name && entry.description !== entry.displayName
            ? h("p", { className: "afgo2-wrap" }, entry.description)
            : null,
          entry.tags?.length
            ? h("div", { className: "afgo2-actions" }, ...entry.tags.map((tag) =>
                h(Chip, { key: tag, plain: true }, tag)))
            : null),
        h("div", { className: "afgo2-body" },
          h("dl", { className: "afgo2-kv" },
            h("dt", null, "注册名"), h("dd", { className: "afgo2-mono afgo2-wrap" }, entry.name),
            h("dt", null, "类型"), h("dd", null, entry.type === "agent" ? "Agent（对话式任务）" : "Kit（固定输入）"),
            h("dt", null, "版本"), h("dd", null, `${version.text}（${version.source}）`),
            h("dt", null, "官方样例"), h("dd", null, entry.demos ? `${entry.demos} 个` : "目录未列出"),
            history?.taskId ? h("dt", null, "历史任务") : null,
            history?.taskId ? h("dd", { className: "afgo2-mono" }, `#${history.taskId}`) : null),
          h("div", { className: "afgo2-actions" },
            entry.type === "kit"
              ? h("button", { type: "button", onClick: onCheck, disabled: loading },
                  loading ? "正在核对…" : "核对调用权限")
              : null,
            history?.taskId
              ? h("button", { type: "button", onClick: onUseTask, "data-variant": "ghost" }, "打开历史任务")
              : null,
            entry.name === SAMPLE_TOOL
              ? h("button", { type: "button", onClick: onOpenSample, "data-variant": "primary" }, "预览 TiO₂ 官方样例")
              : null),
          access
            ? h(Notice, { tone: access.state === "forbidden" ? "warn" : "info" }, access.message)
            : h("p", { className: "afgo2-caption" },
                entry.type === "kit"
                  ? "目录收录 ≠ 当前账号可调用：核对只读取输入 schema（可读不代表提交一定通过）。平台返回 403 时只影响这一项，目录会保留。"
                  : "Agent 目录无法在提交前核对调用权限；以实际提交结果为准。"),
          detail?.schema?.fields?.length
            ? h("div", null,
                h("p", { className: "afgo2-caption" }, `输入字段（${detail.schema.fields.length}）`),
                h("table", { className: "afgo2-table" },
                  h("thead", null, h("tr", null, h("th", null, "字段"), h("th", null, "类型"), h("th", null, "必填"))),
                  h("tbody", null, ...detail.schema.fields.slice(0, 12).map((field) =>
                    h("tr", { key: field.name },
                      h("td", { className: "afgo2-mono afgo2-wrap" }, field.name),
                      h("td", null, field.type),
                      h("td", null, field.required ? "必填" : "可选"))))))
            : null,
          detail?.schema?.demos?.length
            ? h("div", null,
                h("p", { className: "afgo2-caption" }, "目录中的官方样例"),
                h("ul", { className: "afgo2-events" }, ...detail.schema.demos.map((demo, index) =>
                  h("li", { className: "afgo2-event", key: `demo-${index}` },
                    h("span", { className: "t" }, "样例"),
                    h("span", { className: "l afgo2-wrap" }, demo.name),
                    h("span", { className: "s" }, demo.description ?? "")))))
            : null));
    }

    function SamplePreview({ request, account, onClose, onSubmitted }) {
      const [state, setState] = useState({ loading: true });
      const [confirmed, setConfirmed] = useState(false);
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState(null);
      useEffect(() => {
        let alive = true;
        void (async () => {
          const result = await request("sample");
          if (!alive) return;
          setState(result.ok ? { data: result.data } : { error: result.error.message });
        })();
        return () => { alive = false; };
      }, [request]);
      async function submit() {
        setBusy(true);
        setError(null);
        const result = await request("submitSample", {
          confirmed: true, accountId: account.id, fingerprint: state.data.fingerprint
        });
        setBusy(false);
        if (!result.ok) {
          setError(result.error.hint ? `${result.error.message} ${result.error.hint}` : result.error.message);
          return;
        }
        onSubmitted(result.data.id);
      }
      if (state.loading) {
        return h("div", { className: "afgo2-card" },
          h("div", { className: "afgo2-body" }, h("p", { className: "afgo2-caption", role: "status" }, "正在读取官方样例…")));
      }
      if (state.error) {
        return h("div", { className: "afgo2-card" },
          h("div", { className: "afgo2-body" },
            h(Notice, { tone: "err" }, state.error),
            h("button", { type: "button", onClick: onClose }, "关闭")));
      }
      const sample = state.data;
      return h("div", { className: "afgo2-card" },
        h("div", { className: "afgo2-section-head" },
          h("h3", null, `官方样例预览 · ${sample.title}`),
          h("button", { type: "button", "data-variant": "ghost", onClick: onClose }, "关闭")),
        h("div", { className: "afgo2-body" },
          h("dl", { className: "afgo2-kv" },
            h("dt", null, "工具注册名"), h("dd", { className: "afgo2-mono afgo2-wrap" }, sample.tool),
            h("dt", null, "目录版本"), h("dd", null, sample.version ? `v${sample.version}` : "版本未返回"),
            h("dt", null, "提交账号"), h("dd", null, `${account.name}${account.tier ? ` · ${account.tier}` : ""}`)),
          h("p", { className: "afgo2-caption" }, "输入摘要（来自官方 demo，提交前核对）"),
          h("table", { className: "afgo2-table" },
            h("tbody", null, ...sample.summary.slice(0, 12).map((row) =>
              h("tr", { key: row.key },
                h("td", { className: "afgo2-mono afgo2-wrap" }, row.key),
                h("td", { className: "afgo2-wrap" }, row.value))))),
          h("label", { className: "afgo2-check" },
            h("input", { type: "checkbox", checked: confirmed,
              onChange: (event) => setConfirmed(event.target.checked) }),
            h("span", null, "我已核对工具注册名、输入文件与账号，确认提交一次云端计算；费用以星使平台为准。")),
          error ? h(Notice, { tone: "err" }, error) : null,
          h("div", { className: "afgo2-actions" },
            h("button", { type: "button", "data-variant": "primary", disabled: !confirmed || busy, onClick: submit },
              busy ? "提交中…" : "提交官方样例"),
            h("button", { type: "button", onClick: onClose }, "取消")),
          h("p", { className: "afgo2-caption" },
            "提交结果不明时不要重试：先回到「我的任务」核对是否已有记录。")));
    }

    function DiscoverSection({ request, connection, account, onOpenTask, historyByEntry }) {
      const { cached } = useRequester(request, `${connection?.baseUrl}|${account.id}`);
      const [query, setQuery] = useState("");
      const [kind, setKind] = useState("all");
      const [index, setIndex] = useState(() => store.read(scopedKey(connection, account, "catalog"), null));
      const [loading, setLoading] = useState(false);
      const [error, setError] = useState(null);
      const [selected, setSelected] = useState(null);
      const [detail, setDetail] = useState(null);
      const [detailLoading, setDetailLoading] = useState(false);
      const [access, setAccess] = useState(null);
      const [sampleOpen, setSampleOpen] = useState(false);

      const load = useCallback(async (force) => {
        setLoading(true);
        setError(null);
        const result = await cached("catalog", force ? { refresh: true } : undefined, force ? 0 : CATALOG_TTL_MS);
        setLoading(false);
        if (!result.ok) { setError(result.error.message); return; }
        const next = { entries: result.data.entries, counts: result.data.counts, fetchedAt: result.data.fetchedAt };
        setIndex(next);
        store.write(scopedKey(connection, account, "catalog"), next);
      }, [cached, connection, account]);

      useEffect(() => {
        const age = index?.fetchedAt ? Date.now() - Date.parse(index.fetchedAt) : Infinity;
        if (!index || age > CATALOG_TTL_MS) void load(false);
      }, [index, load]);

      useEffect(() => { setAccess(null); setDetail(null); setSampleOpen(false); }, [selected?.name, selected?.type]);

      const results = useMemo(() => (index?.entries ? searchCatalog(index.entries, query, kind) : []),
        [index, query, kind]);

      const check = useCallback(async () => {
        if (!selected) return;
        setDetailLoading(true);
        setAccess(null);
        const result = await request("catalogEntry", { name: selected.name, type: selected.type });
        setDetailLoading(false);
        if (!result.ok) { setError(result.error.message); return; }
        setDetail(result.data);
        setAccess(result.data.access);
      }, [request, selected]);

      const history = selected ? historyByEntry?.[`${selected.type}:${selected.name}`] : null;

      return h("div", { className: "afgo2-discover" },
        h("div", { className: "afgo2-listpane" },
          h("div", { className: "afgo2-head" },
            h("h2", { className: "afgo2-title", style: { fontSize: "15px" } }, "发现工具"),
            h("button", { type: "button", "data-variant": "ghost", onClick: () => void load(true), disabled: loading },
              loading ? "刷新中…" : "刷新目录")),
          h("div", { className: "afgo2-filters" },
            h("input", {
              type: "search", id: "afgo-catalog-query", value: query, "aria-label": "搜索 Kit 或 Agent",
              placeholder: "搜索注册名 / 展示名，如 PySCF", onChange: (event) => setQuery(event.target.value)
            }),
            h("select", { value: kind, "aria-label": "按目录类型筛选",
              onChange: (event) => setKind(event.target.value) },
              h("option", { value: "all" }, "全部类型"),
              h("option", { value: "kit" }, "Kit"),
              h("option", { value: "agent" }, "Agent"))),
          h("p", { className: "afgo2-caption", role: "status" },
            index ? `${results.length} 条命中 · 目录 ${index.counts?.kit ?? 0} Kit + ${index.counts?.agent ?? 0} Agent` : "目录尚未加载"),
          error ? h("div", { className: "afgo2-body" }, h(Notice, { tone: "err" }, error)) : null,
          results.length
            ? h("ul", { className: "afgo2-results", "aria-label": "工具目录" },
                ...results.slice(0, 200).map((entry) => {
                  const historyEntry = historyByEntry?.[`${entry.type}:${entry.name}`];
                  const version = versionText(entry, historyEntry?.version);
                  const current = selected && selected.name === entry.name && selected.type === entry.type;
                  return h("li", { key: `${entry.type}:${entry.name}` },
                    h("button", {
                      type: "button", className: "afgo2-result", "aria-current": current ? "true" : undefined,
                      onClick: () => setSelected(entry)
                    },
                      h("span", { className: "n afgo2-wrap" }, entry.displayName || entry.name),
                      h("span", { className: "r afgo2-mono afgo2-wrap" }, entry.name),
                      h("span", { className: "m" },
                        h(Chip, { plain: true }, entry.type === "agent" ? "Agent" : "Kit"),
                        h("span", null, `${version.text} · ${version.source}`),
                        entry.demos ? h("span", null, `· ${entry.demos} 个样例`) : null)));
                }))
            : !loading
              ? h("div", { className: "afgo2-body" },
                  h(EmptyState, {
                    title: query ? `没有匹配「${query}」的工具` : "目录为空",
                    hint: query ? "试试更短的词，或切换 Kit／Agent 筛选。搜索会做全角/大小写归一化。" : "点击刷新目录重新读取。"
                  }))
              : null),
        h("div", { className: "afgo2-detailpane" },
          h(CatalogEntryDetail, {
            entry: selected, detail, access, loading: detailLoading, history,
            onCheck: check,
            onOpenSample: () => setSampleOpen(true),
            onUseTask: () => { if (history?.taskId) onOpenTask(history.taskId); }
          }),
          sampleOpen
            ? h(SamplePreview, {
                request, account,
                onClose: () => setSampleOpen(false),
                onSubmitted: (id) => { setSampleOpen(false); onOpenTask(id); }
              })
            : null));
    }

    // ------------------------------------------------------------------
    // settings
    // ------------------------------------------------------------------

    function SettingsSection({ connection, account, busy, onConnect, onRemove, catalogCounts, onRefreshCatalog, onClearCache }) {
      return h("div", { className: "afgo2-settings" },
        h(Section, { title: "连接账号" },
          h("div", { className: "afgo2-body" },
            h("dl", { className: "afgo2-kv" },
              h("dt", null, "平台环境"), h("dd", null, `${connection?.env?.label ?? "未知"} · ${connection?.env?.host ?? "—"}`),
              h("dt", null, "Base URL"), h("dd", { className: "afgo2-mono afgo2-wrap" }, connection?.baseUrl ?? "—"),
              h("dt", null, "当前账号"), h("dd", null, account ? `${account.name}${account.tier ? ` · ${account.tier}` : ""}` : "未连接"),
              h("dt", null, "Key 来源"), h("dd", null, connection?.source === "env" ? "DSH 环境变量（只读）" : connection?.source === "file" ? "DSH 凭据存储" : "尚未保存"),
              h("dt", null, "页面可写"), h("dd", null, connection?.writable ? "是" : "否（由环境提供，页面不能覆盖）")),
            h(ApiKeyForm, { connection, busy, onConnect, onRemove }),
            h("p", { className: "afgo2-caption" }, "Key 只提交给 DSH 宿主保存；页面不会读取、回显或记录明文。"))),
        h(Section, { title: "目录缓存" },
          h("div", { className: "afgo2-body" },
            h("p", { className: "afgo2-caption" },
              catalogCounts
                ? `已缓存 ${catalogCounts.kit ?? 0} 个 Kit、${catalogCounts.agent ?? 0} 个 Agent；目录缓存 10 分钟后失效。`
                : "目录尚未读取。"),
            h("div", { className: "afgo2-actions" },
              h("button", { type: "button", onClick: onRefreshCatalog }, "重新读取目录"),
              h("button", { type: "button", "data-variant": "ghost", onClick: onClearCache }, "清除本机任务缓存")))),
        h(Section, { title: "时间字段来源与降级" },
          h("div", { className: "afgo2-body" },
            h("table", { className: "afgo2-table" },
              h("thead", null, h("tr", null, h("th", null, "用途"), h("th", null, "字段"), h("th", null, "缺失时"))),
              h("tbody", null,
                h("tr", null, h("td", null, "任务创建"), h("td", { className: "afgo2-mono" }, "tasks[].created_at"), h("td", null, "显示「创建时间未返回」")),
                h("tr", null, h("td", null, "步骤提交"), h("td", { className: "afgo2-mono" }, "steps[].created_at"), h("td", null, "该步骤不画排队段")),
                h("tr", null, h("td", null, "步骤开始"), h("td", { className: "afgo2-mono" }, "steps[].started_at"), h("td", null, "只画事件点")),
                h("tr", null, h("td", null, "步骤结束"), h("td", { className: "afgo2-mono" }, "steps[].ended_at"), h("td", null, "不计算执行耗时")),
                h("tr", null, h("td", null, "调度排队"), h("td", { className: "afgo2-mono" }, "tasks/{id}/status · job_submitted_at / job_started_at"), h("td", null, "退回步骤 created_at → started_at，并标注口径")),
                h("tr", null, h("td", null, "同步时间"), h("td", { className: "afgo2-mono" }, "本地读取成功时刻"), h("td", null, "显示「未同步」"))),
            h("p", { className: "afgo2-caption" },
              "不使用列表 updated_at 当作完成时间，也不把观察到的变化当作平台事件；没有同层级起止依据时不显示任务总耗时。"))),
        h(Section, { title: "关于" },
          h("div", { className: "afgo2-body" },
            h("p", null, `afgo-dsh v${PLUGIN_VERSION} · 工作台第二阶段`),
            h("p", { className: "afgo2-caption" },
              "后续：多节点工作流与会话视图、可提交的任务表单、历史对比与领域结果摘要。"),
            h("p", { className: "afgo2-caption" },
              "本轮只读：不提交计算、不发追问、不执行工作流。")))));
    }

    // ------------------------------------------------------------------
    // page
    // ------------------------------------------------------------------

    function Page({ request }) {
      const [connection, setConnection] = useState(null);
      const [account, setAccount] = useState(null);
      const [booting, setBooting] = useState(true);
      const [busy, setBusy] = useState(false);
      const [notice, setNotice] = useState(null);
      const [tab, setTab] = useState("tasks");
      const [lastTaskId, setLastTaskId] = useState("");
      const [focus, setFocus] = useState({ id: "", nonce: 0 });
      const [catalogCounts, setCatalogCounts] = useState(null);
      const [historyByEntry, setHistoryByEntry] = useState({});
      const [syncedAt, setSyncedAt] = useState(null);
      const connectionRef = useRef(null);

      const applyAccount = useCallback((next, status) => {
        const resolved = status ?? connectionRef.current;
        connectionRef.current = resolved;
        setAccount(next);
        setConnection(resolved);
        setSyncedAt(Date.now());
        setTab("tasks");
        setNotice(null);
        const stored = store.read(scopedKey(resolved, next, "last"), "");
        const last = typeof stored === "string" && /^[1-9]\d{0,18}$/.test(stored) ? stored : "";
        setLastTaskId(last);
        setFocus({ id: last, nonce: 0 });
        const summaries = store.read(scopedKey(resolved, next, "summaries"), {});
        setHistoryByEntry(buildHistory(summaries));
      }, []);

      useEffect(() => {
        let alive = true;
        async function boot() {
          const status = await request("connection");
          if (!alive) return;
          if (!status.ok) {
            setNotice({ tone: "err", text: status.error.message });
            setBooting(false);
            return;
          }
          connectionRef.current = status.data;
          setConnection(status.data);
          if (status.data.configured) {
            const verified = await request("verify");
            if (!alive) return;
            if (verified.ok) applyAccount(verified.data, status.data);
            else setNotice({ tone: verified.error.code === "invalid_key" ? "warn" : "err", text: verified.error.message });
          }
          if (alive) setBooting(false);
        }
        void boot();
        return () => { alive = false; };
      }, [applyAccount, request]);

      const connect = useCallback(async (key) => {
        setBusy(true);
        setNotice(null);
        try {
          const result = key ? await request("connect", { key }) : await request("verify");
          if (!result.ok) throw new Error(result.error.message);
          const status = await request("connection");
          if (!status.ok) throw new Error(status.error.message);
          applyAccount(result.data, status.data);
          setNotice({ tone: "info", text: `已连接 ${result.data.name}，视图已切换到该账号。` });
        } finally {
          setBusy(false);
        }
      }, [applyAccount, request]);

      const remove = useCallback(async () => {
        setBusy(true);
        try {
          const result = await request("disconnect");
          if (!result.ok) throw new Error(result.error.message);
          setAccount(null);
          setLastTaskId("");
          setFocus({ id: "", nonce: 0 });
          setHistoryByEntry({});
          setCatalogCounts(null);
          const status = await request("connection");
          if (status.ok) { connectionRef.current = status.data; setConnection(status.data); }
          setNotice({ tone: "info", text: "已移除保存的 Key。" });
        } finally {
          setBusy(false);
        }
      }, [request]);

      /** One recovery path for manual lookup, list open, and a submit result. */
      const requestTask = useCallback((id) => {
        const next = String(id ?? "");
        setTab("tasks");
        setLastTaskId(next);
        setFocus((previous) => ({ id: next, nonce: previous.nonce + 1 }));
      }, []);

      const changeTab = useCallback((next) => {
        setTab(next);
        if (next === "discover" && account && connection) {
          setHistoryByEntry(buildHistory(store.read(scopedKey(connection, account, "summaries"), {})));
        }
      }, [account, connection]);

      const clearLocalCache = useCallback(() => {
        if (!account || !connection) return;
        store.remove(scopedKey(connection, account, "summaries"));
        store.remove(scopedKey(connection, account, "last"));
        setHistoryByEntry({});
        setLastTaskId("");
        setNotice({ tone: "info", text: "已清除本机任务缓存：最近任务与状态摘要。" });
      }, [account, connection]);

      const refreshCatalog = useCallback(async () => {
        const result = await request("catalog", { refresh: true });
        if (result.ok) {
          setCatalogCounts(result.data.counts);
          setNotice({ tone: "info", text: `已读取 ${result.data.counts.kit} 个 Kit、${result.data.counts.agent} 个 Agent。` });
        } else {
          setNotice({ tone: "err", text: result.error.message });
        }
      }, [request]);

      useEffect(() => {
        if (tab !== "settings" || !account || catalogCounts) return;
        let alive = true;
        void request("catalog").then((result) => {
          if (alive && result.ok) setCatalogCounts(result.data.counts);
        });
        return () => { alive = false; };
      }, [tab, account, catalogCounts, request]);

      const primaryAction = !account
        ? h("button", { type: "button", "data-variant": "primary", onClick: () => setTab("settings") }, "连接账号")
        : lastTaskId
          ? h("button", { type: "button", "data-variant": "primary", onClick: () => requestTask(lastTaskId) }, `继续查看 #${lastTaskId}`)
          : h("button", { type: "button", "data-variant": "primary", onClick: () => setTab("discover") }, "发现工具");

      const body = h("div", { className: "afgo2", "data-account": account?.id ?? "none" },
        h("style", null, styles),
        h("div", { className: "afgo2-head" },
          h("div", { className: "afgo2-actions" },
            h("h2", { className: "afgo2-title", style: { fontSize: "16px" } }, "AsterFire Go 工作台"),
            h(Chip, { plain: true }, `v${PLUGIN_VERSION}`)),
          h("span", { className: "afgo2-caption" }, "星使智算 · 科学计算")),
        h("div", { className: "afgo2-topbar" },
          h(ConnectionBar, {
            connection, account, syncedAt, syncError: null, tab,
            onOpenSettings: () => setTab("settings")
          }),
          account
            ? h("div", { className: "afgo2-actions" }, primaryAction,
                lastTaskId ? h("button", { type: "button", onClick: () => setTab("discover") }, "发现工具") : null,
                h("button", {
                  type: "button", "data-variant": "ghost",
                  onClick: () => {
                    setTab("tasks");
                    setTimeout(() => document.getElementById("afgo-task-query")?.focus(), 0);
                  }
                }, "输入任务编号"))
            : null,
          h(Tabs, {
            items: [
              { id: "tasks", label: "我的任务" },
              { id: "discover", label: "发现工具" },
              { id: "settings", label: "设置" }
            ],
            value: tab, onChange: changeTab, label: "工作台视图"
          })),
        notice ? h(Notice, { tone: notice.tone === "err" ? "err" : notice.tone }, notice.text) : null,
        !account && !booting
          ? h("div", { className: "afgo2-card" },
              h("div", { className: "afgo2-body" },
                h("p", { className: "afgo2-title" }, connection?.configured ? "重新验证账号以继续" : "连接你的星使智算账号"),
                h("p", { className: "afgo2-caption" },
                  "连接后可以恢复上次打开的任务、查看步骤耗时、下载产物；Key 由 DSH 宿主保存。"),
                h(ApiKeyForm, { connection, busy, onConnect: connect, onRemove: remove, compact: true })))
          : null,
        h("div", { id: "afgo-task-list-anchor" }),
        account && tab === "tasks"
          ? h(TasksSection, {
              key: `${connection?.baseUrl}|${account.id}`,
              request, connection, account,
              initialTaskId: focus.id || lastTaskId,
              focusNonce: focus.nonce,
              onSelectionChange: (id) => { setLastTaskId(id); store.write(scopedKey(connection, account, "last"), id); },
              onDiscover: () => setTab("discover")
            })
          : null,
        account && tab === "discover"
          ? h(DiscoverSection, {
              key: `${connection?.baseUrl}|${account.id}`,
              request, connection, account,
              historyByEntry,
              onOpenTask: requestTask
            })
          : null,
        account && tab === "settings"
          ? h(SettingsSection, {
              connection, account, busy, onConnect: connect, onRemove: remove,
              catalogCounts, onRefreshCatalog: refreshCatalog, onClearCache: clearLocalCache
            })
          : null,
        h("p", { className: "afgo2-caption" },
          "本页只读取平台数据：不提交计算、不发追问、不执行工作流。"));
      return body;
    }

    function buildHistory(summaries) {
      const map = {};
      for (const [id, entry] of Object.entries(summaries ?? {})) {
        const toolbox = entry?.toolbox;
        if (!toolbox?.name) continue;
        const type = entry.type === "agent" ? "agent" : "kit";
        const key = `${type}:${toolbox.name}`;
        if (!map[key]) {
          map[key] = { version: toolbox.version ?? null, taskId: id, at: entry.at ?? null };
        }
      }
      return map;
    }

    // ------------------------------------------------------------------
    // plugin entry
    // ------------------------------------------------------------------

    async function apply(ctx) {
      await ctx.remote.$mount({
        package: "afgo-dsh",
        descriptors: [{
          id: "afgo-dsh#afgoWorkbench/dispatch",
          service: "afgoWorkbench",
          namespace: "afgoWorkbench",
          method: "dispatch",
          invocation: { kind: "direct" },
          parameters: [{
            name: "input",
            wire: "input",
            source: "json",
            codec: {
              mode: "strict",
              typeSymbol: "afgo-dsh#WorkbenchInput",
              create: () => ({ parse(input) {
                if (!input || typeof input !== "object" || Array.isArray(input) || typeof input.action !== "string") {
                  throw new Error("无效的工作台请求。");
                }
                return input;
              } })
            }
          }],
          result: { mode: "src-json" }
        }]
      });
      await ctx.inject(["remote.afgoWorkbench"], (ui) => {
        const request = async (action, fields) => {
          const envelope = await ui.remote.afgoWorkbench.dispatch({ action, ...fields });
          if (!envelope?.ok) {
            return {
              ok: false,
              error: {
                code: "transport",
                message: envelope?.error?.message || "星使智算请求失败。",
                retryable: true
              }
            };
          }
          return envelope.value;
        };
        ui.slots.inject("plugins.bundle.config", () => ui.slots.register({
          name: "plugins.bundle.config",
          key: "afgo-dsh",
          inject: () => ({ request })
        }, Page));
      });
    }

    return {
      apply,
      inject: ["remote", "slots"],
      __test: {
        normalizeSearch, rankCatalog, searchCatalog,
        parseTime, formatBytes, formatDuration, clockOf, dateTimeOf, shortDateOf,
        executionOf, verdictOf, statusOfRow, timelineOf, eventsOf,
        primaryFileOf, primaryFileName, fileKind, parseCsv, decodeBase64Text,
        versionText, scopedKey
      }
    };
  }
});
