# Changelog

遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [未发布]

### 体验（UX v3 阶段 A：基础与主题）

- 工作台样式改为一套设计令牌（间距、圆角、字号、颜色），颜色全部映射到 DSH 的 `--dsw-alias-*` 变量；新增 ⓘ 提示、指标卡、折叠区、骨架屏等通用组件。设计规范见 `docs/UX_V3_DESIGN.md`。
- 结构查看器跟随 DSH 深浅色：页面把当前主题色传入 iframe，宿主切换主题时查看器同步更新；对话里的无头渲染图仍固定浅色。
- 数值结果：单值显示为带单位的指标卡（例如 `Gamma_J_per_m2` 显示为「表面能 γ 1.6104 J/m²」），默认保留 5 位有效数字，原始值在悬停提示里；散点图改用主题色。
- 导出文件名只保留一个扩展名，修复保存对话框产生 `.png.png` / `.json.json` 的问题。
- 加载中由文字改为骨架屏。

### 体验（UX v3 阶段 B：工作台信息架构）

- 顶栏合并为一行：品牌、账号胶囊（状态、账号、环境、同步时间，点击进入设置）和「# 任务编号 打开」输入框。去掉了与标签页重复的「继续查看」「发现工具」「输入任务编号」「账号设置」按钮；上次打开的任务仍会自动恢复。
- 任务列表：按「今天 / 昨天 / 更早」分组；每行用状态点表示状态（运行中为脉冲点，未打开为空心点），标题只占一行，次行显示编号、状态、时间、耗时和工具。列表列吸顶，不再在卡片里嵌套滚动。状态筛选里的「待查询」改名为「未打开」。
- 任务详情改为结论优先：标题区下方用一行显示执行 · 判定 · 同步三个信号，判定依据放在 ⓘ 里；新增「结果摘要」卡片，显示主结果表的关键数值（单行显示数值，多行显示最小值和最大值，不标「最优」）、运行时长、任务输入和代表结果图，并提供「下载主结果」。没有结果表时，显示最后一条可读回复。
- 详情子标签调整为「结果 / 过程 / 文件 / 详情」，默认打开「结果」。「过程」包含时间线和关键时间，「详情」包含原始字段、判定依据和完整回复。
- 宿主端 `task` 动作新增 `inputs`：只保留简单值，文件参数只保留文件名，不把服务器路径传给页面（`lib/task-inputs.js`）。
- 常驻的说明小字改为 ⓘ 提示；完整 SHA-256 收进提示，正文只显示前 8 位。页脚和「关于」的文案改为准确描述：页面只读，示例任务需要确认后才会提交。

### 修复

- `wf status` / `wf exec-status`：平台对已有 execution 的流程稳定返回 500，现自动降级到 `wf execution`，结果带 `degraded: true` 与 `nodes[].status`。
- `wf validate` / `validate-yaml`：以 `blocks_execute` 为准，结果体新增 `valid` / `blocking_count`；存在阻塞项时退出码为 1（此前恒为 0，脚本会漏判）。
- 错误输出：`error_code` 与 `request_id` 提到顶层，DSH 插件把两者拼进用户可见的错误信息里。
- `cloud download` 文件名：按 RFC 6266/5987 解析，优先 `filename*` 并做百分号解码，修复 `01.pdb"; filename*=UTF-8''01.pdb` 这类残缺文件名。
- `cloud download` 失败：包装为一句人话（401/403/404 有中文提示，并带 `request_id`），不再抛出 Python 堆栈和本机绝对路径。
- `cloud upload`：文件名含非 ASCII 字符时在结果里返回 `warnings`，提示平台会丢弃这些字符。
- `tasks get` 新增 `outcome` 字段：按 `structured_output.success` / `status` / 数据字段 / 步骤异常综合判定 success/failed/unknown，避免把 COMPLETED 当成功。
- `kits submit` 提交前按 `input_schema` 校验必填项、枚举取值与数值范围，缺字段直接报错（`--force` 可跳过）；未知字段以 `warnings` 返回。
- `kits list` 默认按名字折叠同名多版本（开发环境 `RFdiffusion2` 曾重复 41 条），版本号收进 `versions`；`--all-versions` 保留原始条目。
- `kits submit` 的 403/404 业务错误附加中文解释：前者是账号未授权，后者是目录有、服务端未注册；404 时再给出目录里的相近条目（实测 `RosettaInterfaceAnalyzer` 的真正注册名是 `RosettaInterfaceAnalyzer-kit`）。

### 文档

- 更新 README 产品说明与插件简介，补充工作台使用流程、安装配置、接口认证及使用限制。
- SKILL.md / README 同步上述行为；Kit `file` 字段的说明改为实测边界（字符串 id 可用、数字 id 不可用）。
- 清理文档矛盾：SKILL.md 示例注释与「已知限制」表不再写「file 字段只认公网 URL」，补充 file_id 不能跨环境使用；1.0.0 条目加更正说明。
- README 运行环境与桌面验收提示词更新为 DSH 0.2.2-rc.2，并注明此前完整验收基于 0.2.2-rc.1。

## [1.5.0] — 2026-11-11

### 新增

- 新增只读 `afg_results` 工具，自动读取任务结构和结果图，使用本地 Mol* 生成结构 PNG，保存为 DSH 持久图片附件及来源记录。
- `afg_tasks get` 在任务停止后自动附带图片汇报；结果卡片直接展示图片，回复使用 `report.markdown` 嵌图。
- 图片引用保存在工具结果与展示元数据中，支持会话重开；模型接收文字与图片引用，兼容纯文本模型。
- 固定运行依赖 `playwright-core`，自动探测本机浏览器，独立无登录渲染进程按内容摘要缓存结构图，并支持取消和失败降级。

## [1.4.0] — 2026-11-11

### 新增

- 任务详情新增结果可视化，识别任务文件中的结构、图片与数值表。
- 内置 Mol* 5.13.1 离线结构查看器，支持晶体 CIF、mmCIF、PDB、XYZ/EXTXYZ、SDF/MOL/MOL2、GRO；提供表示切换、帧选择、晶胞、PNG 与来源记录导出。
- CSV/TSV 按原文件行序绘制数值散点，PNG/JPEG/WebP 展示任务原图。
- 文件响应附任务/文件标识、SHA-256 与读取时间；智能体工具 `afg_tasks get/files` 附可视化候选，新增只读 `visualizations` action。
- 补充给大肥鱼的交接流程及可视化验收边界。

## [1.3.0] — 2026-11-10

工作台第二阶段：把「连接 → 找回任务 → 看清卡点 → 找到结果」做成一条可恢复的路径。

### 新增

- 重做工作台首页：顶部紧凑连接条（脱敏账号 / 档位 / 平台环境 / 同步时间 / 账号设置），主操作按状态切换（连接账号 → 继续查看 #任务号 / 发现工具），「我的任务 / 发现工具 / 设置」三页签固定在可见范围。窄窗口双栏折单栏，详情内可返回列表。
- 任务恢复：手动编号、列表打开、样例提交成功统一走 `openTask`；成功后按 `baseUrl + 账号 id` 保存最近任务（`afgo.v2.last.*`），刷新/重进/重启恢复。切换账号按 key 重挂载，立即清空旧视图。
- 任务列表：最近活动排序、编号/标题/工具搜索、类型与状态筛选、分页加载。未读取详情的行标「待查询」，打开后把判定写入本机摘要，避免首屏逐行请求。
- 任务详情三页签：总览（标题/编号/类型/工具注册名/任务实际版本；执行、结果、同步三栏分开）、步骤时间线（按真实时间摆放、排队与执行分段、并行步骤各自定位、点/列表降级、展开看步骤编号/原始状态/错误）、产物。
- 时间线数据口径写入 UI：排队 = 同一步骤 created_at → started_at（调度时间可用时优先），执行 = started_at → ended_at；无同层级起止依据时不显示任务总耗时。
- 活动任务 6 秒轮询、终态停止；网络错误保留上次结果并提示同步延迟（12 秒重试）；切换任务/账号或离开页面停止旧轮询。
- 发现工具：Kit + Agent 目录一次读取并缓存；NFKC + casefold 搜索，精确命中优先（PySCF / pyscf / ＰｙＳＣＦ / DSSP / MACE 验收）；Kit/Agent 筛选；版本来源分层（平台/样例/图标/历史任务/未知）；单独「核对调用权限」，403 只影响该项；TiO₂ 官方样例输入摘要与提交确认。
- 产物：主结果规则（MACE 表面能 → surface_energies.csv，DSSP → dssp_summary.json）、类型/大小、按名称筛选、下载重试、4 MiB 上限与网页端入口、CSV/JSON/MD/LOG 文本预览（引号感知 CSV 解析）。
- 设置页列出时间字段来源与缺失表现，支持清除本机任务缓存。
- 主机侧错误分类：`runAfg` 给失败附加 `statusCode / code / requestId`，工作台区分 401 / 403 / 404 / 网络 / 超限 / 提交结果不明。
- `tests/workbench_client.test.mjs`：16 组纯函数测试（搜索排序、状态判定、时间线降级、主结果规则、CSV、版本来源、key 隔离）。

### 变更

- `lib/workbench.js` 改为统一信封（`{ok, data}` / `{ok: false, error}`），新增 `tasks / task / files / catalog / catalogEntry` 动作，保留 `connection / connect / verify / disconnect / sample / submitSample`。
- 任务详情的「结果判定」只认步骤证据：结构化输出 → 成功，失败步骤 → 部分完成/失败，无证据 → 待核实；Kit 的结构化输出 JSON 不再被当成「可读回复」。
- 列表 `updated_at` 只用于排序与「最近活动」展示，不参与完成时间推断。

### 验证

- 真实只读回归：85244（恢复/工具身份/时间线/CSV 下载）、84047（切换后产物不串）、73045（DSSP）、84052（执行已停止 + 结果待核实 + 可读回复）、30470（方案编号不属于任务，错误可读）。
- 模拟状态回归 28 项：排队→运行→完成、并行步骤、部分失败、缺失时间、断网恢复、账号切换、下载错误、产物空/失败/403、目录 403。
- Web 与桌面端加载验证；明暗主题、窄窗口、键盘导航均有截图与记录。

## [1.2.0] — 2026-11-04

DSH 插件形态（bundle）+ 可检索性改造。同一仓库现在既能 `dsh plugin add`，也能 `git clone` 当技能用。

### 新增

- `package.json`：包名 `afgo-dsh`，声明 `dsh.bundle.patch`，`keywords` 覆盖中英文检索词（科学计算 / 蛋白质设计 / 分子动力学 / 生物信息学 / DFT / 量子化学 等）。
- `cordis.patch.yml`：bundle 补丁，插入 `afgo` 行，可配置 `python` / `baseUrl` / `timeoutMs`。
- `lib/index.js`：注册五个原生工具 —— `afg_platform`、`afg_files`、`afg_tasks`、`afg_workflows`、`afg_raw`。通过 `node:child_process` 调用仓库内的 `scripts/afg.py`，实现零重复；Python 解释器自动探测（会跳过 Windows 应用商店的假壳子），支持超时与 `AbortSignal` 取消。
- README 新增「作为 DSH 插件安装」与「可检索性」两章：工具表、配置项、触发词表、`gh repo edit --add-topic` 发布命令。

### 变更

- `SKILL.md` 的 `description` / `description_en` 重写，覆盖 科学计算、蛋白质设计、分子动力学、生物信息学、DFT 计算、量子化学 等触发词，提升被模型选中的概率。
- 版本号统一到 `1.2.0`（`afg.py --version` 同步）。

### 验证

- 已在本机 `dsh plugin --profile desktop add` 实际安装：`afgo-dsh` 同时写入 profile 的 `dependencies` 与 `dsh.profile.bundles`；`dsh --profile desktop --dump-config` 能看到合成后的 `- id: afgo` 行。
- **用真实的 `@deepseek-ai/dsh-tools` 加载插件成功**：五个工具的 schema 全部通过 `defineTool` 校验。首版因 object 参数缺少 `additionalProperties` 被拒绝（`UNSUPPORTED_SCHEMA`），已修正。
- 踩坑记录：`dsh plugin add <本地目录>` 装成 junction，Node 按真实路径解析 peer 会 `ERR_MODULE_NOT_FOUND`；改用 tarball 安装（实体目录）即正常。已在 README 注明。
- **工具注册需重启 DSH 生效**，该步未执行；本机 AFG 临时令牌已过期（401），真实调用待换新令牌后复测。

## [1.1.1] — 2026-11-03

文档补齐版（无功能变更）。

### 新增

- README 新增 **调用路径** 章节：一次调用经过的三跳示意图、一个真实请求的 URL / 请求头 / 响应示例、Base URL 与响应信封约定。
- README 新增 **依赖** 章节：明确运行时零第三方依赖、无 `requirements.txt`、无需 `pip install`，并把网络 / 平台 / 账号 / 平台侧依赖逐项列清。
- README 新增 **相关链接** 章节：官网、Swagger UI、OpenAPI 规范原文、飞书官方 CLI 指南、发布日志，附可用性复核说明（2026-11 全部 200）。
- `SKILL.md` 增加 **参考资料** 小节，把端点参考、OpenAPI 地址、官方文档链接交给 Agent，便于排障时自查。

### 变更

- 对比表里「作为 DSH 技能」改为「作为 Agent 技能（DSH / WorkBuddy / Claude Code …）」，与跨 Agent 定位一致。
- 「环境要求」拆分为「依赖」与「环境注意事项」两节。

## [1.1.0] — 2026-10-28

跨 Agent 可移植版本。

### 新增

- `scripts/run.sh` / `scripts/run.ps1` 启动器：自动挑选**可实际运行**的 Python 3（会跳过 Windows 应用商店的 `python3` 假壳子），支持 `AFG_PYTHON` 覆盖，找不到时以退出码 2 明确报错。
- README 增加跨 Agent 安装矩阵：DSH、WorkBuddy、Claude Code、Codex、Cursor、Gemini CLI 的用户级 / 项目级目录。
- `SKILL.md` 增加英文 `description_en`，便于英文环境检索。
- `afg --version` / `-V`。

### 变更

- `SKILL.md` frontmatter 精简为 `name` + `description`（+ `description_en`），去掉非标准的 `compatibility` / `allowed-tools`——这两个字段在 DSH 的技能管理器里没有解析代码，在 WorkBuddy 里也不识别，留着只会误导。
- `SKILL.md` 的调用方式改为可移植写法（启动器 / 直接调解释器），不再写死某台机器的 Python 绝对路径。
- 启动器脚本强制 ASCII，规避 Windows PowerShell 5.1 把无 BOM 的 UTF-8 当 GBK 解析导致的中文吞引号问题。

### 兼容性

- DSH：已实测加载并跑通一次完整 Kit 计算。
- WorkBuddy：目录与格式经其应用包内代码确认一致（`<configDir>/skills`、`SKILL.md` + `name`/`description`），加载行为待重启后确认。

## [1.0.0] — 2026-10-27

首个公开版本。

### 新增

- `afg` 命令行客户端（`scripts/afg.py`），单文件、纯标准库、Python 3.8+。
- 覆盖 Galileo Open API v1 的 62 个路径 / 74 个操作：`info`、`models`、`agents`、`kits`、`cloud`、`tasks`、`wf`、`dev`，以及 `raw` 兜底。
- `SKILL.md`：可作为 DSH（DeepSeek Harness）技能加载，含命令地图、平台语义、踩坑清单。
- `reference/api.md`：74 个操作的中文参数参考；`reference/openapi.json`：平台规范快照。
- 配置解析支持 `--token` / `AFG_TOKEN` / `~/.afg/config.json` / `~/.asterfire/config.json` 四级回退。
- 上传、下载流式处理；接口错误结构化输出 `{success:false, error, status_code, details}`，退出码区分成功与失败。

### 已知问题

- Kit 的 file 字段仅支持公网 URL，云盘 `file_id` 直传会在运行期失败。（2026-11 复核更正：字符串 `file_id` 可用，失败的是数字 id，见「未发布」。）
- 未实现分片上传（`/cloud-disk/uploads*`）。
- `wf tools` 在平台侧返回 500，已提供替代路径。
