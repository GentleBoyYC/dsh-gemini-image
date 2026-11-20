/**
 * Gemini 桌面客户端（Electron）后端。
 *
 * 桌面端的登录态在 %APPDATA%\Gemini 里，用的是 app-bound 加密，cookie 复制
 * 不出来；但它本身就是 Chromium，只要能挂上调试端口，就能用和网页版完全一样
 * 的页面自动化去操作——这正是"调用电脑版 Gemini"最直接的做法。
 */

import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { CdpError, pollUntil } from './cdp.js';
import { GEMINI_URL, isProcessAlive } from './browser.js';

function localAppData() {
  return process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local');
}

/** 找到 Gemini 桌面客户端真正的 Electron 主程序（app-<版本>\Gemini.exe）。 */
export function findGeminiAppExecutable(explicit) {
  if (explicit) {
    if (existsSync(explicit)) return explicit;
    throw new CdpError(`配置的 Gemini 客户端路径不存在：${explicit}`);
  }
  const root = path.join(localAppData(), 'Google', 'Gemini');
  if (!existsSync(root)) return undefined;
  let best;
  for (const name of readdirSync(root)) {
    if (!name.startsWith('app-')) continue;
    const candidate = path.join(root, name, 'Gemini.exe');
    if (!existsSync(candidate)) continue;
    const version = name.slice(4).split('.').map((part) => Number.parseInt(part, 10) || 0);
    if (!best || compareVersions(version, best.version) > 0) best = { version, path: candidate };
  }
  if (best) return best.path;
  const stub = path.join(root, 'Gemini.exe');
  return existsSync(stub) ? stub : undefined;
}

function compareVersions(left, right) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index] || 0;
    const b = right[index] || 0;
    if (a !== b) return a - b;
  }
  return 0;
}

export class GeminiDesktop {
  constructor(options = {}) {
    this.executable = options.executable || '';
    this.port = Number(options.port) > 0 ? Number(options.port) : 9333;
    this.extraArgs = Array.isArray(options.extraArgs) ? options.extraArgs : [];
    this.pid = 0;
    this.launched = false;
  }

  get endpoint() {
    return `http://127.0.0.1:${this.port}`;
  }

  describe() {
    return {
      kind: 'desktop',
      executable: this.executable,
      port: this.port,
      pid: this.pid,
      launched: this.launched,
    };
  }

  async ping() {
    try {
      const response = await fetch(`${this.endpoint}/json/version`, { signal: AbortSignal.timeout(1500) });
      if (!response.ok) return false;
      const body = await response.json();
      return Boolean(body && body.webSocketDebuggerUrl);
    } catch {
      return false;
    }
  }

  async ensure() {
    if (await this.ping()) return this.describe();
    const executable = this.executable || findGeminiAppExecutable('');
    if (!executable) {
      throw new CdpError('没有找到 Gemini 桌面客户端（应在 %LOCALAPPDATA%\\Google\\Gemini）。请先安装，或改用 surface="web"。');
    }
    this.executable = executable;
    const child = spawn(executable, [`--remote-debugging-port=${this.port}`, ...this.extraArgs], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    child.unref();
    this.pid = child.pid || 0;
    this.launched = true;
    const ready = await pollUntil(() => this.ping(), { timeoutMs: 25000, intervalMs: 500 });
    if (!ready) {
      throw new CdpError(
        'Gemini 桌面客户端没有打开调试端口。通常是两种情况：它已经在运行（单实例，新进程会直接退出），或者这个版本禁止远程调试。请先完全退出 Gemini 桌面端再试。',
      );
    }
    return this.describe();
  }

  async listTargets() {
    try {
      const response = await fetch(`${this.endpoint}/json/list`, { signal: AbortSignal.timeout(3000) });
      if (!response.ok) return [];
      const list = await response.json();
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  async ensureGeminiTarget() {
    const targets = await this.listTargets();
    const pages = targets.filter((target) => target.type === 'page' && target.webSocketDebuggerUrl);
    const gemini = pages.find((target) => String(target.url || '').includes('gemini.google.com'));
    if (gemini) return gemini;
    if (pages.length > 0) return pages[0];
    throw new CdpError('Gemini 桌面客户端里没有可用的页面目标');
  }

  async openTarget() {
    throw new CdpError('桌面客户端不支持新开标签页');
  }

  async closeTarget() {
    // 桌面端没有单独的标签页可关
  }

  stop() {
    if (!this.pid) return;
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/PID', String(this.pid), '/T'], { stdio: 'ignore', windowsHide: true, detached: true });
      } else if (isProcessAlive(this.pid)) {
        process.kill(this.pid, 'SIGTERM');
      }
    } catch {
      // 忽略
    }
    this.pid = 0;
    this.launched = false;
  }
}

export { GEMINI_URL };
