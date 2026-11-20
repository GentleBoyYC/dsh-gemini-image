/**
 * dsh-gemini-image —— 让 DSH 能"叫 Gemini 画图，并把图下载到本地"。
 *
 * 三种取图方式：
 *   bridge  —— 浏览器扩展驱动你已登录的 Gemini 网页（默认，最稳）
 *   web/app —— 插件自己启动的受控 Chrome 窗口，用 CDP 操作
 *   desktop —— 电脑版 Gemini 客户端（多数版本禁止调试开关，通常不可用）
 *
 * 对外只暴露一个工具：gemini_image。
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { MAX_ROUNDS, MANIFEST_NAME, alreadyDone, normalizePrompts, pad, readManifest, writeManifest } from './lib/batch.js';
import { ChromiumBrowser, GEMINI_URL, closeProcessGracefully, defaultProfileDir } from './lib/browser.js';
import { DEFAULT_BRIDGE_PORT, GeminiBridge } from './lib/bridge.js';
import { CdpError, sleep } from './lib/cdp.js';
import { GeminiDesktop } from './lib/desktop.js';
import { GeminiPage, extensionForMime } from './lib/page.js';
import { findSourceUserDataDir, importCookies } from './lib/session.js';
import { loadRuntimeSettings, saveRuntimeSettings } from './lib/settings.js';

export const name = 'gemini-image';
export const inject = ['tools'];

const DEFAULTS = {
  /** bridge = 浏览器扩展驱动已登录的 Gemini（默认）；web/app = 受控 Chrome；desktop = 桌面客户端 */
  surface: 'bridge',
  /** 留空则自动探测 Chrome / Edge */
  browserPath: '',
  /** 受控浏览器的用户目录，登录态存在这里 */
  profileDir: '',
  /** 默认保存目录；留空 = 当前工作目录下的 gemini-images */
  outputDir: '',
  /** 接一个已经开着 --remote-debugging-port 的浏览器（0 = 自己启动） */
  cdpPort: 0,
  /** 给受控浏览器指定的代理，例如 http://127.0.0.1:7890；留空 = 跟随系统代理 */
  proxyServer: '',
  /** 导入登录态时用的源用户目录；留空 = 自动找 Chrome/Edge */
  sourceProfile: '',
  /** 桌面端（电脑版 Gemini）暴露的调试端口 */
  desktopPort: 9333,
  /** 指定 Gemini.exe 路径，留空自动找 %LOCALAPPDATA%\Google\Gemini 下最新版本 */
  desktopAppPath: '',
  /** 扩展桥接监听端口（必须和扩展 config.js 里的一致） */
  bridgePort: DEFAULT_BRIDGE_PORT,
  headless: false,
  /** 等图默认时长（秒） */
  waitSeconds: 180,
};

const TOOL_NAME = 'gemini_image';

function text(value) {
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
}

/** 工具返回值必须是"无损 JSON"：去掉 undefined、把非有限数换成 null。 */
function toLosslessJson(value) {
  if (Array.isArray(value)) return value.map(toLosslessJson);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue;
      out[key] = toLosslessJson(item);
    }
    return out;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  if (typeof value === 'function') return null;
  return value;
}

function formatBytes(bytes) {
  const size = Number(bytes) || 0;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function timestamp() {
  const now = new Date();
  const pad2 = (value) => String(value).padStart(2, '0');
  return (
    `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}` +
    `-${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`
  );
}

/** 从 URL 猜 mime（拿不到 content-type 时兜底）。 */
function mimeFromUrl(url) {
  const match = /\.(png|jpe?g|webp|gif|avif)(?:[?#]|$)/i.exec(String(url || ''));
  if (!match) return 'image/png';
  const ext = match[1].toLowerCase();
  return ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`;
}

function normalizeSettings(config) {
  const settings = { ...DEFAULTS };
  if (config && typeof config === 'object') {
    for (const key of Object.keys(DEFAULTS)) {
      const value = config[key];
      if (value === undefined || value === null || value === '') continue;
      settings[key] = value;
    }
  }
  return settings;
}

/** 从工具入参覆盖设置（只覆盖明确给出的字段）。 */
function withOverrides(settings, input) {
  const merged = { ...settings };
  if (input && input.surface) merged.surface = ['app', 'desktop', 'bridge'].includes(input.surface) ? input.surface : 'web';
  if (input && typeof input.browserPath === 'string' && input.browserPath.trim()) merged.browserPath = input.browserPath.trim();
  if (input && typeof input.profileDir === 'string' && input.profileDir.trim()) merged.profileDir = input.profileDir.trim();
  if (input && typeof input.outDir === 'string' && input.outDir.trim()) merged.outputDir = input.outDir.trim();
  if (input && typeof input.proxyServer === 'string' && input.proxyServer.trim()) merged.proxyServer = input.proxyServer.trim();
  if (input && Number(input.waitSeconds) > 0) merged.waitSeconds = Number(input.waitSeconds);
  return merged;
}

/** 生效的浏览器用户目录。 */
function resolveProfileDir(settings) {
  return settings.profileDir ? path.resolve(settings.profileDir) : defaultProfileDir();
}

/** 尽量猜出当前会话的工作目录，猜不到就用进程 cwd。 */
function workspaceDir(ctx, exec) {
  try {
    const agent = exec && exec.agent;
    const sessions = ctx.get('sessions');
    const session = (agent && agent.session) || (agent && agent.id && sessions && sessions.get ? sessions.get(agent.id) : undefined);
    const workingDirectory = ctx.get('workingDirectory');
    if (session && workingDirectory && typeof workingDirectory.get === 'function') {
      const dir = workingDirectory.get(session);
      if (typeof dir === 'string' && dir) return dir;
    }
  } catch {
    // 服务不可用就退回进程目录
  }
  return process.cwd();
}

export function apply(ctx, config = {}) {
  // 优先级：插件 config > 上次运行记住的（browserPath / profileDir / proxyServer）> 默认值
  const settings = normalizeSettings({ ...loadRuntimeSettings(), ...(config && typeof config === 'object' ? config : {}) });
  const state = { browser: null, browserKey: '', page: null, pageKey: '', loginPid: 0, loginStartedAt: 0, bridge: null };
  const tools = ctx.get('tools');

  if (!tools || typeof tools.register !== 'function') {
    ctx.logger?.warn?.('gemini-image: 当前 profile 没有 tools 服务，工具未注册。');
    return;
  }

  /* ---------------- 浏览器 / 页面生命周期 ---------------- */

  function browserKey(settingsNow) {
    return [
      resolveProfileDir(settingsNow),
      settingsNow.surface,
      String(settingsNow.cdpPort || 0),
      settingsNow.browserPath || '',
      settingsNow.proxyServer || '',
      settingsNow.headless ? 'headless' : 'headed',
      String(settingsNow.desktopPort || ''),
    ].join('|');
  }

  function acquireBrowser(settingsNow) {
    const key = browserKey(settingsNow);
    if (state.browser && state.browserKey === key) return state.browser;
    state.browser =
      settingsNow.surface === 'desktop'
        ? new GeminiDesktop({ executable: settingsNow.desktopAppPath || '', port: settingsNow.desktopPort })
        : new ChromiumBrowser({
            executable: settingsNow.browserPath || '',
            userDataDir: resolveProfileDir(settingsNow),
            surface: settingsNow.surface,
            headless: settingsNow.headless,
            cdpPort: settingsNow.cdpPort,
            proxyServer: settingsNow.proxyServer,
          });
    state.browserKey = key;
    state.pageKey = '';
    return state.browser;
  }

  /** 图片保存目录：入参 > 配置 > 工作目录下的 gemini-images。 */
  function resolveOutDir(input, settingsNow, exec) {
    if (input && input.outDir) return path.resolve(input.outDir);
    if (settingsNow.outputDir) return path.resolve(settingsNow.outputDir);
    return path.join(workspaceDir(ctx, exec), 'gemini-images');
  }

  /** 文件名前缀。 */
  function makePrefix(input) {
    const raw = text(input && input.filename)
      .trim()
      .replace(/[\\/:*?"<>|\s]+/g, '-')
      .slice(0, 60);
    return raw || `gemini-${timestamp()}`;
  }

  /**
   * 关掉登录用的普通窗口（不带调试端口那个）。
   * 必须先让它体面退出：Chrome 要把 cookie 落盘，登录态才能被下一次启动复用。
   */
  async function releaseLoginWindow() {
    const pid = state.loginPid;
    state.loginPid = 0;
    if (!pid) return false;
    await closeProcessGracefully(pid);
    await sleep(1500);
    return true;
  }

  async function acquirePage(settingsNow) {
    // 刚打开的登录窗口不要立刻接管：用户可能正在输密码
    if (state.loginPid && Date.now() - state.loginStartedAt < 15000) {
      throw new CdpError('登录窗口刚刚打开。请先在那个窗口里完成 Google 登录，然后再调用一次（15 秒内不会自动接管，避免把正在登录的窗口关掉）。');
    }
    await releaseLoginWindow();
    const browser = acquireBrowser(settingsNow);
    const key = state.browserKey;
    await browser.ensure({ url: GEMINI_URL, timeoutMs: 30000 });
    if (state.page && state.pageKey === key && state.page.session.isOpen) return state.page;
    if (state.page) {
      try {
        await state.page.dispose();
      } catch {
        // 页面已经关掉了
      }
      state.page = null;
    }
    const page = await GeminiPage.open(browser, {});
    state.page = page;
    state.pageKey = key;
    return page;
  }

  /** 同一个进程里只允许一个任务，避免两次调用抢同一个输入框。 */
  let queue = Promise.resolve();
  function exclusive(task) {
    const run = queue.then(task, task);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** 等扩展重新连上（插件重载/浏览器重启后需要几秒）。 */
  async function waitForBridge(bridge, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (bridge.connected()) return true;
      if (Date.now() >= deadline) return false;
      await sleep(700);
    }
  }

  /** 扩展桥接：一个进程内只跑一个服务（插件重载时复用，避免端口被旧实例占住）。 */
  function getBridge(settingsNow) {
    const port = Number(settingsNow.bridgePort) || DEFAULT_BRIDGE_PORT;
    if (state.bridge && state.bridge.server) return state.bridge;
    state.bridge = GeminiBridge.acquire(port);
    return state.bridge;
  }

  /* ---------------- 动作实现 ---------------- */

  async function runStatus(input, exec) {
    const settingsNow = withOverrides(settings, input);
    if (settingsNow.surface === 'bridge') {
      const info = await getBridge(settingsNow).ensure();
      return {
        ok: true,
        action: 'status',
        surface: 'bridge',
        connected: info.connected,
        extensionDir: info.extensionDir,
        port: info.port,
        message: info.connected
          ? `浏览器扩展已连接（127.0.0.1:${info.port}），可以直接用 surface="bridge" 出图。`
          : `浏览器扩展还没连上（端口 ${info.port}）。打开 chrome://extensions → 开启"开发者模式" → "加载已解压的扩展程序" → 选择：${info.extensionDir}；已经在用的话点刷新（↻）并刷新 Gemini 标签页。`,
      };
    }
    const browser = acquireBrowser(settingsNow);
    await browser.ensure({ url: GEMINI_URL, timeoutMs: 30000 });
    const page = await acquirePage(settingsNow);
    // 重新载入一次，拿到的才是当前真实状态（而不是上次残留的页面）
    await page.navigate(GEMINI_URL);
    const snapshot = await page.waitForReady({ timeoutMs: 25000, signal: exec.signal });
    const loggedIn = Boolean(snapshot && snapshot.loggedIn);
    const networkError = (snapshot && snapshot.networkError) || '';
    let message;
    if (networkError) {
      message = `打不开 gemini.google.com（${networkError}）：浏览器连不上 Google。请先开代理/VPN；如果代理不是系统代理，把地址填进 proxyServer。`;
    } else if (loggedIn) {
      message = `Gemini 已就绪（${snapshot.url}），当前对话里有 ${snapshot.images.length} 张图片。`;
    } else {
      message = 'Gemini 尚未登录：请调用 action="login"，在弹出的窗口里登录 Google。';
    }
    return {
      ok: true,
      action: 'status',
      message,
      loggedIn,
      url: (snapshot && snapshot.url) || GEMINI_URL,
      title: (snapshot && snapshot.title) || '',
      imageCount: snapshot && snapshot.images ? snapshot.images.length : 0,
      surface: settingsNow.surface,
      browser: browser.describe(),
    };
  }

  /**
   * 登录：Google 会拒绝在连着调试协议的窗口里登录（signin/rejected），
   * 所以这里开一个"普通"窗口让用户登录，登录后再由 status/generate 接管。
   */
  async function runLogin(input, exec) {
    const settingsNow = withOverrides(settings, input);
    if (settingsNow.surface === 'bridge') {
      const info = await getBridge(settingsNow).ensure();
      return {
        ok: true,
        action: 'login',
        surface: 'bridge',
        loggedIn: info.connected,
        extensionDir: info.extensionDir,
        message: info.connected
          ? '扩展模式不需要登录：用的就是你浏览器里已经登录的 Gemini。'
          : `扩展还没连上。请打开 chrome://extensions → 开发者模式 → 加载已解压的扩展程序 → 选择：${info.extensionDir}`,
      };
    }
    const candidate = acquireBrowser(settingsNow);

    // 桌面端：登录本来就在 App 里做完了，只需要确认一下
    if (settingsNow.surface === 'desktop' || typeof candidate.launchPlain !== 'function') {
      const page = await acquirePage(settingsNow);
      const snapshot = await page.waitForReady({ timeoutMs: 20000, signal: exec.signal });
      const loggedIn = Boolean(snapshot && snapshot.loggedIn);
      return {
        ok: loggedIn,
        action: 'login',
        loggedIn,
        message: loggedIn
          ? '电脑版 Gemini 已就绪（已经在客户端里登录过了）。'
          : '请在 Gemini 桌面客户端窗口里登录 Google，然后再调用一次。',
        surface: settingsNow.surface,
        browser: candidate.describe(),
      };
    }

    if (state.page) {
      try {
        await state.page.dispose();
      } catch {
        // ignore
      }
      state.page = null;
      state.pageKey = '';
    }
    if (state.browser) {
      state.browser.stop();
      state.browser = null;
      state.browserKey = '';
    }
    await releaseLoginWindow();
    await sleep(600);

    const browser = acquireBrowser(settingsNow);
    const pid = browser.launchPlain(GEMINI_URL);
    state.loginPid = pid;
    state.loginStartedAt = Date.now();
    return {
      ok: true,
      action: 'login',
      loggedIn: false,
      message:
        '已打开一个普通 Chrome 窗口（不带调试端口——Google 会拒绝在受控窗口里登录）。请在这个窗口里完成 Google 登录；登录成功后直接再调用 gemini_image（action="status" 或直接 generate），插件会自动关掉这个窗口、带着登录态重新接管。',
      browser: { ...browser.describe(), pid },
      surface: settingsNow.surface,
    };
  }

  /**
   * 从已登录的 Chrome/Edge 导入登录态。
   * 注意：新版 Chromium 的 cookie 是 app-bound 加密，复制到别的用户目录通常
   * 解不开（只会有匿名 cookie），这条路径在多数机器上无效，保留作兼容。
   */
  async function runImport(input, exec) {
    const settingsNow = withOverrides(settings, input);
    if (state.page) {
      try {
        await state.page.dispose();
      } catch {
        // ignore
      }
      state.page = null;
      state.pageKey = '';
    }
    if (state.browser) {
      state.browser.stop();
      state.browser = null;
      state.browserKey = '';
    }
    await releaseLoginWindow();
    await sleep(1000);

    const source = findSourceUserDataDir(input.fromProfile || settingsNow.sourceProfile || '');
    if (!source) {
      throw new CdpError('找不到 Chrome/Edge 的用户目录，请用 fromProfile 指定（例如 C:\\Users\\你\\AppData\\Local\\Google\\Chrome\\User Data）。');
    }
    const target = resolveProfileDir(settingsNow);
    let result;
    try {
      result = importCookies(source, target);
    } catch (error) {
      const code = error && error.code;
      if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
        throw new CdpError('浏览器正开着，它的 cookie 库被独占锁定，复制不了。请把浏览器完全退出（窗口、托盘、后台都退出）后再执行一次 action="import"。');
      }
      throw error;
    }
    if (!result.copied.some((item) => item.includes('Cookies'))) {
      throw new CdpError(`没有从 ${source} 复制到 cookie：${result.skipped.join('；')}`);
    }

    const browser = acquireBrowser(settingsNow);
    await browser.ensure({ url: GEMINI_URL, timeoutMs: 30000 });
    const page = await acquirePage(settingsNow);
    await page.navigate(GEMINI_URL);
    const snapshot = await page.waitForReady({ timeoutMs: 25000, signal: exec.signal });
    const loggedIn = Boolean(snapshot && snapshot.loggedIn);
    return {
      ok: loggedIn,
      action: 'import',
      loggedIn,
      message: loggedIn
        ? `已从 ${source} 导入登录态，Gemini 可以直接用了。`
        : `已复制 cookie（${result.cookieBytes} 字节），但 Gemini 仍显示未登录——新版 Chromium 的 cookie 是 app-bound 加密，换个用户目录就解不开。请改用 surface="bridge"（浏览器扩展会用到你现成的登录态）。`,
      source,
      target,
      copied: result.copied,
      skipped: result.skipped,
    };
  }

  async function runClose() {
    if (state.bridge) {
      state.bridge.stop();
      state.bridge = null;
    }
    if (state.page) {
      try {
        await state.page.dispose();
      } catch {
        // ignore
      }
      state.page = null;
      state.pageKey = '';
    }
    await releaseLoginWindow();
    const browser = state.browser;
    if (browser) browser.stop();
    state.browser = null;
    state.browserKey = '';
    return { ok: true, action: 'close', message: '已关闭受控浏览器与桥接服务。' };
  }

  /**
   * 扩展桥接模式：任务下发给用户浏览器里的扩展，图片由扩展取好字节回传。
   */
  async function runBridgeGenerate(input, exec, settingsNow, prompt) {
    const startedAt = Date.now();
    const waitMs = Math.max(20, Number(settingsNow.waitSeconds) || 180) * 1000;
    const bridge = getBridge(settingsNow);
    const info = await bridge.ensure();
    if (!info.connected) await waitForBridge(bridge, 30000);
    if (!bridge.connected()) {
      return {
        ok: false,
        action: 'generate',
        surface: 'bridge',
        connected: false,
        extensionDir: info.extensionDir,
        port: info.port,
        message:
          `浏览器扩展还没有连上桥接（127.0.0.1:${info.port}）。请确认扩展已加载、并且有一个已登录的 gemini.google.com 标签页；` +
          `扩展目录：${info.extensionDir}`,
      };
    }

    const result = await bridge.runJob({
      prompt,
      newChat: input.newChat !== false,
      timeoutMs: waitMs,
      signal: exec.signal,
    });
    if (!result || !result.ok) {
      return {
        ok: false,
        action: 'generate',
        surface: 'bridge',
        message: (result && result.error) || '扩展没有返回结果',
        prompt,
        elapsedMs: Date.now() - startedAt,
      };
    }

    const received = Array.isArray(result.images) ? result.images : [];
    if (!received.length) {
      return { ok: false, action: 'generate', surface: 'bridge', message: '扩展返回成功但没有图片', prompt };
    }

    const dir = resolveOutDir(input, settingsNow, exec);
    mkdirSync(dir, { recursive: true });
    const prefix = makePrefix(input);
    const images = [];
    const failures = [];
    for (let index = 0; index < received.length; index += 1) {
      const item = received[index];
      if (!item || !item.base64) {
        failures.push(`${item && item.src ? item.src : '未知图片'}：${(item && item.error) || '没有取到字节'}`);
        continue;
      }
      const buffer = Buffer.from(item.base64, 'base64');
      const ext = extensionForMime(item.mime);
      const file = path.join(dir, `${prefix}-${String(index + 1).padStart(2, '0')}.${ext}`);
      writeFileSync(file, buffer);
      images.push({
        path: file,
        url: item.src || '',
        width: item.width || 0,
        height: item.height || 0,
        bytes: buffer.length,
        mime: item.mime || 'image/png',
        method: 'extension',
      });
    }

    if (!images.length) {
      return {
        ok: false,
        action: 'generate',
        surface: 'bridge',
        message: `图片出来了但字节没拿到：${failures.join('；')}`,
        prompt,
      };
    }

    return {
      ok: true,
      action: 'generate',
      surface: 'bridge',
      message: `Gemini 生成了 ${images.length} 张图片，已保存到 ${dir}。`,
      prompt,
      dir,
      images,
      complete: result.complete !== false,
      failures,
      elapsedMs: Date.now() - startedAt,
    };
  }

  /**
   * 批量出图：顺序跑，一条一落盘，manifest 支持断点续跑。
   * 并发刻意保持 1：Gemini 网页版会限流，同时发多条只会一起变慢。
   */
  async function runBatch(input, exec) {
    const settingsNow = withOverrides(settings, input);
    const items = normalizePrompts(input);
    if (!items.length) {
      return { ok: false, action: 'batch', message: 'prompts 为空：请给一个提示词数组（或单个 prompt）。' };
    }
    const rounds = Math.min(MAX_ROUNDS, Math.max(1, Number(input.count) || 1));
    const dir = resolveOutDir(input, settingsNow, exec);
    mkdirSync(dir, { recursive: true });
    const manifestPath = path.join(dir, MANIFEST_NAME);
    const previous = input.resume === true ? readManifest(manifestPath) : null;
    const basePrefix = makePrefix(input);
    const createdAt = new Date().toISOString();
    const startedAt = Date.now();
    const waitMs = Math.max(20, Number(settingsNow.waitSeconds) || 180) * 1000;
    // 单次调用别把工具超时撞满：留出余量，剩下的交给 manifest 续跑
    const budgetMs = Math.min(250000, Math.max(60000, waitMs + 60000));
    const entries = [];

    // 页面没连上就别一条条刷失败记录了，直接给一句能动手的提示
    if (settingsNow.surface === 'bridge') {
      const bridge = getBridge(settingsNow);
      const info = await bridge.ensure();
      if (!info.connected) await waitForBridge(bridge, 30000);
      if (!bridge.connected()) {
        return {
          ok: false,
          action: 'batch',
          surface: 'bridge',
          connected: false,
          extensionDir: info.extensionDir,
          port: info.port,
          message: `浏览器扩展还没有连上桥接（127.0.0.1:${info.port}），整批没有开始。请确认扩展已加载、Gemini 标签页已刷新；扩展目录：${info.extensionDir}`,
        };
      }
    }

    for (let position = 0; position < items.length; position += 1) {
      const index = position + 1;
      const item = items[position];

      const done = previous ? alreadyDone(previous, index, (file) => existsSync(file)) : null;
      if (done) {
        entries.push({ index, prompt: item.prompt, status: 'skipped', files: done.files, ms: 0 });
        writeManifest(manifestPath, { createdAt, outDir: dir, rounds, items: entries });
        continue;
      }
      if (Date.now() - startedAt > budgetMs) {
        entries.push({ index, prompt: item.prompt, status: 'pending', files: [], ms: 0 });
        continue;
      }

      const itemStarted = Date.now();
      const files = [];
      const errors = [];
      for (let round = 1; round <= rounds; round += 1) {
        const promptText =
          rounds > 1 ? `${item.prompt}\n\n（同一主题的第 ${round}/${rounds} 张，构图和上一张明显不同）` : item.prompt;
        const prefix = `${item.filename || `${basePrefix}-${pad(index)}`}${rounds > 1 ? `-r${round}` : ''}`;
        let result;
        try {
          result = await runGenerate(
            { ...input, action: 'generate', prompt: promptText, filename: prefix, outDir: dir, newChat: input.newChat !== false },
            exec,
          );
        } catch (error) {
          result = { ok: false, message: error && error.message ? error.message : String(error) };
        }
        if (result && result.ok && Array.isArray(result.images)) {
          for (const image of result.images) {
            if (image && image.path) files.push(image.path);
          }
        } else {
          errors.push((result && result.message) || '生成失败');
          break;
        }
      }

      const entry = {
        index,
        prompt: item.prompt,
        status: files.length ? 'ok' : 'failed',
        files,
        error: files.length ? '' : errors.join('；'),
        ms: Date.now() - itemStarted,
      };
      entries.push(entry);
      writeManifest(manifestPath, { createdAt, outDir: dir, rounds, items: entries });
      if (entry.status === 'failed' && input.continueOnError === false) break;
    }

    writeManifest(manifestPath, { createdAt, outDir: dir, rounds, items: entries });
    const okItems = entries.filter((entry) => entry.status === 'ok');
    const skipped = entries.filter((entry) => entry.status === 'skipped').length;
    const failed = entries.filter((entry) => entry.status === 'failed').length;
    const pending = entries.filter((entry) => entry.status === 'pending').length;
    const files = entries.flatMap((entry) => entry.files || []);

    const detail = [
      `${okItems.length} 条成功`,
      skipped ? `${skipped} 条已存在（跳过）` : '',
      failed ? `${failed} 条失败` : '',
      pending ? `${pending} 条未开始` : '',
    ]
      .filter(Boolean)
      .join('，');

    return {
      ok: failed === 0 && pending === 0,
      action: 'batch',
      surface: settingsNow.surface,
      message: `批量出图：${detail}，共 ${files.length} 张图片，保存在 ${dir}。${
        pending ? '（有未开始的条目，重新调用并带 resume=true 可接着跑）' : ''
      }`,
      prompt: items
        .map((item) => item.prompt)
        .join(' | ')
        .slice(0, 200),
      dir,
      manifestPath,
      images: files.map((file) => ({ path: file })),
      batch: {
        total: items.length,
        rounds,
        ok: okItems.length,
        skipped,
        failed,
        pending,
        items: entries,
      },
      elapsedMs: Date.now() - startedAt,
    };
  }

  async function runGenerate(input, exec) {
    const prompt = text(input.prompt).trim();
    if (!prompt) {
      return { ok: false, action: 'generate', message: '缺少 prompt：请给出要生成的画面描述。' };
    }
    const settingsNow = withOverrides(settings, input);
    if (settingsNow.surface === 'bridge') return await runBridgeGenerate(input, exec, settingsNow, prompt);
    const waitMs = Math.max(10, Number(settingsNow.waitSeconds) || 180) * 1000;
    const startedAt = Date.now();

    const page = await acquirePage(settingsNow);
    await page.ensureLoggedIn({ signal: exec.signal });

    if (input.newChat !== false) {
      await page.navigate(GEMINI_URL);
      await page.waitForReady({ timeoutMs: 30000, signal: exec.signal });
    }

    const before = await page.probe();
    if (!before || !before.hasEditor) {
      return {
        ok: false,
        action: 'generate',
        message: 'Gemini 输入框不可用，可能尚未登录。请先调用 action="login"。',
        loggedIn: false,
      };
    }

    await page.sendPrompt(prompt);
    const result = await page.waitForImages({
      baseline: before.images.length,
      timeoutMs: waitMs,
      signal: exec.signal,
    });

    if (!result.images.length) {
      return {
        ok: false,
        action: 'generate',
        message: `等了 ${Math.round(waitMs / 1000)} 秒还没看到新图片。可能是提示词被拒绝、额度用尽，或 Gemini 正在排队；可以先用 action="status" 看一下页面状态。`,
        prompt,
        loggedIn: true,
        url: before.url,
        busy: Boolean(result.snapshot && result.snapshot.busy),
        elapsedMs: Date.now() - startedAt,
      };
    }

    const dir = resolveOutDir(input, settingsNow, exec);
    mkdirSync(dir, { recursive: true });
    const prefix = makePrefix(input);
    const images = [];
    const failures = [];
    for (let index = 0; index < result.images.length; index += 1) {
      const image = result.images[index];
      try {
        const grabbed = await page.grab(image.src);
        const ext = extensionForMime(grabbed.mime || mimeFromUrl(image.src));
        const file = path.join(dir, `${prefix}-${String(index + 1).padStart(2, '0')}.${ext}`);
        writeFileSync(file, grabbed.buffer);
        images.push({
          path: file,
          url: image.src,
          width: image.width,
          height: image.height,
          bytes: grabbed.buffer.length,
          mime: grabbed.mime || 'image/png',
          method: grabbed.method,
        });
      } catch (error) {
        failures.push(`${image.src}：${error && error.message ? error.message : error}`);
      }
    }

    if (!images.length) {
      return {
        ok: false,
        action: 'generate',
        message: `图片出现在页面里了，但下载失败：${failures.join('；')}`,
        prompt,
        urls: result.images.map((image) => image.src),
      };
    }

    return {
      ok: true,
      action: 'generate',
      message: `Gemini 生成了 ${images.length} 张图片，已保存到 ${dir}。`,
      prompt,
      dir,
      images,
      complete: result.complete,
      failures,
      elapsedMs: Date.now() - startedAt,
      surface: settingsNow.surface,
    };
  }

  /* ---------------- 工具定义 ---------------- */

  const definition = {
    name: TOOL_NAME,
    description:
      '用 Gemini 生成图片并下载到本地。surface="bridge"（默认，推荐）走浏览器扩展：直接使用你浏览器里已登录的 Gemini 出图，不受 Google 对自动化浏览器的登录拦截；需要先在 chrome://extensions 里加载插件打印出来的扩展目录。' +
      'surface="web"/"app" 会启动一个受控 Chrome 窗口自己操作 gemini.google.com（需要在该窗口里登录）。surface="desktop" 使用电脑版客户端（多数版本禁止调试）。' +
      'action="generate"（默认）需要 prompt；action="batch" 按 prompts 数组逐条顺序出图（写 manifest.json，支持 resume 续跑）；action="status" 查看桥接/登录状态；action="login" 打开登录窗或提示加载扩展；action="import" 从已登录浏览器导入 cookie；action="close" 关闭受控浏览器。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['generate', 'batch', 'status', 'login', 'import', 'close'],
          description:
            '要执行的动作，默认 generate。batch = 批量出图（按 prompts 顺序一张张来，带 manifest 可续跑）。',
        },
        prompt: {
          type: 'string',
          description: '图片描述（action=generate 时必填）。写清主体、风格、构图、比例等要求，效果更稳。',
        },
        prompts: {
          type: 'array',
          items: { type: 'string' },
          description: 'action=batch 时的提示词列表（最多 30 条），按顺序逐条生成。',
        },
        count: {
          type: 'number',
          description: 'action=batch 时每条提示词连续出几轮（1-4，默认 1）；每轮都是新对话，并提示构图要有区别。',
        },
        continueOnError: {
          type: 'boolean',
          description: 'action=batch 时某条失败是否继续后面的条目，默认 true。',
        },
        resume: {
          type: 'boolean',
          description: 'action=batch 时从同目录的 manifest.json 续跑：已完成的条目直接跳过。',
        },
        outDir: {
          type: 'string',
          description: '图片保存目录，默认是当前工作目录下的 gemini-images。',
        },
        filename: {
          type: 'string',
          description: '文件名前缀，可省略；默认按时间戳命名。',
        },
        newChat: {
          type: 'boolean',
          description:
            '生成前是否新开一个对话，默认 true。action=batch 时设为 false 可以让多条提示词共享上下文（例如"同一场景换成水彩风格"）。',
        },
        waitSeconds: {
          type: 'number',
          description: '等待出图的最长秒数，默认 180。',
        },
        surface: {
          type: 'string',
          enum: ['bridge', 'web', 'app', 'desktop'],
          description:
            'bridge=用浏览器扩展驱动你已登录的 Gemini（推荐，不受 Google 登录拦截影响）；web=独立 Chrome 窗口；app=Chrome 应用窗口；desktop=直接驱动电脑版客户端（该客户端禁止调试，通常不可用）。',
        },
        browserPath: {
          type: 'string',
          description: '指定 chrome.exe / msedge.exe 路径，可省略。',
        },
        profileDir: {
          type: 'string',
          description: '指定受控浏览器的用户目录（想换一份登录态时用）。',
        },
        proxyServer: {
          type: 'string',
          description: '给受控浏览器指定代理，如 http://127.0.0.1:7890；留空则跟随系统代理。',
        },
        fromProfile: {
          type: 'string',
          description: 'action=import 时指定源用户目录，例如 C:\\Users\\你\\AppData\\Local\\Google\\Chrome\\User Data；留空自动探测。',
        },
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          action: { type: 'string' },
          message: { type: 'string' },
          loggedIn: { type: 'boolean' },
          connected: { type: 'boolean' },
          port: { type: 'number' },
          extensionDir: { type: 'string' },
          dir: { type: 'string' },
          manifestPath: { type: 'string' },
          batch: { type: 'object', additionalProperties: true },
          complete: { type: 'boolean' },
          elapsedMs: { type: 'number' },
          images: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                url: { type: 'string' },
                width: { type: 'number' },
                height: { type: 'number' },
                bytes: { type: 'number' },
                mime: { type: 'string' },
                method: { type: 'string' },
              },
              additionalProperties: true,
            },
          },
          failures: { type: 'array', items: { type: 'string' } },
        },
        required: ['ok', 'action', 'message'],
        additionalProperties: true,
      },
      render(_args, value) {
        const lines = [];
        if (value && value.action === 'batch' && value.batch) {
          lines.push(value.message || '批量结束。');
          for (const item of value.batch.items || []) {
            const mark = item.status === 'ok' ? '✅' : item.status === 'skipped' ? '⏭' : item.status === 'pending' ? '⏳' : '❌';
            const files = (item.files || []).map((file) => path.basename(file)).join(', ');
            lines.push(`- #${item.index} ${mark} ${files || ''}${item.error ? `  ${item.error}` : ''}`);
          }
          return [{ type: 'text', text: lines.join('\n') }];
        }
        if (value && value.ok) {
          lines.push(value.message || '完成。');
          for (const image of value.images || []) {
            lines.push(`- ${image.path}  ${image.width}×${image.height}  ${formatBytes(image.bytes)}  (${image.method})`);
          }
          if (value.complete === false) lines.push('提示：等待超时结束，可能还有后续图片没有画完。');
        } else {
          lines.push(`Gemini 出图失败：${(value && value.message) || '未知错误'}`);
        }
        if (value && value.failures && value.failures.length) lines.push(`未下载：${value.failures.join('；')}`);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    timeoutMs: 300000,
    async execute(args, exec) {
      const input = args && typeof args === 'object' ? args : {};
      const action = text(input.action) || 'generate';
      try {
        let result;
        if (action === 'status') result = await runStatus(input, exec);
        else if (action === 'login') result = await runLogin(input, exec);
        else if (action === 'import') result = await runImport(input, exec);
        else if (action === 'close') result = await runClose();
        else if (action === 'batch') result = await exclusive(() => runBatch(input, exec));
        else if (action === 'generate') result = await exclusive(() => runGenerate(input, exec));
        else return { ok: false, action, message: `未知的 action：${action}` };

        // 记住这次用的浏览器/目录，下次不用再传
        if (result && result.ok && (input.browserPath || input.profileDir || input.proxyServer)) {
          saveRuntimeSettings({
            browserPath: input.browserPath,
            profileDir: input.profileDir,
            proxyServer: input.proxyServer,
          });
        }
        return toLosslessJson(result);
      } catch (error) {
        const message = error && error.message ? error.message : String(error);
        const label =
          action === 'import'
            ? '导入登录态失败'
            : action === 'login'
              ? '打开登录窗口失败'
              : action === 'status'
                ? '检查 Gemini 状态失败'
                : 'Gemini 出图失败';
        if (error instanceof CdpError) return { ok: false, action, message, error: 'cdp' };
        return { ok: false, action, message: `${label}：${message}` };
      }
    },
  };

  ctx.effect(() => {
    const dispose = tools.register(definition);
    return () => {
      try {
        dispose();
      } catch {
        // ignore
      }
      if (state.page) {
        state.page.dispose().catch(() => {});
        state.page = null;
      }
    };
  });

  // 插件卸载时不要关掉用户正在看的浏览器窗口，只断开调试会话；
  // 桥接服务器必须关掉，否则重载后会占着端口。
  ctx.effect(() => () => {
    if (state.bridge) {
      state.bridge.stop();
      state.bridge = null;
    }
    state.browser = null;
    state.browserKey = '';
  });
}
