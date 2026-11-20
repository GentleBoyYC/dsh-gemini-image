/**
 * 极简 Chrome DevTools Protocol 客户端。
 *
 * 只用 Node 22+ / Electron 28+ 里内置的全局 WebSocket，故意不引入
 * ws / puppeteer 之类的依赖：插件安装在用户 profile 里，装依赖越少
 * 越不容易因为版本/网络问题挂掉。
 */

const WebSocketImpl = globalThis.WebSocket;

/** CDP 调用失败（超时、报错、连接断开）统一抛这个。 */
export class CdpError extends Error {
  constructor(message, method) {
    super(message);
    this.name = 'CdpError';
    this.method = method;
  }
}

export function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function describe(error) {
  return error && typeof error.message === 'string' ? error.message : String(error);
}

/** 一个 page / browser 目标上的 CDP 会话。 */
export class CdpSession {
  constructor(webSocketUrl, options = {}) {
    if (typeof WebSocketImpl !== 'function') {
      throw new CdpError('当前运行时没有全局 WebSocket（需要 Node 22+ 或 Electron 28+）。');
    }
    this.webSocketUrl = webSocketUrl;
    this.defaultTimeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 30000;
    this.socket = null;
    this.pending = new Map();
    this.listeners = new Map();
    this.nextId = 1;
    this.closed = false;
    this.opening = null;
    this.closing = null;
  }

  get isOpen() {
    return this.socket !== null && this.closed === false && this.socket.readyState === 1;
  }

  /** 建立连接；重复调用会复用同一个 Promise。 */
  open() {
    if (this.opening) return this.opening;
    this.opening = new Promise((resolve, reject) => {
      let socket;
      try {
        socket = new WebSocketImpl(this.webSocketUrl);
      } catch (error) {
        reject(new CdpError(`无法创建 WebSocket：${describe(error)}`));
        return;
      }
      this.socket = socket;
      let settled = false;
      socket.addEventListener('open', () => {
        if (settled) return;
        settled = true;
        resolve(this);
      });
      socket.addEventListener('message', (event) => this._handleMessage(event && event.data));
      socket.addEventListener('error', (event) => {
        if (settled) return;
        settled = true;
        reject(new CdpError(`无法连接 CDP：${describe(event && event.message) || '连接被拒绝'}`));
      });
      socket.addEventListener('close', () => {
        this.closed = true;
        if (!settled) {
          settled = true;
          reject(new CdpError('CDP 连接在建立前被关闭'));
        }
        this._rejectAll(new CdpError('CDP 连接已关闭'));
      });
    });
    return this.opening;
  }

  _handleMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (message && message.id !== undefined) {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) {
        entry.reject(new CdpError(`${entry.method}: ${message.error.message || 'CDP 错误'}`, entry.method));
      } else {
        entry.resolve(message.result || {});
      }
      return;
    }
    if (message && typeof message.method === 'string') {
      const handlers = this.listeners.get(message.method);
      if (!handlers) return;
      for (const handler of Array.from(handlers)) {
        try {
          handler(message.params || {});
        } catch {
          // 事件监听器里的异常不能影响 CDP 通道本身
        }
      }
    }
  }

  _rejectAll(error) {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  /** 注册事件监听，返回取消函数。 */
  on(method, handler) {
    let handlers = this.listeners.get(method);
    if (!handlers) {
      handlers = new Set();
      this.listeners.set(method, handlers);
    }
    handlers.add(handler);
    return () => {
      const current = this.listeners.get(method);
      if (current) current.delete(handler);
    };
  }

  send(method, params = {}, options = {}) {
    if (this.closed) return Promise.reject(new CdpError(`CDP 会话已关闭（${method}）`, method));
    if (!this.isOpen) return Promise.reject(new CdpError(`CDP 会话尚未就绪（${method}）`, method));
    const id = this.nextId++;
    const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : this.defaultTimeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpError(`CDP 调用超时（${method}，${timeoutMs}ms）`, method));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new CdpError(`CDP 发送失败（${method}）：${describe(error)}`, method));
      }
    });
  }

  /**
   * 在页面里执行一段表达式。
   * 页面抛出的异常会被转换成 CdpError，方便上层给出可读报错。
   */
  async evaluate(expression, options = {}) {
    const result = await this.send(
      'Runtime.evaluate',
      {
        expression,
        awaitPromise: options.awaitPromise !== false,
        returnByValue: options.returnByValue !== false,
        userGesture: true,
      },
      options,
    );
    if (result && result.exceptionDetails) {
      const detail = result.exceptionDetails;
      const text =
        (detail.exception && (detail.exception.description || detail.exception.value)) ||
        detail.text ||
        '页面脚本执行失败';
      throw new CdpError(String(text), 'Runtime.evaluate');
    }
    return result && result.result ? result.result.value : undefined;
  }

  close() {
    if (this.closing) return this.closing;
    this.closing = new Promise((resolve) => {
      const socket = this.socket;
      this.closed = true;
      this._rejectAll(new CdpError('CDP 会话已关闭'));
      if (!socket || socket.readyState === 3) {
        resolve();
        return;
      }
      const done = () => resolve();
      socket.addEventListener('close', done, { once: true });
      try {
        socket.close();
      } catch {
        resolve();
        return;
      }
      setTimeout(done, 1500);
    });
    return this.closing;
  }
}

/** 轮询直到 predicate 返回真值；超时返回最后一次结果（不抛错）。 */
export async function pollUntil(predicate, options = {}) {
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 30000;
  const intervalMs = Number(options.intervalMs) > 0 ? Number(options.intervalMs) : 400;
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    if (options.signal && options.signal.aborted) throw new CdpError('操作已取消');
    last = await predicate();
    if (last) return last;
    if (Date.now() >= deadline) {
      return options.throwOnTimeout ? Promise.reject(new CdpError(options.message || '等待超时')) : last;
    }
    await sleep(intervalMs);
  }
}
