/**
 * 冒烟测试（不属于插件包）：
 * 1) 用临时用户目录启动 Chrome，验证 CDP 通道；
 * 2) 打开 gemini.google.com，探测登录状态与页面结构；
 * 3) 截一张图确认窗口里真的是 Gemini。
 */
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChromiumBrowser } from '../lib/browser.js';
import { GeminiPage } from '../lib/page.js';

const profile = path.join(os.tmpdir(), 'dsh-gemini-smoke-profile');
mkdirSync(profile, { recursive: true });

const browser = new ChromiumBrowser({ userDataDir: profile, surface: 'web' });
const started = Date.now();
await browser.ensure({ url: 'https://gemini.google.com/app', timeoutMs: 45000 });
console.log('[browser]', JSON.stringify(browser.describe()), `in ${Date.now() - started}ms`);

const page = await GeminiPage.open(browser);
const state = await page.waitForReady({ timeoutMs: 30000 });
console.log('[page]', JSON.stringify({
  url: state?.url,
  title: state?.title,
  ready: state?.ready,
  hasEditor: state?.hasEditor,
  signIn: state?.signIn,
  images: state?.images?.length ?? 0,
  busy: state?.busy,
}, null, 2));

const shot = await page.session.send('Page.captureScreenshot', { format: 'png' });
const out = path.join(process.env.TEMP || os.tmpdir(), 'gemini-smoke.png');
const { writeFileSync } = await import('node:fs');
writeFileSync(out, Buffer.from(shot.data, 'base64'));
console.log('[shot]', out);

await page.dispose();
browser.stop();
console.log('[done]');
