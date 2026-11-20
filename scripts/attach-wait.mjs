/**
 * 附着后等待页面稳定，打印状态并截图。
 * node scripts/attach-wait.mjs <browser-cdp-port> [waitMs]
 */
import { writeFileSync } from 'node:fs';
import { ChromiumBrowser } from '../lib/browser.js';
import { GeminiPage } from '../lib/page.js';
import { shotPath } from './_paths.mjs';

const port = Number(process.argv[2]);
const waitMs = Number(process.argv[3] || 12000);
const browser = new ChromiumBrowser({ cdpPort: port });
await browser.ensure();
const page = await GeminiPage.open(browser);
try {
  for (const delay of [0, waitMs]) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    const state = await page.probe();
    console.log(`[+${delay}ms]`, JSON.stringify({
      url: state?.url,
      title: state?.title,
      ready: state?.ready,
      hasEditor: state?.hasEditor,
      signIn: state?.signIn,
      images: state?.images?.length ?? 0,
      textLength: state?.textLength,
      editorText: (state?.editorText || '').slice(0, 40),
    }));
  }
  const body = await page.session.evaluate('(document.body && document.body.innerText || "").slice(0, 800)');
  console.log('[body]', JSON.stringify(body));
  const html = await page.session.evaluate('document.documentElement.outerHTML.length');
  console.log('[html length]', html);
  const shot = await page.session.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(shotPath('attach-wait.png'), Buffer.from(shot.data, 'base64'));
  console.log('[shot] scripts/attach-wait.png');
} finally {
  await page.dispose();
}
