/**
 * 检查受控浏览器里 google.com 的 cookie 是否存在（判断导入的登录态有没有解密成功）。
 * node scripts/cookies-probe.mjs <browser-cdp-port>
 */
import { ChromiumBrowser } from '../lib/browser.js';
import { GeminiPage } from '../lib/page.js';

const browser = new ChromiumBrowser({ cdpPort: Number(process.argv[2]) });
await browser.ensure();
const page = await GeminiPage.open(browser);
try {
  const result = await page.session.send('Network.getAllCookies');
  const cookies = result.cookies || [];
  const google = cookies.filter((cookie) => String(cookie.domain || '').includes('google'));
  console.log('[cookies total]', cookies.length, ' google:', google.length);
  for (const cookie of google.slice(0, 40)) {
    console.log(' -', cookie.domain, cookie.name, 'len=' + String(cookie.value || '').length, cookie.expires > 0 ? new Date(cookie.expires * 1000).toISOString() : 'session');
  }
} finally {
  await page.dispose();
}
