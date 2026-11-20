/**
 * 端到端测试：在**独立标签页**里加载本地"假 Gemini 页面"，验证
 * 写提示词 → 触发发送 → 等图片出现 → 取回原始字节 的完整链路。
 * 不会碰真实 Gemini 的标签页。
 *
 * node scripts/fake-gemini.test.mjs <browser-cdp-port>
 */
import http from 'node:http';
import zlib from 'node:zlib';
import { writeFileSync } from 'node:fs';

import { ChromiumBrowser } from '../lib/browser.js';
import { GeminiPage } from '../lib/page.js';
import { shotPath } from './_paths.mjs';

/* ---------- 生成一张真实的 PNG ---------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function makePng(width, height) {
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 3 + 1);
    raw[rowStart] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = rowStart + 1 + x * 3;
      raw[offset] = (x * 255) / width;
      raw[offset + 1] = (y * 255) / height;
      raw[offset + 2] = 200;
    }
  }
  return Buffer.concat([header, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const PNG = makePng(800, 600);

/* ---------- 假页面 ---------- */

const PAGE = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>Fake Gemini</title>
<style>
  body { font-family: system-ui; margin: 0; padding: 24px; background: #f6f7fb; }
  #editor { min-height: 48px; padding: 12px; border: 1px solid #ccc; border-radius: 12px; background: #fff; }
  model-response { display: block; margin-top: 24px; }
  img { max-width: 480px; border-radius: 12px; }
</style></head>
<body>
  <h1>Fake Gemini（测试用）</h1>
  <div id="log">未发送</div>
  <div id="editor" contenteditable="true" role="textbox"></div>
  <div id="answers"></div>
<script>
  const editor = document.getElementById('editor');
  window.__sent = [];
  window.__events = [];
  document.addEventListener('keydown', (event) => {
    window.__events.push({ key: event.key, code: event.code, target: event.target && event.target.id });
  }, true);
  editor.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const value = editor.innerText.trim();
    if (!value) return;
    window.__sent.push(value);
    editor.innerText = '';
    document.getElementById('log').textContent = '已发送: ' + value;
    setTimeout(() => {
      const answer = document.createElement('model-response');
      const img = document.createElement('img');
      img.src = '/img/generated.png';
      img.width = 800;
      img.height = 600;
      img.alt = 'generated image';
      answer.appendChild(img);
      answer.appendChild(document.createTextNode('这是假图片，用于测试。'));
      document.getElementById('answers').appendChild(answer);
    }, 1200);
  });
</script>
</body></html>`;

const server = http.createServer((request, response) => {
  if (request.url === '/img/generated.png') {
    response.writeHead(200, { 'content-type': 'image/png', 'content-length': PNG.length, 'access-control-allow-origin': '*' });
    response.end(PNG);
    return;
  }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(PAGE);
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const cdpPort = Number(process.argv[2] || 0);
if (!cdpPort) {
  server.close();
  throw new Error('用法: node scripts/fake-gemini.test.mjs <browser-cdp-port>');
}

const browser = new ChromiumBrowser({ cdpPort });
await browser.ensure();
// 单独开一个标签页，别动用户正在登录的 Gemini
const target = await browser.openTarget(`http://127.0.0.1:${port}/fake`);
const page = await GeminiPage.connect(browser, target.webSocketDebuggerUrl);

try {
  const before = await page.probe();
  console.log('[before]', JSON.stringify({ hasEditor: before.hasEditor, images: before.images.length, url: before.url }));

  const started = Date.now();
  await page.sendPrompt('画一只戴宇航服的橘猫');
  console.log('[send] editor text after send =', JSON.stringify(await page.readEditorText()));
  console.log('[send] page events =', JSON.stringify(await page.session.evaluate('window.__events')));
  console.log('[send] page sent =', JSON.stringify(await page.session.evaluate('window.__sent')));

  const result = await page.waitForImages({ baseline: before.images.length, timeoutMs: 20000 });
  console.log('[wait]', JSON.stringify({ images: result.images.length, complete: result.complete, ms: Date.now() - started }));

  if (!result.images.length) throw new Error('没有等到图片');

  const grabbed = await page.grab(result.images[0].src);
  const signature = grabbed.buffer.subarray(0, 8).toString('hex');
  console.log('[grab]', JSON.stringify({ bytes: grabbed.buffer.length, mime: grabbed.mime, method: grabbed.method, png: signature === '89504e470d0a1a0a' }));
  writeFileSync(shotPath('fake-out.png'), grabbed.buffer);
} finally {
  await page.dispose();
  await browser.closeTarget(target.id);
  server.close();
}
