/**
 * 管理一个「受控」的 Chromium 浏览器（Chrome / Edge）。
 *
 * 思路：用一个独立 user-data-dir 启动浏览器并打开远程调试端口，插件通过
 * CDP 直接操作那个窗口。登录态保存在 user-data-dir 里，只需人工登录一次。
 * 浏览器进程是 detach 的：插件卸载、DSH 重启都不会把用户正在看的窗口关掉。
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CdpError, pollUntil, sleep } from './cdp.js';

export const GEMINI_URL = 'https://gemini.google.com/app';

const WINDOWS_CANDIDATES = [
  '%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe',
  '%ProgramFiles(x86)%\\Google\\Chrome\\Application\\chrome.exe',
  '%LocalAppData%\\Google\\Chrome\\Application\\chrome.exe',
  '%ProgramFiles%\\Microsoft\\Edge\\Application\\msedge.exe',
  '%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe',
  '%LocalAppData%\\Microsoft\\Edge\\Application\\msedge.exe',
  '%ProgramFiles%\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
  '%LocalAppData%\\Chromium\\Application\\chrome.exe',
];

const POSIX_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/microsoft-edge',
  '/snap/bin/chromium',
];

function expandEnv(value) {
  return value.replace(/%([^%]+)%/g, (_match, name) => process.env[name] || process.env[name.toUpperCase()] || '');
}

/** 找一个可用的 Chromium 内核浏览器；显式路径优先。 */
export function findBrowserExecutable(explicitPath) {
  if (explicitPath) {
    if (existsSync(explicitPath)) return explicitPath;
    throw new CdpError(`配置的浏览器路径不存在：${explicitPath}`);
  }
  const candidates = process.platform === 'win32' ? WINDOWS_CANDIDATES : POSIX_CANDIDATES;
  for (const candidate of candidates) {
    const resolved = process.platform === 'win32' ? expandEnv(candidate) : candidate;
    if (resolved && existsSync(resolved)) return resolved;
  }
  return undefined;
}

/** DSH 数据目录（和别的插件保持一致：优先 DSH_HOME）。 */
export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

/** 进程是否还活着。 */
export function isProcessAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code === 'EPERM');
  }
}

/**
 * 体面地关掉一个浏览器：先发关闭请求（让 Chrome 把 cookie 落盘），
 * 超时才强杀。登录窗口必须这样关，否则刚登录的 cookie 可能丢。
 */
export async function closeProcessGracefully(pid, options = {}) {
  if (!pid || !isProcessAlive(pid)) return true;
  const gracefulMs = Number(options.gracefulMs) > 0 ? Number(options.gracefulMs) : 8000;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T'], { stdio: 'ignore', windowsHide: true });
    else process.kill(-pid, 'SIGTERM');
  } catch {
    // 进程可能已经退出
  }
  const exited = await pollUntil(() => !isProcessAlive(pid), { timeoutMs: gracefulMs, intervalMs: 300 });
  if (!exited) {
    try {
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      else process.kill(-pid, 'SIGKILL');
    } catch {
      // 忽略
    }
    await pollUntil(() => !isProcessAlive(pid), { timeoutMs: 4000, intervalMs: 200 });
  }
  return !isProcessAlive(pid);
}

export function defaultProfileDir() {
  return path.join(dshHome(), 'gemini-image', 'profile');
}

async function httpJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(options.timeoutMs || 2500),
  });
  if (!response.ok) return undefined;
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export class ChromiumBrowser {
  constructor(options = {}) {
    this.executable = options.executable || '';
    this.userDataDir = options.userDataDir || defaultProfileDir();
    this.surface = options.surface === 'app' ? 'app' : 'web';
    this.headless = Boolean(options.headless);
    this.attachPort = Number(options.cdpPort) > 0 ? Number(options.cdpPort) : 0;
    this.proxyServer = options.proxyServer || '';
    this.extraArgs = Array.isArray(options.extraArgs) ? options.extraArgs : [];
    this.port = this.attachPort || 0;
    this.pid = 0;
    this.launched = false;
  }

  get endpoint() {
    return `http://127.0.0.1:${this.port}`;
  }

  describe() {
    return {
      executable: this.executable,
      userDataDir: this.userDataDir,
      surface: this.surface,
      port: this.port,
      pid: this.pid,
      launched: this.launched,
    };
  }

  async ping(port = this.port) {
    if (!port) return false;
    try {
      const version = await httpJson(`http://127.0.0.1:${port}/json/version`, { timeoutMs: 1800 });
      return Boolean(version && version.webSocketDebuggerUrl);
    } catch {
      return false;
    }
  }

  /** 从 DevToolsActivePort 读端口（浏览器用 --remote-debugging-port=0 启动时写这个文件）。 */
  readPortFile() {
    const file = path.join(this.userDataDir, 'DevToolsActivePort');
    if (!existsSync(file)) return 0;
    try {
      const text = readFileSync(file, 'utf8');
      const first = text.split(/\r?\n/)[0].trim();
      const port = Number.parseInt(first, 10);
      return Number.isFinite(port) && port > 0 ? port : 0;
    } catch {
      return 0;
    }
  }

  buildArgs(url) {
    const args = [
      `--remote-debugging-port=0`,
      `--user-data-dir=${this.userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-session-crashed-bubble',
      '--hide-crash-restore-bubble',
      '--disable-background-networking',
      '--window-size=1360,920',
      '--window-position=90,60',
    ];
    if (this.headless) args.push('--headless=new', '--disable-gpu');
    if (this.proxyServer) args.push(`--proxy-server=${this.proxyServer}`);
    if (this.surface === 'app') args.push(`--app=${url}`);
    args.push(...this.extraArgs);
    if (this.surface !== 'app') args.push(url);
    return args;
  }

  /** 确保有一个可连的调试端口；必要时启动浏览器。 */
  async ensure(options = {}) {
    const url = options.url || GEMINI_URL;
    const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 30000;

    if (await this.ping()) {
      this.launched = this.launched && true;
      return this.describe();
    }
    if (this.attachPort) {
      throw new CdpError(`配置的 cdpPort=${this.attachPort} 上没有可用的调试端口（请用 --remote-debugging-port=${this.attachPort} 启动浏览器）。`);
    }

    // 上一次启动残留的端口文件：浏览器还活着就复用，避免开第二个窗口。
    const existing = this.readPortFile();
    if (existing && (await this.ping(existing))) {
      this.port = existing;
      return this.describe();
    }

    const executable = this.executable || findBrowserExecutable('');
    if (!executable) {
      throw new CdpError('找不到 Chrome 或 Edge。请安装 Chrome，或在配置里指定 browserPath。');
    }
    this.executable = executable;
    mkdirSync(this.userDataDir, { recursive: true });

    const child = spawn(executable, this.buildArgs(url), {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    child.unref();
    this.pid = child.pid || 0;
    this.launched = true;
    let exitedEarly = false;
    child.once('exit', () => {
      exitedEarly = true;
    });

    try {
      const port = await pollUntil(
        async () => {
          if (exitedEarly) return -1;
          const discovered = this.readPortFile();
          if (discovered && (await this.ping(discovered))) return discovered;
          return 0;
        },
        { timeoutMs, intervalMs: 400 },
      );
      if (port === -1) {
        throw new CdpError(
          '浏览器进程启动后立刻退出了。最常见的原因是：这个用户目录已经被另一个 Chrome 窗口占用（比如登录窗口）。请先关闭那个窗口再重试，或者在配置里换一个 profileDir。',
        );
      }
      if (!port) throw new CdpError(`浏览器在 ${Math.round(timeoutMs / 1000)} 秒内没有打开调试端口。`);
      this.port = port;
      return this.describe();
    } catch (error) {
      // 启动失败时不要留下半死的窗口
      this.stop();
      throw error instanceof CdpError ? error : new CdpError(`浏览器启动失败：${error && error.message ? error.message : error}`);
    }
  }

  /**
   * 不带调试端口启动一个普通窗口（登录专用）。
   * Google 会拒绝在连着 CDP 的浏览器里登录（signin/rejected），
   * 所以第一次登录必须在这条路径上完成，之后再接管重启。
   */
  launchPlain(url = GEMINI_URL) {
    const executable = this.executable || findBrowserExecutable('');
    if (!executable) throw new CdpError('找不到 Chrome 或 Edge。请安装 Chrome，或在配置里指定 browserPath。');
    this.executable = executable;
    mkdirSync(this.userDataDir, { recursive: true });
    const args = this.buildArgs(url).filter((arg) => !arg.startsWith('--remote-debugging-port'));
    const child = spawn(executable, args, { detached: true, stdio: 'ignore', windowsHide: false });
    child.unref();
    this.pid = child.pid || 0;
    return this.pid;
  }

  async listTargets() {
    try {
      const list = await httpJson(`${this.endpoint}/json/list`, { timeoutMs: 3000 });
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  /** 打开一个新标签页并返回它的 target 信息（含 webSocketDebuggerUrl）。 */
  async openTarget(url) {
    if (!this.port) throw new CdpError('浏览器尚未启动');
    const endpoint = `${this.endpoint}/json/new?${encodeURIComponent(url)}`;
    let target;
    // Chrome 111+ 要求 PUT；更老的版本只认 GET
    for (const method of ['PUT', 'GET']) {
      try {
        target = await httpJson(endpoint, { method, timeoutMs: 8000 });
      } catch (error) {
        target = undefined;
      }
      if (target && target.webSocketDebuggerUrl) return target;
    }
    throw new CdpError('无法在浏览器里打开新标签页');
  }

  async closeTarget(id) {
    if (!this.port || !id) return;
    try {
      await fetch(`${this.endpoint}/json/close/${encodeURIComponent(id)}`, {
        signal: AbortSignal.timeout(3000),
      });
    } catch {
      // 关不掉也无所谓，浏览器退出时会一起清理
    }
  }

  /** 找到（或打开）Gemini 页面；优先复用已有标签页，避免越开越多。 */
  async ensureGeminiTarget() {
    const targets = await this.listTargets();
    const pages = targets.filter(
      (target) =>
        target.type === 'page' &&
        typeof target.url === 'string' &&
        target.webSocketDebuggerUrl &&
        !target.url.startsWith('chrome://') &&
        !target.url.startsWith('devtools://') &&
        !target.url.startsWith('chrome-extension://'),
    );
    const gemini = pages.find((target) => target.url.includes('gemini.google.com'));
    if (gemini) return gemini;
    if (pages.length === 1) return pages[0];
    const fallback = pages.find((target) => target.url === 'about:blank') || pages[0];
    if (fallback) return fallback;
    return await this.openTarget(GEMINI_URL);
  }

  /** 关闭浏览器（只关闭我们自己启动的那一个，attach 模式下不动别人的窗口）。 */
  stop() {
    if (!this.pid || this.attachPort) {
      this.port = this.attachPort || 0;
      return;
    }
    try {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(this.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      } else {
        process.kill(-this.pid, 'SIGTERM');
      }
    } catch {
      // 进程可能已经退出
    }
    this.pid = 0;
    this.port = this.attachPort || 0;
  }
}

export { sleep };
