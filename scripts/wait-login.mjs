/**
 * 等待人工登录完成：轮询受控浏览器里的 Gemini 登录状态。
 * node scripts/wait-login.mjs <browser-cdp-port> [timeoutSeconds]
 */
import { ChromiumBrowser } from '../lib/browser.js';
import { GeminiPage } from '../lib/page.js';
import { shotPath } from './_paths.mjs';

const port = Number(process.argv[2]);
const timeoutMs = Number(process.argv[3] || 240) * 1000;
const browser = new ChromiumBrowser({ cdpPort: port });
await browser.ensure();
const page = await GeminiPage.open(browser);
const started = Date.now();
let last = '';
try {
  for (;;) {
    const state = await page.probe();
    const line = JSON.stringify({
      url: state?.url,
      loggedIn: state?.loggedIn,
      signIn: state?.signIn,
      images: state?.images?.length ?? 0,
      textLength: state?.textLength,
    });
    if (line !== last) {
      console.log(`[${Math.round((Date.now() - started) / 1000)}s]`, line);
      last = line;
    }
    if (state?.loggedIn) {
      console.log('[done] logged in');
      break;
    }
    if (Date.now() - started > timeoutMs) {
      console.log('[timeout] still not logged in');
      process.exitCode = 2;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  const shot = await page.session.send('Page.captureScreenshot', { format: 'png' });
  const { writeFileSync } = await import('node:fs');
  writeFileSync(shotPath('login-state.png'), Buffer.from(shot.data, 'base64'));
} finally {
  await page.dispose();
}
