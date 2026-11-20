/**
 * 调试：CDP 的键盘事件到底有没有送进页面。
 * node scripts/keys.debug.mjs <browser-cdp-port>
 */
import http from 'node:http';
import { ChromiumBrowser } from '../lib/browser.js';
import { GeminiPage } from '../lib/page.js';

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>keys</title></head>
<body>
<div id="editor" contenteditable="true" role="textbox" style="min-height:40px;border:1px solid #999"></div>
<script>
  window.__events = [];
  document.addEventListener('keydown', (e) => window.__events.push({ type: 'keydown', key: e.key, code: e.code, target: e.target.id || e.target.tagName }), true);
  document.addEventListener('beforeinput', (e) => window.__events.push({ type: 'beforeinput', inputType: e.inputType, data: e.data }), true);
</script>
</body></html>`;

const server = http.createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(PAGE);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

const browser = new ChromiumBrowser({ cdpPort: Number(process.argv[2]) });
await browser.ensure();
const page = await GeminiPage.open(browser);
try {
  await page.navigate(`http://127.0.0.1:${port}/keys`);
  const point = await page.session.evaluate(`
    (() => {
      const el = document.querySelector('#editor');
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()
  `);
  console.log('[point]', point);
  await page.click(point);
  console.log('[activeElement]', await page.session.evaluate('document.activeElement && (document.activeElement.id || document.activeElement.tagName)'));

  await page.session.send('Input.insertText', { text: 'hello' });
  console.log('[after insertText]', JSON.stringify(await page.session.evaluate('document.querySelector("#editor").innerText')), 'events:', JSON.stringify(await page.session.evaluate('window.__events')));

  await page.pressEnter();
  await new Promise((r) => setTimeout(r, 400));
  console.log('[after enter] events:', JSON.stringify(await page.session.evaluate('window.__events')));
  console.log('[activeElement]', await page.session.evaluate('document.activeElement && (document.activeElement.id || document.activeElement.tagName)'));
} finally {
  await page.dispose();
  server.close();
}
