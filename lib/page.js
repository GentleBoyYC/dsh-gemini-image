/**
 * Gemini 网页端（gemini.google.com）的页面自动化。
 *
 * 只做四件事：判断登录状态、把提示词写进输入框、等图片真的出现在回答里、
 * 把图片原始字节拿回来。选择器写得比较宽松，Gemini 改版时优先保证能降级。
 */

import { CdpError, CdpSession, pollUntil, sleep } from './cdp.js';
import { GEMINI_URL } from './browser.js';

/* ------------------------------------------------------------------ */
/* 注入页面的小函数（用 toString() 序列化，避免手写转义）                */
/* ------------------------------------------------------------------ */

function findEditorInPage() {
  const selectors = [
    'rich-textarea div[contenteditable="true"]',
    'div[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"].ql-editor',
    'textarea[aria-label]',
    'div[contenteditable="true"]',
  ];
  for (const selector of selectors) {
    const element = document.querySelector(selector);
    if (element) return element;
  }
  return null;
}

function readEditorTextInPage(editor) {
  if (!editor) return '';
  if (typeof editor.value === 'string') return editor.value;
  return String(editor.innerText || editor.textContent || '');
}

function probeInPage() {
  const editor = findEditor();
  const text = readEditorText(editor);
  const signIn = Array.from(document.querySelectorAll('a, button')).some((element) => {
    const href = element.getAttribute('href') || '';
    if (/accounts\.google\.com\/(ServiceLogin|signin|v3\/signin)/i.test(href)) return true;
    const label = (element.textContent || '').trim();
    if (!/^(sign in|sign in to gemini|登录|登入)$/i.test(label)) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
  const images = [];
  const seen = new Set();
  const nodes = Array.from(document.images || []);
  for (const image of nodes) {
    const src = image.currentSrc || image.src || '';
    if (!src) continue;
    if (!/^(https?:|blob:|data:image\/)/.test(src)) continue;
    if (src.indexOf('/a/') >= 0 || src.indexOf('/ogw/') >= 0) continue;
    if (/=s(?:16|20|24|28|32|36|40|44|48|56|60|64|72|80|88|96|100|120)(?:-|$)/.test(src)) continue;
    const width = image.naturalWidth || image.width || 0;
    const height = image.naturalHeight || image.height || 0;
    if (width < 200 || height < 150) continue;
    if (seen.has(src)) continue;
    seen.add(src);
    images.push({
      src,
      width,
      height,
      loaded: Boolean(image.complete && width > 0),
      alt: image.alt || '',
      inResponse: Boolean(image.closest('model-response, .model-response, message-content, .conversation-container')),
    });
  }
  const busy = Boolean(
    document.querySelector('mat-progress-bar, [data-test-id="stop-button"], button[aria-label="Stop response"], button[aria-label="停止回答"]'),
  );
  const body = document.body;
  const bodyText = body ? body.innerText || '' : '';
  const errorPage = location.href.startsWith('chrome-error://') || Boolean(document.querySelector('#main-frame-error, .neterror'));
  const networkError = errorPage ? (bodyText.match(/ERR_[A-Z_]+/) || [''])[0] : '';
  return {
    url: location.href,
    title: document.title,
    ready: document.readyState,
    hasEditor: Boolean(editor),
    loggedIn: Boolean(editor) && !signIn && !errorPage,
    editorText: text,
    editorEmpty: text.trim().length === 0,
    signIn,
    errorPage,
    networkError,
    images,
    busy,
    textLength: bodyText.length,
  };
}

function findEditorPointInPage() {
  const editor = findEditor();
  if (!editor) return null;
  try {
    editor.scrollIntoView({ block: 'center', inline: 'nearest' });
  } catch {
    // 老页面可能没有 scrollIntoView 的可选参数
  }
  const rect = editor.getBoundingClientRect();
  if (!rect || rect.width < 4 || rect.height < 4) return null;
  return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
}

/** 把页面级小函数拼成表达式前缀。 */
const PRELUDE = [
  `const findEditor = ${findEditorInPage.toString()};`,
  `const readEditorText = ${readEditorTextInPage.toString()};`,
].join('\n');

function expression(body) {
  return `(() => {\n${PRELUDE}\n${body}\n})()`;
}

const PROBE = expression(`return (${probeInPage.toString()})();`);
const EDITOR_POINT = expression(`return (${findEditorPointInPage.toString()})();`);

/* ------------------------------------------------------------------ */
/* 页面对象                                                            */
/* ------------------------------------------------------------------ */

const MIME_BY_EXT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif' };

export function extensionForMime(mime, fallback = 'png') {
  const normalized = String(mime || '').toLowerCase();
  if (normalized.includes('png')) return 'png';
  if (normalized.includes('jpeg') || normalized.includes('jpg')) return 'jpg';
  if (normalized.includes('webp')) return 'webp';
  if (normalized.includes('gif')) return 'gif';
  if (normalized.includes('avif')) return 'avif';
  return fallback;
}

export function mimeForExtension(ext) {
  return MIME_BY_EXT[String(ext || '').toLowerCase()] || 'image/png';
}

export class GeminiPage {
  constructor(browser, session) {
    this.browser = browser;
    this.session = session;
    /** url -> { requestId, mimeType }：生成图片时顺带抓到的网络响应 */
    this.network = new Map();
    this.disposed = false;
  }

  /** 连接（或新开）Gemini 页面并初始化域。 */
  static async open(browser, options = {}) {
    const target = await browser.ensureGeminiTarget();
    if (!target || !target.webSocketDebuggerUrl) throw new CdpError('无法获取 Gemini 页面的调试地址');
    return await GeminiPage.connect(browser, target.webSocketDebuggerUrl, options);
  }

  /** 直接连接一个已知的 target（测试或复用指定标签页时用）。 */
  static async connect(browser, webSocketDebuggerUrl, options = {}) {
    const session = new CdpSession(webSocketDebuggerUrl, { timeoutMs: options.timeoutMs || 25000 });
    await session.open();
    const page = new GeminiPage(browser, session);
    await page.prepare();
    return page;
  }

  async prepare() {
    await this.session.send('Page.enable');
    await this.session.send('Runtime.enable');
    await this.session.send('Network.enable', { maxTotalBufferSize: 100 * 1024 * 1024 });
    // 关掉缓存，保证新生成的图片一定走网络、从而能用 getResponseBody 取回原始字节
    try {
      await this.session.send('Network.setCacheDisabled', { cacheDisabled: true });
    } catch {
      // 老版本可能不支持，忽略
    }
    this.session.on('Network.responseReceived', (params) => {
      const response = params && params.response;
      if (!response || !response.url) return;
      const mimeType = String(response.mimeType || '');
      const type = String(params.type || '');
      if (type !== 'Image' && !mimeType.startsWith('image/')) return;
      this.network.set(response.url, { requestId: params.requestId, mimeType });
      if (this.network.size > 300) {
        const oldest = Array.from(this.network.keys()).slice(0, 150);
        for (const key of oldest) this.network.delete(key);
      }
    });
  }

  async probe() {
    return await this.session.evaluate(PROBE);
  }

  async navigate(url = GEMINI_URL) {
    await this.session.send('Page.navigate', { url });
    await this.waitForReady({ timeoutMs: 30000 });
  }

  /** 等到 Gemini 的应用壳挂载完成（输入框出现，或明确的登录入口出现）。 */
  async waitForReady(options = {}) {
    const deadline = Date.now() + (options.timeoutMs || 30000);
    let last = null;
    while (Date.now() < deadline) {
      if (options.signal && options.signal.aborted) throw new CdpError('操作已取消');
      try {
        last = await this.probe();
      } catch {
        last = null;
      }
      if (last && (last.loggedIn || last.signIn || last.errorPage)) return last;
      await sleep(500);
    }
    return last;
  }

  /**
   * 确认登录可用。
   * 注意 Gemini 在未登录时也会显示输入框，所以不能只看输入框："登录"入口
   * 还在、或页面停在网络错误页，都不算能用。
   */
  async ensureLoggedIn(options = {}) {
    const deadline = Date.now() + (options.timeoutMs || 20000);
    let state = await this.probe();
    while (Date.now() < deadline) {
      if (options.signal && options.signal.aborted) throw new CdpError('操作已取消');
      if (state && state.loggedIn) return state;
      if (state && state.errorPage) break;
      await sleep(700);
      state = await this.probe().catch(() => state);
    }
    if (state && state.errorPage) {
      throw new CdpError(
        `打不开 gemini.google.com（${state.networkError || '网络错误'}）。请确认代理/VPN 已开启；如果代理不是系统代理，用浏览器参数指定 --proxy-server。`,
      );
    }
    const where = state && state.url ? `当前页面：${state.url}` : '当前页面无法读取';
    throw new CdpError(
      `Gemini 还没有登录（${where}）。请先调用 gemini_image（action="login"）在弹出的窗口里登录 Google，然后再生成。`,
    );
  }

  async click(point) {
    const base = { x: point.x, y: point.y, button: 'left', clickCount: 1 };
    await this.session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
    await this.session.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
    await this.session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
  }

  /** 把提示词写进输入框并发送。 */
  async sendPrompt(prompt) {
    const point = await this.session.evaluate(EDITOR_POINT);
    if (!point) throw new CdpError('找不到 Gemini 的输入框（页面可能还没加载完，或尚未登录）');
    await this.click(point);
    await sleep(120);

    await this.session.send('Input.insertText', { text: prompt });
    let text = await this.readEditorText();
    const head = prompt.slice(0, 16);
    if (!text.includes(head)) {
      // 兜底：有些版本的编辑器不认 Input.insertText，用 execCommand 直接写
      await this.session.evaluate(
        expression(`
          const editor = findEditor();
          if (!editor) return false;
          editor.focus();
          document.execCommand('selectAll', false, null);
          document.execCommand('insertText', false, ${JSON.stringify(prompt)});
          return true;
        `),
      );
      text = await this.readEditorText();
    }
    if (!String(text || '').trim()) throw new CdpError('提示词没有写进 Gemini 输入框');

    await this.pressEnter();
    const sent = await this.waitForSend({ timeoutMs: 8000 });
    if (!sent) {
      await this.clickSendButton();
      await this.waitForSend({ timeoutMs: 8000 });
    }
    return true;
  }

  async readEditorText() {
    return await this.session.evaluate(expression(`return readEditorText(findEditor());`));
  }

  async pressEnter() {
    const base = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
    await this.session.send('Input.dispatchKeyEvent', { type: 'keyDown', text: '\r', unmodifiedText: '\r', ...base });
    await this.session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }

  async clickSendButton() {
    const point = await this.session.evaluate(`
      (() => {
        const labels = ['Send message', 'Send', '发送', '发送消息'];
        const buttons = Array.from(document.querySelectorAll('button'));
        const target = buttons.find((button) => {
          const label = (button.getAttribute('aria-label') || '') + ' ' + (button.textContent || '');
          return labels.some((item) => label.trim().toLowerCase().includes(item.toLowerCase())) && !button.disabled;
        });
        if (!target) return null;
        const rect = target.getBoundingClientRect();
        if (!rect || rect.width < 4) return null;
        return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
      })()
    `);
    if (point) await this.click(point);
  }

  async waitForSend(options = {}) {
    const deadline = Date.now() + (options.timeoutMs || 8000);
    while (Date.now() < deadline) {
      try {
        const state = await this.probe();
        if (state && (state.editorEmpty || state.busy)) return true;
      } catch {
        // 页面正在重绘，忽略
      }
      await sleep(300);
    }
    return false;
  }

  /**
   * 等新图片出现并稳定下来。
   * 只凭"图片已加载 + 连续几轮 DOM 不变"判断，不硬依赖停止按钮的形状。
   */
  async waitForImages(options = {}) {
    const baseline = Number(options.baseline) || 0;
    const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 180000;
    const intervalMs = Number(options.intervalMs) > 0 ? Number(options.intervalMs) : 1500;
    const deadline = Date.now() + timeoutMs;
    let lastSignature = '';
    let stable = 0;
    let latest = null;

    while (Date.now() < deadline) {
      if (options.signal && options.signal.aborted) throw new CdpError('操作已取消');
      let state;
      try {
        state = await this.probe();
      } catch {
        await sleep(intervalMs);
        continue;
      }
      latest = state;
      const fresh = (state.images || []).slice(baseline);
      const loaded = fresh.length > 0 && fresh.every((image) => image.loaded);
      const signature = fresh.map((image) => image.src).join('|') + '#' + (state.textLength || 0);
      if (loaded && signature === lastSignature) stable += 1;
      else stable = 0;
      lastSignature = signature;
      if (loaded && stable >= 2 && (!state.busy || stable >= 4)) {
        return { images: fresh, complete: true, snapshot: state };
      }
      await sleep(intervalMs);
    }
    return { images: (latest && latest.images ? latest.images : []).slice(baseline), complete: false, snapshot: latest };
  }

  /**
   * 取回图片原始字节。
   * 依次尝试：网络抓包 → 页面内 fetch → 新标签页重放（绕开 CORS）。
   */
  async grab(src) {
    const failures = [];
    if (!src) throw new CdpError('图片地址为空');

    if (src.startsWith('data:')) {
      const match = /^data:([^;,]+)?(;base64)?,(.*)$/.exec(src);
      if (match) {
        const mime = match[1] || 'image/png';
        const buffer = match[2] ? Buffer.from(match[3], 'base64') : Buffer.from(decodeURIComponent(match[3]));
        return { buffer, mime, method: 'data-url' };
      }
    }

    let known = this.network.get(src);
    if (!known) {
      // URL 可能带不同的查询参数，退一步按路径匹配
      const wanted = String(src).split('?')[0].split('#')[0];
      for (const [url, entry] of this.network) {
        if (url.split('?')[0].split('#')[0] === wanted) {
          known = entry;
          break;
        }
      }
    }
    if (known && known.requestId) {
      try {
        const body = await this.session.send('Network.getResponseBody', { requestId: known.requestId });
        const buffer = body.base64Encoded ? Buffer.from(body.body, 'base64') : Buffer.from(body.body, 'utf8');
        if (buffer.length > 0) return { buffer, mime: known.mimeType || 'image/png', method: 'network' };
      } catch (error) {
        failures.push(`network: ${error && error.message ? error.message : error}`);
      }
    }

    try {
      const result = await this.session.evaluate(`
        (async () => {
          try {
            const response = await fetch(${JSON.stringify(src)}, { credentials: 'include', cache: 'force-cache' });
            if (!response.ok) return { error: 'HTTP ' + response.status };
            const bytes = new Uint8Array(await response.arrayBuffer());
            let binary = '';
            const chunk = 0x8000;
            for (let index = 0; index < bytes.length; index += chunk) {
              binary += String.fromCharCode.apply(null, bytes.subarray(index, index + chunk));
            }
            return { base64: btoa(binary), mimeType: response.headers.get('content-type') || '' };
          } catch (error) {
            return { error: String((error && error.message) || error) };
          }
        })()
      `);
      if (result && result.base64) {
        return { buffer: Buffer.from(result.base64, 'base64'), mime: result.mimeType || 'image/png', method: 'fetch' };
      }
      failures.push(`fetch: ${result && result.error ? result.error : '空响应'}`);
    } catch (error) {
      failures.push(`fetch: ${error && error.message ? error.message : error}`);
    }

    if (!src.startsWith('blob:')) {
      try {
        const captured = await this.captureInTab(src);
        if (captured) return captured;
      } catch (error) {
        failures.push(`tab: ${error && error.message ? error.message : error}`);
      }
    }

    throw new CdpError(`无法读取图片字节（${failures.join('；')}）`);
  }

  /** 在新标签页里重放请求（禁用缓存），借用浏览器网络栈取回原始字节。 */
  async captureInTab(src) {
    const target = await this.browser.openTarget('about:blank');
    const tab = new CdpSession(target.webSocketDebuggerUrl, { timeoutMs: 25000 });
    await tab.open();
    let requestId = '';
    let mimeType = '';
    const strip = (value) => String(value || '').split('#')[0].split('?')[0];
    const wanted = strip(src);
    tab.on('Network.requestWillBeSent', (params) => {
      const url = params && params.request && params.request.url;
      if (requestId || !url) return;
      if (url === src || strip(url) === wanted) requestId = params.requestId;
    });
    tab.on('Network.responseReceived', (params) => {
      if (params && params.requestId === requestId && params.response) mimeType = params.response.mimeType || mimeType;
    });
    try {
      await tab.send('Page.enable');
      await tab.send('Network.enable');
      await tab.send('Network.setCacheDisabled', { cacheDisabled: true });
      await tab.send('Page.navigate', { url: src });
      const found = await pollUntil(() => requestId, { timeoutMs: 15000, intervalMs: 150 });
      if (!found) throw new CdpError('没有捕获到图片请求');
      const body = await pollUntil(
        async () => {
          try {
            return await tab.send('Network.getResponseBody', { requestId });
          } catch {
            return 0;
          }
        },
        { timeoutMs: 20000, intervalMs: 250 },
      );
      if (!body || !body.body) throw new CdpError('没有取到响应体');
      const buffer = body.base64Encoded ? Buffer.from(body.body, 'base64') : Buffer.from(body.body, 'utf8');
      return { buffer, mime: mimeType || 'image/png', method: 'tab' };
    } finally {
      await tab.close();
      await this.browser.closeTarget(target.id);
    }
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    await this.session.close();
  }
}

export { GEMINI_URL };
