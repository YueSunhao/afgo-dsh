# afg — AsterFire Go 命令行客户端 · DSH 技能

用**纯 Python 标准库**驱动星使智算平台（AsterFire Go，`sidereus-ai.com`）：上传结构文件、提交 Agent / Kit 计算任务、管理云盘、跑工作流、查询状态、下载结果。

不需要下载官方 `asterfire` Go 二进制，也不需要 `pip install` 任何依赖。

> **English**: A dependency-free Python client (and DeepSeek Harness skill) for the AsterFire Go science-computing platform. It speaks the same stable HTTP contract that the official `asterfire` CLI wraps — Galileo Open API v1 (`/open/v1`, header `Asterfire-Token`) — so you get cloud disk, agent tasks, kit runs, and workflows without installing a 10 MB Go binary. Python 3.8+, stdlib only.

---

## 为什么不用官方 CLI

官方 CLI 是这套 REST API 的包装层（它自己的发布说明写着"全部 71 个业务操作统一通过 `/open/v1` 和 `Asterfire-Token` 调用"）。而 CLI 的二进制挂在飞书文档附件里，需要登录才能下载。这个包直接对着同一套契约说话，于是：

| | 官方 `asterfire` CLI | 本项目 `afg` |
|---|---|---|
| 安装 | 下载 9–10 MB 二进制、配 PATH | `git clone` 即可 |
| 依赖 | 无（Go 静态编译） | Python 3.8+（标准库） |
| 覆盖能力 | 71 个业务操作 | 74 个端点（挂在 `/openapi.json` 上，全部枚举） |
| 大文件分片上传 | 支持 | 暂不支持（见[已知限制](#已知限制)） |
| 作为 DSH 技能 | 需自行包装 | 原生就是技能 |

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
| 开发者 | `dev` 镜像与工具包（需账号具备开发者权限） |
| 兜底 | `raw <METHOD> <PATH>` 直接打任意端点 |

完整的 74 个操作、参数和请求体字段见 [`reference/api.md`](reference/api.md)，原始契约见 [`reference/openapi.json`](reference/openapi.json)。

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

## 装成 DSH 技能

DSH（DeepSeek Harness）会扫描技能目录，把本仓库整个放进技能目录即可，`SKILL.md` 就是入口：

```bash
# 全局技能：所有项目都能用
git clone <本仓库地址> ~/.dsh/skills/afg

# 或项目级技能：只在这个仓库里生效
git clone <本仓库地址> <你的项目>/.dsh/skills/afg
```

Windows：

```powershell
git clone <本仓库地址> "$env:USERPROFILE\.dsh\skills\afg"
```

装好后在 DSH 里直接说"帮我用 AsterFire 跑个 DSSP"，模型会自动加载 `SKILL.md` 里的命令地图；技能目录变更后会话内热加载，不必重启。

## 命令速查

```bash
afg info                                    # 当前账号
afg models                                  # 可用模型
afg agents --query gromacs --limit 5        # 找 Agent
afg kits list --query antibody              # 找 Kit
afg kits schema DSSP                        # Kit 的输入要求

afg cloud upload protein.pdb                # -> {"id": ...}
afg cloud list --q protein                  # 搜云盘文件
afg cloud download <file_id> -o out.pdb     # 下载

afg tasks create --toolbox <agent> \
    --message "分析这个结构" --file <file_id> --llm-model deepseek-v4-pro
afg tasks send <task_id> --message "再补一个 RMSF"
afg tasks get <task_id>                     # 步骤、消息、状态
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

afg raw GET /tasks --query type=kit         # 任意端点兜底
```

`--json` 输出紧凑单行（放子命令前后都行），不加则缩进。退出码：`0` 成功、`1` 接口/网络错误、`2` 参数错误。

## 平台语义要点

- **六种 ID 不能混**：`file_id`、`task_id`、`step_id`、`plan_id`（工作流定义）、`execution_id`（一次运行）、`node_id`。节点类查询必须同时给 `plan_id + node_id + execution_id`，查日志还要 `step_id`。
- **一切皆异步**：`tasks create` / `kits submit` / `wf execute` 返回成功只代表请求被受理，不代表算完。`is_thinking=false` 也不等于成功，要再看步骤和产物。
- **JSON 字段大小写不统一**：`taskId` 和 `is_thinking` 并存。先跑一次看真实结构，别凭记忆写解析。

## 配置与安全

- 令牌等同账号密码。**不要**把它写进仓库、日志或截图；`.gitignore` 已排除 `*config*.json` 以外的常见泄漏点。
- 推荐把令牌放在 `~/.afg/config.json`（在用户目录，不进任何仓库），而不是项目目录。
- 撤销令牌：网页端「API令牌」页面操作。本 CLI 没有 `logout`，删掉本地配置文件即可。
- 所有请求都走 HTTPS 发往 `sidereus-ai.com`，没有第三方中转。

## 已知限制

| 限制 | 说明 |
|---|---|
| Kit 的 file 字段只吃公网 URL | 传云盘数字 `file_id` 能过校验但运行期报 `输入结构文件不存在或为空`；传文件名会 500。跑自带本地文件的 Kit 请先把文件放到可访问 URL，或改用 Agent 任务（`tasks create --file <file_id>`）。 |
| 没有分片上传 | 单次 multipart 上传，没有实现 `/cloud-disk/uploads*` 的分片会话。几十 MB 够用，上百 MB 建议用官方 CLI。 |
| `/dev/*` 需要开发者权限 | 普通账号返回 403，不是令牌问题。 |
| `wf tools` 服务端 500 | 平台侧问题（实测可复现），用 `wf tool-contract <name>` 或 `agents --full` 里的 `long_description` 替代。 |
| `wf import` / `replace-yaml` | 请求体按 `{"yaml": "..."}` 组装，字段名未经实机验证。导入前先 `wf validate-yaml`。 |
| 团队/协作路径 | `workspace_id` 参数原样透传，但在无团队的账号上未验证。 |

## 环境要求

- Python 3.8+，无第三方依赖（Windows / macOS / Linux 均可）
- 网络能访问 `https://sidereus-ai.com`
- Windows PowerShell 用户注意：内联 JSON 会被吃掉引号，一律把参数写进文件用 `--input @params.json`

## 项目结构

```
.
├── SKILL.md                 # DSH 技能入口（命令地图、语义、坑）
├── README.md
├── scripts/afg.py           # 全部实现，单文件
├── reference/
│   ├── api.md               # 74 个操作的中文端点参考
│   └── openapi.json         # 平台官方 OpenAPI 规范快照
├── examples/
│   └── kit-input-dssp.json  # 一个真实可跑的 Kit 输入示例
└── .github/workflows/ci.yml # 语法 + CLI + JSON 校验
```

## 免责声明

本项目是**非官方**客户端，与北京星使智算科技有限公司无隶属关系，仅为公开 HTTP 接口的用法封装。接口契约以平台方为准，升级后若字段变化，以 `reference/openapi.json` 最新拉取结果为准：

```bash
curl -s https://sidereus-ai.com/api/open/v1/openapi.json -o reference/openapi.json
```

## License

MIT，见 [LICENSE](LICENSE)。
