# Changelog

## 1.0.0 — 首个稳定版

面向"让 DSH 调 Gemini 出图并下载到本地"的可用版本，默认走浏览器扩展桥接。

### 能力

- `gemini_image` 工具：单张出图、批量出图、状态检查、登录/导入、关闭。
- 三种取图方式：
  - `surface="bridge"`（默认）：浏览器扩展 + 用户已登录的 Gemini 网页。
  - `surface="web"/"app"`：插件自启受控 Chromium，CDP 直接操作页面。
  - `surface="desktop"`：驱动电脑版客户端（受客户端自身限制，通常不可用）。
- 批量：顺序执行、每条落盘、`manifest.json`、`resume` 续跑、`continueOnError`、
  `newChat=false` 共享上下文。
- 图片取字节三条路：网络抓包 → 页面内 fetch → 新标签页重放（绕 CORS）；
  扩展模式则由扩展权限直接下载。

### 已验证

- 真机单张出图（webp 1024×572 / 687×1024）并落盘。
- 真机 2 条批量：成功、`manifest` 正确、`resume` 全跳过。
- `newChat=false` 承接「同一场景换水彩」：同场景同主体。
- 离线故障注入：`ok / failed / ok`、`continueOnError`、resume 只重跑失败项。

### 踩过的坑（都已修）

- Chrome/Edge 156 的 cookie 是 app-bound 加密，跨用户目录复制解不开 →
  改为扩展桥接，用用户现成登录态。
- 电脑版 Gemini 在命令行层面拒绝 `--remote-debugging-port`
  （日志：*refusing to start — a debugging or network-override switch is present*）。
- MV3 后台 service worker 被浏览器挂起 → 轮询挪进内容脚本。
- 插件重载后旧桥接实例占端口、长轮询不释放 → 全局实例复用 +
  `closeAllConnections()` + 端口自动顺延 + 令牌轮换。
- 上一条回答未收尾就发送导致点击被吞 → `waitIdle()` + 三种发送方式轮试。
- 工具返回值含 `undefined` 导致 "value is not lossless JSON" → 递归清洗。
