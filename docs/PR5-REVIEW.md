# PR #5 审查与验收

日期：2026-11-24。原始 PR head：`3ee2e98`。

## 范围

独立侧栏与主面板注册、全屏、首次 API Key 配置、工具图标来源与降级。

## 审查后修正

- CI 原来使用 `--omit=dev`，会漏装新增 React 启动测试依赖；改为安装开发依赖。凭据扫描排除依赖与 Git 内部目录，继续扫描项目文件。
- 固定 React DOM 18.3.1，与 React 及测试渲染器保持一致，提供可复现的浏览器交互检查。
- 布局 ref 已挂在滚动区域自身，原实现却只查询子节点，导致高度变量未更新。改为识别自身并避免重复观察。
- 增加窄屏到宽屏切换、实际滚动区域高度、全屏状态及原生退出同步的回归测试。

## 验证

- 本机 DSH 的 Electron + 已安装 Gateway/Registry：53 项 JavaScript 测试全部通过，无跳过。
- Python：9 项测试全部通过。
- Chromium + 实际 React/DOM：侧栏和主面板成对注册；未配置时仅查询连接；空 Key 本地拦截；模拟验证成功后切换到任务页；原生 Fullscreen API 进入与退出；600px 无横向溢出；高度测量更新；目录图标显示；恢复宽屏。无页面错误。
- 现有启动测试覆盖注册失败后的重试、失效 Key、图标 URL 限制及原图→上游标识→通用图→离线图形降级。
- `git diff --check` 通过。

首次配置与浏览器测试使用离线凭据/目录夹具，不读写用户生产 Key，不提交计算。真实 DSH Gateway 集成测试使用本机安装的模块；浏览器检查使用测试用的侧栏容器，不等同于桌面窗口人工验收。

## 复现

```sh
npm ci --legacy-peer-deps --ignore-scripts
node --test tests/*.test.mjs
python3 -m unittest discover -s tests
DSH_INSTALL_DIR="$HOME/.dsh/profiles" ELECTRON_RUN_AS_NODE=1 \
  '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness' --test tests/*.test.mjs
AFGO_BROWSER=/path/to/chromium node scripts/test-workbench-browser.mjs
```

浏览器检查截图与摘要保存在本地 `out/pr5-review/`，不打包进入插件。
