window.__ModuleLoader__.load({
  id: "afgo-dsh",
  factory(require) {
    const { createElement: h, useEffect, useState } = require("react");
    const sampleTool = "MACE-Flow-SurfaceInterface-Kit";
    const credentialGuide = "https://sidereus-ai.feishu.cn/wiki/X5BEw6SoqiKm8Yko5CtcgnBVnzk#doxcnenOw78qn5uYgkJnfACUw6b";
    const codec = { mode: "src-json" };
    const inputCodec = {
      mode: "strict", typeSymbol: "afgo-dsh#WorkbenchInput",
      create: () => ({ parse(input) {
        if (!input || typeof input !== "object" || Array.isArray(input) || typeof input.action !== "string") {
          throw new Error("无效的工作台请求。");
        }
        return input;
      } })
    };
    const contribution = {
      package: "afgo-dsh",
      descriptors: [{
        id: "afgo-dsh#afgoWorkbench/dispatch", service: "afgoWorkbench",
        namespace: "afgoWorkbench", method: "dispatch", invocation: { kind: "direct" },
        parameters: [{ name: "input", wire: "input", source: "json", codec: inputCodec }], result: codec
      }]
    };

    const styles = `
      .afgo-workbench { display:grid; gap:1rem; margin:1rem 0; color:inherit; }
      .afgo-workbench h2,.afgo-workbench h3,.afgo-workbench p { margin:0; }
      .afgo-workbench .afgo-panel { border:1px solid color-mix(in srgb,currentColor 17%,transparent); border-radius:12px; padding:1rem; display:grid; gap:.75rem; }
      .afgo-workbench .afgo-row { display:flex; gap:.6rem; align-items:center; flex-wrap:wrap; }
      .afgo-workbench .afgo-list { display:grid; gap:.5rem; padding:0; margin:0; list-style:none; }
      .afgo-workbench .afgo-entry { border-top:1px solid color-mix(in srgb,currentColor 12%,transparent); padding:.55rem 0 0; display:grid; gap:.25rem; overflow-wrap:anywhere; }
      .afgo-workbench .afgo-muted { font-size:.875em; opacity:.8; overflow-wrap:anywhere; }
      .afgo-workbench button,.afgo-workbench input:not([type=checkbox]) { padding:.45rem .7rem; border:1px solid color-mix(in srgb,currentColor 25%,transparent); border-radius:7px; color:inherit; background:transparent; font:inherit; }
      .afgo-workbench button:not(:disabled) { cursor:pointer; }
      .afgo-workbench button:disabled { opacity:.5; }
      .afgo-workbench button.afgo-primary { background:#235cce; color:white; border-color:#235cce; }
      .afgo-workbench input:not([type=checkbox]) { width:min(100%,20rem); }
      .afgo-workbench a { color:inherit; text-decoration:underline; }
      .afgo-workbench .afgo-notice { border-inline-start:3px solid #b47d19; padding:.4rem .65rem; }
      .afgo-workbench summary { cursor:pointer; }
      .afgo-workbench pre { white-space:pre-wrap; overflow-wrap:anywhere; margin:.5rem 0; }
    `;
    const button = (text, onClick, disabled, primary = false) =>
      h("button", { type: "button", onClick, disabled, className: primary ? "afgo-primary" : undefined }, text);
    const row = (...children) => h("div", { className: "afgo-row" }, ...children);
    const muted = (text) => h("p", { className: "afgo-muted" }, text);
    const panel = (title, ...children) => h("section", { className: "afgo-panel" }, h("h3", null, title), ...children);

    function progress(task) {
      const states = task.steps.map((s) => s.state);
      if (task.active === true) {
        if (states.includes("RUNNING")) return "运行中";
        if (states.includes("PENDING")) return "排队中";
        return "处理中";
      }
      return { success: "成功", partial: "部分完成", failed: "失败" }[task.outcome?.state]
        ?? "已读取状态，结果待核实";
    }

    function saveDownload(file) {
      const bytes = Uint8Array.from(atob(file.content), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = file.name || "asterfire-result";
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    }

    function Page({ request }) {
      const [connection, setConnection] = useState(null);
      const [account, setAccount] = useState(null);
      const [key, setKey] = useState("");
      const [busy, setBusy] = useState("");
      const [notice, setNotice] = useState("");
      const [query, setQuery] = useState("MACE");
      const [catalog, setCatalog] = useState(null);
      const [sample, setSample] = useState(null);
      const [confirmed, setConfirmed] = useState(false);
      const [submitUnknown, setSubmitUnknown] = useState(false);
      const [history, setHistory] = useState(null);
      const [id, setId] = useState("");
      const [lookup, setLookup] = useState("");
      const [task, setTask] = useState(null);
      const [updatedAt, setUpdatedAt] = useState(null);
      const [pollError, setPollError] = useState("");

      function selectTask(next) {
        setId(next);
        setLookup(next);
        setTask(null);
        setUpdatedAt(null);
      }

      function applyAccount(next, status) {
        setAccount(next);
        setConnection(status);
        setKey("");
        setSample(null);
        setCatalog(null);
        setHistory(null);
        setConfirmed(false);
        setSubmitUnknown(false);
        let last = "";
        try { last = localStorage.getItem(`afgo.last.${status.baseUrl}.${next.id}`) ?? ""; }
        catch { /* storage is optional; task history remains available */ }
        selectTask(last);
      }

      useEffect(() => {
        let current = true;
        async function load() {
          const status = await request("connection");
          if (!current) return;
          setConnection(status);
          if (status.configured) {
            const verified = await request("verify");
            if (current) applyAccount(verified, status);
          }
        }
        load().catch((error) => { if (current) setNotice(error.message); });
        return () => { current = false; };
      }, [request]);

      useEffect(() => {
        if (!account || !id) return;
        let current = true;
        let timer;
        async function refresh() {
          try {
            const next = await request("task", { id });
            if (!current) return;
            setTask(next);
            setPollError("");
            setUpdatedAt(new Date());
            if (next.active === true) timer = setTimeout(refresh, 6000);
          } catch (error) {
            if (!current) return;
            setPollError(error.message);
            timer = setTimeout(refresh, 12000);
          }
        }
        refresh();
        return () => { current = false; clearTimeout(timer); };
      }, [account, id, request]);

      async function act(label, operation) {
        if (busy) return;
        setBusy(label);
        setNotice("");
        try { await operation(); }
        catch (error) { setNotice(error.message); }
        finally { setBusy(""); }
      }

      async function connect() {
        const next = key ? await request("connect", { key }) : await request("verify");
        applyAccount(next, await request("connection"));
      }

      async function submit() {
        setConfirmed(false);
        try {
          const result = await request("submitSample", {
            confirmed: true, accountId: account.id, fingerprint: sample.fingerprint
          });
          selectTask(result.id);
          try { localStorage.setItem(`afgo.last.${connection.baseUrl}.${account.id}`, result.id); }
          catch { /* the task is also on the platform */ }
          setSample(null);
        } catch (error) {
          setSubmitUnknown(true);
          throw error;
        }
      }

      return h("div", { className: "afgo-workbench" },
        h("style", null, styles),
        h("h2", null, "AsterFire Go 工作台"),
        notice && h("p", { role: "alert", className: "afgo-notice" }, notice),
        panel("1. 连接账号",
          muted(connection?.baseUrl ?? "正在读取插件配置…"),
          account && h("p", { role: "status" }, `已连接 ${account.name}${account.tier ? " · " + account.tier : ""}`),
          h("form", { className: "afgo-row", onSubmit: (e) => { e.preventDefault(); act("connection", connect); } },
            h("label", { htmlFor: "afgo-api-key" }, "AsterFire Go API Key"),
            h("input", { id: "afgo-api-key", type: "password", value: key, autoComplete: "off",
              onChange: (e) => setKey(e.target.value), placeholder: connection?.configured ? "留空验证已配置的 Key" : "粘贴你的 API Key" }),
            h("button", { type: "submit", className: "afgo-primary", disabled: Boolean(busy) ||
              (key ? !connection?.writable : !connection?.configured) }, key ? "验证并保存" : "验证账号"),
            h("a", { href: credentialGuide, target: "_blank", rel: "noreferrer" }, "获取 API Key"),
            connection?.source === "file" && connection.writable && button("移除保存的 Key", () => act("remove", async () => {
              await request("disconnect");
              setAccount(null);
              setConnection(await request("connection"));
              setKey("");
              setCatalog(null);
              setSample(null);
              setHistory(null);
              selectTask("");
            }), Boolean(busy))),
          muted("Key 由 DSH 宿主保存。页面不会读取已保存的明文。")),
        account && panel("2. 找工具和运行样例",
          h("form", { className: "afgo-row", onSubmit: (e) => { e.preventDefault(); act("search", async () => {
            setCatalog(await request("search", { query }));
          }); } },
          h("label", { htmlFor: "afgo-tool-query" }, "搜索 Kit 或 Agent"),
          h("input", { id: "afgo-tool-query", value: query, onChange: (e) => setQuery(e.target.value) }),
          h("button", { type: "submit", disabled: Boolean(busy) }, "搜索工具")),
          catalog && h("ul", { className: "afgo-list" },
            ...["kits", "agents"].flatMap((kind) => catalog[kind].map((tool) =>
              h("li", { className: "afgo-entry", key: kind + tool.name },
                h("strong", null, tool.display_name || tool.name),
                muted([kind === "kits" ? "Kit" : "Agent", tool.name,
                  tool.version && `${tool.version}（${tool.version_source}）`].filter(Boolean).join(" · ")),
                tool.description && muted(tool.description),
                tool.name === sampleTool && muted("可从下方打开官方 TiO₂ (110) 样例"))))),
          catalog && !catalog.kits.length && !catalog.agents.length && muted("没有匹配的目录条目。"),
          row(button("打开 TiO₂ (110) 官方样例", () => act("sample", async () => {
            setSample(await request("sample"));
            setConfirmed(false);
          }), Boolean(busy), true)),
          sample && h("div", { className: "afgo-entry" },
            h("strong", null, sample.title),
            muted(`${sample.tool}${sample.version ? " · " + sample.version : ""}`),
            h("details", null, h("summary", null, "查看官方输入参数"),
              h("pre", null, JSON.stringify(sample.input, null, 2))),
            h("label", { className: "afgo-row" },
              h("input", { type: "checkbox", checked: confirmed,
                onChange: (e) => setConfirmed(e.target.checked), disabled: submitUnknown }),
              "确认使用当前账号提交云端计算，费用以星使平台为准"),
            row(button("提交官方样例", () => act("submit", submit),
              !confirmed || submitUnknown || Boolean(busy), true)),
            submitUnknown && h("p", { className: "afgo-notice" },
              "请先在最近任务中核对是否已有提交记录，再决定是否重新提交。"))),
        account && panel("3. 我的任务",
          row(button("查看最近 Kit 任务", () => act("history", async () => {
            setHistory(await request("tasks"));
          }), Boolean(busy))),
          history && h("ul", { className: "afgo-list" }, ...history.map((entry) =>
            h("li", { className: "afgo-entry", key: entry.id },
              button(`#${entry.id} · ${entry.title}`, () => selectTask(entry.id), Boolean(busy))))),
          history?.length === 0 && muted("当前账号没有 Kit 任务。"),
          h("form", { className: "afgo-row", onSubmit: (e) => {
            e.preventDefault(); if (lookup.trim() !== id) selectTask(lookup.trim());
            else if (id) act("refresh", async () => { setTask(await request("task", { id })); setUpdatedAt(new Date()); });
          } },
          h("label", { htmlFor: "afgo-task-id" }, "任务编号"),
          h("input", { id: "afgo-task-id", value: lookup, inputMode: "numeric", onChange: (e) => setLookup(e.target.value) }),
          h("button", { type: "submit", disabled: !/^[1-9]\d{0,18}$/.test(lookup.trim()) || Boolean(busy) }, "查看 / 刷新")),
          id && !task && !pollError && muted(`正在读取任务 #${id}…`),
          pollError && h("p", { role: "status", className: "afgo-notice" }, `暂时无法同步：${pollError}`),
          task && h("div", { className: "afgo-entry" },
            h("strong", { role: "status" }, `任务 #${task.id} · ${progress(task)}`),
            muted(updatedAt ? `最后更新 ${updatedAt.toLocaleTimeString()}` : ""),
            task.outcome?.reason && muted(task.outcome.reason),
            ...task.steps.map((step, index) => muted(`步骤 ${step.id || index + 1} · ${step.state ?? "待更新"}`)),
            h("h3", null, "产物"),
            (task.files === null || !task.files.length) && muted(task.files === null ? "暂时无法读取产物。" : "暂无可下载产物。"),
            h("ul", { className: "afgo-list" }, ...(task.files ?? []).map((file) =>
              h("li", { className: "afgo-row", key: file.id }, h("span", null, file.name),
                button("下载 " + file.name, () => act("download", async () => {
                  saveDownload(await request("download", { id: task.id, fileId: file.id }));
                }), Boolean(busy) || Number(file.size) > 4 * 1024 * 1024)))),
            muted("超过 4 MiB 的产物请在星使智算网页端下载。"))));
    }

    async function apply(ctx) {
      await ctx.remote.$mount(contribution);
      await ctx.inject(["remote.afgoWorkbench"], (ui) => {
        const request = async (action, fields) => {
          const result = await ui.remote.afgoWorkbench.dispatch({ action, ...fields });
          if (!result.ok) throw new Error(result.error?.message || "星使智算请求失败。");
          return result.value;
        };
        ui.slots.inject("plugins.bundle.config", () => ui.slots.register({
          name: "plugins.bundle.config",
          key: "afgo-dsh",
          inject: () => ({ request })
        }, Page));
      });
    }

    return { apply, inject: ["remote", "slots"] };
  }
});
