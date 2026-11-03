# Changelog

遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

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
