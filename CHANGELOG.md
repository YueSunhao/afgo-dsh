# Changelog

遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

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
