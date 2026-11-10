# Changelog

遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [未发布]

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

- SKILL.md / README 同步上述行为；Kit `file` 字段的说明改为实测边界（字符串 id 可用、数字 id 不可用）。

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

- Kit 的 file 字段仅支持公网 URL，云盘 `file_id` 直传会在运行期失败。
- 未实现分片上传（`/cloud-disk/uploads*`）。
- `wf tools` 在平台侧返回 500，已提供替代路径。
