/**
 * 让受控浏览器打开真实 Gemini，打印页面状态并截图。
 * node scripts/gemini-live.mjs <browser-cdp-port>
 */
import { writeFileSync } from 'node:fs';
import { ChromiumBrowser, GEMINI_URL } from '../lib/browser.js';
import { GeminiPage } from '../lib/page.js';
import { shotPath } from './_paths.mjs';

const browser = new ChromiumBrowser({ cdpPort: Number(process.argv[2]) });
await browser.ensure();
const page = await GeminiPage.open(browser);
try {
  const started = Date.now();
  await page.navigate(GEMINI_URL);
  console.log('[navigate]', Date.now() - started, 'ms');
  const state = await page.waitForReady({ timeoutMs: 30000 });
  console.log('[probe]', JSON.stringify({
    url: state?.url,
    title: state?.title,
    ready: state?.ready,
    hasEditor: state?.hasEditor,
    signIn: state?.signIn,
    images: state?.images?.length ?? 0,
  }, null, 2));
  const body = await page.session.evaluate('(document.body && document.body.innerText || "").slice(0, 700)');
  console.log('[body]', JSON.stringify(body));
  const shot = await page.session.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(shotPath('live-shot.png'), Buffer.from(shot.data, 'base64'));
  console.log('[shot] scripts/live-shot.png');
} finally {
  await page.dispose();
}
