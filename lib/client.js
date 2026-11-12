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
 *     has not been opened shows a hollow dot (「未打开」) — the list never fans out one detail
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

    const PLUGIN_VERSION = "1.6.0";
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
    const OUTCOME_LABELS = { success: "成功", failed: "失败", partial: "部分完成", unknown: "待核实" };

    function verdictOf(task) {
      // The CLI's outcome (tasks get → outcome) reads structured_output and
      // the step-failed marker, which the page cannot see; when the host
      // passes it through it is the one verdict, so the workbench, the
      // conversation tools and the CLI agree.
      const outcome = task?.outcome;
      if (task?.isThinking !== true && outcome && OUTCOME_LABELS[outcome.state]) {
        const evidence = Array.isArray(outcome.evidence) ? outcome.evidence : [];
        const reason = outcome.state === "unknown"
          ? (task?.messages?.hasReadableReply
              ? "平台没有返回结构化成功信号，但已有可读回复；结论请以回复为准。"
              : `平台没有返回结构化成功信号，也没有可读回复${outcome.reason ? `（${outcome.reason}）` : ""}。`)
          : outcome.reason || OUTCOME_LABELS[outcome.state];
        return { state: outcome.state, label: OUTCOME_LABELS[outcome.state], reason, evidence, source: "cli" };
      }
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
      return { state: "unresolved", label: "未打开" };
    }

    /** Dot/chip tone per row or verdict state; `unread` is the hollow dot. */
    function toneOf(state) {
      if (state === "running" || state === "queued") return "run";
      if (state === "success" || state === "done") return "ok";
      if (state === "failed") return "err";
      if (state === "partial" || state === "unknown" || state === "stopped") return "warn";
      if (state === "unresolved") return "unread";
      return undefined;
    }

    /** List grouping by the row's last activity (local calendar days). */
    function dateGroupOf(iso, now = Date.now()) {
      const ms = parseTime(iso);
      if (ms == null) return "时间未返回";
      const startOfToday = new Date(now);
      startOfToday.setHours(0, 0, 0, 0);
      const today = startOfToday.getTime();
      if (ms >= today) return "今天";
      if (ms >= today - 24 * 60 * 60 * 1000) return "昨天";
      return "更早";
    }

    /**
     * Row label column: a short identifier column if there is one
     * (File_ID → term_000), otherwise the first text column whose values stay
     * short; -1 when nothing qualifies.
     */
    function labelColumnOf(rows, numericIndexes) {
      const textIndexes = (rows[0] ?? []).map((_, index) => index).filter((index) => !numericIndexes.has(index) &&
        rows.slice(1).some((row) => String(row[index] ?? "").trim()) &&
        rows.slice(1).every((row) => String(row[index] ?? "").trim().length <= 32));
      return textIndexes.find((index) => /^(label|name|id|file_?id|term(ination)?(_?id)?|system|structure)$/i.test(String(rows[0][index]).trim()))
        ?? textIndexes[0] ?? -1;
    }

    /** Axis ticks on 1/2/5 × 10ⁿ steps covering [low, high]; at most ~count+1 ticks. */
    function niceTicks(low, high, count = 4) {
      if (!Number.isFinite(low) || !Number.isFinite(high)) return [];
      if (low === high) return [low];
      const raw = (high - low) / count;
      const power = Math.pow(10, Math.floor(Math.log10(raw)));
      // nearest 1/2/5 step (log scale), so a range never collapses to one tick
      const step = [1, 2, 5, 10].map((m) => m * power)
        .reduce((best, candidate) => Math.abs(Math.log(candidate / raw)) < Math.abs(Math.log(best / raw)) ? candidate : best);
      const first = Math.ceil(low / step - 1e-9) * step;
      const ticks = [];
      for (let value = first; value <= high + step * 1e-9; value += step) ticks.push(Number(value.toPrecision(12)));
      return ticks;
    }

    /** 1 value → metric card, 2–30 → sorted bars, more → line in file order. */
    function chartKindOf(count) {
      if (count <= 0) return "none";
      if (count === 1) return "metric";
      return count <= 30 ? "bars" : "line";
    }

    /**
     * Zero-based bar geometry in percent of the track. All-positive bars grow
     * right from the left edge, all-negative bars grow left from the right
     * edge, mixed signs diverge from the zero line. Never min-anchored, so a
     * bar's length always reads as magnitude.
     */
    function barGeometryOf(values) {
      const low = Math.min(0, ...values);
      const high = Math.max(0, ...values);
      const span = high - low || 1;
      const at = (value) => (value - low) / span * 100;
      const zero = at(0);
      return values.map((value) => {
        const end = at(value);
        return { left: Math.min(zero, end), width: Math.max(Math.abs(end - zero), 0.6), zero };
      });
    }

    /**
     * Headline numbers from a result table, for the summary card. Picks the
     * same column the plot would pick, uses the first text column as the row
     * label, and never ranks rows as "best": with several rows it reports the
     * minimum and maximum as what they are.
     */
    function summaryMetricsOf(text, delimiter = ",") {
      const parsed = parseCsv(text, 201, delimiter);
      const rows = parsed.rows.filter((row) => row.some((cell) => String(cell).trim()));
      if (rows.length < 2) return null;
      const columns = numericColumns(rows);
      if (!columns.length) return null;
      const primary = columns.find((entry) => /^gamma_j_per_m2$/i.test(entry.name))
        ?? columns.find((entry) => /gamma|energy|rmsd|affinity|score/i.test(entry.name)) ?? columns[0];
      const labelIndex = labelColumnOf(rows, new Set(columns.map((entry) => entry.index)));
      const values = rows.slice(1).flatMap((row, index) => {
        const raw = String(row[primary.index] ?? "").trim();
        const value = Number(raw);
        return raw && Number.isFinite(value)
          ? [{ value, raw, row: index + 1, label: labelIndex >= 0 ? String(row[labelIndex] ?? "").trim() || null : null }]
          : [];
      });
      if (!values.length) return null;
      const label = columnLabelOf(primary.name);
      if (values.length === 1) {
        const only = values[0];
        const dataRow = rows[only.row];
        // Only columns we can name (a known quantity or a parsed unit), one per
        // quantity, never a second unit of the primary quantity.
        const seen = new Set([label.label]);
        const secondary = [];
        for (const entry of columns) {
          if (entry.index === primary.index || secondary.length >= 2) continue;
          const meta = columnLabelOf(entry.name);
          if (!meta.unit && meta.label === meta.raw) continue;
          if (seen.has(meta.label)) continue;
          const raw = String(dataRow[entry.index] ?? "").trim();
          if (!raw || !Number.isFinite(Number(raw))) continue;
          seen.add(meta.label);
          secondary.push({ label: meta.label, unit: meta.unit, value: formatValue(raw), raw, column: entry.name });
        }
        return {
          rows: 1,
          primary: { label: label.label, unit: label.unit, value: formatValue(only.raw), raw: only.raw, column: label.raw,
            context: only.label ?? `第 ${only.row} 行` },
          secondary
        };
      }
      const low = values.reduce((best, entry) => entry.value < best.value ? entry : best);
      const high = values.reduce((best, entry) => entry.value > best.value ? entry : best);
      return {
        rows: values.length,
        primary: { label: `${label.label}（最小）`, unit: label.unit, value: formatValue(low.raw), raw: low.raw, column: label.raw,
          context: `${low.label ?? `第 ${low.row} 行`} · 共 ${values.length} 行` },
        secondary: [
          { label: `${label.label}（最大）`, unit: label.unit, value: formatValue(high.raw), raw: high.raw, column: label.raw },
          { label: "数据行", unit: null, value: String(values.length), raw: String(values.length), column: null }
        ]
      };
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

    function visualizationCandidates(files) {
      const list = (files ?? []).filter((file) => file.visualization);
      // The host ranks with lib/visualization.js#rankCandidates (shared with
      // the conversation report); fall back to the local order otherwise.
      if (list.length && list.every((file) => Number.isInteger(file.rank))) {
        return list.slice().sort((a, b) => a.rank - b.rank);
      }
      return list
        .sort((a, b) => {
          const rank = (file) => {
            if (file.visualization.kind === "structure") return /final/i.test(file.name) ? 0 : 1;
            return file.visualization.kind === "image" ? 2 : 3;
          };
          return rank(a) - rank(b) || a.name.localeCompare(b.name, "en");
        });
    }

    /**
     * Which files feed the summary card: the table its numbers come from and
     * the image shown beside them. The primary-file rule wins; otherwise a
     * small result-looking table/image (same name hints the conversation
     * report uses), otherwise the first small one. Nothing is downloaded here.
     */
    function summarySourcesOf(toolboxName, files) {
      const list = files ?? [];
      const small = (file, limit) => file.size == null || file.size <= limit;
      const hinted = (file) => /rank|plot|summary|composition|energ|result|score/i.test(file.name);
      const primary = primaryFileOf(toolboxName, list);
      const tables = list.filter((file) => file.visualization?.kind === "table" && small(file, PREVIEW_LIMIT));
      const shared = list.find((file) => file.representative === "image");
      const table = primary && primary.visualization?.kind === "table" && small(primary, PREVIEW_LIMIT)
        ? primary
        : tables.find(hinted) ?? tables[0] ?? null;
      const images = list.filter((file) => file.visualization?.kind === "image" && small(file, MAX_DOWNLOAD));
      const image = shared ?? images.find(hinted) ?? images[0] ?? null;
      return { primary, table, image };
    }

    function numericColumns(rows) {
      if (rows.length < 2) return [];
      return rows[0].map((name, index) => ({ name, index })).filter(({ index }) =>
        rows.slice(1).some((row) => row[index]?.trim() && Number.isFinite(Number(row[index]))));
    }

    // ------------------------------------------------------------------
    // numbers and column labels (shown values never replace the raw value:
    // the raw string stays available as a title / copy target)
    // ------------------------------------------------------------------

    /**
     * Format a number for display: 5 significant digits by default, three
     * decimals at or above 1000 so energies like -1424.58761 keep meV detail,
     * and scientific notation for very small or very large magnitudes.
     */
    function formatValue(value, digits = 5) {
      const number = typeof value === "number" ? value : Number(String(value ?? "").trim());
      if (value == null || String(value).trim() === "" || !Number.isFinite(number)) return "—";
      if (number === 0) return "0";
      const magnitude = Math.abs(number);
      if (magnitude >= 1e7 || magnitude < 1e-4) {
        return number.toExponential(Math.max(digits - 1, 1)).replace(/\.?0+e/, "e");
      }
      if (magnitude >= 1000) {
        // Energies like -1424.58761 eV: keep the integer part whole and three
        // decimals, so differences in meV stay visible.
        return number.toFixed(3).replace(/\.?0+$/, "");
      }
      const text = number.toPrecision(digits);
      return text.includes("e") ? String(Number(text)) : text.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
    }

    // Unit suffixes as they appear in result column names (case-sensitive
    // where case carries meaning: `_A` is ångström, `_a` is not matched).
    const UNIT_SUFFIXES = [
      [/_J_per_m2$/i, "J/m²"], [/_meV_per_atom$/i, "meV/atom"], [/_eV_per_atom$/i, "eV/atom"],
      [/_eV_per_A2$/, "eV/Å²"], [/_eV_per_A$|_eV_A$|_eVA$/, "eV/Å"], [/_kcal_per_mol$|_kcal_mol$/i, "kcal/mol"], [/_kJ_per_mol$|_kJ_mol$/i, "kJ/mol"],
      [/_meV$/i, "meV"], [/_eV$/i, "eV"], [/_Ha$|_hartree$/i, "Ha"], [/_GPa$/i, "GPa"], [/_K$/, "K"],
      [/_A3$/, "Å³"], [/_A2$/, "Å²"], [/_A$/, "Å"], [/_angstrom$/i, "Å"], [/_nm$/i, "nm"], [/_ps$/i, "ps"], [/_fs$/i, "fs"],
      [/_deg$|_degree$/i, "°"], [/_pct$|_percent$/i, "%"]
    ];
    // Known quantity stems → readable label. Unknown stems keep the raw name.
    const QUANTITY_LABELS = [
      [/^gamma$|^surface_energy$/i, "表面能 γ"], [/^e_?ads$|^adsorption_energy$/i, "吸附能"],
      [/^e_?tot(al)?$|^total_energy$/i, "总能量"], [/^energy$/i, "能量"], [/^e_?form(ation)?$|^formation_energy$/i, "形成能"],
      [/^rmsd$/i, "RMSD"], [/^affinity$|^vina_score$|^docking_score$/i, "结合打分"],
      [/^band_?gap$/i, "带隙"], [/^homo$/i, "HOMO"], [/^lumo$/i, "LUMO"], [/^volume$/i, "体积"],
      [/^density$/i, "密度"], [/^pressure$/i, "压力"], [/^temperature$|^temp$/i, "温度"],
      [/^area$/i, "面积"], [/^num_?atoms$|^n_?atoms$/i, "原子数"], [/^e_?slab$/i, "slab 能量"],
      [/^final_?fmax$|^fmax$|^(relax_?)?max_?force$/i, "最大残余力"], [/^excess_?energy$/i, "过剩能"]
    ];

    /**
     * Split a result column name into a readable label and unit. The raw name
     * is always returned so the UI can show it in a hint; a column we do not
     * recognise keeps its raw name as the label and gets no unit.
     */
    function columnLabelOf(name) {
      const raw = String(name ?? "").trim();
      let stem = raw;
      let unit = null;
      for (const [pattern, symbol] of UNIT_SUFFIXES) {
        if (pattern.test(stem)) { unit = symbol; stem = stem.replace(pattern, ""); break; }
      }
      const known = QUANTITY_LABELS.find(([pattern]) => pattern.test(stem));
      const label = known ? known[1] : (unit ? stem : raw) || raw;
      return { label, unit, raw };
    }

    /** Minimal RFC4180 parser: quotes, doubled quotes, CRLF, BOM. */
    function parseCsv(text, limitRows = 40, delimiter = ",") {
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
        if (char === delimiter) { row.push(field); field = ""; index += 1; continue; }
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

    /**
     * Download file name. With `ext`, the name gets that extension exactly once
     * and inner dots become dashes (`slab.cif-frame-1.png` → `slab-cif-frame-1.png`),
     * so a save dialog that detects extensions does not produce `.png.png`.
     * Without `ext` the original name is kept, only a repeated trailing
     * extension (`a.png.png`) is collapsed. Path separators are never kept.
     */
    function exportName(name, ext) {
      let base = String(name ?? "").trim().replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_") || "asterfire-result";
      if (!ext) return base.replace(/(\.[A-Za-z0-9]{1,8})\1+$/i, "$1");
      const suffix = `.${String(ext).replace(/^\./, "").toLowerCase()}`;
      while (base.toLowerCase().endsWith(suffix)) base = base.slice(0, -suffix.length);
      base = base.replace(/\.+/g, "-").replace(/^-+|-+$/g, "") || "asterfire-result";
      return `${base}${suffix}`;
    }

    function saveDownload(file, ext) {
      const binary = atob(String(file.content ?? ""));
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      const blob = new Blob([bytes], { type: file.mime || "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = exportName(file.name, ext);
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

    // Design tokens (docs/UX_V3_DESIGN.md §2). Every colour maps to a DSH
    // host variable so light/dark follow the host; the hex values are only
    // fallbacks for a host that does not define the variable.
    const tokens = `
      .afgo2, .afgo2-scope {
        --afgo-s1:4px; --afgo-s2:8px; --afgo-s3:12px; --afgo-s4:16px; --afgo-s5:24px; --afgo-s6:32px;
        --afgo-r-s:6px; --afgo-r-m:8px; --afgo-r-l:12px;
        --afgo-fs-xs:12px; --afgo-fs-s:13px; --afgo-fs-m:14px; --afgo-fs-l:16px; --afgo-fs-xl:20px; --afgo-fs-xxl:28px;
        --afgo-fg:var(--dsw-alias-label-primary, #0f1115);
        --afgo-fg-2:var(--dsw-alias-label-secondary, #61666b);
        --afgo-fg-3:var(--dsw-alias-label-tertiary, #81858c);
        --afgo-fg-4:var(--dsw-alias-label-caption, #9aa0a6);
        --afgo-bg:var(--dsw-alias-bg-base, #fff);
        --afgo-layer-1:var(--dsw-alias-bg-layer-1, transparent);
        --afgo-layer-2:var(--dsw-alias-bg-layer-2, #f7f8fa);
        --afgo-line-1:var(--dsw-alias-border-l1, #0000000a);
        --afgo-line-2:var(--dsw-alias-border-l2, #0000001a);
        --afgo-line-3:var(--dsw-alias-border-l3, #0000001f);
        --afgo-accent:var(--dsw-alias-link, #4176e6);
        --afgo-ok:var(--dsw-alias-state-success-primary, #12863c);
        --afgo-ok-soft:var(--dsw-alias-state-success-tertiary, #e6faed);
        --afgo-warn:var(--dsw-alias-state-warn-label, #a35b0b);
        --afgo-warn-dot:var(--dsw-alias-state-warn-primary, #f59e0b);
        --afgo-warn-soft:var(--dsw-alias-state-warn-tertiary, #fef5e7);
        --afgo-err:var(--dsw-alias-state-error-primary, #ec1313);
        --afgo-err-soft:var(--dsw-alias-state-error-tertiary, #fee2e2);
        --afgo-chart-1:var(--afgo-accent);
        --afgo-chart-muted:var(--afgo-line-3);
      }
    `;

    const styles = tokens + `
      .afgo2 { display:flex; flex-direction:column; gap:16px; margin:12px 0; min-width:0;
        color:var(--afgo-fg);
        font-family:var(--dsh-font-family-text, inherit); font-size:var(--afgo-fs-m); line-height:1.55; }
      .afgo2 *, .afgo2 *::before, .afgo2 *::after { box-sizing:border-box; }
      .afgo2 h2, .afgo2 h3, .afgo2 h4, .afgo2 p { margin:0; }
      .afgo2 ul, .afgo2 ol { margin:0; padding:0; list-style:none; }
      .afgo2 button, .afgo2 input, .afgo2 select { font:inherit; color:inherit; }
      .afgo2 button { background:transparent; border:1px solid var(--afgo-line-3);
        border-radius:var(--afgo-r-m); min-height:32px; padding:5px 12px; cursor:pointer; }
      .afgo2 button:hover:not(:disabled) { background:var(--dsw-alias-interactive-bg-hover, #2631480f); }
      .afgo2 button:disabled { opacity:.5; cursor:not-allowed; }
      .afgo2 button[data-variant=primary] { background:var(--dsw-alias-button-primary-fill, #0f1115);
        border-color:transparent; color:var(--dsw-alias-label-primary-foreground, #fff); }
      .afgo2 button[data-variant=ghost] { border-color:transparent; }
      .afgo2 button[data-variant=link] { border:0; padding:0; min-height:0; color:var(--afgo-accent); text-decoration:underline; }
      .afgo2 a { color:var(--afgo-accent); }
      .afgo2 a:focus-visible, .afgo2 button:focus-visible, .afgo2 input:focus-visible,
      .afgo2 select:focus-visible, .afgo2 [tabindex]:focus-visible {
        outline:2px solid var(--afgo-accent); outline-offset:2px; }
      .afgo2 input, .afgo2 select { background:var(--afgo-bg);
        border:1px solid var(--afgo-line-3); border-radius:var(--afgo-r-m);
        min-height:32px; padding:5px 10px; min-width:0; max-width:100%; }
      .afgo2-muted { color:var(--afgo-fg-2); }
      .afgo2-caption { color:var(--afgo-fg-4); font-size:var(--afgo-fs-xs); }
      .afgo2-mono { font-family:var(--dsh-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace); }
      .afgo2-wrap { overflow-wrap:anywhere; word-break:break-word; min-width:0; }
      .afgo2-card { background:var(--afgo-layer-1);
        border:1px solid var(--afgo-line-2); border-radius:var(--afgo-r-l); min-width:0; }
      .afgo2-chip { display:inline-flex; align-items:center; gap:6px; padding:1px 8px; border-radius:999px;
        font-size:var(--afgo-fs-xs); line-height:18px; white-space:nowrap; border:1px solid var(--afgo-line-2);
        background:var(--afgo-layer-2); color:var(--afgo-fg-2); }
      .afgo2-chip[data-tone=ok] { background:var(--afgo-ok-soft); border-color:transparent;
        color:var(--afgo-ok); }
      .afgo2-chip[data-tone=warn] { background:var(--afgo-warn-soft); border-color:transparent;
        color:var(--afgo-warn); }
      .afgo2-chip[data-tone=err] { background:var(--afgo-err-soft); border-color:transparent;
        color:var(--afgo-err); }
      .afgo2-chip[data-tone=plain] { background:transparent; }
      .afgo2-dot { width:8px; height:8px; border-radius:50%; flex:none; background:var(--afgo-fg-4); }
      .afgo2-dot[data-tone=ok] { background:var(--afgo-ok); }
      .afgo2-dot[data-tone=warn] { background:var(--afgo-warn-dot); }
      .afgo2-dot[data-tone=err] { background:var(--afgo-err); }
      .afgo2-notice { display:flex; gap:8px; align-items:flex-start; padding:8px 12px; border-radius:var(--afgo-r-m);
        font-size:var(--afgo-fs-s); border:1px solid transparent; }
      .afgo2-notice[data-tone=warn] { background:var(--afgo-warn-soft);
        color:var(--afgo-warn); }
      .afgo2-notice[data-tone=err] { background:var(--afgo-err-soft);
        color:var(--afgo-err); }
      .afgo2-notice[data-tone=info] { background:var(--afgo-layer-2);
        color:var(--afgo-fg-2); }
      .afgo2-env { display:flex; gap:6px; align-items:center; flex-wrap:wrap; font-size:var(--afgo-fs-xs);
        color:var(--afgo-fg-3); }
      .afgo2-actions { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
      .afgo2-topbar { position:sticky; top:0; z-index:8; display:flex; flex-direction:column; gap:10px;
        background:var(--afgo-bg); padding:2px 0 8px; }
      #afgo-task-list-anchor { scroll-margin-top:120px; }
      .afgo2-tabs { display:flex; gap:2px; border-bottom:1px solid var(--afgo-line-2); }
      .afgo2-tab { border:0 !important; border-radius:0 !important; border-bottom:2px solid transparent !important;
        padding:8px 12px !important; color:var(--afgo-fg-2); background:transparent; min-height:36px; }
      .afgo2-tab[aria-selected=true] { color:var(--afgo-fg) !important;
        border-bottom-color:var(--afgo-fg) !important; font-weight:600; }
      .afgo2-tab:hover { background:transparent !important; color:var(--afgo-fg) !important; }
      .afgo2-head { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; flex-wrap:wrap; }
      .afgo2-title { font-size:var(--afgo-fs-l); font-weight:600; line-height:1.4; overflow-wrap:anywhere; }
      .afgo2-detail-head .afgo2-title { display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden; }
      .afgo2-sub { font-size:var(--afgo-fs-xs); color:var(--afgo-fg-3); }
      .afgo2-tasks { display:grid; grid-template-columns:minmax(280px, 360px) minmax(0, 1fr);
        gap:16px; align-items:start; min-width:0; }
      .afgo2-listpane, .afgo2-detailpane { display:flex; flex-direction:column; gap:10px; min-width:0; }
      .afgo2-filters { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
      .afgo2-filters input { flex:1 1 140px; }
      .afgo2-list { display:flex; flex-direction:column; gap:2px; padding:4px;
        max-height:min(64vh, 620px); overflow:auto; }
      .afgo2-row { display:grid; grid-template-columns:auto minmax(0,1fr); gap:10px; text-align:left;
        align-items:flex-start; border:1px solid transparent !important; background:transparent;
        border-radius:var(--afgo-r-m); padding:10px; min-height:0; }
      .afgo2-row[aria-current=true] { background:var(--afgo-layer-2);
        border-color:var(--afgo-line-2) !important; }
      .afgo2-row-title { font-weight:600; font-size:var(--afgo-fs-s); line-height:1.45; overflow-wrap:anywhere;
        display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
      .afgo2-row-meta { display:flex; gap:6px; align-items:center; flex-wrap:wrap; margin-top:4px;
        font-size:var(--afgo-fs-xs); color:var(--afgo-fg-3); min-width:0; }
      .afgo2-row-meta .afgo2-mono { overflow-wrap:anywhere; }
      .afgo2-status-strip { display:grid; grid-template-columns:repeat(auto-fit, minmax(150px, 1fr));
        gap:8px; padding:12px 16px; border-top:1px solid var(--afgo-line-1); }
      .afgo2-status { display:flex; flex-direction:column; gap:2px; padding:8px 10px; border-radius:var(--afgo-r-m);
        background:var(--afgo-layer-2); min-width:0; }
      .afgo2-status .k { font-size:11px; color:var(--afgo-fg-4); }
      .afgo2-status .v { font-weight:600; display:flex; align-items:center; gap:6px; font-size:var(--afgo-fs-s); }
      .afgo2-status .h { font-size:var(--afgo-fs-xs); color:var(--afgo-fg-3); overflow-wrap:anywhere; }
      .afgo2-detail-head { display:flex; flex-direction:column; gap:8px; padding:14px 16px; }
      .afgo2-meta { display:grid; grid-template-columns:repeat(auto-fit, minmax(170px, 1fr)); gap:8px 16px; }
      .afgo2-meta div { min-width:0; }
      .afgo2-meta b { display:block; font-size:11px; font-weight:500; color:var(--afgo-fg-4); }
      .afgo2-meta span { display:block; font-size:var(--afgo-fs-xs); color:var(--afgo-fg-2); overflow-wrap:anywhere; }
      .afgo2-section { display:flex; flex-direction:column; min-width:0; }
      .afgo2-section-head { display:flex; align-items:center; justify-content:space-between; gap:8px;
        padding:10px 16px; border-bottom:1px solid var(--afgo-line-1); flex-wrap:wrap; }
      .afgo2-section-head h3 { font-size:var(--afgo-fs-s); font-weight:600; }
      .afgo2-body { padding:12px 16px; display:flex; flex-direction:column; gap:10px; min-width:0; }
      .afgo2-kv { display:grid; grid-template-columns:minmax(120px, 38%) minmax(0,1fr); gap:4px 12px; font-size:var(--afgo-fs-s); }
      .afgo2-kv dt { color:var(--afgo-fg-3); }
      .afgo2-kv dd { margin:0; overflow-wrap:anywhere; }
      .afgo2-tl { display:flex; flex-direction:column; padding:8px 16px 12px; gap:2px; }
      .afgo2-axis { display:grid; grid-template-columns:minmax(140px, 38%) minmax(0,1fr) 96px; gap:12px;
        padding:4px 0; font-size:11px; color:var(--afgo-fg-4); }
      .afgo2-ticks { display:flex; justify-content:space-between; gap:4px; }
      .afgo2-tl-row { display:grid; grid-template-columns:minmax(140px, 38%) minmax(0,1fr) 96px;
        gap:12px; align-items:center; padding:8px 0; border-top:1px solid var(--afgo-line-1); }
      .afgo2-tl-name { display:flex; flex-direction:column; gap:1px; min-width:0; }
      .afgo2-tl-name b { font-size:var(--afgo-fs-s); overflow-wrap:anywhere; }
      .afgo2-tl-name span { font-size:11px; color:var(--afgo-fg-4); overflow-wrap:anywhere; }
      .afgo2-track { position:relative; height:26px; border-radius:var(--afgo-r-s);
        background:var(--afgo-layer-2); overflow:hidden; }
      .afgo2-track .tick { position:absolute; top:0; bottom:0; width:1px;
        background:var(--afgo-line-2); }
      .afgo2-bar { position:absolute; top:7px; height:12px; border-radius:3px;
        background:var(--dsw-alias-state-success-secondary, #4ed17e); }
      .afgo2-bar[data-kind=queue] { top:8px; height:10px; background:transparent;
        border:1px dashed var(--dsw-alias-border-l4, #00000029); }
      .afgo2-bar[data-tone=warn] { background:var(--afgo-warn-dot); }
      .afgo2-bar[data-tone=err] { background:var(--afgo-err); }
      .afgo2-point { position:absolute; top:9px; width:8px; height:8px; border-radius:50%;
        background:var(--afgo-fg-2); transform:translateX(-4px); }
      .afgo2-tl-dur { font-size:var(--afgo-fs-xs); text-align:right; color:var(--afgo-fg-2);
        font-variant-numeric:tabular-nums; overflow-wrap:anywhere; }
      .afgo2-expand { grid-column:1 / -1; }
      .afgo2-expand .afgo2-kv { font-size:var(--afgo-fs-xs); }
      .afgo2-events { display:flex; flex-direction:column; gap:2px; }
      .afgo2-event { display:grid; grid-template-columns:76px minmax(0,1fr) auto; gap:10px;
        font-size:var(--afgo-fs-xs); padding:3px 0; align-items:baseline; }
      .afgo2-event .t { color:var(--afgo-fg-4); font-variant-numeric:tabular-nums; }
      .afgo2-event .s { color:var(--afgo-fg-4); }
      .afgo2-files { display:flex; flex-direction:column; gap:6px; }
      .afgo2-file { display:grid; grid-template-columns:minmax(0,1fr) 64px 72px auto; gap:10px;
        align-items:center; padding:8px; border:1px solid var(--afgo-line-1); border-radius:var(--afgo-r-m); }
      .afgo2-file[data-primary=true] { background:var(--afgo-ok-soft);
        border-color:transparent; }
      .afgo2-file-name { display:flex; align-items:center; gap:8px; min-width:0; font-size:var(--afgo-fs-s); }
      .afgo2-file-meta { font-size:var(--afgo-fs-xs); color:var(--afgo-fg-3); text-align:right; }
      .afgo2-file-actions { text-align:right; display:flex; gap:6px; justify-content:flex-end; }
      .afgo2-preview { max-height:280px; overflow:auto; border:1px solid var(--afgo-line-2);
        border-radius:var(--afgo-r-m); padding:8px; background:var(--afgo-bg); }
      .afgo2-preview pre { margin:0; white-space:pre-wrap; overflow-wrap:anywhere; font-size:var(--afgo-fs-xs);
        font-family:var(--dsh-font-family-code, ui-monospace, monospace); }
      .afgo2-table { border-collapse:collapse; width:100%; font-size:var(--afgo-fs-xs); }
      .afgo2-table th, .afgo2-table td { text-align:left; padding:3px 6px;
        border-bottom:1px solid var(--afgo-line-1); overflow-wrap:anywhere; }
      .afgo2-table th { color:var(--afgo-fg-3); font-weight:500; }
      .afgo2-discover { display:grid; grid-template-columns:minmax(260px, 380px) minmax(0,1fr); gap:16px; }
      .afgo2-results { display:flex; flex-direction:column; gap:2px; padding:4px; max-height:min(60vh, 560px); overflow:auto; }
      .afgo2-result { display:flex; flex-direction:column; gap:3px; text-align:left; border:1px solid transparent !important;
        border-radius:var(--afgo-r-m); padding:9px 10px; min-height:0; align-items:stretch; }
      .afgo2-result[aria-current=true] { background:var(--afgo-layer-2);
        border-color:var(--afgo-line-2) !important; }
      .afgo2-result .n { font-weight:600; font-size:var(--afgo-fs-s); overflow-wrap:anywhere; }
      .afgo2-result .r { font-size:var(--afgo-fs-xs); color:var(--afgo-fg-2); overflow-wrap:anywhere; }
      .afgo2-result .m { display:flex; gap:6px; flex-wrap:wrap; font-size:var(--afgo-fs-xs); color:var(--afgo-fg-4); }
      .afgo2-empty { display:flex; flex-direction:column; gap:6px; align-items:flex-start;
        padding:20px 16px; border:1px dashed var(--afgo-line-3); border-radius:var(--afgo-r-m); }
      .afgo2-empty b { font-size:var(--afgo-fs-s); }
      .afgo2-settings { display:grid; gap:12px; }
      .afgo2-form { display:flex; gap:8px; flex-wrap:wrap; align-items:flex-end; }
      .afgo2-form label { display:flex; flex-direction:column; gap:4px; font-size:var(--afgo-fs-xs);
        color:var(--afgo-fg-2); flex:1 1 240px; min-width:0; }
      .afgo2-check { display:flex; gap:8px; align-items:flex-start; font-size:var(--afgo-fs-s); }
      .afgo2-check input { min-height:0; margin-top:3px; }
      .afgo2-sr { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden;
        clip:rect(0 0 0 0); white-space:nowrap; border:0; }
      .afgo2-back { display:none; }
      /* v3 shared components (docs/UX_V3_DESIGN.md §3) */
      .afgo2-num { font-variant-numeric:tabular-nums; }
      .afgo2-dot[data-tone=run] { background:var(--afgo-accent); animation:afgo-pulse 1.6s infinite; }
      .afgo2-dot[data-tone=unread] { background:transparent; border:1.5px solid var(--afgo-fg-4); }
      @keyframes afgo-pulse { 0% { box-shadow:0 0 0 0 color-mix(in srgb, var(--afgo-accent) 55%, transparent); }
        70% { box-shadow:0 0 0 6px transparent; } 100% { box-shadow:0 0 0 0 transparent; } }
      .afgo2-chip[data-tone=run] { background:color-mix(in srgb, var(--afgo-accent) 14%, transparent);
        border-color:transparent; color:var(--afgo-accent); }
      .afgo2-hint { display:inline-grid; place-items:center; width:16px; height:16px; border-radius:50%; flex:none;
        border:1px solid var(--afgo-line-3); color:var(--afgo-fg-3); font-size:10px; font-weight:600;
        font-style:normal; line-height:1; cursor:help; position:relative; vertical-align:middle; }
      .afgo2-hint:hover::after, .afgo2-hint:focus-visible::after { content:attr(data-tip); position:absolute; left:50%; top:22px;
        transform:translateX(-50%); width:max-content; max-width:260px; padding:8px 10px; border-radius:var(--afgo-r-m);
        background:var(--afgo-layer-2); border:1px solid var(--afgo-line-2); color:var(--afgo-fg-2);
        font-size:var(--afgo-fs-xs); font-weight:400; line-height:1.5; z-index:20; white-space:normal;
        text-align:left; box-shadow:0 8px 24px #0000002e; }
      .afgo2-metric { display:flex; flex-direction:column; gap:2px; min-width:0; }
      .afgo2-metric .k { font-size:var(--afgo-fs-xs); color:var(--afgo-fg-3); display:flex; gap:6px; align-items:center; }
      .afgo2-metric .v { font-size:var(--afgo-fs-xxl); font-weight:600; line-height:1.2; letter-spacing:-.01em;
        font-variant-numeric:tabular-nums; overflow-wrap:anywhere; }
      .afgo2-metric .v small { font-size:var(--afgo-fs-m); font-weight:500; color:var(--afgo-fg-2); margin-left:4px; letter-spacing:0; }
      .afgo2-metric .c { font-size:var(--afgo-fs-xs); color:var(--afgo-fg-3); overflow-wrap:anywhere; }
      .afgo2-metric[data-size=m] .v { font-size:var(--afgo-fs-xl); }
      .afgo2-metric-card { padding:var(--afgo-s4) var(--afgo-s5); }
      .afgo2-disclosure { border-top:1px solid var(--afgo-line-1); }
      .afgo2-disclosure > summary { cursor:pointer; list-style:none; padding:10px 0 0; font-size:var(--afgo-fs-xs);
        color:var(--afgo-fg-3); display:flex; align-items:center; gap:6px; }
      .afgo2-disclosure > summary::-webkit-details-marker { display:none; }
      .afgo2-disclosure > summary::before { content:"›"; display:inline-block; transition:transform .15s; font-size:14px; }
      .afgo2-disclosure[open] > summary::before { transform:rotate(90deg); }
      .afgo2-disclosure-body { padding-top:var(--afgo-s2); }
      .afgo2-skel { display:block; border-radius:4px; height:12px;
        background:linear-gradient(90deg, var(--afgo-layer-2) 0%, var(--afgo-line-2) 50%, var(--afgo-layer-2) 100%);
        background-size:200% 100%; animation:afgo-shimmer 1.4s infinite; }
      @keyframes afgo-shimmer { from { background-position:200% 0; } to { background-position:-200% 0; } }
      .afgo2-skeleton { display:flex; flex-direction:column; gap:var(--afgo-s3); padding:var(--afgo-s4); }
      .afgo2-chart { display:flex; flex-direction:column; gap:var(--afgo-s3); min-width:0; }
      .afgo2-chart-head { display:flex; align-items:baseline; justify-content:space-between; gap:var(--afgo-s3); flex-wrap:wrap; }
      .afgo2-chart-head h4 { font-size:var(--afgo-fs-s); font-weight:600; margin:0; }
      .afgo2-hbar { display:grid; grid-template-columns:minmax(56px, max-content) minmax(0,1fr) max-content;
        gap:6px var(--afgo-s3); align-items:center; font-size:var(--afgo-fs-xs); }
      .afgo2-hbar .lab { color:var(--afgo-fg-2); font-family:var(--dsh-font-family-code, ui-monospace, monospace);
        max-width:160px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .afgo2-hbar .track { height:14px; position:relative; }
      .afgo2-hbar .fill { position:absolute; top:0; bottom:0; border-radius:3px; background:var(--afgo-chart-muted); min-width:2px; }
      .afgo2-hbar .zero { position:absolute; top:-3px; bottom:-3px; width:1px; background:var(--afgo-fg-4); }
      .afgo2-hbar .fill[data-hi=true] { background:var(--afgo-chart-1); }
      .afgo2-hbar .val { text-align:right; font-variant-numeric:tabular-nums; color:var(--afgo-fg-2); }
      .afgo2-hbar .val[data-hi=true] { color:var(--afgo-fg); font-weight:600; }
      .afgo2-svgchart { width:100%; height:auto; display:block; }
      .afgo2-svgchart text { fill:var(--afgo-fg-3); font-size:11px; font-family:var(--dsh-font-family-text, inherit); }
      .afgo2-svgchart .grid { stroke:var(--afgo-line-2); }
      .afgo2-svgchart .axis { stroke:var(--afgo-line-3); }
      .afgo2-svgchart .line { stroke:var(--afgo-chart-1); fill:none; stroke-width:2; }
      .afgo2-svgchart .pt { fill:var(--afgo-chart-1); }
      .afgo2-svgchart .last-label { fill:var(--afgo-fg); }
      .afgo2-seg { display:flex; gap:var(--afgo-s1); flex-wrap:wrap; }
      .afgo2-seg button { min-height:28px; padding:2px 10px; border-color:var(--afgo-line-2); color:var(--afgo-fg-2);
        font-size:var(--afgo-fs-xs); }
      .afgo2-seg button[aria-pressed=true] { background:var(--afgo-layer-2); border-color:var(--afgo-line-3); color:var(--afgo-fg); }
      .afgo2-seg .kind { color:var(--afgo-fg-4); margin-left:4px; }
      .afgo2-structure { position:relative; }
      .afgo2-viewer-frame { display:block; width:100%; aspect-ratio:4 / 3; min-height:360px; max-height:620px;
        border:1px solid var(--afgo-line-2); border-radius:var(--afgo-r-l); background:var(--afgo-bg); }
      .afgo2-structure[data-expanded=true] { position:fixed; inset:0; z-index:1000; background:var(--afgo-bg);
        padding:var(--afgo-s3); display:flex; flex-direction:column; gap:var(--afgo-s2); }
      .afgo2-structure[data-expanded=true] .afgo2-viewer-frame { flex:1 1 auto; height:auto; max-height:none; aspect-ratio:auto; min-height:0; }
      .afgo2 .afgo2-viewer-close { align-self:flex-end; order:-1; }
      .afgo2 button.afgo2-zoom { display:block; padding:0; border:1px solid var(--afgo-line-2); border-radius:var(--afgo-r-l);
        background:var(--afgo-layer-2); cursor:zoom-in; overflow:hidden; max-width:100%; min-height:0; }
      .afgo2-zoom img { display:block; max-width:100%; max-height:520px; object-fit:contain; }
      .afgo2-lightbox { position:fixed; inset:0; z-index:1000; display:flex; flex-direction:column; align-items:center; justify-content:center;
        gap:var(--afgo-s3); padding:var(--afgo-s5); background:color-mix(in srgb, var(--afgo-bg) 92%, transparent); cursor:zoom-out; }
      .afgo2-lightbox img { max-width:100%; max-height:calc(100vh - 96px); object-fit:contain; border-radius:var(--afgo-r-m);
        box-shadow:0 12px 40px #0000004d; background:#fff; }
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
    ` + `
      /* ---- v3 stage B: workbench layout (docs/UX_V3_DESIGN.md §4.1–4.3) ---- */
      .afgo2-topbar { position:static; gap:var(--afgo-s3); padding:0; }
      .afgo2-headbar { display:flex; align-items:center; gap:var(--afgo-s3); flex-wrap:wrap; min-width:0; }
      .afgo2-brand { font-size:var(--afgo-fs-l); font-weight:600; white-space:nowrap; }
      .afgo2 button.afgo2-account { display:inline-flex; align-items:center; gap:8px; min-height:30px; padding:0 var(--afgo-s3);
        border-radius:999px; background:var(--afgo-layer-2); border-color:transparent; font-size:var(--afgo-fs-xs);
        color:var(--afgo-fg-2); min-width:0; max-width:100%; }
      .afgo2-account b { color:var(--afgo-fg); font-weight:600; }
      .afgo2-account .sep { color:var(--afgo-fg-4); }
      .afgo2-account .env { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .afgo2-spacer { flex:1 1 auto; }
      .afgo2-open { display:flex; align-items:center; border:1px solid var(--afgo-line-3); border-radius:var(--afgo-r-m);
        background:var(--afgo-bg); min-height:32px; padding-left:10px; }
      .afgo2-open:focus-within { outline:2px solid var(--afgo-accent); outline-offset:1px; }
      .afgo2-open .hash { color:var(--afgo-fg-4); font-size:var(--afgo-fs-s); }
      .afgo2 .afgo2-open input { border:0; background:transparent; width:120px; padding:0 6px; min-height:30px; outline:none; }
      .afgo2 .afgo2-open button { border:0; border-left:1px solid var(--afgo-line-3); border-radius:0 var(--afgo-r-m) var(--afgo-r-m) 0;
        min-height:30px; font-size:var(--afgo-fs-s); }
      .afgo2-open-error { font-size:var(--afgo-fs-xs); color:var(--afgo-err); }

      .afgo2-tasks { grid-template-columns:minmax(260px, 320px) minmax(0, 1fr); gap:var(--afgo-s5); }
      .afgo2-listpane { position:sticky; top:var(--afgo-s3); max-height:calc(100vh - 24px); gap:var(--afgo-s2); }
      .afgo2-listpane .afgo2-filters { flex-wrap:nowrap; }
      .afgo2-listpane .afgo2-filters input { flex:1 1 auto; min-width:0; }
      .afgo2-listpane .afgo2-filters select { flex:none; max-width:96px; }
      .afgo2-list { max-height:none; overflow:auto; padding:0; margin:0 -4px; padding:0 4px; flex:1 1 auto; min-height:0; gap:0; }
      .afgo2-group { font-size:11px; color:var(--afgo-fg-4); padding:var(--afgo-s3) var(--afgo-s2) var(--afgo-s1); }
      .afgo2-row { grid-template-columns:8px minmax(0,1fr); gap:10px; align-items:baseline; padding:9px var(--afgo-s2);
        border-radius:var(--afgo-r-m); width:100%; }
      .afgo2-row:hover { background:var(--dsw-alias-interactive-bg-hover, #2631480f); }
      .afgo2-row[aria-current=true] { background:var(--afgo-layer-2); border-color:transparent !important; }
      .afgo2-row .afgo2-dot { transform:translateY(-1px); }
      .afgo2-row-title { -webkit-line-clamp:1; font-size:var(--afgo-fs-s); }
      .afgo2-row-meta { margin-top:2px; gap:6px; flex-wrap:nowrap; overflow:hidden; white-space:nowrap; }
      .afgo2-row-meta .sep { color:var(--afgo-fg-4); }
      .afgo2-row-meta .tool { overflow:hidden; text-overflow:ellipsis; min-width:0; }
      .afgo2-list-foot { display:flex; align-items:center; gap:var(--afgo-s2); padding:var(--afgo-s1) 0; }

      .afgo2-detail { display:flex; flex-direction:column; gap:var(--afgo-s4); min-width:0; }
      .afgo2-dhead { display:flex; flex-direction:column; gap:6px; min-width:0; }
      .afgo2-eyebrow { display:flex; gap:6px; align-items:center; flex-wrap:wrap; font-size:var(--afgo-fs-xs); color:var(--afgo-fg-3); }
      .afgo2-eyebrow .sep { color:var(--afgo-fg-4); }
      .afgo2-dtitle { font-size:var(--afgo-fs-xl); font-weight:600; line-height:1.35; overflow-wrap:anywhere;
        display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
      .afgo2-signals { display:flex; gap:var(--afgo-s4); flex-wrap:wrap; align-items:center; font-size:var(--afgo-fs-xs); color:var(--afgo-fg-3); }
      .afgo2-signal { display:inline-flex; align-items:center; gap:6px; }
      .afgo2-signal b { color:var(--afgo-fg); font-weight:500; font-size:var(--afgo-fs-s); }
      .afgo2-summary { display:grid; grid-template-columns:minmax(0,1fr) auto; overflow:hidden; }
      .afgo2-summary-main { padding:var(--afgo-s4) var(--afgo-s5); display:flex; flex-direction:column; gap:var(--afgo-s3); min-width:0; }
      .afgo2-summary-media { background:var(--afgo-layer-2); border-left:1px solid var(--afgo-line-2); width:240px;
        display:grid; place-items:center; padding:var(--afgo-s2); }
      .afgo2-summary-media img { max-width:100%; max-height:200px; object-fit:contain; border-radius:var(--afgo-r-s); }
      .afgo2-metrics { display:flex; gap:var(--afgo-s5) var(--afgo-s6); flex-wrap:wrap; }
      .afgo2-summary-actions { display:flex; gap:var(--afgo-s2); flex-wrap:wrap; }
      .afgo2-inputs { display:flex; gap:6px; flex-wrap:wrap; }
      .afgo2-input { display:inline-flex; gap:6px; align-items:baseline; padding:2px 8px; border-radius:var(--afgo-r-s);
        background:var(--afgo-layer-2); font-size:var(--afgo-fs-xs); max-width:100%; }
      .afgo2-input .k { color:var(--afgo-fg-3); font-family:var(--dsh-font-family-code, ui-monospace, monospace); }
      .afgo2-input .v { color:var(--afgo-fg); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .afgo2-reply { font-size:var(--afgo-fs-s); color:var(--afgo-fg-2); white-space:pre-wrap; overflow-wrap:anywhere;
        display:-webkit-box; -webkit-line-clamp:4; -webkit-box-orient:vertical; overflow:hidden; margin:0; font-family:inherit; }
      .afgo2-detail > .afgo2-tabs { margin-top:var(--afgo-s1); }
      .afgo2-panel { min-width:0; }
      .afgo2-panel > .afgo2-section, .afgo2-panel > .afgo2-body { padding-left:0; padding-right:0; }
      .afgo2-foot { display:flex; gap:6px; align-items:center; }

      @media (max-width: 860px) {
        .afgo2-tasks { grid-template-columns:minmax(0,1fr); }
        .afgo2-listpane { position:static; max-height:none; }
        .afgo2-list { overflow:visible; }
        .afgo2-summary { grid-template-columns:minmax(0,1fr); }
        .afgo2-summary-media { width:auto; border-left:0; border-top:1px solid var(--afgo-line-2); }
        .afgo2 .afgo2-open input { width:84px; }
        .afgo2-headbar .afgo2-spacer { display:none; }
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

    /** ⓘ hint: keeps explanatory text one hover/focus away instead of on the page. */
    function Hint({ text, label }) {
      if (!text) return null;
      return h("span", { className: "afgo2-hint", tabIndex: 0, role: "note", "data-tip": text,
        "aria-label": label ? `${label}：${text}` : text }, "i");
    }

    /** One headline number: label (+hint), formatted value with unit, context line. */
    function Metric({ label, value, unit, raw, context, hint, size }) {
      return h("div", { className: "afgo2-metric", "data-size": size },
        h("div", { className: "k" }, label, h(Hint, { text: hint, label })),
        h("div", { className: "v", title: raw != null ? String(raw) : undefined }, value,
          unit ? h("small", null, unit) : null),
        context ? h("div", { className: "c" }, context) : null);
    }

    function Disclosure({ summary, children, defaultOpen = false }) {
      return h("details", { className: "afgo2-disclosure", open: defaultOpen || undefined },
        h("summary", null, summary),
        h("div", { className: "afgo2-disclosure-body" }, children));
    }

    /** Skeleton placeholder shaped like the content it stands in for. */
    function Skeleton({ lines = [40, 85, 60], block = 0, label = "正在读取…" }) {
      return h("div", { className: "afgo2-skeleton", role: "status", "aria-busy": "true" },
        h("span", { className: "afgo2-sr" }, label),
        ...lines.map((width, index) => h("span", { key: index, className: "afgo2-skel", "aria-hidden": "true",
          style: { width: `${width}%`, height: index === 1 ? "18px" : undefined } })),
        block ? h("span", { className: "afgo2-skel", "aria-hidden": "true", style: { height: `${block}px`, borderRadius: "8px" } }) : null);
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

    /** Compact account pill: dot · account · environment · sync. Opens settings. */
    function AccountPill({ connection, account, syncedAt, onOpenSettings }) {
      const online = Boolean(account);
      const env = connection?.env?.label ?? "环境未知";
      const sync = syncedAt ? `${clockOf(syncedAt).slice(0, 5)} 同步` : online ? "尚未同步" : null;
      return h("button", { type: "button", className: "afgo2-account", onClick: onOpenSettings,
        title: `${online ? `账号 ${account.name}${account.tier ? ` · ${account.tier}` : ""}` : "未连接"} · ${env} · ${connection?.env?.host ?? connection?.baseUrl ?? ""}（打开设置）` },
        h(Dot, { tone: online ? "ok" : undefined }),
        h("b", null, online ? account.name : connection ? "未连接" : "正在读取连接…"),
        h("span", { className: "sep", "aria-hidden": "true" }, "·"),
        h("span", { className: "env" }, env),
        sync ? h("span", { className: "sep", "aria-hidden": "true" }, "·") : null,
        sync ? h("span", { role: "status" }, sync) : null);
    }

    /** "# [task id] 打开" — the one way to jump to a task by number. */
    function OpenTaskBox({ onOpen }) {
      const [value, setValue] = useState("");
      const [error, setError] = useState(null);
      function submit(event) {
        event.preventDefault();
        const id = value.trim().replace(/^#/, "");
        if (!/^[1-9]\d{0,18}$/.test(id)) { setError("请输入数字任务编号"); return; }
        setError(null);
        setValue("");
        onOpen(id);
      }
      return h("form", { onSubmit: submit, style: { display: "flex", flexDirection: "column", gap: "2px", alignItems: "flex-end" } },
        h("div", { className: "afgo2-open" },
          h("span", { className: "hash", "aria-hidden": "true" }, "#"),
          h("input", { id: "afgo-open-task", inputMode: "numeric", autoComplete: "off", value,
            placeholder: "任务编号", "aria-label": "按任务编号打开", "aria-invalid": error ? "true" : undefined,
            onChange: (event) => { setValue(event.target.value); if (error) setError(null); } }),
          h("button", { type: "submit" }, "打开")),
        error ? h("span", { className: "afgo2-open-error", role: "alert" }, error) : null);
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
      { id: "unresolved", label: "未打开" }
    ];

    function rowMatchesStatus(item, summary, status) {
      if (status === "all") return true;
      return statusOfRow(item, summary).state === status;
    }

    function TaskRow({ item, summary, selected, onSelect }) {
      const status = statusOfRow(item, summary);
      const tool = item.toolbox?.displayName || item.toolbox?.name || (item.type === "agent" ? "Agent" : item.type === "kit" ? "Kit" : null);
      const tip = status.state === "unresolved" ? "未打开，状态未读取" : status.label;
      return h("button", {
        type: "button",
        className: "afgo2-row",
        "aria-current": selected ? "true" : undefined,
        onClick: () => onSelect(item),
        "data-task-id": item.id,
        title: item.title
      },
        h("span", { className: "afgo2-dot", "data-tone": toneOf(status.state), title: tip, role: "img", "aria-label": tip }),
        h("span", { style: { minWidth: 0, display: "flex", flexDirection: "column" } },
          h("span", { className: "afgo2-row-title" }, item.title),
          h("span", { className: "afgo2-row-meta" },
            h("span", { className: "afgo2-mono" }, `#${item.id}`),
            status.state !== "unresolved" ? h("span", { className: "sep" }, "·") : null,
            status.state !== "unresolved" ? h("span", null, status.label) : null,
            h("span", { className: "sep" }, "·"),
            h("span", null, shortDateOf(item.updatedAt ?? item.createdAt)),
            summary?.totalMs ? h("span", { className: "sep" }, "·") : null,
            summary?.totalMs ? h("span", null, formatDuration(summary.totalMs)) : null,
            tool ? h("span", { className: "sep" }, "·") : null,
            tool ? h("span", { className: "tool afgo2-mono" }, tool) : null)));
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
      const now = Date.now();
      const rows = [];
      let group = null;
      for (const item of items) {
        const next = dateGroupOf(item.updatedAt ?? item.createdAt, now);
        if (next !== group) {
          group = next;
          rows.push(h("li", { key: `group-${next}`, className: "afgo2-group", role: "presentation" }, next));
        }
        rows.push(h("li", { key: item.id },
          h(TaskRow, { item, summary: summaries[item.id], selected: item.id === selectedId, onSelect })));
      }
      return h(React.Fragment, null,
        error ? h(Notice, { tone: "err" }, error) : null,
        !items.length && !loading && !error
          ? h(EmptyState, {
              title: emptyHint?.title ?? "当前筛选没有任务",
              hint: emptyHint?.hint ?? "换一个类型或状态，或在右上角输入任务编号。",
              action: onDiscover ? h("button", { type: "button", onClick: onDiscover }, "发现工具") : null
            })
          : null,
        items.length
          ? h("ul", { className: "afgo2-list", "aria-label": "我的任务", onKeyDown, ref: listRef }, ...rows)
          : null,
        loading && !items.length ? h(Skeleton, { lines: [70, 50, 80, 45], label: "正在读取任务…" }) : null,
        loading && items.length ? h("p", { className: "afgo2-caption", role: "status" }, "正在读取…") : null,
        hasMore && !loading
          ? h("div", { className: "afgo2-list-foot" }, h("button", { type: "button", "data-variant": "ghost", onClick: onMore }, "加载更多"))
          : null);
    }

    // ------------------------------------------------------------------
    // task detail
    // ------------------------------------------------------------------

    /** Execution · verdict · sync on one line; each keeps its own tone and reason. */
    function Signals({ task, syncedAt, syncError, polling }) {
      const execution = executionOf(task);
      const verdict = verdictOf(task);
      const startMs = (task.steps ?? []).map((step) => parseTime(step.startedAt)).filter((value) => value != null);
      const runningFor = execution.state === "running" && startMs.length ? Math.max(0, Date.now() - Math.min(...startMs)) : null;
      const steps = task.steps?.length ?? 0;
      const ended = (task.steps ?? []).filter((step) => parseTime(step.endedAt) != null).length;
      return h("div", { className: "afgo2-signals", role: "group", "aria-label": "任务状态" },
        h("span", { className: "afgo2-signal" }, "执行",
          h(Dot, { tone: toneOf(execution.state) }), h("b", null, execution.label),
          runningFor != null ? `已运行 ${formatDuration(runningFor)}` : steps ? `${ended}/${steps} 步` : null,
          h(Hint, { label: "执行状态", text: execution.detail })),
        h("span", { className: "afgo2-signal" }, "判定",
          h(Chip, { tone: verdict.state === "success" ? "ok" : verdict.state === "failed" ? "err" : verdict.state === "running" ? "run" : "warn" }, verdict.label),
          task.messages?.hasReadableReply ? h(Chip, { plain: true }, "已有可读回复") : null,
          h(Hint, { label: "判定依据", text: `${verdict.reason} 判定与执行状态分开显示。` })),
        h("span", { className: "afgo2-signal" }, "同步",
          h(Dot, { tone: syncError ? "warn" : syncedAt ? "ok" : undefined }),
          h("b", null, syncError ? "延迟" : polling ? "自动刷新" : syncedAt ? "正常" : "未同步"),
          syncedAt ? clockOf(syncedAt).slice(0, 5) : null,
          h(Hint, { label: "同步状态", text: syncError
            ? `${syncError}。下面保留的是上次成功读取的内容。`
            : polling ? "任务运行中，每 6 秒自动读取一次；切到其他任务即停止。" : "最近一次从平台读取详情的时间。" })));
    }

    /**
     * Conclusion first: the headline number(s) from the result table, the
     * task inputs, and the representative image. Reads at most one table and
     * one image (both small), only for the opened task.
     */
    function ResultSummary({ task, files, filesLoading, request, onDownload, onOpenFiles, onOpenDetails }) {
      const sources = useMemo(() => summarySourcesOf(task.toolbox?.name, files), [task.toolbox?.name, files]);
      // undefined = still reading, null = nothing to show
      const [metrics, setMetrics] = useState(undefined);
      const [imageUrl, setImageUrl] = useState(null);
      useEffect(() => {
        let alive = true;
        if (!sources.table) { setMetrics(null); return undefined; }
        setMetrics(undefined);
        void request("download", { id: task.id, fileId: sources.table.id }).then((result) => {
          if (!alive) return;
          if (!result.ok) { setMetrics(null); return; }
          try {
            const text = decodeBase64Text(result.data.content);
            setMetrics(summaryMetricsOf(text, sources.table.visualization?.format === "tsv" ? "\t" : ","));
          } catch { setMetrics(null); }
        });
        return () => { alive = false; };
      }, [request, task.id, sources.table?.id]); // eslint-disable-line react-hooks/exhaustive-deps
      useEffect(() => {
        let alive = true;
        let url = null;
        setImageUrl(null);
        if (!sources.image) return undefined;
        void request("download", { id: task.id, fileId: sources.image.id }).then((result) => {
          if (!alive || !result.ok) return;
          const format = String(sources.image.visualization?.format ?? "png").replace("jpg", "jpeg");
          const bytes = Uint8Array.from(atob(result.data.content), (char) => char.charCodeAt(0));
          url = URL.createObjectURL(new Blob([bytes], { type: `image/${format}` }));
          setImageUrl(url);
        });
        return () => { alive = false; if (url) URL.revokeObjectURL(url); };
      }, [request, task.id, sources.image?.id]); // eslint-disable-line react-hooks/exhaustive-deps

      const timeline = timelineOf(task);
      const inputs = Array.isArray(task.inputs) ? task.inputs.slice(0, 6) : [];
      const reply = task.messages?.lastAssistant;
      const download = sources.primary ?? sources.table;
      const sourceName = sources.table?.name;
      const extra = [
        ...(metrics?.secondary ?? []).map((entry) => ({ ...entry, key: `m-${entry.label}` })),
        timeline.totalMs ? { key: "dur", label: "运行时长", value: formatDuration(timeline.totalMs), unit: null } : null,
        files?.length ? { key: "files", label: "文件", value: String(files.length), unit: null } : null
      ].filter(Boolean).slice(0, 3);
      const hasMedia = Boolean(sources.image);
      return h("section", { className: "afgo2-card afgo2-summary", "aria-label": "结果摘要",
        style: hasMedia ? undefined : { gridTemplateColumns: "minmax(0,1fr)" } },
        h("div", { className: "afgo2-summary-main" },
          metrics
            ? h(Metric, { label: metrics.primary.label, value: metrics.primary.value, unit: metrics.primary.unit,
                raw: metrics.primary.raw, context: metrics.primary.context,
                hint: `来自 ${sourceName} 的列 ${metrics.primary.column}，原始值 ${metrics.primary.raw}。单位按列名解析，科学含义以任务报告为准。` })
            : metrics === undefined
              ? h(Skeleton, { lines: [25, 45], label: "正在读取主结果…" })
              : reply
                ? h("div", null,
                    h("div", { className: "afgo2-caption", style: { marginBottom: "4px" } }, "最后一条可读回复"),
                    h("pre", { className: "afgo2-reply" }, reply.preview ?? reply.text),
                    h("button", { type: "button", "data-variant": "link", onClick: onOpenDetails, style: { marginTop: "4px" } }, "查看全文"))
                : h("p", { className: "afgo2-muted" }, filesLoading ? "正在读取文件清单…"
                    : files?.length ? "没有找到可直接读出数值的结果表，结果文件在「文件」里。" : "平台没有返回结果文件。"),
          extra.length ? h("div", { className: "afgo2-metrics" },
            ...extra.map((entry) => h(Metric, { key: entry.key, size: "m", label: entry.label, value: entry.value, unit: entry.unit, raw: entry.raw }))) : null,
          inputs.length ? h("div", { className: "afgo2-inputs", "aria-label": "任务输入" },
            ...inputs.map((input) => h("span", { key: input.key, className: "afgo2-input", title: `${input.key} = ${input.value}` },
              h("span", { className: "k" }, input.key), h("span", { className: "v" }, input.value)))) : null,
          h("div", { className: "afgo2-summary-actions" },
            download ? h("button", { type: "button", "data-variant": "primary", onClick: () => onDownload(download) }, "下载主结果") : null,
            h("button", { type: "button", onClick: onOpenFiles }, files?.length ? `全部文件 · ${files.length}` : "全部文件"))),
        hasMedia ? h("div", { className: "afgo2-summary-media" },
          imageUrl ? h("img", { src: imageUrl, alt: `任务 #${task.id} 结果图 ${sources.image.name}`, title: sources.image.name })
            : h("span", { className: "afgo2-skel", style: { width: "100%", height: "140px", borderRadius: "6px" }, "aria-hidden": "true" })) : null);
    }

    function OverviewPanel({ task, timeline, versionInfo }) {
      const execution = executionOf(task);
      const verdict = verdictOf(task);
      return h("div", { className: "afgo2-section" },
        h("div", { className: "afgo2-section-head" },
          h("h3", null, "详情"),
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
          Array.isArray(task.inputs) && task.inputs.length
            ? h("div", null,
                h("p", { className: "afgo2-caption" }, "任务输入"),
                h("dl", { className: "afgo2-kv" }, ...task.inputs.flatMap((input) => [
                  h("dt", { key: `k-${input.key}`, className: "afgo2-mono" }, input.key),
                  h("dd", { key: `v-${input.key}`, className: "afgo2-wrap" },
                    input.kind === "file" ? `${input.value}${input.bytes != null ? ` · ${formatBytes(input.bytes)}` : ""}` : input.value)])))
            : null));
    }

    /** Key times the platform returned, newest last. */
    function KeyEvents({ task }) {
      const events = eventsOf(task).slice(0, 8);
      if (!events.length) return h("p", { className: "afgo2-caption afgo2-body" }, "平台没有返回任何步骤时间。");
      return h("div", { className: "afgo2-body" },
        h("p", { className: "afgo2-caption" }, "关键时间", h(Hint, { text: "只列平台返回的时间字段，不做推算。" })),
        h("ul", { className: "afgo2-events" }, ...events.map((event, index) =>
          h("li", { className: "afgo2-event", key: `ev-${index}` },
            h("span", { className: "t" }, clockOf(parseTime(event.at))),
            h("span", { className: "l afgo2-wrap" }, `${event.kind} · ${event.text}`),
            h("span", { className: "s afgo2-mono" }, event.source)))));
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
                h("span", null, `步骤 ${row.step.id || "—"} · ${row.step.jobStatus ?? "状态未返回"}${row.warnings.length ? " · 时间异常" : ""}`),
                h("span", null, row.hasTime
                  ? `开始 ${row.step.startedAt ? clockOf(parseTime(row.step.startedAt)) : "—"} · 结束 ${row.step.endedAt ? clockOf(parseTime(row.step.endedAt)) : "—"}`
                  : "开始 / 结束时间未返回")),
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

    let viewerDocument = null;

    // Colours the viewer iframe needs, read from the resolved --afgo-* tokens
    // so the sandboxed page (which cannot see host variables) matches DSH.
    const VIEWER_THEME_TOKENS = { fg: "--afgo-fg", fg2: "--afgo-fg-2", bg: "--afgo-bg", layer: "--afgo-layer-2",
      line: "--afgo-line-3", accent: "--afgo-accent", warn: "--afgo-warn" };

    function viewerThemeOf(element) {
      if (!element || typeof getComputedStyle !== "function") return null;
      const computed = getComputedStyle(element);
      const theme = {};
      for (const [key, token] of Object.entries(VIEWER_THEME_TOKENS)) {
        const value = computed.getPropertyValue(token).trim();
        if (value) theme[key] = value;
      }
      return Object.keys(theme).length ? theme : null;
    }

    const VIEWER_STALL_MS = 12000;

    function StructureViewer({ task, file, data, request }) {
      const frame = useRef(null);
      const channel = useRef(crypto.randomUUID());
      const lastBeat = useRef(0);
      const [html, setHtml] = useState(null);
      const [error, setError] = useState(null);
      const [loaded, setLoaded] = useState(false);
      const [expanded, setExpanded] = useState(false);
      const [stalled, setStalled] = useState(false);
      const [mount, setMount] = useState(0);
      useEffect(() => {
        let current = true;
        const load = async () => {
          if (!viewerDocument) {
            const result = await request("viewer");
            if (!result.ok) throw new Error(result.error.message);
            viewerDocument = result.data.html;
          }
          if (current) setHtml(viewerDocument);
        };
        load().catch((failure) => { if (current) setError(failure.message); });
        return () => { current = false; };
      }, [request]);
      useEffect(() => {
        const receive = (event) => {
          const message = event.data;
          if (event.source !== frame.current?.contentWindow || message?.source !== "afgo-molstar") return;
          if (message.type === "ready") {
            frame.current.contentWindow.postMessage({
              type: "afgo-structure", channel: channel.current,
              taskId: task.id, fileId: file.id, name: file.name,
              format: file.visualization.format, text: decodeBase64Text(data.content),
              sha256: data.provenance?.sha256, fetchedAt: data.provenance?.fetchedAt,
              theme: viewerThemeOf(frame.current)
            }, "*");
            return;
          }
          if (message.channel !== channel.current) return;
          lastBeat.current = Date.now();
          if (message.type === "error") setError(message.message);
          if (message.type === "loaded") setLoaded(true);
          if (message.type === "fullscreen") setExpanded((value) => !value);
          if (message.type === "fullscreen-exit") setExpanded(false);
          if (message.type === "png" && typeof message.content === "string" && message.content.length < 24 * 1024 * 1024) {
            saveDownload({ name: message.name ?? `task-${task.id}-${file.name}`, content: message.content, mime: "image/png" }, "png");
          }
          if (message.type === "manifest") {
            const bytes = new TextEncoder().encode(JSON.stringify(message.manifest, null, 2));
            saveDownload({ name: `task-${task.id}-${file.name}-scene`,
              content: btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join("")), mime: "application/json" }, "json");
          }
        };
        window.addEventListener("message", receive);
        return () => window.removeEventListener("message", receive);
      }, [task.id, file.id, file.name, file.visualization.format, data]);
      useEffect(() => {
        if (!html || loaded) return;
        const timer = setTimeout(() => setError("结构加载超时，可重新选择文件重试或下载原文件。"), 45000);
        return () => clearTimeout(timer);
      }, [html, loaded, mount]);
      // Watchdog: the viewer beats every 2 s once loaded. If it stops while
      // the page is visible, unmount the iframe so a hung renderer cannot take
      // the page with it, and say so.
      useEffect(() => {
        if (!loaded || stalled) return undefined;
        lastBeat.current = Date.now();
        const onVisible = () => { if (document.visibilityState === "visible") lastBeat.current = Date.now(); };
        document.addEventListener("visibilitychange", onVisible);
        const timer = setInterval(() => {
          if (document.visibilityState !== "visible") return;
          if (Date.now() - lastBeat.current > VIEWER_STALL_MS) { setStalled(true); setExpanded(false); }
        }, 3000);
        return () => { clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
      }, [loaded, stalled]);
      useEffect(() => {
        if (!expanded) return undefined;
        const onKey = (event) => { if (event.key === "Escape") setExpanded(false); };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
      }, [expanded]);
      const reload = () => { setStalled(false); setLoaded(false); setError(null); channel.current = crypto.randomUUID(); setMount((value) => value + 1); };
      // Follow host light/dark switches while the viewer is open. DSH swaps the
      // variables by changing attributes or classes on <html>/<body>.
      useEffect(() => {
        if (!loaded || typeof MutationObserver !== "function") return;
        let last = JSON.stringify(viewerThemeOf(frame.current));
        const push = () => {
          const theme = viewerThemeOf(frame.current);
          const next = JSON.stringify(theme);
          if (!theme || next === last) return;
          last = next;
          frame.current?.contentWindow?.postMessage({ type: "afgo-theme", channel: channel.current, theme }, "*");
        };
        const observer = new MutationObserver(push);
        for (const node of [document.documentElement, document.body]) {
          if (node) observer.observe(node, { attributes: true, attributeFilter: ["class", "style", "data-theme", "data-color-scheme"] });
        }
        const media = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;
        media?.addEventListener?.("change", push);
        return () => { observer.disconnect(); media?.removeEventListener?.("change", push); };
      }, [loaded]);
      if (stalled) {
        return h("div", { className: "afgo2-structure" },
          h(Notice, { tone: "warn" }, "结构视图没有响应，已停止以免拖慢页面。可以重新加载，或在「文件」里下载原文件。"),
          h("div", { className: "afgo2-actions", style: { marginTop: "8px" } },
            h("button", { type: "button", onClick: reload }, "重新加载结构视图")));
      }
      return h("div", { className: "afgo2-structure", "data-expanded": expanded ? "true" : undefined },
        error ? h(Notice, { tone: "err" }, error) : null,
        !html ? h(Skeleton, { lines: [30], block: 360, label: "正在加载本地结构查看器…" }) : null,
        html ? h("iframe", { key: mount, ref: frame, title: `任务 ${task.id} 的结构 ${file.name}`,
          sandbox: "allow-scripts", srcDoc: html, className: "afgo2-viewer-frame" }) : null,
        expanded ? h("button", { type: "button", className: "afgo2-viewer-close", onClick: () => setExpanded(false) }, "退出全屏 · Esc") : null);
    }

    function useWidth(ref, fallback = 640) {
      const [width, setWidth] = useState(fallback);
      useEffect(() => {
        const node = ref.current;
        if (!node || typeof ResizeObserver !== "function") return undefined;
        const observer = new ResizeObserver((entries) => {
          const next = Math.round(entries[0]?.contentRect?.width ?? 0);
          if (next > 0) setWidth(next);
        });
        observer.observe(node);
        return () => observer.disconnect();
      }, [ref]);
      return width;
    }

    function BarChart({ points, label }) {
      const sorted = points.slice().sort((a, b) => a.value - b.value);
      const geometry = barGeometryOf(sorted.map((point) => point.value));
      const lowest = sorted[0];
      const mixed = sorted[0].value < 0 && sorted[sorted.length - 1].value > 0;
      return h("div", { className: "afgo2-hbar", role: "list", "aria-label": `${label}，按数值升序` },
        ...sorted.flatMap((point, index) => {
          const hi = point === lowest;
          const geo = geometry[index];
          return [
            h("span", { key: `l${point.row}`, className: "lab", title: point.label ?? `第 ${point.row} 行` }, point.label ?? `行 ${point.row}`),
            h("span", { key: `t${point.row}`, className: "track", role: "listitem",
              "aria-label": `${point.label ?? `第 ${point.row} 行`}：${point.raw}` },
              mixed ? h("span", { className: "zero", style: { left: `${geo.zero}%` } }) : null,
              h("span", { className: "fill", "data-hi": hi ? "true" : undefined,
                style: { left: `${geo.left}%`, width: `${geo.width}%` } })),
            h("span", { key: `v${point.row}`, className: "val", "data-hi": hi ? "true" : undefined, title: point.raw }, formatValue(point.raw))
          ];
        }));
    }

    function LineChart({ points, label }) {
      const box = useRef(null);
      const width = Math.max(280, useWidth(box));
      const height = 220;
      const left = 64;
      const right = 16;
      const top = 16;
      const bottom = 28;
      const values = points.map((point) => point.value);
      const low = Math.min(...values);
      const high = Math.max(...values);
      const spread = high - low || Math.abs(high) * 0.1 || 1;
      const y0 = low - spread * 0.06;
      const y1 = high + spread * 0.06;
      const n = points.length;
      const x = (index) => left + (n > 1 ? index / (n - 1) : 0.5) * (width - left - right);
      const y = (value) => top + (1 - (value - y0) / (y1 - y0)) * (height - top - bottom);
      const yTicks = niceTicks(y0, y1, 4);
      const xCount = width < 420 ? 3 : 5;
      const xTicks = Array.from(new Set(Array.from({ length: xCount }, (_, k) => Math.round(k / (xCount - 1) * (n - 1)))));
      const last = points[n - 1];
      const path = points.map((point, index) => `${index ? "L" : "M"}${x(index).toFixed(1)} ${y(point.value).toFixed(1)}`).join(" ");
      return h("div", { ref: box, style: { width: "100%" } },
        h("svg", { className: "afgo2-svgchart", width, height, viewBox: `0 0 ${width} ${height}`, role: "img",
          "aria-label": `${label}，按原文件行序，共 ${n} 个值，最小 ${formatValue(low)}，最大 ${formatValue(high)}，最后一个 ${last.raw}` },
          ...yTicks.map((tick, index) => h("g", { key: `y${index}` },
            h("line", { className: "grid", x1: left, x2: width - right, y1: y(tick), y2: y(tick) }),
            h("text", { x: left - 8, y: y(tick) + 4, textAnchor: "end" }, formatValue(tick, 6)))),
          h("line", { className: "axis", x1: left, x2: width - right, y1: height - bottom, y2: height - bottom }),
          ...xTicks.map((index) => h("text", { key: `x${index}`, x: x(index), y: height - 8, textAnchor: "middle" }, String(points[index].row))),
          h("path", { className: "line", d: path }),
          n <= 200 ? h("g", null, ...points.map((point, index) => h("circle", { key: point.row, cx: x(index), cy: y(point.value), r: 6,
            fill: "transparent" }, h("title", null, `第 ${point.row} 行 · ${point.raw}`)))) : null,
          h("circle", { className: "pt", cx: x(n - 1), cy: y(last.value), r: 4 }),
          h("text", { className: "last-label", x: x(n - 1) - 8, y: y(last.value) + (y(last.value) < top + 16 ? 18 : -10), textAnchor: "end" },
            `${formatValue(last.raw)} · 第 ${last.row} 行`)));
    }

    function ValueTable({ points, label }) {
      return h("div", { className: "afgo2-preview", style: { maxHeight: "320px" } },
        h("table", { className: "afgo2-table" },
          h("thead", null, h("tr", null, h("th", null, "行"), h("th", null, "标签"), h("th", { style: { textAlign: "right" } }, label))),
          h("tbody", null, ...points.map((point) => h("tr", { key: point.row },
            h("td", { className: "afgo2-num" }, point.row),
            h("td", { className: "afgo2-mono" }, point.label ?? "—"),
            h("td", { className: "afgo2-num", style: { textAlign: "right" }, title: point.raw }, formatValue(point.raw)))))));
    }

    function NumericPlot({ text, delimiter }) {
      const parsed = useMemo(() => parseCsv(text, 201, delimiter), [text, delimiter]);
      const columns = useMemo(() => numericColumns(parsed.rows), [parsed]);
      const [selected, setSelected] = useState(null);
      const [view, setView] = useState("chart");
      const column = columns.find((entry) => selected !== null && entry.index === Number(selected))
        ?? columns.find((entry) => /^gamma_j_per_m2$/i.test(entry.name))
        ?? columns.find((entry) => /gamma|energy|rmsd|affinity|score/i.test(entry.name)) ?? columns[0];
      if (!column) return h("p", { className: "afgo2-caption" }, "此表没有可绘图的数值列，可在「文件」里预览或下载原表。");
      const label = columnLabelOf(column.name);
      const labelText = label.unit ? `${label.label}（${label.unit}）` : label.label;
      const labelIndex = labelColumnOf(parsed.rows, new Set(columns.map((entry) => entry.index)));
      const points = parsed.rows.slice(1).flatMap((row, index) => {
        const raw = row[column.index]?.trim();
        const value = Number(raw);
        const rowLabel = labelIndex >= 0 ? String(row[labelIndex] ?? "").trim() || null : null;
        return raw && Number.isFinite(value) ? [{ row: index + 1, value, raw, label: rowLabel }] : [];
      });
      const kind = chartKindOf(points.length);
      const hint = `原列名 ${label.raw}${labelIndex >= 0 ? `，行标签取自列 ${parsed.rows[0][labelIndex]}` : ""}。单位按列名解析，科学含义以任务报告为准。`;
      const caption = kind === "bars" ? `${points.length} 个值 · 升序；只高亮最小值，不代表最优`
        : kind === "line" ? `${points.length} 个值 · 按原文件行序${parsed.truncated ? "，仅前 200 行" : ""}` : null;
      return h("div", { className: "afgo2-chart" },
        h("div", { className: "afgo2-chart-head" },
          h("h4", null, labelText, " ", h(Hint, { label: "数据来源", text: hint })),
          h("div", { className: "afgo2-actions" },
            columns.length > 1 ? h("select", { value: column.index, onChange: (event) => setSelected(Number(event.target.value)), "aria-label": "选择数值列" },
              ...columns.map((entry) => {
                const meta = columnLabelOf(entry.name);
                return h("option", { key: entry.index, value: entry.index }, meta.label === entry.name ? entry.name : `${meta.label} · ${entry.name}`);
              })) : null,
            kind === "bars" || kind === "line"
              ? h("div", { className: "afgo2-seg", role: "group", "aria-label": "图或表" },
                  h("button", { type: "button", "aria-pressed": view === "chart", onClick: () => setView("chart") }, "图"),
                  h("button", { type: "button", "aria-pressed": view === "table", onClick: () => setView("table") }, "表"))
              : null)),
        kind === "metric" ? h("div", { className: "afgo2-card afgo2-metric-card" },
          h(Metric, { label: label.label, value: formatValue(points[0].value), unit: label.unit, raw: points[0].raw,
            context: points[0].label ?? `原文件第 ${points[0].row} 行`, hint: `列 ${label.raw}，原始值 ${points[0].raw}。` })) : null,
        kind === "none" ? h("p", { className: "afgo2-caption" }, "这一列没有有效数值。") : null,
        (kind === "bars" || kind === "line") && view === "table" ? h(ValueTable, { points, label: labelText }) : null,
        kind === "bars" && view === "chart" ? h(BarChart, { points, label: labelText }) : null,
        kind === "line" && view === "chart" ? h(LineChart, { points, label: labelText }) : null,
        caption ? h("p", { className: "afgo2-caption" }, caption) : null);
    }

    /** Result image that opens full-size in an in-page overlay (Esc / click closes). */
    function ZoomableImage({ src, alt, onError }) {
      const [open, setOpen] = useState(false);
      useEffect(() => {
        if (!open) return undefined;
        const onKey = (event) => { if (event.key === "Escape") setOpen(false); };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
      }, [open]);
      return h(React.Fragment, null,
        h("button", { type: "button", className: "afgo2-zoom", onClick: () => setOpen(true), "aria-label": `放大查看：${alt}`, title: "点击放大" },
          h("img", { src, alt, onError })),
        open ? h("div", { className: "afgo2-lightbox", role: "dialog", "aria-modal": "true", "aria-label": alt, onClick: () => setOpen(false) },
          h("img", { src, alt }),
          h("button", { type: "button", onClick: () => setOpen(false), autoFocus: true }, "关闭 · Esc")) : null);
    }

    const KIND_SHORT = { structure: "结构", image: "图", table: "表" };

    function ResultAsset({ task, file, request }) {
      const [asset, setAsset] = useState(null);
      const [error, setError] = useState(null);
      useEffect(() => {
        let current = true;
        let imageUrl;
        setAsset(null);
        setError(null);
        const load = async () => {
          const result = await request("download", { id: task.id, fileId: file.id });
          if (!current) return;
          if (!result.ok) { setError(result.error.message); return; }
          const kind = file.visualization.kind;
          if (kind === "image") {
            const format = file.visualization.format.replace("jpg", "jpeg");
            const binary = atob(result.data.content);
            const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
            imageUrl = URL.createObjectURL(new Blob([bytes], { type: `image/${format}` }));
          }
          setAsset({ ...result.data, imageUrl });
        };
        load().catch((failure) => { if (current) setError(failure.message); });
        return () => { current = false; if (imageUrl) URL.revokeObjectURL(imageUrl); };
      }, [request, task.id, file.id, file.visualization.kind, file.visualization.format]);
      if (error) return h(Notice, { tone: "err" }, `${error}。可在「文件」里下载原文件。`);
      if (!asset) return h(Skeleton, { lines: [30], block: 320, label: "正在读取任务文件…" });
      return h("div", null,
        file.visualization.kind === "structure" ? h(StructureViewer, { key: file.id, task, file, data: asset, request }) : null,
        asset.imageUrl ? h(ZoomableImage, { src: asset.imageUrl, alt: `任务 #${task.id} 原始图片 ${file.name}`, onError: () => setError("图片内容无法解码") }) : null,
        file.visualization.kind === "table" ? h(NumericPlot, { text: decodeBase64Text(asset.content), delimiter: file.visualization.format === "tsv" ? "\t" : "," }) : null,
        h("p", { className: "afgo2-caption afgo2-foot" }, `${file.name} · SHA-256 ${asset.provenance?.sha256 ? asset.provenance.sha256.slice(0, 8) : "未返回"}`,
          asset.provenance?.sha256 ? h(Hint, { label: "完整 SHA-256", text: `任务 #${task.id} · ${file.name} · SHA-256 ${asset.provenance.sha256}` }) : null));
    }

    function VisualizationPanel({ task, files, request, loading, error, onRetry }) {
      const candidates = useMemo(() => visualizationCandidates(files), [files]);
      const [selection, setSelection] = useState(null);
      const selected = candidates.find((file) => file.id === selection) ?? candidates[0];
      if (loading) return h(Skeleton, { lines: [35], block: 320, label: "正在识别任务可视化文件…" });
      if (error) return h("div", { className: "afgo2-body" }, h(Notice, { tone: "err" }, error.message),
        h("button", { type: "button", onClick: onRetry }, "重试读取"));
      if (!selected) return h(EmptyState, { title: "这个任务没有可预览的结构、图片或数值表", hint: task.messages?.hasReadableReply ? "结论见上方的可读回复；原始文件在「文件」里。" : "原始文件和报告在「文件」里。",
        action: h(Hint, { label: "支持的格式", text: "结构 CIF / mmCIF / PDB / XYZ / EXTXYZ / SDF / MOL / MOL2 / GRO；图片 PNG / JPEG / WebP；数值表 CSV / TSV。" }) });
      const tooLarge = selected.size != null && selected.size > MAX_DOWNLOAD;
      return h("div", { className: "afgo2-body", style: { display: "grid", gap: "12px" } },
        h("div", { className: "afgo2-actions" },
          candidates.length <= 10
            ? h("div", { className: "afgo2-seg", role: "group", "aria-label": "选择结果文件" },
                ...candidates.map((file) => h("button", { key: file.id, type: "button", "aria-pressed": file.id === selected.id,
                  onClick: () => setSelection(file.id), title: file.name },
                  file.name, h("span", { className: "kind" }, KIND_SHORT[file.visualization.kind] ?? ""))))
            : h("select", { "aria-label": "选择结果文件", value: selected.id, style: { maxWidth: "100%" }, onChange: (event) => setSelection(event.target.value) },
                ...candidates.map((file) => h("option", { key: file.id, value: file.id }, `${file.name} · ${KIND_SHORT[file.visualization.kind] ?? ""}`))),
          h(Hint, { label: "文件来源", text: "来自这个任务的文件清单，可能包含输入、中间文件和输出；排序与对话里的结果图一致。三维预览保留原始坐标，键线是按距离推断的；计算是否成功以上方的结果判定为准。" })),
        tooLarge ? h(Notice, { tone: "warn" }, `文件超过 ${formatBytes(MAX_DOWNLOAD)} 预览上限，请在「文件」里前往平台下载。`) :
          h(ResultAsset, { key: `${task.id}:${selected.id}`, task, file: selected, request }));
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
      if (loading) return h("div", { className: "afgo2-body" }, h("p", { className: "afgo2-caption", role: "status" }, "正在读取文件清单…"));
      if (error) {
        const tone = error.code === "forbidden" ? "warn" : "err";
        return h("div", { className: "afgo2-body" },
          h(Notice, { tone }, error.code === "forbidden"
            ? "当前账号无权访问这个任务的文件。"
            : error.code === "not_found"
              ? "平台没有返回文件目录（任务可能已删除或不属于当前账号）。"
              : `文件读取失败：${error.message}`),
          error.retryable !== false ? h("button", { type: "button", onClick: onRetry }, "重试读取") : null);
      }
      if (!files.length) {
        return h("div", { className: "afgo2-body" },
          h(EmptyState, { title: "暂无文件", hint: "平台返回的文件目录为空。任务完成前这里通常为空，稍后刷新再看。" }),
          h("button", { type: "button", onClick: onRetry }, "刷新文件"));
      }
      return h("div", { className: "afgo2-section" },
        h("div", { className: "afgo2-section-head" },
          h("h3", null, `文件 · ${files.length} 个`),
          h("div", { className: "afgo2-actions" },
            h("input", {
              type: "search", value: filter, "aria-label": "按文件名或类型筛选文件",
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
          !visible.length ? h("p", { className: "afgo2-caption" }, "没有匹配的文件。") : null,
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
      catalogEntry, onOpenDiscover, request
    }) {
      const [tab, setTab] = useState("result");
      useEffect(() => { setTab("result"); }, [task?.id]);
      const back = h("button", { type: "button", "data-variant": "ghost", className: "afgo2-back", onClick: onBack,
        style: { alignSelf: "flex-start", paddingLeft: 0 } }, "← 任务列表");
      if (loading && !task) {
        return h("div", { className: "afgo2-detail afgo2-detailpane", id: "afgo-task-detail" },
          back, h(Skeleton, { lines: [30, 70, 50], block: 160, label: "正在读取任务详情…" }));
      }
      if (error && !task) {
        return h("div", { className: "afgo2-detail afgo2-detailpane", id: "afgo-task-detail" },
          back,
          h(Notice, { tone: "err" }, error.message),
          h("p", { className: "afgo2-caption" },
            "如果这个编号是工作流方案（plan_id），只读工作流视图会在后续版本提供。"),
          h("div", { className: "afgo2-actions" },
            h("button", { type: "button", onClick: onRetry }, "重试"),
            h("button", { type: "button", "data-variant": "ghost", onClick: onOpenDiscover }, "发现工具")));
      }
      if (!task) {
        return h("div", { className: "afgo2-detail afgo2-detailpane", id: "afgo-task-detail" },
          h(EmptyState, { title: "选择一个任务查看结果", hint: "也可以在右上角输入任务编号直接打开。" }));
      }
      const timeline = timelineOf(task);
      const versionInfo = catalogEntry ? versionText(catalogEntry, task.toolbox?.version) : null;
      const tool = task.toolbox?.displayName || task.toolbox?.name;
      return h("div", { className: "afgo2-detail afgo2-detailpane", id: "afgo-task-detail" },
        back,
        h("header", { className: "afgo2-dhead" },
          h("div", { className: "afgo2-eyebrow" },
            h("span", { className: "afgo2-mono" }, `#${task.id}`),
            tool ? h("span", { className: "sep" }, "·") : null,
            tool ? h("span", { className: "afgo2-mono" }, tool) : null,
            task.toolbox?.version ? h("span", null, `v${task.toolbox.version}`) : null,
            h("span", { className: "sep" }, "·"),
            h("span", null, task.type === "agent" ? "Agent" : task.type === "kit" ? "Kit" : "类型未知"),
            task.meta?.createdAt ? h("span", { className: "sep" }, "·") : null,
            task.meta?.createdAt ? h("span", { title: dateTimeOf(task.meta.createdAt) }, `创建 ${shortDateOf(task.meta.createdAt)}`) : null),
          h("h2", { className: "afgo2-dtitle", title: task.meta?.title }, task.meta?.title ?? `任务 #${task.id}`),
          h(Signals, { task, syncedAt, syncError, polling })),
        syncError ? h(Notice, { tone: "warn" }, `同步延迟：${syncError}。下面保留的是上次成功读取的内容。`) : null,
        h(ResultSummary, { task, files, filesLoading, request, onDownload,
          onOpenFiles: () => setTab("files"), onOpenDetails: () => setTab("details") }),
        h(Tabs, {
          label: "任务详情视图",
          value: tab,
          onChange: setTab,
          items: [
            { id: "result", label: "结果" },
            { id: "process", label: "过程" },
            { id: "files", label: `文件${files?.length ? ` · ${files.length}` : ""}` },
            { id: "details", label: "详情" }
          ]
        }),
        h("div", { className: "afgo2-panel", role: "tabpanel" },
          tab === "result" ? h(VisualizationPanel, { key: task.id, task, files, request, loading: filesLoading, error: filesError, onRetry: onFilesRetry }) : null,
          tab === "process" ? h(React.Fragment, null, h(TimelinePanel, { task }), h(KeyEvents, { task })) : null,
          tab === "files"
            ? h(ArtifactsPanel, {
                task, files: files ?? [], loading: filesLoading, error: filesError, onRetry: onFilesRetry,
                onDownload, downloadState, onPreview, preview
              })
            : null,
          tab === "details" ? h(OverviewPanel, { task, timeline, versionInfo }) : null));
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
        h("aside", { className: "afgo2-listpane", "aria-label": "任务列表" },
          h("div", { className: "afgo2-filters" },
            h("input", {
              type: "search", id: "afgo-task-query", ref: searchRef, value: query,
              "aria-label": "按标题、工具或编号筛选；回车在平台上搜索",
              placeholder: "搜索标题、工具或 #编号", onChange: (event) => setQuery(event.target.value),
              onKeyDown: (event) => { if (event.key === "Enter") openByNumber(); }
            })),
          h("div", { className: "afgo2-filters" },
            h("select", { value: typeFilter, "aria-label": "按类型筛选",
              onChange: (event) => { setTypeFilter(event.target.value); setServerKeyword(""); } },
              ...TYPE_FILTERS.map((option) => h("option", { key: option.id, value: option.id }, option.label))),
            h("select", { value: statusFilter, "aria-label": "按状态筛选",
              onChange: (event) => setStatusFilter(event.target.value) },
              ...STATUS_FILTERS.map((option) => h("option", { key: option.id, value: option.id }, option.label))),
            h("span", { className: "afgo2-spacer" }),
            h(Hint, { label: "列表说明", text: "按最近活动排序。空心圆点表示这个任务还没打开过：列表不逐条读取详情，打开后状态才会补上并缓存在本机。搜索框回车会在平台上按关键词查询。" }),
            h("button", { type: "button", "data-variant": "ghost", title: "刷新列表", "aria-label": "刷新列表",
              onClick: () => void loadList({ page: 1 }), disabled: listLoading }, "刷新")),
          listError ? h(Notice, { tone: "err" }, listError) : null,
          h(TaskList, {
            items: visibleRows, summaries, selectedId, loading: listLoading, hasMore, error: null,
            onSelect: (item) => void openTask(item.id, item),
            onMore: () => void loadList({ page: page + 1, append: true }),
            emptyHint: query || statusFilter !== "all" || typeFilter !== "all"
              ? { title: "当前筛选没有任务", hint: "清空筛选，或换一个状态。" }
              : { title: "还没有任务", hint: "从「发现工具」打开官方样例，或在右上角输入任务编号。" },
            onDiscover
          })),
        h(TaskDetail, {
          task, loading: taskLoading, error: taskError,
          onRetry: () => void openTask(selectedId),
          onBack: () => setPane("list"),
          syncedAt, syncError, polling: thinking,
          files, filesLoading, filesError,
          onFilesRetry: () => void loadFiles(selectedId, generation.current),
          onDownload: download, downloadState, onPreview: previewFile, preview,
          onOpenDiscover: onDiscover, catalogEntry, request
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
            h("p", null, `afgo-dsh v${PLUGIN_VERSION}`),
            h("p", { className: "afgo2-caption" },
              "后续：多节点工作流与会话视图、可提交的任务表单、历史对比与领域结果摘要。"),
            h("p", { className: "afgo2-caption" },
              "页面只读取平台数据；「发现工具」里的示例任务需要你确认后才会提交。不发追问、不执行工作流。")))));
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

      const body = h("div", { className: "afgo2", "data-account": account?.id ?? "none" },
        h("style", null, styles),
        h("div", { className: "afgo2-topbar" },
          h("div", { className: "afgo2-headbar" },
            h("span", { className: "afgo2-brand" }, "AsterFire Go"),
            h(AccountPill, { connection, account, syncedAt, onOpenSettings: () => setTab("settings") }),
            h("span", { className: "afgo2-spacer" }),
            account
              ? h(OpenTaskBox, { onOpen: requestTask })
              : !booting ? h("button", { type: "button", "data-variant": "primary", onClick: () => setTab("settings") }, "连接账号") : null),
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
                  "连接后可以恢复上次打开的任务、查看步骤耗时、下载结果文件；Key 由 DSH 宿主保存。"),
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
          "本页只读取平台数据；提交示例任务需要你在页面上确认。"));
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
    // Persistent conversation images use the host-authorized attachment loader.
    function reportOfBlock(block) {
      for (const part of block?.content ?? []) {
        if (part.type !== "text") continue;
        try {
          const value = JSON.parse(part.text);
          if (value?.report) return value.report;
        } catch { /* output may have been compacted; presentation metadata remains */ }
      }
      return block?.meta?.afgoReport ?? null;
    }

    function ResultReportRow({ toolName, phase, block, renderSlot, loadImage }) {
      const report = reportOfBlock(block);
      const images = (report?.images ?? []).filter((image) => image?.attachment?.attachmentId);
      const text = (block?.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n");
      return h("section", { "data-afgo-result-report": report?.taskId ?? "",
        style: { border: "1px solid var(--dsw-alias-border-l2, #8884)", borderRadius: "12px", padding: "12px", margin: "8px 0", display: "grid", gap: "10px" } },
        h("strong", null, report ? `计算结果图 · #${report.taskId}` : `${toolName} · ${phase === "result" ? "已返回" : "处理中"}`),
        images.length && renderSlot && loadImage ? renderSlot("tool.call.images", {
          images: images.map((image) => ({ attachment: image.attachment })), loadImage, align: "start"
        }) : null,
        ...images.map((image) => h("p", { key: image.attachment.attachmentId, style: { margin: 0, fontSize: "12px", overflowWrap: "anywhere" } }, image.caption)),
        ...(report?.warnings ?? []).map((warning, index) => h("p", { key: `warning-${index}`, role: "status", style: { margin: 0, fontSize: "12px" } }, warning)),
        text ? h("details", null, h("summary", null, "查看任务返回与来源信息"),
          h("pre", { style: { maxHeight: "260px", overflow: "auto", whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: "12px" } }, text)) : null);
    }

    // plugin entry
    // ------------------------------------------------------------------

    async function apply(ctx) {
      for (const key of ["afg_results", "afg_tasks"]) {
        ctx.slots.inject("tool.call.toolview", () => ctx.slots.register({
          name: "tool.call.toolview", key,
          children: { "tool.call.images": { kind: "single", scope: "session" } }
        }, ResultReportRow));
      }
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
        primaryFileOf, primaryFileName, fileKind, parseCsv, decodeBase64Text, visualizationCandidates, numericColumns,
        formatValue, columnLabelOf, exportName, toneOf, dateGroupOf, summaryMetricsOf, summarySourcesOf,
        labelColumnOf, chartKindOf, barGeometryOf, niceTicks,
        versionText, scopedKey, reportOfBlock
      }
    };
  }
});
