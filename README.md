# dsh-gemini-image

让 DSH 直接「叫 Gemini 画图，并把图下载到本地」。

插件注册一个工具 `gemini_image`：把提示词交给 Gemini，等图片画完，把原始
字节取回来存成本地文件，再把路径返回给 DSH。之后的处理（`read_image` 看图、
嵌进 PPT、当素材继续合成）就和本地图片完全一样。注意:为确保单张图片上下文纯净，该插件可能导致gemini产生大量会话！！！

<p align="center">
  <img src="docs/preview-cat-astronaut.jpg" width="34%" alt="提示词：戴宇航头盔的橘猫，赛博朋克霓虹街道" />
  <img src="docs/preview-ink-mountain.jpg" width="56%" alt="提示词：水墨雪山与一叶孤舟，大量留白" />
</p>
<p align="center">
  <sub>两张都是插件直接生成并落盘的原始结果（仅压缩尺寸），单张耗时约 20–35 秒。</sub>
</p>

支持三种取图方式，按可靠性排序：

| surface | 用的是什么 | 需要登录 | 说明 |
| --- | --- | --- | --- |
| `bridge`（推荐） | 浏览器扩展 + 你已登录的 Gemini 网页 | 用你浏览器里现成的登录态 | Google 无法把"自动化浏览器"和你区分开，最稳 |
| `web` / `app` | 插件自己启动的受控 Chrome 窗口 | 要在那个窗口里登录 | 干净隔离，但 Google 常拒绝在自动化窗口里登录 |
| `desktop` | 电脑版 Gemini 客户端 | 客户端里已登录 | 多数版本**禁止**调试开关，通常不可用 |

## 安装

分两步：**装插件**（DSH 这一侧）和**装浏览器扩展**（真正出图的那一端）。
只用 `surface="web"` 受控浏览器模式的话，可以跳过第二步。

> **TL;DR**　装插件 → `install_bundle` 指向 clone 下来的目录；
> 装扩展 → 调 `gemini_image(action="status")` 拿到 `extensionDir`，在
> `chrome://extensions` 加载它；验证 → 再调一次 `status` 看到「已连接」。

### 1. 装插件

```bash
git clone https://github.com/GentleBoyYC/DSH-connect-to-gemini-image.git
```

在 DSH 里用 `plugin_manager` 把这个目录装成 bundle（或在 Agent 里说「把
`<clone 后的路径>` 作为 bundle 安装」）：

```jsonc
{ "action": "install_bundle", "target": "<clone 后的绝对路径>" }
```

`install_bundle` 会把包 `link` 进 profile 并激活插件行，不需要构建。

### 2. 装浏览器扩展

仓库里的 `extension/` **不能直接加载**——它缺少带本机端口和令牌的
`config.js`。正确顺序是让插件先生成一份：

1. 在 DSH 里调用一次 `gemini_image(action="status")`。返回里会带
   `extensionDir`，Windows 上通常就是：

   ```
   %USERPROFILE%\.dsh\gemini-image\extension
   ```

2. 在 Chrome 或 Edge 打开 `chrome://extensions`（Edge 是 `edge://extensions`），
   打开右上角「开发者模式」，点「加载已解压的扩展程序」，选择上面那个目录。
3. 打开（或保留）一个已登录的 `https://gemini.google.com` 标签页。
4. 再调一次 `gemini_image(action="status")`，看到「已连接」即可；扩展图标的
   徽标变绿也表示连上了。

> 平时不用管扩展。只有在插件升级、扩展代码变化、或端口/令牌变化时，才需要
> 点扩展卡片上的刷新（↻）。

## 出第一张图

```
gemini_image(prompt="一只戴宇航服的橘猫，赛博朋克霓虹，竖构图")
```

`surface` 默认就是 `bridge`，不用写。图片默认存到当前工作目录下的
`gemini-images/`，返回值里带绝对路径、尺寸和字节数。

扩展徽标：**绿色** = 已连上；**红色 !** = 没连上（插件没在运行，或者端口/
令牌对不上，重新加载扩展即可）。

## 受控浏览器模式（surface = web / app）

```
gemini_image(action="login")     # 打开一个"普通"窗口（不带调试端口）
# 在那个窗口登录 Google
gemini_image(action="status")    # 插件接管：关掉登录窗口，带登录态重启受控实例
gemini_image(prompt="...", surface="web")
```

这条路在隔离性上更干净（独立用户目录，不动你的日常浏览器），代价是 Google
经常对自动化/新配置文件弹「此浏览器或应用可能不安全」，登录会被拒绝。若你
的环境能登录，它完全可用。

`action="import"` 可以尝试从已登录的 Chrome/Edge 复制登录态，但 Chrome 156+
与新版 Edge 的 cookie 是 **app-bound 加密**（与本机可执行文件绑定），复制到
别的用户目录后解不开，多半只能拿到匿名 cookie——所以才有 `bridge` 这条路。

## 网络与代理

扩展模式下，出网用的是**你日常浏览器自己的网络**，插件不参与，代理照旧。

受控浏览器模式（`web`/`app`）用受控 Chrome 的网络栈，默认跟随系统代理；
如果代理只对某些程序生效，显式指定：

```
gemini_image(action="status", proxyServer="http://127.0.0.1:7890")
```

## 批量出图（action = batch）

```
gemini_image(
  action="batch",
  prompts=["雨夜便利店的流浪狗，电影感", "同一场景换成水彩插画风格"],
  count=1,                 # 每条连续出几轮（1-4）
  newChat=false,           # 共享上下文，让"同一场景"能承接上一张
  continueOnError=true,    # 单条失败继续后面的
  outDir="D:\\work_space_ds\\gemini-images\\batch-demo",
  waitSeconds=150          # 单条超时
)
```

- **顺序执行**：Gemini 网页版会限流，并发只会一起变慢，所以刻意保持 1；
- **一条一落盘**：每完成一条就写一次 `manifest.json`；
- **断点续跑**：`resume=true` 会跳过 manifest 里已完成、且文件还在的条目（实测 2 条全部跳过，不再消耗额度）；
- **单次预算**：一次调用最多跑约 250 秒，没轮到的条目记为 `pending`，下次带 `resume=true` 接着跑；
- **`newChat` 很关键**：默认 `true`（每条独立新对话）；写「同一场景改成 X」这类承接式提示词时必须传 `false`，否则第二条没有上下文。

`manifest.json` 形如：

```json
{
  "version": 1,
  "createdAt": "2026-11-08T02:47:15.489Z",
  "outDir": "D:\\...\\batch-demo",
  "rounds": 1,
  "items": [
    { "index": 1, "prompt": "…", "status": "ok",
      "files": ["D:\\...\\batch-demo\\gemini-20261108-104715-01-01.webp"], "ms": 32352 }
  ]
}
```

状态有 `ok` / `failed` / `pending` / `skipped` 四种。

## 工具参数

| 参数 | 说明 |
| --- | --- |
| `action` | `generate`（默认）/ `batch` / `status` / `login` / `import` / `close` |
| `prompt` | 画面描述，`generate` 时必填 |
| `prompts` | `batch` 的提示词数组（最多 30 条） |
| `count` | `batch` 时每条提示词的轮数（1-4） |
| `continueOnError` | `batch` 单条失败是否继续，默认 `true` |
| `resume` | `batch` 续跑：跳过 manifest 里已完成的条目 |
| `surface` | `bridge`（默认，推荐）/ `web` / `app` / `desktop` |
| `outDir` | 保存目录，默认 `<工作目录>/gemini-images` |
| `filename` | 文件名前缀，默认 `gemini-<时间戳>` |
| `newChat` | 是否先新开对话，默认 `true`；`batch` 里设 `false` 可共享上下文 |
| `waitSeconds` | 等图秒数，默认 180 |
| `browserPath` / `profileDir` / `proxyServer` / `fromProfile` | 受控浏览器模式专用 |

`cordis.patch.yml` 的 `config` 里可以写默认值：
`surface`、`outputDir`、`bridgePort`、`headless`、`waitSeconds`、
`browserPath`、`profileDir`、`proxyServer`、`desktopPort`。

## 它是怎么工作的

```
prompt ──> 插件 gemini_image
              │
              ├─(bridge) 127.0.0.1:47623 任务队列
              │      ↑ 扩展长轮询领任务 / 回传图片字节
              │      └─ 扩展在 gemini.google.com 页面里写提示词、点发送、
              │         等图片出现，再取字节（扩展权限绕开 CORS）
              │
              └─(web/app) 受控 Chrome + CDP 直接操作页面
```

扩展只做页面上的事，不碰账号密码；插件只在本机回环地址上排队任务，
令牌写在扩展目录的 `config.js` 里（每次安装随机生成）。

## 文件结构

```
index.js              插件入口：工具定义、三种 surface 的动作编排、落盘
lib/bridge.js         本地任务队列 + 扩展目录生成
lib/browser.js        受控 Chrome/Edge 的启动、端口发现、优雅关闭
lib/cdp.js            零依赖 CDP 客户端（全局 WebSocket）
lib/page.js           Gemini 页面自动化（CDP 版）
lib/desktop.js        电脑版客户端后端（通常被客户端自身禁用）
lib/session.js        从别的浏览器导入 cookie（app-bound 加密下多半无效）
lib/settings.js       记住上次用的浏览器/目录
extension/            浏览器扩展**源码**（真正加载的是插件生成的副本）
docs/                 README 预览图
locale/*.json         插件管理器里的标题与描述
icon.svg              插件图标
cordis.patch.yml      插入 profile 的补丁行
```

扩展的「可加载副本」在运行时生成，位置是
`$DSH_HOME/gemini-image/extension`（Windows：`%USERPROFILE%\.dsh\gemini-image\extension`）。
它比仓库里的多一个 `config.js`，里面有本机端口和随机令牌。

## 开发脚本（不属于发布内容）

`scripts/` 是维护用的自测工具，`files` 里没有它们，安装出来的插件不包含：

| 脚本 | 用途 |
| --- | --- |
| `logic.test.mjs` | 工具注册、入参、输出、渲染的离线自测 |
| `batch.test.mjs` | 假扩展驱动，验证批量 / 失败继续 / manifest / resume |
| `fake-extension.mjs` | 冒充扩展占用桥接，排查协议问题 |
| `fake-gemini.test.mjs`、`scripts/keys.debug.mjs` | 本地假页面 + CDP，验证 `web` 模式的页面自动化 |
| `smoke.mjs`、`gemini-live.mjs`、`attach-probe.mjs`、`attach-wait.mjs`、`cookies-probe.mjs`、`wait-login.mjs` | CDP 连接、登录态、cookie 的排查工具 |

## 使用边界

- 本插件是对 **Gemini 网页界面的自动化**，不是官方 API。这类用法可能不符合
  Google 的服务条款，请自行判断风险，仅用于个人自用场景，不要用来刷量或分发
  生成内容牟利。
- 扩展只操作页面，不读取/上传你的账号凭据；桥接令牌随机生成，只写在
  `$DSH_HOME`，且服务只监听 `127.0.0.1`。
- 仓库里不包含任何登录态、cookie 或令牌；`extension/config.js` 是运行时生成的。
- 出图额度、地区限制、界面改版都不在本插件控制范围内。

## 版本

当前 `1.0.0`，变更记录见 [CHANGELOG.md](CHANGELOG.md)。

## 常见问题

- **扩展连不上**：确认扩展已加载、插件正在运行（先调一次
  `gemini_image(action="status", surface="bridge")` 让插件起服务）；
  改过 `bridgePort` 后要重新加载扩展（`config.js` 里的端口/令牌会变）。
- **扩展连上了但不出图**：确认有一个已登录的 `gemini.google.com` 标签页；
  内容脚本会自己点"新对话"、填提示词、点发送，若 Gemini 改版改了 DOM，
  需要调整 `extension/content.js` 里的选择器。
- **提示「此浏览器或应用可能不安全」**：这是 Google 对自动化浏览器的拦截，
  用 `surface="bridge"`（你自己浏览器的会话）即可绕开。
- **`desktop` 模式起不来**：客户端会在日志里明确写
  *refusing to start — a debugging or network-override switch is present*，
  这是它自己的安全策略，无法绕过。
