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
import difflib
import http.client
import json
import mimetypes
import os
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

DEFAULT_BASE = "https://sidereus-ai.com/api"
API_PREFIX = "/open/v1"
TIMEOUT = 120
VERSION = "1.2.0"
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


def _url(base, path, query, *, prefix=API_PREFIX):
    url = base.rstrip("/") + prefix + path
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


def _request_config(token, base):
    cfg = load_config() if not token or not base else {}
    token = token or cfg["token"]
    base = base or cfg["base_url"]
    if not token:
        raise AfgError(
            "缺少 API 令牌。请先写入 ~/.afg/config.json，或设置环境变量 AFG_TOKEN，"
            "或使用 --token。", status=None)
    return token, base


def request(method, path, *, query=None, body=None, files=None, token=None,
            base=None, timeout=TIMEOUT, retries=2, prefix=API_PREFIX, bearer=False,
            event_limit=None):
    """Issue one API call. Returns the parsed body; headers land in LAST_HEADERS."""
    token, base = _request_config(token, base)
    read_only = method.upper() in ("GET", "HEAD", "OPTIONS")
    if not read_only:
        retries = 0
    url = _url(base, path, query, prefix=prefix)
    headers = {"Accept": "application/json", "User-Agent": "afg-py/1.0 (dsh)"}
    if not bearer:
        headers["Asterfire-Token"] = token
    if event_limit is not None:
        headers["Accept"] = "text/event-stream"
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
            # Non-ASCII names must not travel bare in `filename=`: servers that
            # decode the header as Latin-1 (or drop the bytes outright, as this
            # one does) lose the name. RFC 6266/5987 carries it in `filename*`
            # with the ASCII form kept as a fallback.
            ascii_name = fp.name.encode("ascii", "ignore").decode("ascii").strip() or "file"
            quoted_name = urllib.parse.quote(fp.name, safe="")
            chunks.append(("--%s\r\nContent-Disposition: form-data; name=\"%s\"; "
                           "filename=\"%s\"; filename*=UTF-8''%s\r\n"
                           "Content-Type: %s\r\n\r\n"
                           % (boundary, field, ascii_name, quoted_name,
                              ctype)).encode("utf-8"))
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
        if bearer:
            req.add_unredirected_header("Authorization", "Bearer " + token)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                ctype = resp.headers.get("Content-Type", "")
                LAST_HEADERS.clear()
                LAST_HEADERS.update(dict(resp.headers))
                if event_limit is not None:
                    if not ctype.lower().startswith("text/event-stream"):
                        raise AfgError("会话事件接口未返回 text/event-stream。")
                    return _read_events(resp, event_limit, timeout)
                raw = resp.read()
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
        except (urllib.error.URLError, TimeoutError, ConnectionError,
                http.client.HTTPException) as e:
            last = e
            if attempt < retries:
                continue
            reason = getattr(e, "reason", e)
            if read_only:
                raise AfgError("网络错误: %s" % reason) from None
            raise AfgError(
                "网络错误: %s。写入结果未知，请先查询平台状态再决定是否重试。" % reason
            ) from None
    raise AfgError("网络错误: %s" % (last,))


def _read_events(response, limit, timeout):
    deadline = time.monotonic() + timeout
    events, data = [], []
    fields = {}
    reason = "timeout"
    total_bytes = 0
    try:
        while len(events) < limit and time.monotonic() < deadline:
            line = response.readline(1 << 20)
            if not line:
                reason = "eof"
                break
            total_bytes += len(line)
            if total_bytes > (1 << 20):
                reason = "size_limit"
                break
            line = line.decode("utf-8", "replace").rstrip("\r\n")
            if not line:
                if data:
                    fields["data"] = _decode("\n".join(data).encode("utf-8"))
                    events.append(fields)
                fields, data = {}, []
                continue
            key, _, value = line.partition(":")
            if value.startswith(" "):
                value = value[1:]
            if key == "data":
                data.append(value)
            elif key in ("id", "event"):
                fields[key] = value
    except TimeoutError:
        pass
    if len(events) == limit:
        reason = "limit"
    return {"events": events, "stopped": reason}


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


def _filename_from_content_disposition(cdisp):
    """Recover the server's filename per RFC 6266 / RFC 5987.

    The ext-value form (`filename*=UTF-8''%E4%B8%AD.pdb`) wins because it is
    the only one that survives non-ASCII names; the quoted and bare forms are
    fallbacks. OBS replies carry both, and grabbing the tail of the header is
    what used to leak `"; filename*=UTF-8''` into the local file name.
    """
    if not cdisp:
        return None
    m = re.search(r"filename\*\s*=\s*([^']*)''([^;]+)", cdisp, re.I)
    if m:
        charset = (m.group(1) or "utf-8").strip().lower()
        raw = m.group(2).strip().strip('"')
        try:
            return urllib.parse.unquote(raw, encoding=charset or "utf-8")
        except LookupError:
            return urllib.parse.unquote(raw)
    m = re.search(r'filename\s*=\s*"((?:[^"\\]|\\.)*)"', cdisp, re.I)
    if m:
        return m.group(1).replace('\\"', '"')
    m = re.search(r"filename\s*=\s*([^;]+)", cdisp, re.I)
    if m:
        return m.group(1).strip().strip('"') or None
    return None


def download(path, query, out_path, *, token=None, base=None, timeout=TIMEOUT, max_bytes=None):
    token, base = _request_config(token, base)
    url = _url(base, path, query)
    req = urllib.request.Request(url, headers={"Asterfire-Token": token,
                                               "User-Agent": "afg-py/1.0 (dsh)"})
    try:
        resp = urllib.request.urlopen(req, timeout=timeout)
    except urllib.error.HTTPError as e:
        raw = e.read()
        payload = _decode(raw) if raw else None
        msg = None
        if isinstance(payload, dict):
            err = payload.get("error")
            if isinstance(err, dict):
                msg = err.get("message") or err.get("code")
            elif isinstance(err, str):
                msg = err
        hint = {401: "令牌无效或已过期", 403: "无权访问该文件",
                404: "文件不存在或不属于当前账号"}.get(e.code)
        raise AfgError("下载失败：%s" % (msg or hint or ("服务端返回 HTTP %s" % e.code)),
                       status=e.code, payload=payload) from None
    except urllib.error.URLError as e:
        raise AfgError("下载失败：网络错误（%s）" % (e.reason,)) from None

    with resp:
        length = resp.headers.get("Content-Length", "")
        if max_bytes is not None and length.isdigit() and int(length) > max_bytes:
            raise AfgError("产物超过本次下载大小限制。")
        ctype = resp.headers.get("Content-Type", "")
        name = _filename_from_content_disposition(
            resp.headers.get("Content-Disposition", ""))
        target = Path(out_path) if out_path else Path(name or "download.bin")
        n = 0
        try:
            with open(target, "wb") as f:
                while True:
                    size = 1 << 20 if max_bytes is None else min(1 << 20, max_bytes - n + 1)
                    chunk = resp.read(size)
                    if not chunk:
                        break
                    n += len(chunk)
                    if max_bytes is not None and n > max_bytes:
                        raise AfgError("产物超过本次下载大小限制。")
                    f.write(chunk)
        except OSError as e:
            raise AfgError("无法写入 %s：%s（请确认目录存在且可写）"
                           % (target, e.strerror or e.__class__.__name__)) from None
    return {"saved_to": str(target.resolve()), "bytes": n, "content_type": ctype}


# Set by commands whose body carries the verdict while the process status must
# still be non-zero (today: `wf validate` with blocking issues).
EXIT_OVERRIDE = {"code": 0}


def _blocking_issues(result):
    issues = result.get("issues") if isinstance(result, dict) else None
    return [i for i in (issues or [])
            if i.get("blocks_execute") or i.get("severity") == "error"]


def _mark_validation(result):
    """Make the verdict usable without reading prose.

    The platform answers 200 even when validation carries `blocks_execute:
    true`, so a caller that trusts the HTTP status or the process exit code
    walks straight into a workflow that cannot run. `blocks_execute` is the
    authoritative signal; surface it in the body and in the exit code.
    """
    if not isinstance(result, dict):
        return result
    blocking = _blocking_issues(result)
    result["valid"] = not blocking
    result["blocking_count"] = len(blocking)
    if blocking:
        EXIT_OVERRIDE["code"] = 1
    return result


def _wf_status_fallback(a, reason):
    """Recover progress when the status endpoints answer 5xx.

    `/workflows/{id}/status` and `/workflows/{id}/executions/{exec}/status`
    fail on any plan that owns a real execution, while the execution detail
    endpoint stays healthy and carries per-node state. Degrading to it beats
    reporting nothing.
    """
    plan_id = a.plan_id
    execution_id = getattr(a, "execution_id", None)
    if not execution_id:
        listing = unwrap(request("GET", "/workflows/%s/executions" % plan_id,
                                 token=a.token, base=a.base_url))
        execs = (listing or {}).get("executions") or []
        if not execs:
            raise AfgError("状态接口暂不可用（%s），且该流程没有执行记录" % reason,
                           status=500)
        execution_id = execs[0].get("id")
    detail = unwrap(request("GET", "/workflows/%s/executions/%s"
                            % (plan_id, execution_id),
                            token=a.token, base=a.base_url))
    nodes = detail.get("nodes") if isinstance(detail, dict) else None
    return {
        "degraded": True,
        "reason": "status 接口返回 5xx，已降级读取执行明细（%s）" % reason,
        "plan_status": detail.get("status") if isinstance(detail, dict) else None,
        "execution_id": execution_id,
        "nodes": [{"id": n.get("logical_id") or n.get("id"),
                   "status": n.get("status")} for n in (nodes or [])],
    }


# --------------------------------------------------------------------------
# commands
# --------------------------------------------------------------------------
def cmd_info(a):
    return unwrap(request("GET", "/info", token=a.token, base=a.base_url))


def cmd_models(a):
    return unwrap(request("GET", "/models", token=a.token, base=a.base_url))


BRIEF_KEYS = ("name", "display_name", "description", "tags", "type", "author",
              "version", "version_source", "versions")


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


# ---------------------------------------------------------------------------
# toolbox helpers: version, schema lookup, submit-time validation
# ---------------------------------------------------------------------------

def _asset_version(url, name):
    if not isinstance(url, str) or not url.startswith(("http://", "https://")):
        return None
    try:
        path = urllib.parse.urlsplit(url).path
    except ValueError:
        return None
    parts = [urllib.parse.unquote(part) for part in path.split("/")]
    if not any(part in ("toolbox-icons", "toolbox-icon", "toolbox-demos",
                        "toolboxes", "toolbox", "kits", "kit") for part in parts):
        return None
    for tool, version in zip(parts, parts[1:]):
        if tool == name and re.fullmatch(r"v?\d+(?:\.\d+){1,3}(?:[-+][\w.-]+)?", version):
            return version
    return None


def _toolbox_entry(item):
    entry = dict(item)
    for field in ("version", "current_version", "toolbox_version"):
        if isinstance(item.get(field), str) and item[field].strip():
            entry.update(version=item[field].strip(), version_source=field)
            return entry
    version = _asset_version(item.get("icon"), item.get("name"))
    if version:
        entry.update(version=version, version_source="icon")
        return entry
    demos = set()
    for demo in item.get("demos") or []:
        if not isinstance(demo, dict):
            continue
        value = demo.get("value")
        files = demo.get("files")
        urls = list(value.values()) if isinstance(value, dict) else []
        if isinstance(files, list):
            urls.extend(files)
        demos.update(v for v in (_asset_version(u, item.get("name")) for u in urls) if v)
    if len(demos) == 1:
        entry.update(version=next(iter(demos)), version_source="demo")
    return entry


def _toolboxes(kind, token, base):
    data = unwrap(request("GET", "/toolboxes", query={"type": kind},
                          token=token, base=base))
    items = data.get("toolboxes", data) if isinstance(data, dict) else data
    return [_toolbox_entry(t) for t in items or []]


def _version_key(version):
    match = re.fullmatch(r"v?(\d+(?:\.\d+)*)(?:-([^+]+))?(?:\+.*)?", version)
    if not match:
        return (), False, (), version
    release, prerelease = match.groups()
    suffix = tuple((0, int(p)) if p.isdigit() else (1, p) for p in (prerelease or "").split("."))
    return tuple(map(int, release.split("."))), prerelease is None, suffix, version


def _versions(items):
    versions = {t["version"] for t in items if isinstance(t.get("version"), str) and t["version"]}
    for t in items:
        reported = t.get("versions")
        if isinstance(reported, list):
            versions.update(v for v in reported if isinstance(v, str) and v)
    return sorted(versions, key=_version_key)


def _select_kit(items, name, version=None):
    matches = [t for t in items if t.get("name") == name]
    if not matches:
        raise AfgError("找不到 kit: %s（先跑 `afg kits list --query %s`）" % (name, name))
    versions = _versions(matches)
    candidates = [t for t in matches if t.get("version") == version] if version else matches
    if not candidates:
        raise AfgError("Kit %s 没有可识别的版本 %s。目录版本：%s"
                       % (name, version, "、".join(versions) or "未知"))
    first = candidates[0]
    if any(t.get("input_schema") != first.get("input_schema") for t in candidates[1:]):
        raise AfgError("Kit %s 有多份不同的输入 schema，无法确定提交使用的版本。"
                       "请用 kits schema --version 查看目录版本：%s。"
                       % (name, "、".join(versions) or "未知"))
    return dict(first, versions=versions)


def _validate_kit_input(toolbox, value):
    """Check a submit payload against the kit's own input_schema.

    The platform accepts anything (missing required fields, wrong enum values)
    and only fails later, after the task was queued. Catching it here costs one
    catalog read and keeps the error attached to the argument that caused it.
    """
    schema = (toolbox or {}).get("input_schema") or {}
    fields = [f for f in (schema.get("fields") or []) if isinstance(f, dict)]
    by_name = {f.get("name"): f for f in fields}
    hard, soft = [], []

    for f in fields:
        name = f.get("name")
        required = (f.get("validation") or {}).get("required")
        if required and value.get(name) in (None, "", []):
            hard.append("缺少必填字段 %s（%s）" % (name, f.get("label") or f.get("type")))

    for name, val in value.items():
        f = by_name.get(name)
        if f is None:
            soft.append("未知字段 %s：该 Kit 的 schema 没有这个字段，服务端可能忽略" % name)
            continue
        if f.get("type") == "select":
            allowed = [o["value"] for o in (f.get("options") or [])
                       if isinstance(o, dict) and "value" in o]
            if allowed and val not in allowed:
                hard.append("字段 %s 的取值 %r 不在允许列表 %s 中"
                            % (name, val, allowed[:8]))
        if f.get("type") == "number" and isinstance(val, (int, float)):
            v = f.get("validation") or {}
            if "min" in v and val < v["min"]:
                hard.append("字段 %s=%s 小于最小值 %s" % (name, val, v["min"]))
            if "max" in v and val > v["max"]:
                hard.append("字段 %s=%s 大于最大值 %s" % (name, val, v["max"]))
    return hard, soft



def _suggest_kit_names(name, token, base, limit=3):
    """Suggest catalog entries close to a name that 404'd.

    Name drift is real: `RosettaInterfaceAnalyzer` is listed but only
    `RosettaInterfaceAnalyzer-kit` is registered and callable.
    """
    try:
        data = unwrap(request("GET", "/toolboxes", query={"type": "kit"},
                              token=token, base=base))
    except Exception:
        return []
    items = data.get("toolboxes", data) if isinstance(data, dict) else data
    names = [t.get("name") for t in (items or []) if t.get("name") and t.get("name") != name]
    return difflib.get_close_matches(name, names, n=limit, cutoff=0.75)

def _explain_business_error(message):
    """Attach an actionable hint to the platform's two opaque business errors.

    Neither string names the cause: one means the account lacks the grant, the
    other means the catalog lists a toolbox the server never registered. Users
    otherwise read both as "the plugin is broken".
    """
    if not message:
        return message
    if "not authorized to use this application" in message and "403：" not in message:
        return message + "（403：该工具在当前账号或环境未开放，可在目录里确认它确实存在）"
    if "Application not found" in message and "404：" not in message:
        return message + "（404：服务端没有注册该应用；可能是目录残留、名称不一致，或该条目只在另一环境注册）"
    return message


def _task_outcome(detail):
    """Keep each step's verdict so later output cannot overwrite a failure."""
    evidence = []
    success_reason = None

    for st in detail.get("steps") or []:
        failures = []
        slurm = (st.get("slurm_job_status") or "").upper()
        if slurm in ("FAILED", "CANCELLED", "TIMEOUT", "NODE_FAIL", "OUT_OF_MEMORY"):
            failures.append("slurm=%s" % slurm)
        if isinstance(st.get("status"), int) and st["status"] < 0:
            failures.append("step_status=%s" % st["status"])

        output = (st.get("tool_data") or {}).get("structured_output")
        if not isinstance(output, dict):
            output = {}
        flag = output.get("success")
        if isinstance(flag, dict):
            flag = flag.get("value")
        if flag is False:
            failures.append("structured_output.success=false")
        status = output.get("status")
        if isinstance(status, dict):
            status = status.get("value")
        if isinstance(status, str) and status.lower() in ("error", "failed", "failure"):
            failures.append("structured_output.status=%s" % status)

        if failures:
            evidence.extend(failures)
        elif flag is True:
            success_reason = "structured_output.success=true"
        elif not success_reason:
            data_keys = output.keys() - {"success", "status", "message"}
            if data_keys:
                success_reason = "structured_output 含 %d 个数据字段" % len(data_keys)

    for m in detail.get("messages") or []:
        if "__STEP_FAILED__" in str(m.get("content") or "")[:120]:
            evidence.append("step_failed_marker")
            break

    if detail.get("is_thinking") is True:
        return {"state": "unknown", "reason": "任务仍在运行", "evidence": evidence}
    if evidence:
        state = "partial" if success_reason else "failed"
        reason = "、".join(evidence)
        if success_reason:
            reason = "部分步骤有成功证据，但存在失败步骤：" + reason
        return {"state": state, "reason": reason, "evidence": evidence}
    if success_reason:
        return {"state": "success", "reason": success_reason, "evidence": evidence}
    return {"state": "unknown", "reason": "缺少判定依据", "evidence": evidence}


def _search_text(text):
    return unicodedata.normalize("NFKC", str(text or "")).casefold().strip()


def _search_rank(item, query):
    name = _search_text(item.get("name"))
    display = _search_text(item.get("display_name"))
    if query == name:
        return 0
    if query == display:
        return 1
    if name.startswith(query) or display.startswith(query):
        return 2
    if query in name or query in display:
        return 3
    if any(query in _search_text(item.get(key)) for key in ("description", "tags")):
        return 4
    return None


def _catalog(a, kind):
    items = _toolboxes(kind, a.token, a.base_url)
    groups = {}
    for t in items:
        groups.setdefault(t.get("name"), []).append(t)
    query = _search_text(a.query)
    ranked = [(0 if not query else _search_rank(t, query), t) for t in items]
    matched = [t for rank, t in sorted(((r, t) for r, t in ranked if r is not None),
                                      key=lambda pair: pair[0])]
    selected = {}
    shown = []
    for t in matched:
        name = t.get("name")
        if not a.all_versions and name in selected:
            continue
        if name not in selected:
            selected[name] = _versions(groups[name])
        shown.append(dict(t, versions=selected[name]))
    if a.limit:
        shown = shown[:a.limit]
    return {"count": len(shown), "entries": len(matched),
            kind + "s": _brief(shown, a.full)}


def cmd_agents(a):
    return _catalog(a, "agent")


def cmd_kits(a):
    return _catalog(a, "kit")


def cmd_kit_schema(a):
    return _select_kit(_toolboxes("kit", a.token, a.base_url), a.name, a.version)


def _prepare_kit_input(a):
    value = parse_input(a.input)
    if not isinstance(value, dict):
        raise AfgError("Kit 输入必须是 JSON 对象。")
    if a.force:
        return value, []
    toolbox = _select_kit(_toolboxes("kit", a.token, a.base_url), a.kit)
    hard, warnings = _validate_kit_input(toolbox, value)
    if hard:
        raise AfgError("Kit 输入校验未通过：\n  - " + "\n  - ".join(hard)
                       + "\n（--force 可跳过 schema 校验）")
    return value, warnings


def cmd_kit_submit(a):
    value, warnings = _prepare_kit_input(a)
    payload = {"toolbox": a.kit, "input": value}
    if a.workspace_id:
        payload["workspace_id"] = a.workspace_id
    try:
        result = unwrap(request("POST", "/kits/submit", body=payload,
                                token=a.token, base=a.base_url))
    except AfgError as e:
        message = _explain_business_error(str(e))
        if e.status == 404:
            hints = _suggest_kit_names(a.kit, a.token, a.base_url)
            if hints:
                message += "；目录里有相近条目：%s" % "、".join(hints)
        raise AfgError(message, status=e.status, payload=e.payload) from None
    if warnings and isinstance(result, dict):
        result["warnings"] = warnings
    return result


def cmd_kit_run(a):
    value, warnings = _prepare_kit_input(a)
    payload = {"kit_name": a.kit, "input": value}
    result = unwrap(request("POST", "/tasks/%s/kit-run" % a.task_id, body=payload,
                            token=a.token, base=a.base_url))
    if warnings and isinstance(result, dict):
        result["warnings"] = warnings
    return result


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
    result = data["file"] if isinstance(data, dict) and isinstance(data.get("file"), dict) else data
    # 平台的 multipart 解析会丢掉文件名里的非 ASCII 字节（也会吞掉 %），
    # 中文名会被静默改写成残缺的英文名——先把这件事说出来，别让用户以为传对了。
    local = Path(a.path).name
    stored = result.get("name") if isinstance(result, dict) else None
    if stored and local != stored:
        result["warnings"] = [
            "平台丢弃了文件名中的非 ASCII 字符：%r -> %r。建议改用英文文件名后重新上传。"
            % (local, stored)]
    return result


def cmd_cloud_download(a):
    if a.max_bytes is not None and a.max_bytes < 1:
        raise AfgError("--max-bytes 必须为正整数。")
    return download("/files/%s/download" % a.file_id, {"workspace_id": a.workspace_id},
                    a.out, token=a.token, base=a.base_url, timeout=a.timeout, max_bytes=a.max_bytes)


def cmd_tasks_list(a):
    return unwrap(request("GET", "/tasks",
                          query={"type": a.type, "workspace_id": a.workspace_id,
                                 "page": a.page, "per_page": a.per_page,
                                 "keyword": a.keyword, "folder_id": a.folder_id},
                          token=a.token, base=a.base_url))


def cmd_tasks_get(a):
    detail = unwrap(request("GET", "/tasks/%s" % a.task_id, query={"limit": a.limit},
                           token=a.token, base=a.base_url))
    if isinstance(detail, dict):
        detail["outcome"] = _task_outcome(detail)
    return detail


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
    if a.sub == "delete" and not a.yes:
        raise AfgError("确认删除工作流请加 --yes（plan_id=%s）" % a.plan_id)
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
        try:
            return unwrap(request("GET", "/workflows/%s/status" % a.plan_id,
                                  query={"execution_id": a.execution_id},
                                  token=a.token, base=a.base_url))
        except AfgError as e:
            if e.status is None or e.status < 500:
                raise
            return _wf_status_fallback(a, str(e))
    if a.sub == "exec-status":
        try:
            return unwrap(request("GET", "/workflows/%s/executions/%s/status"
                                  % (a.plan_id, a.execution_id),
                                  token=a.token, base=a.base_url))
        except AfgError as e:
            if e.status is None or e.status < 500:
                raise
            return _wf_status_fallback(a, str(e))
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
    if a.sub == "validate":
        return _mark_validation(unwrap(request("POST", "/workflows/%s/validate"
                                               % a.plan_id,
                                               token=a.token, base=a.base_url)))
    if a.sub == "validate-yaml":
        text = read_text_arg(a.yaml)
        return _mark_validation(unwrap(request("POST", "/workflows/%s/yaml/validate"
                                               % a.plan_id,
                                               body={"yaml": text},
                                               token=a.token, base=a.base_url)))
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


def cmd_wf_session(a):
    action = a.session_action
    token = os.environ.get("AFG_SESSION_TOKEN") or a.token
    path = "/openagent/sessions"
    method = "GET"
    body = None
    query = None
    if action == "plan-create":
        method, path = "POST", "/workflow"
        body = {key: getattr(a, key) for key in ("title", "prompt", "file_ids", "auto_mode")
                if getattr(a, key) is not None}
        query = {"workspace_id": a.workspace_id}
    elif action in ("create", "list"):
        if a.plan_id < 1:
            raise AfgError("plan_id 必须是正整数。")
        if action == "create":
            method, body = "POST", {"plan_id": a.plan_id}
        else:
            query = {"plan_id": a.plan_id}
    else:
        if not a.session_id.strip() or a.session_id in (".", ".."):
            raise AfgError("请提供有效的 session_id。")
        path += "/" + urllib.parse.quote(a.session_id, safe="")
        if action == "events":
            if not 1 <= a.limit <= 100 or not 1 <= a.seconds <= 60:
                raise AfgError("事件读取 limit 必须在 1–100，seconds 必须在 1–60。")
            return request("GET", "/openagent/event", query={"session_id": a.session_id},
                           token=token, base=a.base_url, prefix="", bearer=True, timeout=a.seconds,
                           retries=0, event_limit=a.limit)
        if action == "send":
            parts = (parse_input(a.parts) if a.parts is not None else
                     [{"type": "text", "text": a.message}])
            if (not isinstance(parts, list) or not parts
                    or not all(isinstance(p, dict) and p.get("type") for p in parts)):
                raise AfgError("parts 必须是非空 JSON 对象数组，每项都需要 type。")
            if any(p["type"] == "text" and
                   (not isinstance(p.get("text"), str) or not p["text"].strip()) for p in parts):
                raise AfgError("文本消息不能为空。")
            method, path, body = "POST", path + "/prompt_async", {"parts": parts}
            if a.llm_model:
                body["llm_model"] = a.llm_model
        elif action == "messages":
            if a.limit is not None and a.limit < 1:
                raise AfgError("limit 必须是正整数。")
            path += "/messages"
            query = {"limit": a.limit, "before": a.before}
        else:
            method, path = "POST", path + "/abort"
    response = request(method, path, body=body, query=query, token=token, base=a.base_url,
                       timeout=a.timeout, prefix="", bearer=True)
    data = response.get("data", response) if isinstance(response, dict) else response
    if action == "plan-create":
        return response
    if action in ("send", "abort") and response in (b"", "", None):
        return {"accepted": True}
    if action == "messages":
        cursor = next((v for k, v in LAST_HEADERS.items() if k.lower() == "x-next-cursor"), None)
        if isinstance(data, dict) and isinstance(data.get("messages"), list):
            return dict(data, next_cursor=cursor or data.get("next_cursor"))
        return {"messages": data, "next_cursor": cursor}
    return data


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
    pa.add_argument("--query", help="按注册名、展示名、描述或标签搜索")
    pa.add_argument("--limit", type=int, help="最多返回几条")
    pa.add_argument("--full", action="store_true", help="返回完整字段（含长文档）")
    pa.add_argument("--all-versions", action="store_true", help="保留同注册名的不同目录条目")
    pa.set_defaults(func=cmd_agents)

    k = mkadd(sub, "kits", help="Kit 工具")
    ks = k.add_subparsers(dest="sub", required=True)
    kq = mkadd(ks, "list")
    kq.add_argument("--query")
    kq.add_argument("--limit", type=int, help="最多返回几条")
    kq.add_argument("--full", action="store_true", help="返回完整字段（含长文档）")
    kq.add_argument("--all-versions", action="store_true",
                    help="保留同名 Kit 的每个历史版本（默认按名字折叠）")
    kq.set_defaults(func=cmd_kits)
    ksch = mkadd(ks, "schema")
    ksch.add_argument("name")
    ksch.add_argument("--version", help="查看指定目录版本的 schema")
    ksch.set_defaults(func=cmd_kit_schema)
    ksub = mkadd(ks, "submit")
    ksub.add_argument("--kit", required=True)
    ksub.add_argument("--input", required=True, help="JSON 或 @params.json")
    ksub.add_argument("--workspace-id", type=int)
    ksub.add_argument("--force", action="store_true", help="跳过提交前的 schema 校验")
    ksub.set_defaults(func=cmd_kit_submit)
    krun = mkadd(ks, "run")
    krun.add_argument("task_id")
    krun.add_argument("--kit", required=True)
    krun.add_argument("--input", required=True)
    krun.add_argument("--force", action="store_true", help="跳过提交前的 schema 校验")
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
    cd.add_argument("--max-bytes", type=int, help=argparse.SUPPRESS)
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
    wd = mkadd(ws, "delete")
    wd.add_argument("plan_id")
    wd.add_argument("--yes", action="store_true", help="确认删除工作流")
    wd.set_defaults(func=cmd_wf)
    session = mkadd(ws, "session", help="Workflow 智算会话")
    actions = session.add_subparsers(dest="session_action", required=True)
    plan = mkadd(actions, "plan-create")
    plan.add_argument("--title")
    plan.add_argument("--prompt")
    plan.add_argument("--file", dest="file_ids", action="append")
    plan.add_argument("--auto-mode", action="store_true", default=None)
    plan.add_argument("--workspace-id", type=int)
    for action in ("create", "list"):
        mkadd(actions, action).add_argument("plan_id", type=int)
    send = mkadd(actions, "send")
    send.add_argument("session_id")
    content = send.add_mutually_exclusive_group(required=True)
    content.add_argument("--message")
    content.add_argument("--parts", help="JSON 数组或 @parts.json")
    send.add_argument("--llm-model")
    messages = mkadd(actions, "messages")
    messages.add_argument("session_id")
    messages.add_argument("--limit", type=int)
    messages.add_argument("--before")
    events = mkadd(actions, "events")
    events.add_argument("session_id")
    events.add_argument("--limit", type=int, default=20)
    events.add_argument("--seconds", type=int, default=10)
    mkadd(actions, "abort").add_argument("session_id")
    session.set_defaults(func=cmd_wf_session)
    for name, extra, attrs in [
        ("get", ["plan_id"], []),
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
        return EXIT_OVERRIDE["code"] or 0
    except AfgError as e:
        err = {"success": False, "error": _explain_business_error(str(e))}
        if e.status is not None:
            err["status_code"] = e.status
        detail = e.payload.get("error") if isinstance(e.payload, dict) else None
        if isinstance(detail, dict):
            if detail.get("code"):
                err["error_code"] = detail.get("code")
            if detail.get("request_id"):
                err["request_id"] = detail.get("request_id")
        if e.payload is not None:
            err["details"] = e.payload
        print(json.dumps(err, ensure_ascii=False, indent=2), file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
