# 任务结果可视化交接

本轮在现有 DSH 原生工作台中集成结果可视化。结构由本地打包的 Mol* 5.13.1 解析和渲染，任务文件继续通过宿主凭据服务及已有下载接口读取。

## v1.5 对话图片汇报

原生工具 `afg_results` 接收 `task_id`，自动选取一份代表性结构和一张平台结果图。结构在独立的本地无登录浏览器进程内，通过同一份 Mol* 查看器生成 PNG；结果图保留平台原图。两张图片及其来源记录通过 DSH 附件服务持久保存，工具返回 `report.images`、`report.markdown` 和缺图/失败原因。

`afg_tasks get` 在任务的 `is_thinking=false` 时也自动附加 `report`，原有 `result` 与可视化候选字段继续保留。工具结果卡片使用宿主的图片画廊显示附件，支持大图查看；最终回复直接使用 `report.markdown`。附件引用同时保存在展示元数据中，重开会话时重新加载，图片内容不会以 base64 写入对话。模型接收文字和图片引用，纯文本模型也可完成图片汇报。

自动结构图需要本机 Chrome/Chromium/兼容浏览器或已有 Playwright Chromium。可通过插件配置 `browserExecutable` 或环境变量 `AFGO_BROWSER` 指定路径。固定运行依赖为 `playwright-core@1.65.0`；插件运行时探测已有浏览器。结构图按源文件摘要缓存，单文件仍限制为 4 MiB；浏览器不可用时返回具体原因，并继续保存可读取的平台结果图。

## 用户入口

进入「插件 → afgo-dsh → 我的任务」，打开任务编号并选择「结果可视化」。页面按该任务的文件清单识别三维结构、图片和 CSV/TSV；优先选择文件名含 `final` 的结构供预览，用户可切换其他文件。排序只决定展示顺序，文件角色及科学含义以任务报告为准。

结构提供原子球、球棍和蛋白骨架表示，支持旋转、缩放、聚焦结构、完整视野和多帧切换。默认按原子范围取景，完整视野包含晶胞及其真空层。坐标帧切换保留相机。导出的 PNG 对应当前视角，来源记录 JSON 包含任务 ID、文件 ID、文件名、SHA-256、读取时间、Mol* 版本、当前帧、表示方式和相机。

图片展示任务生成的 PNG/JPEG/WebP 原图。数值表可选择数值列，单个数值以指标卡显示，多行数据按原文件行序绘制散点，悬停查看原值，至多读取前 200 行绘图。空值和非数值项跳过，图中单位沿用原列名与任务报告。

## 支持范围

- 结构支持 CIF/mmCIF、PDB/ENT、XYZ/EXTXYZ、SDF/MOL/MOL2、GRO。CIF 根据原始内容识别晶体 CIF 与 mmCIF。晶胞在模型有记录时显示，部分占据位点数量在查看器中提示。
- EXTXYZ 显示原始坐标帧，其 Lattice、PBC 和附加属性尚未映射到 Mol* 模型；需要晶胞信息时选择对应 CIF。
- ASE 二进制 `.traj`、XTC、ZIP、gzip 压缩结构等格式保留原文件下载入口。
- 当前自动识别任务根目录的文件，嵌套目录的浏览与文件识别作为后续扩展。
- 预览与工作台下载共用 4 MiB 上限，结构额外限制为 100,000 个显示原子。WebGL 无法初始化、格式无法解析或超过限制时显示错误，用户可下载原文件。
- 缺少结构、图片或数值表时，页面明确提示现有产物没有匹配预览。任务文件可能包含输入、过程文件及最终输出，预览与结果成功判定分别呈现。

## 给大肥鱼的工作指令

请继续使用本机 `afgo-dsh`，把任务可视化纳入每次结果汇报。

1. 通过 `afg_tasks get` 核对任务结果，并使用返回的 `report`。尚无图片汇报或需要重新生成时，调用 `afg_results`，参数为 `task_id=<编号>`。保留原有 `result` 的解析方式。
2. 每次最终汇报都将 `report.markdown` 中的结构图与结果图直接嵌入回复，注明任务编号、工具、结果判定、原文件名和来源记录。缺少某类文件或生成失败时，说明 `report.warnings`，并附工作台路径。
3. 优先用 `85244` 验证 TiO₂ CIF、晶胞、EXTXYZ 坐标帧、原始结果 PNG 和 CSV 散点，用 `84052` 验证水分子 XYZ，用 `73045` 验证 DSSP 的结构/图片文件。已有任务足以完成只读回归。
4. 核对「首次进入能直接看到结构」「切换任务与文件不串内容」「帧切换正确」「PNG 与来源记录都能导出」「损坏和超限文件提示清楚」。桌面与 Web 的证据分别记录。
5. 展开「已完成 → 已调用工具」，检查图片汇报卡片；检查最终回复的图片能直接看到、能放大。重启桌面端后重开同一会话，检查两处图片和来源链接。科学解释以原始数据和报告为依据，自动绘制的键线只用于查看。

完整的桌面验收提示词见 [桌面对话图片验收提示词](DESKTOP_IMAGE_ACCEPTANCE_PROMPT.md)。

## 开发与复现

源码入口为 `lib/visualization.js`（分类与智能体清单）、`lib/workbench.js`（工作台文件校验）、`lib/result-report.js`（汇报与持久附件）、`lib/structure-renderer.js`（本地离线出图）、`lib/client.js`（工作台和对话卡片）及 `viewer/engine.js`（Mol* 渲染）。

`lib/structure-viewer.html` 是随包交付的离线构建文件，运行时按需读取。查看器在仅允许脚本的 sandbox iframe 内运行，其 CSP 禁止网络连接；宿主通过消息传递所选文件内容，API Key 保留在宿主侧。页面更换文件或任务会卸载查看器，释放图形上下文与图片 URL。

开发构建需安装锁定的开发依赖，运行环境直接使用随包的构建文件。

```bash
npm ci --legacy-peer-deps --ignore-scripts
npm run build:viewer
node --test tests/*.test.mjs
python3 -m unittest discover -s tests
npm pack
```

Mol* 与实际打包依赖的许可证文本随 `lib/MOLSTAR-LICENSE` 和 `lib/VIEWER-LICENSES.txt` 提供。自动生成的 HTML 通过 `build:viewer` 更新。

## 参考项目

借鉴 research-story-harness 的结构来源记录、按对象选择表示方式及保留晶胞/占据率的原则，代码独立实现。 [ovito-structure skill](https://github.com/Phorbol/research-story-harness/tree/main/skills/ovito-structure)

Mol* 的 PluginContext、结构构建器和截图接口用于本地交互式渲染。 [Mol* 仓库](https://github.com/molstar/molstar) · [插件实例文档](https://molstar.org/docs/v5/plugin/instance/)
