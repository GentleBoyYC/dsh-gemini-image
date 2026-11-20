/**
 * 扩展桥接：让"用户自己那个已登录的浏览器"帮 DSH 出图。
 *
 * 为什么需要它：Google 会拒绝在自动化/受控的 Chromium 里登录，而 Chrome 156
 * 的 cookie 又是 app-bound 加密、复制到别的用户目录解不开。于是换个方向——
 * 插件在 127.0.0.1 起一个很小的任务队列，浏览器扩展来领任务，在用户已经
 * 登录的 Gemini 页面里操作，再把图片字节回传，插件落盘。
 */

import http from 'node:http';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { dshHome } from './browser.js';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION_SOURCE = path.join(PACKAGE_ROOT, 'extension');
const EXTENSION_FILES = ['manifest.json', 'background.js', 'content.js'];

export const DEFAULT_BRIDGE_PORT = 47623;

/**
 * 进程级注册表：插件被重载时，旧实例的 HTTP 服务器还占着端口。
 * 把实例挂在 globalThis 上，新实例可以直接复用（任务队列也不会断），
 * 而不是撞 EADDRINUSE。
 */
const REGISTRY_KEY = Symbol.for('dsh.gemini-image.bridge-registry');

function registry() {
  if (!globalThis[REGISTRY_KEY]) globalThis[REGISTRY_KEY] = new Map();
  return globalThis[REGISTRY_KEY];
}

function dataDir() {
  return path.join(dshHome(), 'gemini-image');
}

export class GeminiBridge {
  /** 取一个进程内可复用的实例（插件重载后仍保留队列与端口）。 */
  static acquire(port) {
    const map = registry();
    const existing = map.get(port);
    if (existing && existing.server) return existing;
    const created = new GeminiBridge({ port });
    map.set(port, created);
    return created;
  }

  constructor(options = {}) {
    this.port = Number(options.port) > 0 ? Number(options.port) : DEFAULT_BRIDGE_PORT;
    this.server = null;
    this.token = '';
    this.queue = [];
    this.waiters = [];
    this.pending = new Map();
    this.lastSeenAt = 0;
    this.extensionDir = '';
    this.extensionVersion = '';
  }

  connected() {
    return Boolean(this.lastSeenAt) && Date.now() - this.lastSeenAt < 30000;
  }

  info() {
    return {
      port: this.port,
      connected: this.connected(),
      idleMs: this.lastSeenAt ? Date.now() - this.lastSeenAt : 0,
      extensionDir: this.extensionDir,
      extensionVersion: this.extensionVersion,
      queued: this.queue.length,
      running: this.pending.size,
    };
  }

  loadToken() {
    const file = path.join(dataDir(), 'bridge-token.txt');
    try {
      if (existsSync(file)) {
        const existing = readFileSync(file, 'utf8').trim();
        if (existing.length >= 16) return existing;
      }
    } catch {
      // 读不到就重新生成
    }
    const token = randomBytes(24).toString('hex');
    try {
      mkdirSync(dataDir(), { recursive: true });
      writeFileSync(file, `${token}\n`, 'utf8');
    } catch {
      // 写不了就只在内存里用
    }
    return token;
  }

  /** 把扩展源码复制到用户数据目录，并把端口/令牌写进 config.js。 */
  prepareExtension() {
    const target = path.join(dataDir(), 'extension');
    mkdirSync(target, { recursive: true });
    const missing = [];
    for (const name of EXTENSION_FILES) {
      const source = path.join(EXTENSION_SOURCE, name);
      if (!existsSync(source)) {
        missing.push(name);
        continue;
      }
      copyFileSync(source, path.join(target, name));
    }
    if (missing.length > 0) {
      throw new Error(`插件包缺少扩展文件：${missing.join(', ')}`);
    }
    writeFileSync(
      path.join(target, 'config.js'),
      `// 由 dsh-gemini-image 生成，包含本机桥接端口、令牌与版本\nself.DSH_BRIDGE = ${JSON.stringify({
        port: this.port,
        basePort: this.basePort || this.port,
        token: this.token,
        version: this.version(),
      })};\n`,
      'utf8',
    );
    return target;
  }

  /** 扩展上报用的版本号（也方便排查"扩展是不是旧版"）。 */
  version() {
    if (this.packageVersion) return this.packageVersion;
    try {
      this.packageVersion = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')).version || '0.0.0';
    } catch {
      this.packageVersion = '0.0.0';
    }
    return this.packageVersion;
  }

  async ensure() {
    if (this.server) return this.info();
    this.token = this.loadToken();
    const requested = this.port;
    this.basePort = requested;
    let bound = false;
    for (let offset = 0; offset < 10 && !bound; offset += 1) {
      const port = requested + offset;
      try {
        await this.listenOn(port);
        this.port = port;
        bound = true;
      } catch (error) {
        if (error && error.code === 'EADDRINUSE') continue;
        throw new Error(`本地桥接端口 ${port} 无法监听：${error && error.message ? error.message : error}`);
      }
    }
    if (!bound) {
      throw new Error(`${requested} 起连续 10 个端口都被占用，请在配置里改 bridgePort。`);
    }
    this.extensionDir = this.prepareExtension();
    return this.info();
  }

  /** 在指定端口起服务；端口占用时抛出带 EADDRINUSE 的原始错误，交给上层换端口。 */
  listenOn(port) {
    const server = http.createServer((request, response) => {
      this.route(request, response).catch((error) => {
        this.reply(response, 500, { ok: false, error: error && error.message ? error.message : String(error) });
      });
    });
    return new Promise((resolve, reject) => {
      const onError = (error) => {
        server.removeListener('error', onError);
        try {
          server.close();
        } catch {
          // ignore
        }
        reject(error);
      };
      server.once('error', onError);
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', onError);
        this.server = server;
        resolve();
      });
    });
  }

  reply(response, status, body) {
    const text = JSON.stringify(body);
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(text),
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      // Chrome 的 Private Network Access：公网页面（gemini.google.com）访问
      // 127.0.0.1 会先发预检，必须显式允许，否则请求根本发不出去。
      'access-control-allow-private-network': 'true',
      'cache-control': 'no-store',
    });
    response.end(text);
  }

  readBody(request) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      request.on('data', (chunk) => {
        size += chunk.length;
        if (size > 64 * 1024 * 1024) {
          reject(new Error('回传数据过大'));
          request.destroy();
          return;
        }
        chunks.push(chunk);
      });
      request.on('end', () => {
        try {
          const raw = Buffer.concat(chunks).toString('utf8');
          resolve(raw ? JSON.parse(raw) : {});
        } catch (error) {
          reject(error);
        }
      });
      request.on('error', reject);
    });
  }

  async route(request, response) {
    const url = new URL(request.url || '/', `http://127.0.0.1:${this.port}`);
    if (request.method === 'OPTIONS') {
      this.reply(response, 200, { ok: true });
      return;
    }
    const token = url.searchParams.get('t') || '';
    if (token !== this.token) {
      this.reply(response, 403, { ok: false, error: '令牌不匹配：请重新加载扩展（config.js 里的令牌可能过期了）' });
      return;
    }
    const pathname = url.pathname;

    if (pathname === '/hello') {
      this.lastSeenAt = Date.now();
      try {
        const body = await this.readBody(request);
        if (body && typeof body.version === 'string') this.extensionVersion = body.version;
      } catch {
        // hello 没带 body 也算
      }
      this.reply(response, 200, { ok: true, port: this.port });
      return;
    }

    if (pathname === '/next') {
      this.lastSeenAt = Date.now();
      const waitMs = Math.min(25000, Math.max(1000, Number(url.searchParams.get('wait')) || 20000));
      const job = await this.nextJob(waitMs);
      this.reply(response, 200, { ok: true, job });
      return;
    }

    if (pathname === '/result') {
      this.lastSeenAt = Date.now();
      const body = await this.readBody(request);
      const resolve = body && body.id ? this.pending.get(body.id) : undefined;
      if (resolve) {
        this.pending.delete(body.id);
        resolve(body);
      }
      this.reply(response, 200, { ok: true });
      return;
    }

    if (pathname === '/status') {
      this.reply(response, 200, this.info());
      return;
    }

    this.reply(response, 404, { ok: false, error: '未知路径' });
  }

  nextJob(waitMs) {
    const job = this.queue.shift();
    if (job) return Promise.resolve(job);
    return new Promise((resolve) => {
      const waiter = { resolve, timer: null };
      waiter.timer = setTimeout(() => {
        this.waiters = this.waiters.filter((item) => item !== waiter);
        resolve(null);
      }, waitMs);
      this.waiters.push(waiter);
    });
  }

  enqueue(job) {
    const waiter = this.waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(job);
      return;
    }
    this.queue.push(job);
  }

  /** 下发一次生成任务，等扩展把结果送回来。 */
  async runJob(options = {}) {
    const info = await this.ensure();
    if (!info.connected) {
      const error = new Error('浏览器扩展还没有连上桥接');
      error.code = 'bridge-not-connected';
      error.extensionDir = info.extensionDir;
      throw error;
    }
    const timeoutMs = Math.max(20000, Number(options.timeoutMs) || 180000);
    const id = randomBytes(6).toString('hex');
    const job = { id, prompt: options.prompt, newChat: options.newChat !== false, timeoutMs };
    const settled = new Promise((resolve) => this.pending.set(id, resolve));
    this.enqueue(job);

    const timeout = new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ ok: false, error: `等待浏览器返回结果超时（${Math.round(timeoutMs / 1000)} 秒）` }), timeoutMs + 30000);
      if (typeof timer.unref === 'function') timer.unref();
    });
    const aborted = new Promise((resolve) => {
      if (!options.signal) return;
      if (options.signal.aborted) {
        resolve({ ok: false, error: '已取消' });
        return;
      }
      options.signal.addEventListener('abort', () => resolve({ ok: false, error: '已取消' }), { once: true });
    });

    try {
      return await Promise.race([settled, timeout, aborted]);
    } finally {
      this.pending.delete(id);
    }
  }

  stop() {
    if (!this.server) return;
    // 先掐断挂着的长轮询，否则扩展要等 20 秒超时才发现插件已经重启
    try {
      if (typeof this.server.closeAllConnections === 'function') this.server.closeAllConnections();
    } catch {
      // ignore
    }
    try {
      this.server.close();
    } catch {
      // ignore
    }
    this.server = null;
    const map = registry();
    for (const [key, value] of map) {
      if (value === this) map.delete(key);
    }
  }
}
