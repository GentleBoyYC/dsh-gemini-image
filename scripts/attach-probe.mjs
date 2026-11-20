/**
 * 附着到已经在跑的受控浏览器（host 侧启动的那个），打印页面真实状态。
 * 用法: node scripts/attach-probe.mjs <port>
 */
import { ChromiumBrowser } from '../lib/browser.js';
import { GeminiPage } from '../lib/page.js';
import { shotPath } from './_paths.mjs';

const port = Number(process.argv[2] || 0);
if (!port) throw new Error('用法: node scripts/attach-probe.mjs <port>');

const browser = new ChromiumBrowser({ cdpPort: port });
await browser.ensure();
const page = await GeminiPage.open(browser);
const state = await page.probe();
console.log('[probe]', JSON.stringify({
  url: state?.url,
  title: state?.title,
  ready: state?.ready,
  hasEditor: state?.hasEditor,
  signIn: state?.signIn,
  busy: state?.busy,
  images: state?.images?.length ?? 0,
}, null, 2));

const body = await page.session.evaluate('(document.body && document.body.innerText || "").slice(0, 600)');
console.log('[body]', JSON.stringify(body));

const shot = await page.session.send('Page.captureScreenshot', { format: 'png' });
const { writeFileSync } = await import('node:fs');
const out = shotPath('attach-shot.png');
writeFileSync(out, Buffer.from(shot.data, 'base64'));
console.log('[shot]', out);

await page.dispose();
