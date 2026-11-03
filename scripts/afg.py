#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""afg — AsterFire Go (星使智算平台) command line client.

A dependency-free (Python 3.8+ stdlib only) client for the platform's
"Galileo Open API v1", which is the same contract the official `asterfire`
CLI speaks. It exists so DSH can drive AsterFire Go without needing the
Go binary.

Auth: header `Asterfire-Token: <api token>`.
Base: https://sidereus-ai.com/api/open/v1  (override with --base-url / AFG_BASE_URL)

Token resolution order:
  1. --token
  2. $AFG_TOKEN
  3. ~/.afg/config.json            {"base_url": "...", "token": "..."}
  4. ~/.asterfire/config.json      (official CLI's config, for compatibility)

Exit codes: 0 ok · 1 api/runtime error · 2 usage/config error
"""

import argparse
import base64
import json
import mimetypes
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

DEFAULT_BASE = "https://sidereus-ai.com/api"
API_PREFIX = "/open/v1"
TIMEOUT = 120
VERSION = "1.1.1"
LAST_HEADERS = {}  # headers of the most recent request()


# --------------------------------------------------------------------------
# config
# --------------------------------------------------------------------------
def _home():
    return Path(os.environ.get("USERPROFILE") or Path.home())


def _config_candidates():
    return [
        _home() / ".afg" / "config.json",
        _home() / ".asterfire" / "config.json",
    ]


def load_config():
    cfg = {"base_url": DEFAULT_BASE, "token": None}
    for p in _config_candidates():
        try:
            if p.is_file():
                data = json.loads(p.read_text(encoding="utf-8-sig"))
                if data.get("base_url"):
                    cfg["base_url"] = data["base_url"]
                if data.get("token"):
                    cfg["token"] = data["token"]
                break
        except Exception:
            continue
    cfg["base_url"] = os.environ.get("AFG_BASE_URL") or cfg["base_url"]
    cfg["token"] = os.environ.get("AFG_TOKEN") or cfg["token"]
    return cfg


# --------------------------------------------------------------------------
# http
# --------------------------------------------------------------------------
class AfgError(Exception):
    def __init__(self, message, status=None, payload=None):
        super().__init__(message)
        self.status = status
        self.payload = payload


def _url(base, path, query):
    url = base.rstrip("/") + API_PREFIX + path
    if query:
        clean = {k: v for k, v in query.items() if v is not None}
        if clean:
            url += "?" + urllib.parse.urlencode(clean, doseq=True)
    return url


def _decode(body):
    try:
        return json.loads(body.decode("utf-8"))
    except Exception:
        return body.decode("utf-8", "replace")


def request(method, path, *, query=None, body=None, files=None, token=None,
            base=None, timeout=TIMEOUT, retries=2):
    """Issue one API call. Returns the parsed body; headers land in LAST_HEADERS."""
    token = token or load_config()["token"]
    base = base or load_config()["base_url"]
    if not token:
        raise AfgError(
            "缺少 API 令牌。请先写入 ~/.afg/config.json，或设置环境变量 AFG_TOKEN，"
            "或使用 --token。", status=None)

    url = _url(base, path, query)
    headers = {"Asterfire-Token": token, "Accept": "application/json",
               "User-Agent": "afg-py/1.0 (dsh)"}
    data = None

    if files:
        boundary = "----afg" + base64.urlsafe_b64encode(os.urandom(12)).decode().strip("=")
        chunks = []
        for name, value in (body or {}).items():
            if value is None:
                continue
            chunks.append(("--%s\r\nContent-Disposition: form-data; name=\"%s\"\r\n\r\n"
                           % (boundary, name)).encode() + str(value).encode("utf-8") + b"\r\n")
        for field, fpath in files.items():
            fp = Path(fpath)
            if not fp.is_file():
                raise AfgError("文件不存在: %s" % fp)
            ctype = mimetypes.guess_type(fp.name)[0] or "application/octet-stream"
            chunks.append(("--%s\r\nContent-Disposition: form-data; name=\"%s\"; "
                           "filename=\"%s\"\r\nContent-Type: %s\r\n\r\n"
                           % (boundary, field, fp.name, ctype)).encode("utf-8"))
            chunks.append(fp.read_bytes())
            chunks.append(b"\r\n")
        chunks.append(("--%s--\r\n" % boundary).encode())
        data = b"".join(chunks)
        headers["Content-Type"] = "multipart/form-data; boundary=%s" % boundary
    elif body is not None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"

    last = None
    for attempt in range(retries + 1):
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read()
                ctype = resp.headers.get("Content-Type", "")
                LAST_HEADERS.clear()
                LAST_HEADERS.update(dict(resp.headers))
                if "json" in ctype or raw[:1] in (b"{", b"["):
                    return _decode(raw)
                return raw
        except urllib.error.HTTPError as e:
            raw = e.read()
            payload = _decode(raw)
            msg = None
            if isinstance(payload, dict):
                err = payload.get("error")
                if isinstance(err, dict):
                    msg = err.get("message") or err.get("code")
                elif isinstance(err, str):
                    msg = err
                msg = msg or payload.get("message") or payload.get("detail")
            raise AfgError(msg or ("HTTP %s %s" % (e.code, e.reason)), status=e.code,
                           payload=payload)
        except urllib.error.URLError as e:
            last = e
            if attempt < retries:
                continue
            raise AfgError("网络错误: %s" % (e.reason,))
    raise AfgError("网络错误: %s" % (last,))


def emit(obj, as_json=False):
    if isinstance(obj, bytes):
        sys.stdout.buffer.write(obj)
        return
    text = json.dumps(obj, ensure_ascii=False, separators=(",", ":") if as_json else None,
                      indent=None if as_json else 2)
    print(text)


def unwrap(payload):
    """Return .data when the envelope matches {success, data}."""
    if isinstance(payload, dict) and "data" in payload and "success" in payload:
        return payload["data"]
    return payload


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------
def parse_input(spec):
    """--input accepts inline JSON, @file.json, or '-' for stdin."""
    if spec is None:
        return None
    try:
        if spec == "-":
            return json.loads(sys.stdin.read())
        if spec.startswith("@"):
            return json.loads(Path(spec[1:]).read_text(encoding="utf-8-sig"))
        return json.loads(spec)
    except json.JSONDecodeError as e:
        raise AfgError(
            "JSON 解析失败（%s）。Windows PowerShell 会把内联 JSON 的引号吃掉，"
            "请把参数写进文件后用 --input @params.json。" % e)


def read_text_arg(spec):
    if spec is None:
        return None
    if spec.startswith("@"):
        return Path(spec[1:]).read_text(encoding="utf-8-sig")
    return spec


def download(path, query, out_path):
    token = load_config()["token"]
    base = load_config()["base_url"]
    url = _url(base, path, query)
    req = urllib.request.Request(url, headers={"Asterfire-Token": token,
                                               "User-Agent": "afg-py/1.0 (dsh)"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        ctype = resp.headers.get("Content-Type", "")
        cdisp = resp.headers.get("Content-Disposition", "")
        name = None
        if "filename=" in cdisp:
            name = cdisp.split("filename=")[-1].strip().strip('";')
        target = Path(out_path) if out_path else Path(name or "download.bin")
        n = 0
        with open(target, "wb") as f:
            while True:
                chunk = resp.read(1 << 20)
                if not chunk:
                    break
                f.write(chunk)
                n += len(chunk)
    return {"saved_to": str(target.resolve()), "bytes": n, "content_type": ctype}


# --------------------------------------------------------------------------
# commands
# --------------------------------------------------------------------------
def cmd_info(a):
    return unwrap(request("GET", "/info", token=a.token, base=a.base_url))


def cmd_models(a):
    return unwrap(request("GET", "/models", token=a.token, base=a.base_url))


BRIEF_KEYS = ("name", "display_name", "description", "tags", "type", "author")


def _brief(items, full):
    if full:
        return items
    out = []
    for t in items:
        row = {k: t.get(k) for k in BRIEF_KEYS if t.get(k) not in (None, "", [])}
        if isinstance(row.get("author"), dict):
            row["author"] = row["author"].get("name")
        if t.get("initial_assistant_message"):
            row["has_intro"] = True
        if t.get("input_schema"):
            row["has_schema"] = True
        if t.get("demos"):
            row["demos"] = len(t["demos"])
        out.append(row)
    return out


def cmd_agents(a):
    data = unwrap(request("GET", "/toolboxes", query={"type": "agent"},
                          token=a.token, base=a.base_url))
    items = data.get("toolboxes", data) if isinstance(data, dict) else data
    if a.query:
        q = a.query.lower()
        items = [t for t in items
                 if q in (t.get("name", "") + " " + (t.get("description") or "") + " "
                          + " ".join(t.get("tags") or [])).lower()]
    if getattr(a, "limit", None):
        items = items[:a.limit]
    return {"count": len(items), "agents": _brief(items, getattr(a, "full", False))}


def cmd_kits(a):
    data = unwrap(request("GET", "/toolboxes", query={"type": "kit"},
                          token=a.token, base=a.base_url))
    items = data.get("toolboxes", data) if isinstance(data, dict) else data
    if getattr(a, "query", None):
        q = a.query.lower()
        items = [t for t in items
                 if q in (t.get("name", "") + " " + (t.get("description") or "") + " "
                          + " ".join(t.get("tags") or [])).lower()]
    if getattr(a, "limit", None):
        items = items[:a.limit]
    return {"count": len(items), "kits": _brief(items, getattr(a, "full", False))}


def cmd_kit_schema(a):
    data = unwrap(request("GET", "/toolboxes", query={"type": "kit"},
                          token=a.token, base=a.base_url))
    items = data.get("toolboxes", data) if isinstance(data, dict) else data
    for t in items:
        if t.get("name") == a.name:
            return t
    raise AfgError("找不到 kit: %s（先跑 `afg kits list --query %s`）" % (a.name, a.name))


def cmd_kit_submit(a):
    payload = {"toolbox": a.kit, "input": parse_input(a.input)}
    if a.workspace_id:
        payload["workspace_id"] = a.workspace_id
    return unwrap(request("POST", "/kits/submit", body=payload,
                          token=a.token, base=a.base_url))


def cmd_kit_run(a):
    payload = {"kit_name": a.kit, "input": parse_input(a.input)}
    return unwrap(request("POST", "/tasks/%s/kit-run" % a.task_id, body=payload,
                          token=a.token, base=a.base_url))


def cmd_cloud_list(a):
    return unwrap(request("GET", "/cloud-disk/files",
                          query={"workspace_id": a.workspace_id, "parent_id": a.parent_id,
                                 "page": a.page, "per_page": a.per_page, "q": a.q},
                          token=a.token, base=a.base_url))


def cmd_cloud_upload(a):
    data = unwrap(request("POST", "/cloud-disk/files",
                          body={"workspace_id": a.workspace_id, "parent_id": a.parent_id},
                          files={"file": a.path},
                          token=a.token, base=a.base_url, timeout=max(TIMEOUT, a.timeout)))
    # 服务端返回 {"file": {...}}，文档里的 .id 在 data.file.id 下面
    if isinstance(data, dict) and isinstance(data.get("file"), dict):
        return data["file"]
    return data


def cmd_cloud_download(a):
    return download("/files/%s/download" % a.file_id, {"workspace_id": a.workspace_id}, a.out)


def cmd_tasks_list(a):
    return unwrap(request("GET", "/tasks",
                          query={"type": a.type, "workspace_id": a.workspace_id,
                                 "page": a.page, "per_page": a.per_page,
                                 "keyword": a.keyword, "folder_id": a.folder_id},
                          token=a.token, base=a.base_url))


def cmd_tasks_get(a):
    return unwrap(request("GET", "/tasks/%s" % a.task_id, query={"limit": a.limit},
                          token=a.token, base=a.base_url))


def cmd_tasks_status(a):
    return unwrap(request("GET", "/tasks/%s/status" % a.task_id,
                          query={"step_id": a.step_id},
                          token=a.token, base=a.base_url))


def cmd_tasks_files(a):
    path = str(a.task_id)
    if a.subpath:
        path = base64.b64encode(("%s/%s" % (a.task_id, a.subpath)).encode()).decode()
    return unwrap(request("GET", "/tasks/files", query={"path": path,
                                                       "workspace_id": a.workspace_id},
                          token=a.token, base=a.base_url))


def cmd_tasks_create(a):
    payload = {"message": a.message, "toolbox": a.toolbox, "file_ids": a.file or []}
    if a.llm_model:
        payload["llm_model"] = a.llm_model
    if a.workspace_id:
        payload["workspace_id"] = a.workspace_id
    if a.folder_id:
        payload["folder_id"] = a.folder_id
    return unwrap(request("POST", "/tasks", body=payload,
                          token=a.token, base=a.base_url))


def cmd_tasks_send(a):
    payload = {"message": a.message, "file_ids": a.file or []}
    if a.llm_model:
        payload["llm_model"] = a.llm_model
    return unwrap(request("POST", "/tasks/%s/messages" % a.task_id, body=payload,
                          token=a.token, base=a.base_url))


def cmd_tasks_stop(a):
    return unwrap(request("POST", "/tasks/%s/stop" % a.task_id, body={},
                          token=a.token, base=a.base_url))


def cmd_tasks_rename(a):
    return unwrap(request("POST", "/tasks/%s/rename" % a.task_id,
                          body={"name": a.name, "workspace_id": a.workspace_id},
                          token=a.token, base=a.base_url))


def cmd_tasks_delete(a):
    if not a.yes:
        raise AfgError("删除任务是不可逆操作，确认请加 --yes（task_id=%s）" % a.task_id)
    return unwrap(request("DELETE", "/tasks/%s" % a.task_id, token=a.token, base=a.base_url))


# -- workflows --------------------------------------------------------------
WF = {
    "list": ("GET", "/workflows", None),
    "get": ("GET", "/workflows/{plan_id}", None),
    "delete": ("DELETE", "/workflows/{plan_id}", None),
    "validate": ("POST", "/workflows/{plan_id}/validate", None),
    "execute": ("POST", "/workflows/{plan_id}/execute", None),
    "status": ("GET", "/workflows/{plan_id}/status", None),
    "cancel": ("POST", "/workflows/{plan_id}/cancel", None),
    "executions": ("GET", "/workflows/{plan_id}/executions", None),
    "execution": ("GET", "/workflows/{plan_id}/executions/{execution_id}", None),
    "exec-status": ("GET", "/workflows/{plan_id}/executions/{execution_id}/status", None),
    "lineage": ("GET", "/workflows/{plan_id}/executions/{execution_id}/lineage", None),
    "node-outputs": ("GET", "/workflows/{plan_id}/nodes/{node_id}/outputs", None),
    "node-execution": ("GET", "/workflows/{plan_id}/nodes/{node_id}/execution", None),
    "node-logs": ("GET", "/workflows/{plan_id}/nodes/{node_id}/steps/{step_id}/logs", None),
    "node-retry": ("POST", "/workflows/{plan_id}/nodes/{node_id}/retry", None),
    "node-stop": ("POST", "/workflows/{plan_id}/nodes/{node_id}/stop", None),
}


def cmd_wf(a):
    if a.sub in ("list",):
        return unwrap(request("GET", "/workflows",
                              query={"workspace_id": a.workspace_id, "folder_id": a.folder_id,
                                     "status": a.status},
                              token=a.token, base=a.base_url))
    if a.sub == "create":
        payload = {"title": a.title}
        if a.prompt:
            payload["prompt"] = a.prompt
        if a.file:
            payload["file_ids"] = a.file
        if a.workspace_id:
            payload["workspace_id"] = a.workspace_id
        return unwrap(request("POST", "/workflows", body=payload,
                              token=a.token, base=a.base_url))
    if a.sub == "execute":
        payload = {}
        if a.inherit_inputs_from:
            payload["inherit_inputs_from"] = a.inherit_inputs_from
        if a.use_default_inputs is not None:
            payload["use_default_inputs"] = a.use_default_inputs
        return unwrap(request("POST", "/workflows/%s/execute" % a.plan_id,
                              query={"no_cache": "true" if a.no_cache else None},
                              body=payload, token=a.token, base=a.base_url))
    if a.sub == "status":
        return unwrap(request("GET", "/workflows/%s/status" % a.plan_id,
                              query={"execution_id": a.execution_id},
                              token=a.token, base=a.base_url))
    if a.sub == "exec-status":
        return unwrap(request("GET", "/workflows/%s/executions/%s/status"
                              % (a.plan_id, a.execution_id), token=a.token, base=a.base_url))
    if a.sub == "node-outputs":
        return unwrap(request("GET", "/workflows/%s/nodes/%s/outputs" % (a.plan_id, a.node_id),
                              query={"execution_id": a.execution_id},
                              token=a.token, base=a.base_url))
    if a.sub == "node-execution":
        return unwrap(request("GET", "/workflows/%s/nodes/%s/execution"
                              % (a.plan_id, a.node_id),
                              query={"execution_id": a.execution_id},
                              token=a.token, base=a.base_url))
    if a.sub == "node-logs":
        return unwrap(request("GET", "/workflows/%s/nodes/%s/steps/%s/logs"
                              % (a.plan_id, a.node_id, a.step_id),
                              query={"execution_id": a.execution_id},
                              token=a.token, base=a.base_url))
    if a.sub == "node-stop":
        return unwrap(request("POST", "/workflows/%s/nodes/%s/stop"
                              % (a.plan_id, a.node_id),
                              query={"execution_id": a.execution_id}, body={},
                              token=a.token, base=a.base_url))
    if a.sub == "node-retry":
        return unwrap(request("POST", "/workflows/%s/nodes/%s/retry"
                              % (a.plan_id, a.node_id), body={},
                              token=a.token, base=a.base_url))
    if a.sub == "node-retry-step":
        return unwrap(request("POST", "/workflows/%s/nodes/%s/steps/%s/retry"
                              % (a.plan_id, a.node_id, a.step_id),
                              query={"execution_id": a.execution_id},
                              body=parse_input(a.args) if a.args else {},
                              token=a.token, base=a.base_url))
    if a.sub == "node-input":
        if a.cloud_file_id:
            payload = {"cloud_file_id": a.cloud_file_id}
        else:
            payload = {"content": read_text_arg(a.content)}
        return unwrap(request("POST", "/workflows/%s/nodes/%s/input"
                              % (a.plan_id, a.node_id),
                              query={"execution_id": a.execution_id}, body=payload,
                              token=a.token, base=a.base_url))
    if a.sub == "node-input-file":
        return unwrap(request("POST", "/workflows/%s/nodes/%s/input/file"
                              % (a.plan_id, a.node_id),
                              query={"execution_id": a.execution_id},
                              files={"file": a.file_path}, body={},
                              token=a.token, base=a.base_url))
    if a.sub == "export":
        data = request("GET", "/workflows/%s/export" % a.plan_id,
                        token=a.token, base=a.base_url)
        if a.out:
            text = data if isinstance(data, str) else json.dumps(data, ensure_ascii=False, indent=2)
            Path(a.out).write_text(text, encoding="utf-8")
            return {"saved_to": str(Path(a.out).resolve())}
        return data
    if a.sub == "import":
        text = read_text_arg(a.yaml)
        return unwrap(request("POST", "/workflows/import", body={"yaml": text},
                              token=a.token, base=a.base_url))
    if a.sub == "replace-yaml":
        text = read_text_arg(a.yaml)
        return unwrap(request("PUT", "/workflows/%s/yaml" % a.plan_id, body={"yaml": text},
                              token=a.token, base=a.base_url))
    if a.sub == "validate-yaml":
        text = read_text_arg(a.yaml)
        return unwrap(request("POST", "/workflows/%s/yaml/validate" % a.plan_id,
                              body={"yaml": text}, token=a.token, base=a.base_url))
    if a.sub == "tools":
        return unwrap(request("GET", "/workflow-tools",
                              query={"query": a.query,
                                     "dag_only": "true" if a.dag_only else None},
                              token=a.token, base=a.base_url))
    if a.sub == "tool-contract":
        return unwrap(request("GET", "/workflow-tools/%s/contract" % a.name,
                              token=a.token, base=a.base_url))
    if a.sub == "tool-detail":
        return unwrap(request("GET", "/workflow-tools/%s/detail" % a.name,
                              token=a.token, base=a.base_url))
    if a.sub == "templates":
        return unwrap(request("GET", "/workflow-templates",
                              query={"scope": a.scope, "query": a.query,
                                     "category": a.category},
                              token=a.token, base=a.base_url))
    if a.sub == "template":
        return unwrap(request("GET", "/workflow-templates/%s" % a.template_id,
                              token=a.token, base=a.base_url))
    if a.sub == "use-template":
        body = {"title": a.title} if a.title else {}
        if a.params:
            body.update(parse_input(a.params) or {})
        return unwrap(request("POST", "/workflow-templates/%s/create-workflow" % a.template_id,
                              body=body, token=a.token, base=a.base_url))
    if a.sub == "save-template":
        return unwrap(request("POST", "/workflows/%s/template" % a.plan_id,
                              body=parse_input(a.params) if a.params else {},
                              token=a.token, base=a.base_url))
    if a.sub in WF:
        method, tmpl, _ = WF[a.sub]
        path = tmpl.format(plan_id=getattr(a, "plan_id", None),
                           node_id=getattr(a, "node_id", None),
                           execution_id=getattr(a, "execution_id", None),
                           step_id=getattr(a, "step_id", None))
        return unwrap(request(method, path, body={} if method == "POST" else None,
                              token=a.token, base=a.base_url))
    raise AfgError("未知子命令: wf %s" % a.sub)


def cmd_dev(a):
    if a.sub == "list":
        return unwrap(request("GET", "/dev/images",
                              query={"page": a.page, "per_page": a.per_page,
                                     "name": a.name, "version": a.version},
                              token=a.token, base=a.base_url))
    if a.sub == "clusters":
        return unwrap(request("GET", "/dev/images/build-clusters",
                              token=a.token, base=a.base_url))
    if a.sub == "get":
        return unwrap(request("GET", "/dev/images/%s" % a.image_id,
                              token=a.token, base=a.base_url))
    if a.sub == "create":
        body = {"name": a.name, "version": a.version, "source_type": a.source_type}
        if a.docker_url:
            body["docker_url"] = a.docker_url
        if a.file_id:
            body["file_id"] = a.file_id
        if a.remark:
            body["remark"] = a.remark
        return unwrap(request("POST", "/dev/images", body=body,
                              token=a.token, base=a.base_url))
    if a.sub == "build":
        return unwrap(request("POST", "/dev/images/%s/build" % a.image_id,
                              body={"cluster": a.cluster}, token=a.token, base=a.base_url))
    if a.sub == "task":
        return unwrap(request("GET", "/dev/async-tasks/%s" % a.image_task_id,
                              token=a.token, base=a.base_url))
    if a.sub == "log":
        return unwrap(request("GET", "/dev/async-tasks/%s/log" % a.image_task_id,
                              query={"step_id": a.step_id},
                              token=a.token, base=a.base_url))
    if a.sub == "toolboxes":
        return unwrap(request("GET", "/dev/toolboxes", token=a.token, base=a.base_url))
    if a.sub == "upload-toolbox":
        return unwrap(request("POST", "/dev/toolboxes", files={"file": a.path},
                              body={}, token=a.token, base=a.base_url))
    raise AfgError("未知子命令: dev %s" % a.sub)


def cmd_raw(a):
    query = {}
    for pair in a.query or []:
        if "=" in pair:
            k, v = pair.split("=", 1)
            query[k] = v
    return unwrap(request(a.method.upper(), a.path, query=query or None,
                          body=parse_input(a.body) if a.body else None,
                          token=a.token, base=a.base_url))


# --------------------------------------------------------------------------
# cli
# --------------------------------------------------------------------------
_SUB = argparse.ArgumentParser(add_help=False)
_SUB.add_argument("--token", default=argparse.SUPPRESS)
_SUB.add_argument("--base-url", default=argparse.SUPPRESS)
_SUB.add_argument("--json", action="store_true", default=argparse.SUPPRESS)
_SUB.add_argument("--timeout", type=int, default=argparse.SUPPRESS)


def mkadd(parent, *args, **kwargs):
    """add_parser() that also accepts the global flags after the subcommand."""
    kwargs["parents"] = [_SUB]
    return parent.add_parser(*args, **kwargs)


def build_parser():
    p = argparse.ArgumentParser(
        prog="afg",
        description="AsterFire Go (星使智算) API client — Galileo Open API v1",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""示例:
  afg info
  afg agents --query gromacs
  afg kits schema fpocket-kit
  afg cloud upload protein.pdb
  afg tasks create --toolbox gromacs_modular_agent --message "检查这个结构" --file 12345
  afg tasks status 678 --json
  afg wf list
  afg raw GET /tasks --query type=kit
""")
    p.add_argument("-V", "--version", action="version", version="afg " + VERSION)
    p.add_argument("--token", help="API 令牌（默认读 ~/.afg/config.json 或 AFG_TOKEN）")
    p.add_argument("--base-url", help="API 根地址，默认 https://sidereus-ai.com/api")
    p.add_argument("--json", action="store_true", help="紧凑单行 JSON 输出")
    p.add_argument("--timeout", type=int, default=TIMEOUT)
    sub = p.add_subparsers(dest="cmd", required=True)

    pi = mkadd(sub, "info", help="当前账号信息（= asterfire me）")
    pi.set_defaults(func=cmd_info)
    pm = mkadd(sub, "models", help="可用模型列表")
    pm.set_defaults(func=cmd_models)

    pa = mkadd(sub, "agents", help="列出 Agent 工具箱")
    pa.add_argument("--query", help="按名称/描述/标签过滤")
    pa.add_argument("--limit", type=int, help="最多返回几条")
    pa.add_argument("--full", action="store_true", help="返回完整字段（含长文档）")
    pa.set_defaults(func=cmd_agents)

    k = mkadd(sub, "kits", help="Kit 工具")
    ks = k.add_subparsers(dest="sub", required=True)
    kq = mkadd(ks, "list")
    kq.add_argument("--query")
    kq.add_argument("--limit", type=int, help="最多返回几条")
    kq.add_argument("--full", action="store_true", help="返回完整字段（含长文档）")
    kq.set_defaults(func=cmd_kits)
    ksch = mkadd(ks, "schema")
    ksch.add_argument("name")
    ksch.set_defaults(func=cmd_kit_schema)
    ksub = mkadd(ks, "submit")
    ksub.add_argument("--kit", required=True)
    ksub.add_argument("--input", required=True, help="JSON 或 @params.json")
    ksub.add_argument("--workspace-id", type=int)
    ksub.set_defaults(func=cmd_kit_submit)
    krun = mkadd(ks, "run")
    krun.add_argument("task_id")
    krun.add_argument("--kit", required=True)
    krun.add_argument("--input", required=True)
    krun.set_defaults(func=cmd_kit_run)

    c = mkadd(sub, "cloud", help="云盘文件")
    cs = c.add_subparsers(dest="sub", required=True)
    cl = mkadd(cs, "list")
    cl.add_argument("--parent-id", type=int)
    cl.add_argument("--workspace-id", type=int)
    cl.add_argument("--page", type=int)
    cl.add_argument("--per-page", type=int)
    cl.add_argument("--q")
    cl.set_defaults(func=cmd_cloud_list)
    cu = mkadd(cs, "upload")
    cu.add_argument("path")
    cu.add_argument("--workspace-id", type=int)
    cu.add_argument("--parent-id", type=int)
    cu.set_defaults(func=cmd_cloud_upload)
    cd = mkadd(cs, "download")
    cd.add_argument("file_id")
    cd.add_argument("-o", "--out")
    cd.add_argument("--workspace-id", type=int)
    cd.set_defaults(func=cmd_cloud_download)

    t = mkadd(sub, "tasks", help="Agent 任务")
    ts = t.add_subparsers(dest="sub", required=True)
    tl = mkadd(ts, "list")
    tl.add_argument("--type", choices=["agent", "kit"])
    tl.add_argument("--keyword")
    tl.add_argument("--page", type=int)
    tl.add_argument("--per-page", type=int)
    tl.add_argument("--workspace-id", type=int)
    tl.add_argument("--folder-id", type=int)
    tl.set_defaults(func=cmd_tasks_list)
    tg = mkadd(ts, "get")
    tg.add_argument("task_id")
    tg.add_argument("--limit", type=int)
    tg.set_defaults(func=cmd_tasks_get)
    tst = mkadd(ts, "status")
    tst.add_argument("task_id")
    tst.add_argument("--step-id", type=int)
    tst.set_defaults(func=cmd_tasks_status)
    tf = mkadd(ts, "files")
    tf.add_argument("task_id")
    tf.add_argument("subpath", nargs="?")
    tf.add_argument("--workspace-id", type=int)
    tf.set_defaults(func=cmd_tasks_files)
    tc = mkadd(ts, "create")
    tc.add_argument("--toolbox", required=True)
    tc.add_argument("--message", required=True)
    tc.add_argument("--file", action="append", help="平台文件 ID，可重复")
    tc.add_argument("--llm-model")
    tc.add_argument("--workspace-id", type=int)
    tc.add_argument("--folder-id", type=int)
    tc.set_defaults(func=cmd_tasks_create)
    tsd = mkadd(ts, "send")
    tsd.add_argument("task_id")
    tsd.add_argument("--message", required=True)
    tsd.add_argument("--file", action="append")
    tsd.add_argument("--llm-model")
    tsd.set_defaults(func=cmd_tasks_send)
    tsp = mkadd(ts, "stop")
    tsp.add_argument("task_id")
    tsp.set_defaults(func=cmd_tasks_stop)
    trn = mkadd(ts, "rename")
    trn.add_argument("task_id")
    trn.add_argument("name")
    trn.add_argument("--workspace-id", type=int)
    trn.set_defaults(func=cmd_tasks_rename)
    tdl = mkadd(ts, "delete")
    tdl.add_argument("task_id")
    tdl.add_argument("--yes", action="store_true")
    tdl.set_defaults(func=cmd_tasks_delete)

    w = mkadd(sub, "wf", help="工作流（= asterfire workflows）")
    ws = w.add_subparsers(dest="sub", required=True)
    wl = mkadd(ws, "list")
    wl.add_argument("--workspace-id", type=int)
    wl.add_argument("--folder-id", type=int)
    wl.add_argument("--status")
    wl.set_defaults(func=cmd_wf)
    wc = mkadd(ws, "create")
    wc.add_argument("--title", required=True)
    wc.add_argument("--prompt")
    wc.add_argument("--file", action="append")
    wc.add_argument("--workspace-id", type=int)
    wc.set_defaults(func=cmd_wf)
    for name, extra, attrs in [
        ("get", ["plan_id"], []),
        ("delete", ["plan_id"], []),
        ("validate", ["plan_id"], []),
        ("cancel", ["plan_id"], []),
        ("executions", ["plan_id"], []),
        ("status", ["plan_id"], ["--execution-id"]),
        ("execute", ["plan_id"], ["--execution-id", "--node-id", "--no-cache",
                                  "--inherit-inputs-from", "--use-default-inputs"]),
        ("execution", ["plan_id", "execution_id"], []),
        ("exec-status", ["plan_id", "execution_id"], []),
        ("lineage", ["plan_id", "execution_id"], []),
        ("node-outputs", ["plan_id", "node_id"], ["--execution-id"]),
        ("node-execution", ["plan_id", "node_id"], ["--execution-id"]),
        ("node-logs", ["plan_id", "node_id", "step_id"], ["--execution-id"]),
        ("node-retry", ["plan_id", "node_id"], []),
        ("node-retry-step", ["plan_id", "node_id", "step_id"], ["--execution-id", "--args"]),
        ("node-stop", ["plan_id", "node_id"], ["--execution-id"]),
        ("node-input", ["plan_id", "node_id"], ["--execution-id", "--content",
                                                "--file", "--cloud-file-id"]),
        ("node-input-file", ["plan_id", "node_id"], ["--execution-id", "--file-path"]),
        ("export", ["plan_id"], ["-o/--out"]),
        ("import", [], ["--yaml"]),
        ("replace-yaml", ["plan_id"], ["--yaml"]),
        ("validate-yaml", ["plan_id"], ["--yaml"]),
    ]:
        sp = mkadd(ws, name)
        for pos in extra:
            sp.add_argument(pos)
        for flag in attrs:
            if flag.startswith("-o/--out"):
                sp.add_argument("-o", "--out")
            elif flag == "--no-cache":
                sp.add_argument("--no-cache", action="store_true")
            elif flag == "--use-default-inputs":
                sp.add_argument("--use-default-inputs", dest="use_default_inputs",
                                type=lambda v: v.lower() != "false", default=None)
            elif flag == "--execution-id":
                sp.add_argument("--execution-id")
            elif flag == "--node-id":
                sp.add_argument("--node-id")
            elif flag == "--inherit-inputs-from":
                sp.add_argument("--inherit-inputs-from")
            elif flag == "--step-id":
                sp.add_argument("--step-id")
            elif flag == "--file-path":
                sp.add_argument("--file-path")
            elif flag == "--cloud-file-id":
                sp.add_argument("--cloud-file-id")
            elif flag == "--content":
                sp.add_argument("--content")
            elif flag == "--args":
                sp.add_argument("--args")
            elif flag == "--yaml":
                sp.add_argument("--yaml", required=True)
            elif flag == "--file":
                sp.add_argument("--file")
        sp.set_defaults(func=cmd_wf)
    wt = mkadd(ws, "tools")
    wt.add_argument("--query")
    wt.add_argument("--dag-only", action="store_true")
    wt.set_defaults(func=cmd_wf)
    for nm in ("tool-contract", "tool-detail"):
        sp = mkadd(ws, nm)
        sp.add_argument("name")
        sp.set_defaults(func=cmd_wf)
    wtp = mkadd(ws, "templates")
    wtp.add_argument("--scope")
    wtp.add_argument("--query")
    wtp.add_argument("--category")
    wtp.set_defaults(func=cmd_wf)
    wtpd = mkadd(ws, "template")
    wtpd.add_argument("template_id")
    wtpd.set_defaults(func=cmd_wf)
    wtpu = mkadd(ws, "use-template")
    wtpu.add_argument("template_id")
    wtpu.add_argument("--title")
    wtpu.add_argument("--params")
    wtpu.set_defaults(func=cmd_wf)
    wtps = mkadd(ws, "save-template")
    wtps.add_argument("plan_id")
    wtps.add_argument("--params")
    wtps.set_defaults(func=cmd_wf)

    d = mkadd(sub, "dev", help="开发者镜像与工具包（需要开发者权限）")
    ds = d.add_subparsers(dest="sub", required=True)
    for nm in ("list", "clusters"):
        sp = mkadd(ds, nm)
        sp.add_argument("--page", type=int)
        sp.add_argument("--per-page", type=int)
        sp.add_argument("--name")
        sp.add_argument("--version")
        sp.set_defaults(func=cmd_dev)
    dg = mkadd(ds, "get")
    dg.add_argument("image_id")
    dg.set_defaults(func=cmd_dev)
    dc = mkadd(ds, "create")
    dc.add_argument("--name", required=True)
    dc.add_argument("--version", required=True)
    dc.add_argument("--docker-url")
    dc.add_argument("--file-id")
    dc.add_argument("--remark")
    dc.add_argument("--source-type", default="docker", choices=["docker", "sif_docker"])
    dc.set_defaults(func=cmd_dev)
    db = mkadd(ds, "build")
    db.add_argument("image_id")
    db.add_argument("--cluster", required=True)
    db.set_defaults(func=cmd_dev)
    dt = mkadd(ds, "task")
    dt.add_argument("image_task_id")
    dt.set_defaults(func=cmd_dev)
    dl = mkadd(ds, "log")
    dl.add_argument("image_task_id")
    dl.add_argument("--step-id", required=True)
    dl.set_defaults(func=cmd_dev)
    mkadd(ds, "toolboxes").set_defaults(func=cmd_dev)
    du = mkadd(ds, "upload-toolbox")
    du.add_argument("path")
    du.set_defaults(func=cmd_dev)

    r = mkadd(sub, "raw", help="直接调用任意端点，例如: raw GET /tasks --query type=kit")
    r.add_argument("method")
    r.add_argument("path")
    r.add_argument("--query", action="append")
    r.add_argument("--body")
    r.set_defaults(func=cmd_raw)
    return p


def main(argv=None):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass
    args = build_parser().parse_args(argv)
    try:
        result = args.func(args)
        emit(result, as_json=args.json)
        return 0
    except AfgError as e:
        err = {"success": False, "error": str(e)}
        if e.status is not None:
            err["status_code"] = e.status
        if e.payload is not None:
            err["details"] = e.payload
        print(json.dumps(err, ensure_ascii=False, indent=2), file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
