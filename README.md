# AsterFire Go 科学智算插件

[![ci](https://github.com/YueSunhao/afgo-dsh/actions/workflows/ci.yml/badge.svg)](https://github.com/YueSunhao/afgo-dsh/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![python](https://img.shields.io/badge/python-3.8%2B-blue.svg)](scripts/afg.py)

在 DSH 中连接云端科学计算，完成工具检索、任务管理与结果获取。

`afgo-dsh` 是面向 DeepSeek Harness（DSH）的 AsterFire Go 平台接入插件。通过平台公开接口，将科学计算工具、云端文件、计算任务与工作流能力接入智能体，支持从输入准备、任务提交到进度跟踪和结果下载的完整操作流程。

插件提供可视化工作台与智能体工具调用两种操作入口。用户可以在插件页面管理账号、查找工具和查看任务，也可以通过 DSH 对话调用平台能力。计算任务由 AsterFire Go 平台执行，本地插件负责请求提交、状态同步与结果获取。

## 主要功能

### 账号连接与环境识别

在插件工作台填写 API Key，验证账号后查看脱敏账号信息、账号等级及当前平台环境。凭据由 DSH 宿主服务管理，页面隐藏已保存的 Key。

### Kit 与 Agent 工具检索

按工具注册名、展示名、功能描述或标签搜索平台目录，支持 Kit 与 Agent 分类筛选。

工具条目展示注册名、类型及可识别的版本信息，并标注版本来源。通过平台字段获得的版本，以及根据官方样例或图标路径推断的版本，分别呈现。工具的实际调用权限由当前账号、平台环境及平台授权决定。

### 任务管理与进度查看

通过最近任务列表或右上角的任务编号输入框打开计算任务。详情页先给出结论：标题下方一行显示执行状态、结果判定和同步状态；「结果摘要」卡片显示主结果表的关键数值（带单位）、运行时长、任务输入和代表结果图。没有结果表的 Agent 任务，在摘要中显示最后一条可读回复。

「过程」标签按平台返回的时间记录展示步骤时间线，帮助用户了解任务的提交、等待、执行和结束过程。重新进入工作台时，可恢复当前账号与平台环境下最近查看的任务。

### 计算结果与文件管理

在「文件」标签查看任务文件清单，按名称或类型筛选，识别已配置规则的主结果，并进行下载或文本预览。

工作台支持受限大小的 CSV、JSON、Markdown 和日志文件预览。单个文件的工作台下载上限为 4 MiB，较大文件可通过 AsterFire Go 平台网页端获取。

### 结果可视化

任务详情的「结果」标签按任务文件清单自动识别结构、图片和数值表，排序与对话里的结果图一致。Mol* 查看器在本地加载，颜色跟随 DSH 深浅色主题，支持旋转、缩放、原子球／球棍／蛋白骨架切换、坐标帧选择和全屏；PNG 和来源记录可从 ⋯ 菜单导出。晶体 CIF 与蛋白 mmCIF 按文件内容分别解析；晶胞在文件有记录时显示。图片保留任务生成的原图，点击可放大。CSV／TSV 可选择数值列：1 个值显示带单位的指标卡，2–30 个值显示按数值排序、以零为基线的条形图，更多数值显示折线图；图表均可切换为表格，并且不标注「最优」。

查看器支持 CIF、mmCIF、PDB、XYZ、EXTXYZ、SDF、MOL、MOL2 和 GRO。EXTXYZ 当前只显示坐标帧，额外的晶胞/PBC 属性应通过原文件或 CIF 核对；ASE 二进制轨迹、XTC、压缩包及压缩结构文件保留下载入口。结构预览上限为单文件 4 MiB、显示原子 100,000 个。文件清单可能含输入、中间文件和输出，展示预览时保留任务编号、原文件名和 SHA-256，结果判定沿用任务状态。

智能体可调用 `afg_results` 自动生成结构图并附上任务已有的结果图。图片保存为 DSH 持久附件，在对话的结果卡片中直接显示；返回的 `report.markdown` 可直接用于最终回复。`afg_tasks get` 查询已经停止的任务时也会自动附带图片汇报。原始文件、来源摘要和相机记录随图保存。 [可视化交接与验收说明](docs/VISUALIZATION_HANDOFF.md)

### 智能体任务与工作流

通过 DSH 原生工具调用 Agent 任务、Kit 计算和工作流接口，支持任务创建、状态查询、消息读取、产物获取及工作流执行管理。

智算会话支持方案与会话创建、消息发送、历史查询、实时事件读取和生成中断，适用于需要多轮交互的计算方案设计与执行准备。

## 使用方式

### DSH 插件

在 DSH 插件管理器中安装插件包，按宿主提示完成加载，然后进入「插件 → afgo-dsh → AsterFire Go 工作台」。

| 页面 | 主要用途 |
|---|---|
| 我的任务 | 查看最近任务、按编号找回任务、跟踪步骤、获取结果 |
| 发现工具 | 搜索 Kit 与 Agent、查看工具信息、预览官方样例 |
| 设置 | 配置 API Key、验证账号、查看连接环境 |

插件同时向 DSH 注册以下原生工具，供智能体在对话中调用。

| 工具 | 能力范围 |
|---|---|
| `afg_platform` | 账号信息、可用模型、Kit／Agent 目录及输入要求 |
| `afg_files` | 云端文件查询、上传与下载 |
| `afg_tasks` | Agent 任务、Kit 提交、任务状态、产物管理及可视化候选 |
| `afg_results` | 自动生成结构 PNG、附上已有结果图、在对话中展示并保存来源记录 |
| `afg_workflows` | 工作流定义、校验、执行管理及智算会话 |
| `afg_raw` | 面向开发者的底层接口调用 |

### Agent Skill

项目同时提供包含 `SKILL.md` 和调用脚本的技能目录，可用于支持该技能格式及本地命令执行的智能体环境。

技能模式与 DSH 插件复用同一份 Python 客户端，适合通过自然语言组织平台操作，或将平台调用纳入已有自动化流程。具体安装目录和加载方式以所用智能体的技能规范为准。

## 典型使用流程

1. **连接账号**
   在 AsterFire Go 平台创建 API Key，在插件工作台完成配置与账号验证。
2. **选择工具**
   根据计算需求检索 Kit 或 Agent，核对注册名、输入要求、版本信息和账号权限。
3. **准备与提交**
   上传所需文件，填写输入参数，核对官方样例或任务配置后提交。工作台提供 TiO₂（110）表面能官方样例预览与提交入口，提交前需显式确认。
4. **跟踪任务**
   保存平台返回的任务编号，查看任务状态、步骤记录和平台返回的时间信息。异步请求被受理后，计算结果需通过后续查询确认。
5. **获取结果**
   查看产物清单，预览或下载主结果，结合任务回复、结构化输出和文件内容开展后续分析。

## 安装与配置

### 在 DSH 中安装

在 DSH 插件管理器中添加 GitHub 仓库地址或已下载的插件安装包。

```text
github:YueSunhao/afgo-dsh
```

安装完成后按宿主提示重新加载或重启 DSH，在工作台「设置」中填写 API Key 并验证账号。不同分支和版本的功能范围以对应的版本说明为准。 [版本记录](CHANGELOG.md)

### 安装 Agent Skill

将仓库放入所用智能体的技能目录。以下以 DSH 用户级技能目录为例。

```bash
git clone https://github.com/YueSunhao/afgo-dsh --branch workbench-v2-desktop ~/.dsh/skills/afg
```

技能模式使用 `AFG_TOKEN` 环境变量或用户目录下的 `~/.afg/config.json` 配置令牌。配置文件格式如下，示例中的占位内容需替换为个人 API Key。

```json
{
  "base_url": "https://sidereus-ai.com/api",
  "token": "<你的 API Key>"
}
```

从技能目录执行以下命令，可验证账号连接。

```bash
python3 scripts/afg.py info
```

macOS 和 Linux 可通过 `bash scripts/run.sh info` 启动；Windows 可通过 `powershell -File scripts\run.ps1 info` 启动。完整的配置优先级、命令参数和调用示例见技能文档。 [Agent Skill 使用说明](SKILL.md)

## 接口与运行环境

插件通过 HTTPS 调用 AsterFire Go 平台接口。常规 Open API 使用 `Asterfire-Token` 认证；智算会话按平台文档使用 Bearer 认证。

底层客户端采用 Python 标准库实现，要求 Python 3.8 或更高版本。DSH 插件部分使用宿主提供的运行环境与服务。科学计算所需的软件和计算资源由平台侧提供。

| 项目 | 要求或说明 |
|---|---|
| Python | 3.8 或更高版本 |
| 自动结构图 | 本机 Chrome/Chromium/兼容浏览器，或已有 Playwright Chromium；可用 `browserExecutable` 或 `AFGO_BROWSER` 指定路径 |
| DSH | 当前适配桌面版 0.2.2-rc.2；v1.3 工作台与 v1.5 对话图片的完整验收在 0.2.2-rc.1 上完成，升级后建议按 [验收提示词](docs/DESKTOP_IMAGE_ACCEPTANCE_PROMPT.md) 回归 |
| Node.js | 独立部署插件宿主时，遵循包内 `engines` 声明 |
| 网络 | 能够通过 HTTPS 访问配置的平台地址及所需文件资源 |
| 账号 | 有效的 AsterFire Go API Key 及所调用工具的访问权限 |

接口参数、输入文件类型和可用操作以平台当前文档及工具输入规范为准。工具目录、版本和账号授权可能随平台更新而变化。 [接口参数参考](reference/api.md) · [OpenAPI 规范快照](reference/openapi.json)

## 状态与结果说明

工作台分别呈现执行状态、结果判定和同步状态。结果判定包含成功、部分完成、失败和待核实；缺少结构化判定依据时，保留待核实状态，同时展示可读取的回复和产物。

时间线依据平台实际返回的字段生成。时间记录不足时，展示已有时间点或步骤顺序，帮助用户核对任务过程。

## 使用限制与注意事项

| 项目 | 说明 |
|---|---|
| 工作台文件下载 | 单文件上限为 4 MiB，超限文件通过平台网页端下载 |
| 文件上传 | 客户端采用单次 multipart 上传，分片上传会话尚未实现 |
| Kit 文件输入 | 按工具 schema 提供准确字段名；使用已验证的字符串文件 ID 或公开资源 URL，具体支持范围以工具为准 |
| 非 ASCII 文件名 | 上传时可能受到平台文件名解析影响；客户端会在返回结果中给出相关提示 |
| 工作流状态查询 | 状态接口异常时可降级读取执行详情，返回结果标注 `degraded` |
| 工作流导入与 YAML 替换 | 部分请求字段仍需结合平台实测核对，执行前应完成校验 |
| 开发者功能 | 镜像与开发者工具包操作需要相应的平台权限 |
| 团队资源 | `workspace_id` 参数支持传递，团队协作场景需按实际账号授权验证 |

API Key 应保存在宿主凭据服务或用户级配置中，避免进入项目仓库、日志和截图。撤销令牌可在平台的 API 令牌管理页面操作。

## 项目与文档

本项目为独立维护的开源客户端，基于 AsterFire Go 平台公开接口开发，采用 MIT 许可证。平台账号、工具授权、计算资源与计费由平台侧管理。 [许可证](LICENSE)

- 平台入口与账号管理。 [AsterFire Go](https://sidereus-ai.com)
- 平台功能与操作指南。 [用户手册](https://sidereus-ai.feishu.cn/wiki/QDb7wi90Ziv6oDkC77LcS4Q2nqh)
- 接口说明与调用规范。 [Open API](https://sidereus-ai.feishu.cn/wiki/X5BEw6SoqiKm8Yko5CtcgnBVnzk)
- 官方命令行操作指南。 [AsterFire CLI 使用指南](https://sidereus-ai.feishu.cn/wiki/WKbSwmulLi9zGDkTvE3cGAhHnPh)
- 智能体调用、配置与命令示例。 [Agent Skill 使用说明](SKILL.md)
- 插件源码、版本记录与问题反馈。 [GitHub 仓库](https://github.com/YueSunhao/afgo-dsh) · [版本记录](CHANGELOG.md)

结构预览使用 Mol* 5.13.1，按 MIT 许可证分发，源码和许可证随插件提供。设计参考 research-story-harness 的结构来源记录和表示方式，采用独立实现。 [Mol*](https://github.com/molstar/molstar) · [Mol* 许可证](lib/MOLSTAR-LICENSE) · [参考 skill](https://github.com/Phorbol/research-story-harness/tree/main/skills/ovito-structure)
