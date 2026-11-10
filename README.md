# afgo-dsh — AsterFire Go（星使智算）DSH 插件 · 通用 Agent 技能

[![ci](https://github.com/YueSunhao/afgo-dsh/actions/workflows/ci.yml/badge.svg)](https://github.com/YueSunhao/afgo-dsh/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![python](https://img.shields.io/badge/python-3.8%2B-blue.svg)](scripts/afg.py)
[![node](https://img.shields.io/badge/node-%E2%89%A522.19-339933.svg)](package.json)

一个仓库，两种用法，底层是**同一份纯 Python 标准库客户端**：

| 用法 | 安装 | 生效方式 |
|---|---|---|
| **DSH 插件（bundle）** | `dsh plugin --profile desktop add afgo-dsh` | 重启 DSH，工具列表里直接多出 `afg_platform` / `afg_files` / `afg_tasks` / `afg_workflows` / `afg_raw` |
| **通用 Agent 技能** | `git clone` 到任意 Agent 的技能目录 | DSH 热加载；WorkBuddy 重启后出现在技能列表 |

驱动的是星使智算平台（AsterFire Go，`sidereus-ai.com`）：上传结构文件、提交 Agent / Kit 计算任务、管理云盘、跑工作流、查询状态、下载结果。**不需要下载官方 `asterfire` Go 二进制，也不需要 `pip install` 任何依赖。**

> **English**: A DeepSeek Harness plugin (bundle) and a portable Agent Skill in one repository. Both drive the AsterFire Go science-computing platform through the same stable HTTP contract the official `asterfire` CLI wraps — Galileo Open API v1 (`/open/v1`, header `Asterfire-Token`) — so you get cloud disk, agent tasks, kit runs, and workflows without installing a 10 MB Go binary. Python 3.8+, stdlib only.

---

## 为什么不用官方 CLI

官方 CLI 是这套 REST API 的包装层（它自己的发布说明写着"全部 71 个业务操作统一通过 `/open/v1` 和 `Asterfire-Token` 调用"）。而 CLI 的二进制挂在飞书文档附件里，需要登录才能下载。这个包直接对着同一套契约说话，于是：

| | 官方 `asterfire` CLI | 本项目 `afg` |
|---|---|---|
| 安装 | 下载 9–10 MB 二进制、配 PATH | `git clone` 即可 |
| 依赖 | 无（Go 静态编译） | Python 3.8+（标准库） |
| 覆盖能力 | 71 个业务操作 | 74 个端点（挂在 `/openapi.json` 上，全部枚举） |
| 大文件分片上传 | 支持 | 暂不支持（见[已知限制](#已知限制)） |
| 作为 Agent 技能 | 需自行包装 | 原生就是技能（DSH / WorkBuddy / Claude Code …） |

两者可以共存：`afg` 不会碰 `~/.asterfire/` 下的官方配置（除非你没写自己的配置，它会回退去读）。

## 功能

| 模块 | 能力 |
|---|---|
| 账号 | `info`（当前账号 / 档位 / 团队）、`models`（可用模型） |
| 工具箱 | `agents`（71 个 Agent）、`kits list`（393 个 Kit）、`kits schema`（输入要求） |
| 云盘 | `cloud list` / `upload` / `download` |
| Agent 任务 | `tasks create` / `send` / `list` / `get` / `status` / `files` / `stop` / `rename` / `delete` |
| Kit 计算 | `kits submit`（新任务）/ `kits run`（挂在已有任务里） |
| 工作流 | `wf` 全套：创建、校验、执行、状态、执行记录、谱系、节点输出/日志/重试/停止/输入、导入导出 YAML、模板市场 |
| 智算会话 | `wf session`：建方案、建会话、发送消息、查询历史、读取事件和中断生成 |
| 开发者 | `dev` 镜像与工具包（需账号具备开发者权限） |
| 兜底 | `raw <METHOD> <PATH>` 直接打任意端点 |

完整的 74 个操作、参数和请求体字段见 [`reference/api.md`](reference/api.md)，原始契约见 [`reference/openapi.json`](reference/openapi.json)。

## 调用路径

一次调用从头到尾只经过三跳，没有中间服务：

```
┌──────────────────────┐  ① 读 SKILL.md   ┌──────────────────────┐
│  DSH / WorkBuddy /   │ ───────────────▶ │  Agent 决定用 afg    │
│  Claude Code / …     │                  └──────────┬───────────┘
└──────────────────────┘                             │ ② 执行 shell
                        ┌────────────────────────────▼───────────────────────────┐
                        │ scripts/run.sh  (POSIX)  /  scripts/run.ps1  (Windows) │
                        │        └──▶ scripts/afg.py -- 纯标准库，不装任何包       │
                        └────────────────────────────┬───────────────────────────┘
                                                     │ ③ HTTPS
                                                     │   Asterfire-Token: <token>
                                                     ▼
                              https://sidereus-ai.com/api/open/v1/<path>
                                                     │
                                                     ▼
                                          星使智算平台（真正的计算在这里）
```

具体到一次请求：

```
afg tasks status 55712 --json
  → GET https://sidereus-ai.com/api/open/v1/tasks/55712/status
    headers: { "Asterfire-Token": <token>, "Accept": "application/json" }
  ← 200 {"success":true,"data":{"is_thinking":false, …}}
```

- **Base URL**：`https://sidereus-ai.com/api`，程序自动拼上 `/open/v1`；可用 `--base-url` / `AFG_BASE_URL` 改。
- **认证**：只需要 `Asterfire-Token` 一个请求头，无 OAuth、无 cookie、无浏览器登录。
- **响应信封**：恒为 `{success, data}`；错误为 `{success:false, error:{code,message,details,request_id}}` 并附 `status_code`。
- **端点映射**：CLI 子命令 → REST 路径的对照表在 [`reference/api.md`](reference/api.md)，每个操作的参数、请求体字段都可查。

## 快速开始

### 1. 拿 API 令牌

登录 <https://sidereus-ai.com>，点用户头像 → **API令牌** → 创建一个 → 复制完整令牌。

> CLI 只支持令牌登录，没有账号密码或浏览器登录方式。

### 2. 写配置

`~/.afg/config.json`（Windows 上是 `C:\Users\<你>\.afg\config.json`）：

```json
{
  "base_url": "https://sidereus-ai.com/api",
  "token": "<你的 API 令牌>"
}
```

也可以不用配置文件，用环境变量 `AFG_TOKEN`，或者每次传 `--token`。

### 3. 验证

```bash
python3 scripts/afg.py info
```

能返回 `username`、`tier`、`workspaces` 就说明通了。

### 4. 跑第一个任务

```bash
# 看看有什么 Kit
python3 scripts/afg.py kits list --query dssp

# 看看它要什么输入
python3 scripts/afg.py kits schema DSSP

# 提交（输入写文件，见 examples/kit-input-dssp.json）
python3 scripts/afg.py kits submit --kit DSSP --input @examples/kit-input-dssp.json

# 查产物、下载
python3 scripts/afg.py tasks files <task_id>
python3 scripts/afg.py cloud download <文件id> -o report.md
```

## 作为 DSH 插件安装（bundle）

```bash
# 从 GitHub 直装（现在就能用，已实测）
dsh plugin --profile desktop add github:YueSunhao/afgo-dsh

# 本地仓库（开发时）
dsh plugin --profile desktop add /path/to/afgo-dsh

# npm（发布后可用）
dsh plugin --profile desktop add afgo-dsh
```

装完 **必须重启 DSH**，插件在进程内加载，不重启不会出现。装好后工具列表里会有五个原生工具：

| 工具 | 作用 | 主要 action |
|---|---|---|
| `afg_platform` | 账号、模型、Agent / Kit 目录与输入 schema、健康检查 | `info` `models` `agents` `kits` `kit_schema` `health` |
| `afg_files` | 云盘上传 / 下载 / 列举 | `upload` `download` `list` |
| `afg_tasks` | Agent 任务与 Kit 提交、跟踪、取产物 | `create` `send` `get` `status` `files` `kit_submit` `kit_run` … |
| `afg_workflows` | 工作流定义、执行和智算会话 | `create` `validate` `execute` `status` `node_outputs` `session_*` … |
| `afg_raw` | 任意端点兜底 | 任意 `METHOD + path` |

插件配置写在 `cordis.patch.yml` 的 `insert` 行里（`~/.dsh/profiles/desktop/cordis.patch.yml` 可覆盖）：

```yaml
- insert:
    - id: afgo
      name: afgo-dsh
      config:
        python: ""                                  # 留空自动探测；也可写绝对路径
        baseUrl: "https://sidereus-ai.com/api"
        token: ""                                   # 建议留空，用 ~/.afg/config.json
        timeoutMs: 120000
```

令牌**不要**写进 `token` 字段——那会随 profile 的 `package.json` 落盘。放在 `~/.afg/config.json` 或 `AFG_TOKEN` 环境变量里。

> **本地开发注意**：`dsh plugin add <目录>` 会被 pnpm 装成 **junction / 符号链接**，而 Node 按真实路径解析 `@deepseek-ai/dsh-tools`，从 `E:\...` 往上找不到 profile 的 peer，会报 `ERR_MODULE_NOT_FOUND`。要么用 tarball 装（`npm pack` 后 `dsh plugin add ./afgo-dsh-1.2.0.tgz`），要么走 `github:` / npm——那两条路装的是实体目录，能正常解析。

### 在 DSH 插件页使用工作台

在 DSH Web 中打开 **插件 → afgo-dsh → AsterFire Go 工作台**。已验证的宿主版本为 `0.2.1-rc.5`，工作台使用该版本的插件配置页和宿主凭据服务。

1. 在工作台填写自己的 API Key，点 **验证并保存**。通过账号验证后，DSH 按当前 API 环境保存 Key，页面只显示账号信息。
2. 搜索 Kit 或 Agent，或者打开 **TiO₂ (110) 官方样例**。核对官方参数和平台费用说明后提交。
3. 在 **我的任务** 查看状态和产物。重新打开工作台时会恢复上次提交的任务，也可从最近 Kit 任务或任务编号找回。单个产物最多通过工作台下载 4 MiB，较大的文件可到星使智算网页端下载。

## 作为 Agent 技能安装

本包是标准的 Agent Skills 形态：一个目录 + `SKILL.md`（YAML frontmatter 里 `name` + `description`）+ 脚本。凡是认这套约定的 Agent，把仓库整个 clone 到它的技能目录即可。

| Agent | 用户级（全局） | 项目级 |
|---|---|---|
| **DSH** (DeepSeek Harness) | `~/.dsh/skills/` | `<项目>/.dsh/skills/` |
| **WorkBuddy** | `~/.workbuddy/skills/` | `<项目>/.workbuddy/skills/` |
| Claude Code | `~/.claude/skills/` | `<项目>/.claude/skills/` |
| Codex | `~/.codex/skills/` | `<项目>/.codex/skills/` |
| Cursor | `~/.cursor/skills/` | `<项目>/.cursor/skills/` |
| Gemini CLI | `~/.gemini/skills/` | `<项目>/.gemini/skills/` |

```bash
# 以 DSH 为例；换成上表任意目录即可
git clone https://github.com/YueSunhao/afgo-dsh ~/.dsh/skills/afg

# WorkBuddy
git clone https://github.com/YueSunhao/afgo-dsh ~/.workbuddy/skills/afg
```

Windows PowerShell：

```powershell
git clone https://github.com/YueSunhao/afgo-dsh "$env:USERPROFILE\.dsh\skills\afg"
git clone https://github.com/YueSunhao/afgo-dsh "$env:USERPROFILE\.workbuddy\skills\afg"
```

装好后直接说「帮我用 AsterFire 跑个 DSSP」，Agent 会自动加载 `SKILL.md` 里的命令地图。

- **DSH**：技能目录变更**会话内热加载**，不必重启。
- **WorkBuddy**：技能扫描结果有缓存（`~/.workbuddy/.skill-list-cache.json`），**重启后在技能列表里生效**。
- 目录名建议就叫 `afg`，与 frontmatter 的 `name` 一致，避免个别 Agent 按目录名索引时对不上。

## 运行方式

技能里自带两个启动器，会自动挑一个**真能跑**的 Python 3（Windows 上 `python3` 常是应用商店的假壳子，启动器会跳过它）：

```bash
bash scripts/run.sh info                                        # macOS / Linux / Git Bash
powershell -ExecutionPolicy Bypass -File scripts\run.ps1 info   # Windows

# 或者直接调解释器
python3 scripts/afg.py info
python  scripts\afg.py info
```

用 `AFG_PYTHON` 可以强制指定解释器路径；找不到可用解释器时启动器以退出码 2 结束并说明原因。

## 命令速查

```bash
afg info                                    # 当前账号
afg models                                  # 可用模型
afg agents --query gromacs --limit 5        # 找 Agent
afg kits list --query antibody              # 找 Kit（默认按名字折叠同名多版本）
afg kits schema DSSP                        # Kit 的输入要求

afg cloud upload protein.pdb                # -> {"id": ...}
afg cloud list --q protein                  # 搜云盘文件
afg cloud download <file_id> -o out.pdb     # 下载

afg tasks create --toolbox <agent> \
    --message "分析这个结构" --file <file_id> --llm-model deepseek-v4-pro
afg tasks send <task_id> --message "再补一个 RMSF"
afg tasks get <task_id>                     # 步骤、消息、状态 + outcome 判定
afg tasks files <task_id> [子路径]           # 产物清单
afg tasks stop <task_id>

afg kits submit --kit <kit> --input @params.json
afg kits run <task_id> --kit <kit> --input @params.json

afg wf list
afg wf create --title "流程名" --prompt "预测结构并汇总"
afg wf validate <plan_id>
afg wf execute <plan_id>                    # -> execution_id
afg wf exec-status <plan_id> <execution_id>
afg wf node-outputs <plan_id> <node_id> --execution-id <execution_id>
afg wf delete <plan_id> --yes

afg raw GET /tasks --query type=kit         # 任意端点兜底
```

### 目录版本与智算会话

- `agents` 和 `kits list` 支持按注册名、展示名、描述和标签搜索。`version_source` 标记版本来源，优先读取平台字段，其次参考该工具的图标或官方样例资产路径。`--all-versions`（DSH `all_versions`）可查看每条记录。
- `kits schema <注册名> --version <版本>` 查看对应的目录 schema。提交接口按注册名解析工具。目录中存在多份不同的 schema 时，默认会拦截提交，请先核对该环境实际使用的 schema。
- 智算会话按官方示例向 `/api` 发送 `Authorization: Bearer`。优先读取 `AFG_SESSION_TOKEN`，否则使用当前令牌。常规 Open API 仍用 `Asterfire-Token`。创建方案返回 `id`，创建会话返回 `opencode_session_id`。发消息的响应表示受理，回复用 `messages` 查询。历史分页读取返回的 `next_cursor`，下一次传 `--before`。

```bash
afg wf session plan-create --title "计算方案" --prompt "描述计算需求"
afg wf session create <plan_id>
afg wf session list <plan_id>
afg wf session send <session_id> --message "补充计算需求"
afg wf session messages <session_id> --limit 20
afg wf session events <session_id> --limit 10 --seconds 5
afg wf session abort <session_id>
```

DSH 使用 `afg_workflows` 的 `session_plan_create`、`session_create`、`session_list`、`session_send`、`session_messages`、`session_events` 和 `session_abort`。`session_events` 在一次调用中返回一批 SSE 事件。旧 Agent 的 `afg_tasks create/send` 仍使用原有任务接口。

`--json` 输出紧凑单行（放子命令前后都行），不加则缩进。退出码：`0` 成功、`1` 接口/网络错误（含 `wf validate` 判定有阻塞问题）、`2` 参数错误。

## 平台语义要点

- **六种 ID 不能混**：`file_id`、`task_id`、`step_id`、`plan_id`（工作流定义）、`execution_id`（一次运行）、`node_id`。节点类查询必须同时给 `plan_id + node_id + execution_id`，查日志还要 `step_id`。
- **一切皆异步**。`tasks create` / `kits submit` / `wf execute` 成功返回时，平台已受理请求。通过 `tasks get` 查看任务的 `outcome`，区分 `success`、`partial`、`failed` 和 `unknown`。写入时发生网络错误，应先查询平台状态再决定是否重试。
- **提交前校验**。`kits submit` 和 `kits run` 都要求 JSON 对象，并按 `input_schema` 检查必填项和枚举值。CLI 的 `--force` 只跳过 schema 检查。
- **JSON 字段大小写不统一**：`taskId` 和 `is_thinking` 并存。先跑一次看真实结构，别凭记忆写解析。

## 配置与安全

- 令牌等同账号密码。**不要**把它写进仓库、日志或截图；`.gitignore` 已排除 `*config*.json` 以外的常见泄漏点。
- 推荐把令牌放在 `~/.afg/config.json`（在用户目录，不进任何仓库），而不是项目目录。
- 撤销令牌：网页端「API令牌」页面操作。本 CLI 没有 `logout`，删掉本地配置文件即可。
- 所有请求都走 HTTPS 发往 `sidereus-ai.com`，没有第三方中转。

## 已知限制

| 限制 | 说明 |
|---|---|
| Kit 的 file 字段 | 字符串 `file_id` 实测会被解析成真实文件；**JSON 数字 id 不会**（原样传入后运行期报文件不存在），文件名或坏 id 直接 500。字段名必须与 `input_schema` 一致，写错会被静默忽略。稳妥顺序：字符串 id → 公网 URL → Agent 任务（`tasks create --file <file_id>`）。 |
| 云盘文件名只保留 ASCII | 平台的 multipart 解析会丢掉非 ASCII 字节，中文名会被改写成残缺英文名；`cloud upload` 会在 `warnings` 里提示。建议用英文文件名。 |
| 工作流状态接口 500 | `wf status` / `wf exec-status` 对已有 execution 的流程稳定 500；CLI 自动降级到 `wf execution`，结果带 `degraded: true` 与 `nodes[].status`。 |
| 没有分片上传 | 单次 multipart 上传，没有实现 `/cloud-disk/uploads*` 的分片会话。几十 MB 够用，上百 MB 建议用官方 CLI。 |
| `/dev/*` 需要开发者权限 | 普通账号返回 403，不是令牌问题。 |
| `wf tools` 服务端 500 | 平台侧问题（实测可复现），用 `wf tool-contract <name>` 或 `agents --full` 里的 `long_description` 替代。 |
| `wf import` / `replace-yaml` | 请求体按 `{"yaml": "..."}` 组装，字段名未经实机验证。导入前先 `wf validate-yaml`。 |
| 团队/协作路径 | `workspace_id` 参数原样透传，但在无团队的账号上未验证。 |

## 依赖

**运行时零依赖**：只用 Python 标准库（`urllib` / `json` / `argparse` / `pathlib` 等），没有 `requirements.txt`、没有 `pyproject.toml`，**不需要 `pip install` 任何东西**。

| 类别 | 要求 |
|---|---|
| Python | 3.8+（实测 3.11；`run.sh` / `run.ps1` 会自动挑一个真能跑的解释器） |
| 第三方包 | 无 |
| 网络 | HTTPS 出站可达 `sidereus-ai.com` |
| 平台 | Windows / macOS / Linux 均可 |
| 账号 | 一个有效的 AsterFire API 令牌（平台侧，不落盘在仓库里） |
| 平台侧依赖 | 无 —— 分子动力学、结构预测等计算全部在星使智算的集群上跑，本地只负责发请求和收结果 |

可选：装个 `jq` 方便自己在 shell 里裁 JSON（本项目自身不依赖它，`--json` 输出已经够用）。

## 环境注意事项

- 启动器会跳过「存在但跑不起来」的解释器并自动降级；也可用 `AFG_PYTHON` 强制指定
- Windows PowerShell 用户注意：内联 JSON 会被吃掉引号，一律把参数写进文件用 `--input @params.json`

## 相关链接

| 用途 | 链接 |
|---|---|
| 平台官网（注册、取令牌） | <https://sidereus-ai.com> |
| OpenAPI 交互文档（Swagger UI，可直接试调） | <https://sidereus-ai.com/api/open/v1/docs> |
| OpenAPI 规范原文（本仓库快照的来源） | <https://sidereus-ai.com/api/open/v1/openapi.json> |
| 官方 CLI 使用指南（飞书文档） | <https://sidereus-ai.feishu.cn/wiki/WKbSwmulLi9zGDkTvE3cGAhHnPh> |
| 官方 CLI 发布日志（版本变更、破坏性变更） | <https://sidereus-ai.feishu.cn/wiki/HqypwisPAi5UdlkmZZ4cXDFVnjg> |
| 官方 CLI 二进制 | 在上面的「发布日志」页附件里，需登录飞书账号下载（本包用不到） |

> 飞书文档属于平台方的租户空间，可能要求登录或权限；Swagger UI 与 `openapi.json` 是公开的，随时可访问（2026-11 复核均为 200）。
> 取令牌：登录官网 → 右上角用户头像 → **API令牌** → 新建 → 复制完整令牌。

## 可检索性（怎么被搜到 / 怎么被选中）

这条路要做两件事：**人搜得到**（GitHub / npm），**模型选得中**（工具描述与技能描述里得有触发词）。

**触发词已经埋在三处**：`package.json` 的 `keywords`、`SKILL.md` 的 `description`、`lib/index.js` 里每个工具的 `description`。覆盖：

| 中文 | 英文 |
|---|---|
| 科学计算、科学智算、星使智算、云计算、科研自动化 | science-computing, scientific-computing, hpc, workflow |
| 蛋白质设计、蛋白结构预测、蛋白质工程 | protein-design, protein-structure-prediction |
| 分子动力学、分子模拟、分子对接、自由能计算 | molecular-dynamics, docking, free-energy |
| 生物信息学、结构生物信息学 | bioinformatics |
| DFT 计算、密度泛函、量子化学、第一性原理、电子结构 | dft, density-functional-theory, quantum-chemistry |
| 高通量计算 / 筛选、材料计算 | high-throughput, materials-science |

**GitHub 侧**：仓库的 description 与 topics 决定搜索命中。发布后执行（需要 `gh` 已登录）：

```bash
gh repo edit YueSunhao/afgo-dsh \
  --description "AsterFire Go 科学计算插件：蛋白质设计·分子动力学·生物信息学·DFT/量子化学 | DSH plugin + Agent Skill" \
  --add-topic science-computing --add-topic computational-chemistry \
  --add-topic quantum-chemistry --add-topic density-functional-theory \
  --add-topic molecular-dynamics --add-topic protein-design \
  --add-topic bioinformatics --add-topic materials-science \
  --add-topic dsh --add-topic dsh-plugin --add-topic deepseek-harness \
  --add-topic agent-skill --add-topic asterfire --add-topic hpc
```

**npm 侧**：`keywords` 已写入 `package.json`，`npm publish` 后即可被 npm search 检索。

**模型侧**：DSH 里工具是按 `description` 路由的，所以即使不搜仓库，说一句「用星使跑个分子动力学」也会命中 `afg_tasks` / `afg_platform`。

## 兼容性说明

- **DSH 插件（bundle）**：已在本机 `--profile desktop` 实际安装成功，`afgo-dsh` 同时进入 `dependencies`（`link:` 指向仓库）与 `dsh.profile.bundles`。**工具注册需重启 DSH 后生效**——这一步未替用户执行。
- **DSH 技能**：已实测加载并跑通一次完整 Kit 计算与结果下载。
- **WorkBuddy**：其应用包内 `createSkillsDomainService` 的 `skillsDir` 解析为 `<configDir>/skills`（即 `~/.workbuddy/skills`），与本包的目录约定一致；技能格式（`SKILL.md` + `name`/`description`）与其 46 个内置技能完全相同。**加载动作需重启 WorkBuddy 后确认**，本仓库未在 WorkBuddy 内实跑。
- 其他 Agent 按其官方技能目录约定放置即可；没有 shell 执行能力的 Agent 只能读 `SKILL.md`，无法真正调用 API。

## 项目结构

```
.
├── package.json             # npm 包 + dsh.bundle.patch 声明（插件入口）
├── cordis.patch.yml         # bundle 补丁：把 afgo 行插进 DSH loader
├── lib/index.js             # 原生工具注册（afg_platform / files / tasks / workflows / raw）
├── SKILL.md                 # 技能入口（命令地图、平台语义、坑）
├── README.md
├── CHANGELOG.md
├── LICENSE                  # MIT
├── scripts/
│   ├── afg.py               # 全部实现，单文件、纯标准库
│   ├── run.sh               # POSIX 启动器（自动挑可用 Python 3）
│   └── run.ps1              # Windows 启动器（同上，ASCII-only）
├── reference/
│   ├── api.md               # 74 个操作的中文端点参考
│   └── openapi.json         # 平台官方 OpenAPI 规范快照
├── examples/
│   └── kit-input-dssp.json  # 一个真实可跑的 Kit 输入示例
└── .github/workflows/ci.yml # Python 语法、Node 语法、CLI、JSON、frontmatter、凭据泄漏
```

插件与技能共用同一份 `scripts/afg.py`：插件通过 `node:child_process` 调它，技能通过 `run.sh` / `run.ps1` 调它，不存在两份实现漂移。

## 免责声明

本项目是**非官方**客户端，与北京星使智算科技有限公司无隶属关系，仅为公开 HTTP 接口的用法封装。接口契约以平台方为准，升级后若字段变化，以 `reference/openapi.json` 最新拉取结果为准：

```bash
curl -s https://sidereus-ai.com/api/open/v1/openapi.json -o reference/openapi.json
```

## License

MIT，见 [LICENSE](LICENSE)。
