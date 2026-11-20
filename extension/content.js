/* global chrome */
/**
 * 运行在 gemini.google.com 页面里的内容脚本。
 *
 * 它自己负责整条链路：向本机桥接领任务 → 在页面上写提示词、点发送、
 * 等图片出现 → 取图片字节（扩展权限可绕开 CORS）→ 回传结果。
 *
 * 轮询放在这里而不是后台 service worker，是因为 MV3 的 worker 会被浏览器
 * 挂起，长轮询放那儿会表现为"扩展掉线"；内容脚本跟着标签页活，更稳。
 */
(() => {
  if (window.__dshGeminiBridgeLoaded) return;
  window.__dshGeminiBridgeLoaded = true;

  /* ---------- 页面元素 ---------- */

  const EDITOR_SELECTORS = [
    'rich-textarea div[contenteditable="true"]',
    'div[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"].ql-editor',
    'textarea[aria-label]',
    'div[contenteditable="true"]',
  ];

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function findEditor() {
    for (const selector of EDITOR_SELECTORS) {
      const element = document.querySelector(selector);
      if (element) return element;
    }
    return null;
  }

  function editorText(editor) {
    if (!editor) return '';
    if (typeof editor.value === 'string') return editor.value;
    return String(editor.innerText || editor.textContent || '');
  }

  function visible(element) {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function hasSignIn() {
    return Array.from(document.querySelectorAll('a, button')).some((element) => {
      const href = element.getAttribute('href') || '';
      if (/accounts\.google\.com\/(ServiceLogin|signin|v3\/signin)/i.test(href)) return true;
      const label = (element.textContent || '').trim();
      return /^(sign in|sign in to gemini|登录|登入)$/i.test(label) && visible(element);
    });
  }

  function collectImages() {
    const images = [];
    const seen = new Set();
    for (const image of Array.from(document.images || [])) {
      const src = image.currentSrc || image.src || '';
      if (!src) continue;
      if (!/^(https?:|blob:|data:image\/)/.test(src)) continue;
      if (src.includes('/a/') || src.includes('/ogw/')) continue;
      if (/=s(?:16|20|24|28|32|36|40|44|48|56|60|64|72|80|88|96|100|120)(?:-|$)/.test(src)) continue;
      const width = image.naturalWidth || image.width || 0;
      const height = image.naturalHeight || image.height || 0;
      if (width < 200 || height < 150) continue;
      if (seen.has(src)) continue;
      seen.add(src);
      images.push({ src, width, height, loaded: Boolean(image.complete && width > 0) });
    }
    return images;
  }

  function clickElement(element) {
    if (!element) return false;
    try {
      element.scrollIntoView({ block: 'center' });
    } catch {
      // ignore
    }
    const rect = element.getBoundingClientRect();
    const options = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    };
    element.dispatchEvent(new MouseEvent('mousedown', options));
    element.dispatchEvent(new MouseEvent('mouseup', options));
    element.dispatchEvent(new MouseEvent('click', options));
    return true;
  }

  function clickNewChat() {
    const candidates = Array.from(document.querySelectorAll('button, a'));
    const target = candidates.find((element) => {
      const label = `${element.getAttribute('aria-label') || ''} ${element.textContent || ''}`.toLowerCase();
      return visible(element) && /new chat|new conversation|新对话|发起新对话|新建对话/.test(label);
    });
    return clickElement(target);
  }

  function clickSend() {
    const candidates = Array.from(document.querySelectorAll('button'));
    const target = candidates.find((element) => {
      const label = `${element.getAttribute('aria-label') || ''} ${element.textContent || ''}`.toLowerCase();
      if (!visible(element) || element.disabled) return false;
      return /send message|^send$|发送|发送消息/.test(label.trim());
    });
    return clickElement(target);
  }

  function isBusy() {
    const nodes = Array.from(
      document.querySelectorAll(
        'mat-progress-bar, [data-test-id="stop-button"], button[aria-label="Stop response"], button[aria-label="停止回答"]',
      ),
    );
    return nodes.some((node) => visible(node));
  }

  /** 等上一条回答收尾（共享上下文时，下一条不能在上一条还在生成时发送）。 */
  async function waitIdle(timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!isBusy() && findEditor()) return true;
      await sleep(500);
    }
    return !isBusy();
  }

  async function sendPrompt(prompt) {
    const editor = findEditor();
    if (!editor) {
      if (hasSignIn()) throw new Error('Gemini 还没有登录：请在这个浏览器里登录后再试');
      throw new Error('找不到 Gemini 输入框（页面可能还没加载完）');
    }
    editor.focus();
    try {
      document.execCommand('selectAll', false, null);
    } catch {
      // ignore
    }
    const inserted = document.execCommand('insertText', false, prompt);
    if (!inserted || !editorText(editor).includes(prompt.slice(0, 12))) {
      editor.textContent = prompt;
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, data: prompt, inputType: 'insertText' }));
    }
    await sleep(150);

    // 点发送按钮和按回车都可能因为页面状态失效，轮流试几轮
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt === 0) {
        if (!clickSend()) {
          const enter = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true });
          editor.dispatchEvent(enter);
        }
      } else if (attempt === 1) {
        const enter = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true });
        findEditor()?.dispatchEvent(enter);
      } else {
        clickSend();
      }
      for (let wait = 0; wait < 6; wait += 1) {
        await sleep(250);
        if (!editorText(findEditor()).trim()) return true;
      }
    }
    return false;
  }

  async function waitForImages(baseline, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let lastSignature = '';
    let stable = 0;
    let latest = [];
    while (Date.now() < deadline) {
      const images = collectImages();
      latest = images;
      const fresh = images.slice(baseline);
      const loaded = fresh.length > 0 && fresh.every((image) => image.loaded);
      const signature = fresh.map((image) => image.src).join('|');
      if (loaded && signature === lastSignature) stable += 1;
      else stable = 0;
      lastSignature = signature;
      if (loaded && stable >= 2) return { images: fresh, complete: true };
      await sleep(1200);
    }
    return { images: latest.slice(baseline), complete: false };
  }

  async function runJob(job) {
    const timeoutMs = Math.max(15000, Number(job.timeoutMs) || 180000);
    if (job.newChat) {
      clickNewChat();
      await sleep(800);
    }
    // 上一条可能还在收尾，先等页面空闲再发
    await waitIdle(30000);
    const baseline = collectImages().length;
    const sent = await sendPrompt(String(job.prompt || ''));
    if (!sent) {
      return { ok: false, error: '提示词没有发出去（输入框没有被清空），请确认 Gemini 页面可以正常使用' };
    }
    const result = await waitForImages(baseline, timeoutMs);
    if (!result.images.length) {
      return { ok: false, error: `等了 ${Math.round(timeoutMs / 1000)} 秒没有出现新图片（可能被拒绝、额度用尽或还在排队）` };
    }
    return {
      ok: true,
      complete: result.complete,
      images: result.images.map((image) => ({ src: image.src, width: image.width, height: image.height })),
      text: (document.body ? document.body.innerText : '').slice(-400),
    };
  }

  /* ---------- 桥接 ---------- */

  let config = null;
  let activePort = 0;
  let polling = false;

  async function loadConfig() {
    if (config) return config;
    try {
      const reply = await chrome.runtime.sendMessage({ type: 'dsh-config' });
      if (reply && reply.port > 0) {
        config = reply;
        return config;
      }
    } catch {
      // 后台还没起，下次再问
    }
    return null;
  }

  /**
   * 从 basePort 起扫描 10 个端口（插件端口被占时会顺延）。
   * 不能从"上次连上的端口"往上扫：插件重启后可能回到更小的端口。
   */
  function candidatePorts() {
    const base = Number(config.basePort) || Number(config.port) || 47623;
    const ports = [Number(config.port) || base];
    for (let offset = 0; offset < 10; offset += 1) ports.push(base + offset);
    return Array.from(new Set(ports));
  }

  async function discoverPort() {
    for (const port of candidatePorts()) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/hello?t=${encodeURIComponent(config.token)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ version: config.version || '0.0.0' }),
          cache: 'no-store',
        });
        if (response.ok) return port;
      } catch {
        // 这个端口没人
      }
    }
    return 0;
  }

  async function fetchImageBytes(url) {
    const response = await fetch(url, { credentials: 'include' });
    if (!response.ok) throw new Error(`图片下载失败 HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    let binary = '';
    const chunk = 0x8000;
    for (let index = 0; index < bytes.length; index += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(index, index + chunk));
    }
    return { mime: response.headers.get('content-type') || 'image/png', base64: btoa(binary) };
  }

  async function deliver(job, result) {
    const images = [];
    for (const image of result.images || []) {
      try {
        const bytes = await fetchImageBytes(image.src);
        images.push({ ...image, ...bytes });
      } catch (error) {
        images.push({ ...image, error: error && error.message ? error.message : String(error) });
      }
    }
    await fetch(`http://127.0.0.1:${activePort}/result?t=${encodeURIComponent(config.token)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: job.id,
        ok: Boolean(result.ok),
        error: result.error || '',
        complete: result.complete !== false,
        text: result.text || '',
        images,
      }),
    });
  }

  async function pollLoop() {
    if (polling) return;
    polling = true;
    try {
      while (polling) {
        if (!(await loadConfig())) {
          await sleep(4000);
          continue;
        }
        if (!activePort) {
          activePort = await discoverPort();
          if (!activePort) {
            await sleep(5000);
            continue;
          }
        }
        try {
          const response = await fetch(
            `http://127.0.0.1:${activePort}/next?wait=20000&t=${encodeURIComponent(config.token)}`,
            { cache: 'no-store' },
          );
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const data = await response.json();
          if (!data || !data.job) continue;
          const result = await runJob(data.job);
          await deliver(data.job, result);
        } catch {
          activePort = 0;
          await sleep(3000);
        }
      }
    } finally {
      polling = false;
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message && message.type === 'dsh-ping') {
      sendResponse({ ok: true, connected: Boolean(activePort), url: location.href });
      return false;
    }
    return false;
  });

  pollLoop();
})();
