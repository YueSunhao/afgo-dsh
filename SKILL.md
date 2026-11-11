---
name: afg
description: "星使智算 / AsterFire Go / AFGO 科学计算平台的调用入口：把云端科学计算当作本地命令用 —— 蛋白质设计、蛋白质结构预测、分子动力学模拟、分子对接、自由能计算、生物信息学分析、DFT 计算 / 密度泛函 / 量子化学 / 第一性原理、高通量筛选、材料计算。用于上传结构文件、提交 Agent 或 Kit 任务、查询任务状态、下载计算结果、编排多步工作流、列出平台上的 Agent/Kit 目录。当用户提到『科学计算』『跑个计算』『蛋白质设计』『分子动力学』『DFT』『量子化学』『生信分析』『星使/AsterFire/AFGO』，或要求把某个结构交给云端算、并取回轨迹/报告/图表时使用。同样适用于官方 asterfire CLI 未安装的场景：本技能直连同一套 Open API v1，纯 Python 标准库，无需 Go 二进制、无需 pip 安装。"
description_en: "Run cloud science computing from the terminal via AsterFire Go (星使智算): protein design and structure prediction, molecular dynamics, docking, free-energy calculations, bioinformatics, DFT / density-functional / quantum-chemistry workflows, high-throughput screening, materials computation. Upload structures, submit Agent/Kit jobs, poll status, fetch results, and orchestrate multi-step workflows. Same stable Open API v1 the official asterfire CLI wraps, but pure Python stdlib — no Go binary, no pip install."
---

# AFG — AsterFire Go 平台操作

把当前 Agent 接到星使智算平台（AsterFire Go）的 **Galileo Open API v1** 上。官方 `asterfire` CLI 只是这套 HTTP API 的包装层，本技能直接用 Python 标准库调用同一套端点，因此**不需要下载 10 MB 的 Go 二进制，也不需要 pip 装任何包**。

适用于任何支持「读 SKILL.md + 执行 shell 命令」的 Agent：DSH、WorkBuddy、Claude Code、Codex、Cursor 等，用法完全一致。

## 怎么跑

本文件所在目录记为 `<skill-dir>`（含 `SKILL.md` 的那一层）。三种等价写法，任选一种：

```bash
# 1) 启动器（推荐，自动找 Python）
bash <skill-dir>/scripts/run.sh info                              # macOS / Linux / Git Bash
powershell -ExecutionPolicy Bypass -File <skill-dir>\scripts\run.ps1 info   # Windows

# 2) 直接调解释器
python3 <skill-dir>/scripts/afg.py info
python  <skill-dir>\scripts\afg.py info

# 3) 装到 PATH 后（可选）
ln -s <skill-dir>/scripts/afg.py ~/bin/afg
```

启动器按 `AFG_PYTHON` → `python3` / `python` / `py -3` 的顺序找一个可用的 Python 3，找不到会以退出码 2 报错。要求 Python 3.8+，只用标准库。

先跑 `info` 确认令牌有效：能返回 `username`、`tier`、`workspaces` 就是通的。`--json` 输出紧凑单行（放在子命令前后都行），不加则缩进。退出码 `0` 成功、`1` 接口或网络错误（**也包括 `wf validate` 判定存在阻塞问题**）、`2` 参数错误——脚本里靠退出码判断，不要靠输出文本。`wf validate` 的结果体里另有 `valid` / `blocking_count`：含 `blocks_execute=true` 的 issue 时退出码为 1，但 body 仍是正常结果，不是异常。

## 配置

令牌放在 `<home>/.afg/config.json`：

```json
{ "base_url": "https://sidereus-ai.com/api", "token": "<api token>" }
```

解析顺序：`--token` → 环境变量 `AFG_TOKEN` → `~/.afg/config.json` → `~/.asterfire/config.json`（官方 CLI 的配置，兼容用）。`base_url` 同理可用 `--base-url` / `AFG_BASE_URL` 覆盖；末尾不要带 `/open/v1`，程序自己拼。

**安全规则**：令牌等同账号密码。不要把它打印到对话里、不要写进项目目录或提交到仓库、不要出现在给用户看的命令示例里。需要展示配置时用 `afg info`（只回账号信息）。

## 命令地图

| 目的 | 命令 |
|---|---|
| 当前账号 | `info` |
| 可用模型 | `models` |
| Agent 清单 | `agents [--query 关键词] [--limit N] [--full]` |
| Kit 清单 | `kits list [--query] [--limit N] [--full] [--all-versions]`（默认按名字折叠多版本） |
| Kit 输入要求 | `kits schema <kit_name>` |
| 云盘列表 | `cloud list [--parent-id] [--workspace-id] [--q]` |
| 上传文件 | `cloud upload <本地路径>` → 记住返回的 `id` |
| 下载文件 | `cloud download <file_id> -o <本地路径>` |
| 建 Agent 任务 | `tasks create --toolbox <agent> --message "..." [--file <file_id> ...] [--llm-model <m>]` |
| 任务列表 / 详情 / 状态 | `tasks list` · `tasks get <id>`（含 `outcome` 判定）· `tasks status <id> [--step-id]` |
| 任务结果文件 | `tasks files <task_id> [子路径]` |
| 继续对话 | `tasks send <id> --message "..."` |
| 停止 / 改名 / 删除 | `tasks stop <id>` · `tasks rename <id> 新名` · `tasks delete <id> --yes` |
| 直接跑 Kit | `kits submit --kit <kit> --input @params.json` |
| 在已有任务里跑 Kit | `kits run <task_id> --kit <kit> --input @params.json` |
| 工作流 | `wf list/create/get/execute/status/executions/execution/exec-status/lineage` |
| 智算会话 | `wf session plan-create` → `wf session create <plan_id>` → `wf session send <session_id> --message "需求"` → `wf session messages <session_id>` |
| 删除工作流 | `wf delete <plan_id> --yes` |
| 节点 | `wf node-outputs/node-execution/node-logs/node-retry/node-stop/node-input` |
| 流程工具与模板 | `wf tools` · `wf tool-contract <name>` · `wf templates` · `wf use-template <id>` |
| 任意端点兜底 | `raw GET /tasks --query type=kit` · `raw POST /kits/submit --body @body.json` |

完整的接口契约（74 个操作、全部参数和请求体字段）在本技能目录的 `reference/api.md`，原始规范在 `reference/openapi.json`。`--help` 对每一层都可用：`afg --help`、`afg tasks --help`、`afg wf --help`。

## 典型流程

**A. 拿结构文件跑一个 Kit（已实测跑通）**

```bash
afg kits schema DSSP --json          # 先看 input_schema.fields：哪些必填、文件字段叫什么
# file 字段只认公网 URL，把输入写进文件（Windows 上内联 JSON 会被 PowerShell 吃引号）：
#   params.json: {"structure_file": "https://.../1cbs.cif.gz", "output_format": "mmcif"}
afg kits submit --kit DSSP --input @params.json --json
#   => task_id、step_id
afg tasks get <task_id> --json       # 看 args / steps，比 status 信息多
afg tasks files <task_id> --json     # 列结果文件，取每一项的 id
afg cloud download <文件id> -o report.md
```

**B. 让 Agent 干活（对话式，需要多轮确认）**

```bash
afg agents --query gromacs --json                    # 选 agent_name
afg cloud upload protein.pdb --json                  # 拿 file_id
afg tasks create --toolbox gromacs_modular_agent --message "检查这个结构的热稳定性" --file <file_id> --json
afg tasks get <task_id> --json                       # isThinking=false 看 steps
afg tasks send <task_id> --message "再补一个 RMSF 分析" --json
```

**C. 工作流**

```bash
afg wf create --title "蛋白质分析流程" --prompt "预测结构并汇总结果" --json
afg wf get <plan_id> --json          # 检查节点和连接，别只信创建成功
afg wf validate <plan_id> --json     # 先校验再执行
afg wf execute <plan_id> --json      # => execution_id
afg wf exec-status <plan_id> <execution_id> --json
afg wf node-outputs <plan_id> <node_id> --execution-id <execution_id> --json
```

## 平台语义（最容易踩的坑）

### 结果可视化与用户报告

DSH 原生工具 `afg_tasks` 支持只读 `action=visualizations, task_id=<任务编号>`，返回结构、图片和 CSV/TSV 候选及工作台入口。`get` 与 `files` 的返回也包含 `visualizations`。这是 DSH 工具能力；独立 Python CLI 继续通过 `tasks files` 获取文件清单。

每次汇报计算结果时，核对该任务的产物，附上可用的结构预览入口或已下载的结果图片，并说明任务编号、实际文件名与文件角色。工作台路径为「插件 → afgo-dsh → 我的任务 → 打开编号 → 结果可视化」。若已实际导出或下载图片，可使用本地文件链接或 Markdown 图片展示；没有生成图片时给出可操作的查看入口。

结构预览使用本地 Mol*，可导出 PNG 与带任务 ID、文件 ID、SHA-256、相机和表示方式的 scene.json。渲染基于任务文件的真实坐标，文件清单可能同时含输入、中间文件与输出。晶胞及占据率以来源文件为准，自动推断的键线用于显示。EXTXYZ 当前只展示坐标帧；ASE `.traj`、XTC 和压缩结构文件需要下载后在合适工具中查看。缺少可视化文件时，在报告中注明并附现有报告/数据文件。

- **ID 有六种，别混**：`file_id`（云盘/上传）、`task_id`（Agent 或 Kit 任务）、`step_id`（一次工具执行）、`plan_id`（工作流定义）、`execution_id`（工作流某次运行）、`node_id`（流程节点）。节点类查询**必须同时**带 `plan_id + node_id + execution_id`，查日志还要 `step_id`。
- **异步**。`tasks create` / `kits submit` / `wf execute` 成功返回时，平台已受理请求。用 `tasks get` 查看 `outcome`（`success` / `partial` / `failed` / `unknown`），并核对步骤和产物。写入时发生网络错误，应先查询平台状态再决定是否重试。
- **参数名大小写不统一**：同一平台里 `taskId` 和 `is_thinking` 并存。读字段前先 `--json` 看一次真实结构，别凭记忆写解析逻辑。
- **目录版本**。`agents` 和 `kits list` 支持搜索展示名，提交使用注册名。用 `kits schema <注册名> --version <版本>` 检查特定目录版本，版本来自资产路径时以 `version_source` 为准。智算会话 ID 取自 `opencode_session_id`，消息分页使用 `next_cursor`。
- **`--file` 在 `tasks create/send` 里是平台 file_id，不是本地路径**；本地的文件先 `cloud upload`。`wf node-input --file` 才是本地路径。
- **Kit 的 file 字段：字符串 `file_id` 实测可被解析**（2026-11 复核：DSSP、pdb2pqr、PDBFixer-kit 都把它换成了真实文件）。但边界很脆：传 **JSON 数字** id 不会被解析（原样传入，运行期报文件不存在）；传**文件名**或不存在的 id 直接 500；字段名必须与 `input_schema` 一致，写错会被静默忽略。稳妥顺序：字符串 id → 可访问 URL → 改走 Agent 任务（`tasks create --file <file_id>`）。
- **`cloud upload` 的返回是 `data.file`**（真实 id 在 `data.file.id`），不是文档里写的顶层 `.id`。本技能的 `afg cloud upload` 已经把这一层压平，直接输出文件对象。
- **Windows 上不要写内联 JSON**：`--input '{"a":1}'` 会被 PowerShell 5.1 的引号处理弄坏。一律写 `params.json` 再 `--input @params.json`（本技能会给出这个提示）。
- **`kits submit` 的 input 结构由每个 kit 的 `input_schema` 决定**，不要照抄别的 kit 的示例。提交前 CLI 会按 schema 校验必填项与枚举值，不通过会直接报错（`--force` 跳过）；平台本身不校验，错了要等跑完才知道。
- **错误 JSON**：`success:false` + `error{code,message,details,request_id}`；HTTP 码同时给出 `status_code`。`request_id` 报给平台客服时有用，值得原样保留。本 CLI 已把 `error_code` / `request_id` 提到顶层，并会拼进一句话错误里。
- **工作流状态接口可能 500**：`wf status` / `wf exec-status` 对"有真实 execution"的流程会返回 500，而 `wf execution` 正常。CLI 已自动降级：结果里带 `degraded: true`、`plan_status` 和 `nodes[].status`，看到 `degraded` 就知道走了兜底路径，别把它当成接口正常。
- **`wf validate` 以 `blocks_execute` 为准**：结果体有 `valid` / `blocking_count`；含阻塞项时退出码为 1。不要用 HTTP 200 或"有没有 issues"判断可执行性。
- **云盘上传只保留 ASCII 文件名**：平台的 multipart 解析会丢掉非 ASCII 字节（连 `%` 也吞），中文名会被静默改写成残缺英文名。`cloud upload` 会在 `warnings` 里提示；建议直接用英文文件名。
- **权限**：`/dev/*`（镜像、开发者工具包）需要开发者权限，普通账号会 403 —— 这不是令牌坏了。`info` 里的 `user_type`/`tier` 能看出账号档位。

## 已知限制（实现或服务端）

| 情况 | 说明 |
|---|---|
| `wf tools` 500 | 服务端 `internal_error`，加不加 `--dag-only` 都复现（2026-10 实测）。工具契约改用 `wf tool-contract <name>` 或 `agents --full` 里的 `long_description`。 |
| Kit 吃本地文件 | 见上文：file 字段只验证了公网 URL 可用，云盘 file_id 直传会在运行期失败。 |
| 大文件分片上传 | 走的是普通 multipart 一次性上传，没有实现 `/cloud-disk/uploads*` 那套分片会话。几十 MB 级别够用；上百 MB 建议改用官方 CLI。 |
| `wf import/replace-yaml` | 请求体按 `{"yaml": "<yaml 文本>"}` 组装，服务端只声明了 `additionalProperties: true`，字段名未经实机验证；导入前务必先 `wf validate-yaml`。 |
| 团队/协作 | `workspace_id` 相关参数原样透传，但当前账号 `workspaces: []`，团队路径没验证过。 |

## 实测记录（2026-10-27）

同一账号（trial/basic 档位）上验证过的：

- `info` `models` `agents` `kits list` `kits schema` `cloud list` `cloud upload` `cloud download` `raw GET /health` `wf list` `tasks list/get/status/files` — 全部正常。
- 完整执行链跑通一次：`kits submit --kit DSSP` → `tasks files` → `cloud download`，报告「运行状态：成功，解析残基数 137，识别链 A」，拿到 `secondary_structure.tsv`（5 KB，137 行）与 `report.md`。
- `tasks files <task_id>`（`path` 直接传 task_id）**确认可用**，不需要 base64。
- `/dev/*` 返回 403（账号无开发者权限）。
- 失败样本：file 字段传数字 id → 任务建成功但运行期 `FileNotFoundError`；传文件名 → 提交时 500。

## 排障

- `缺少 API 令牌` → 写 `~/.afg/config.json`，或 `export AFG_TOKEN=...`。
- `401` → 令牌无效，或令牌与 `base_url` 不属于同一环境（生产 `https://sidereus-ai.com/api`）。
- `403` → 账号权限不足（团队资源、开发者资源），不是令牌问题。
- `找不到 Python 3` → 设 `AFG_PYTHON` 指向解释器绝对路径，或改用 `<skill-dir>/scripts/afg.py` 直接调用。
- 探测连通性：`afg raw GET /health --json` 应回 `{"status":"ok"}`。

## 参考资料

- 端点参数参考（本目录）：`reference/api.md` —— 74 个操作的参数与请求体字段
- OpenAPI 规范快照（本目录）：`reference/openapi.json`；落后时用
  `curl -s https://sidereus-ai.com/api/open/v1/openapi.json -o reference/openapi.json` 重新拉
- OpenAPI 交互文档（浏览器里可直接试调）：<https://sidereus-ai.com/api/open/v1/docs>
- 官方 CLI 使用指南（飞书，需登录）：<https://sidereus-ai.feishu.cn/wiki/WKbSwmulLi9zGDkTvE3cGAhHnPh>
- 官方 CLI 发布日志（飞书，破坏性变更看这里）：<https://sidereus-ai.feishu.cn/wiki/HqypwisPAi5UdlkmZZ4cXDFVnjg>
- 本仓库 README：安装矩阵、调用路径图、已知限制与兼容性说明
