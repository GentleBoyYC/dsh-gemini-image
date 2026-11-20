/**
 * 批量出图的离线测试：用假扩展回传 PNG，验证
 * 逐条执行 / 失败继续 / manifest 落盘 / resume 跳过。
 * 不触碰真实插件实例（用独立端口 47690）。
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { apply } from '../index.js';

const PORT = 47690;
const OUT = path.join(os.tmpdir(), 'dsh-gemini-batch-test');

/* ---------- 一张真实 PNG ---------- */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();
const crc32 = (buffer) => {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
};
const chunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
};
function makePng(width, height) {
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const o = row + 1 + x * 3;
      raw[o] = 30 + (x * 200) / width;
      raw[o + 1] = 90 + (y * 120) / height;
      raw[o + 2] = 230;
    }
  }
  return Buffer.concat([header, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const PNG = makePng(320, 240);

/* ---------- 假扩展 ---------- */
const TOKEN = readFileSync(
  path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'gemini-image', 'bridge-token.txt'),
  'utf8',
).trim();

let jobCount = 0;
async function helloWithRetry() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/hello?t=${TOKEN}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ version: 'fake-batch' }),
      });
      if (response.ok) return true;
    } catch {
      // 插件还没起服务，等等再来
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function runFakeExtension() {
  await helloWithRetry();
  for (;;) {
    let job = null;
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/next?wait=5000&t=${TOKEN}`);
      job = (await response.json()).job;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
      continue;
    }
    if (!job) continue;
    jobCount += 1;
    const fail = String(job.prompt || '').includes('FAIL');
    await new Promise((resolve) => setTimeout(resolve, 120));
    await fetch(`http://127.0.0.1:${PORT}/result?t=${TOKEN}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        fail
          ? { id: job.id, ok: false, error: '模拟失败：额度用尽' }
          : {
              id: job.id,
              ok: true,
              complete: true,
              images: [{ src: 'https://example.invalid/x.png', width: 320, height: 240, mime: 'image/png', base64: PNG.toString('base64') }],
            },
      ),
    });
  }
}

/* ---------- 插件 ---------- */
let definition;
const ctx = {
  get(key) {
    if (key === 'tools') {
      return {
        register(def) {
          definition = def;
          return () => {};
        },
      };
    }
    return undefined;
  },
  effect(fn) {
    const dispose = fn();
    return dispose;
  },
  logger: { warn: console.warn },
};

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
apply(ctx, { bridgePort: PORT, surface: 'bridge' });

const signal = new AbortController().signal;
// 先起桥接服务（ensure 只在 bridge 动作里发生）
const boot = await definition.execute({ action: 'status' }, { signal });
console.log('[boot]', boot.port, boot.connected);

runFakeExtension().catch((error) => console.error('[fake]', error.message));
await new Promise((resolve) => setTimeout(resolve, 800));

const result = await definition.execute(
  { action: 'batch', prompts: ['第一张：雪山', 'FAIL 这一条应该失败', '第三张：孤舟'], outDir: OUT, filename: 'batch' },
  { signal },
);

console.log('[batch]', JSON.stringify({
  ok: result.ok,
  message: result.message,
  manifest: result.manifestPath,
  items: (result.batch.items || []).map((item) => ({ index: item.index, status: item.status, files: item.files.length })),
}, null, 2));

const manifest = JSON.parse(readFileSync(path.join(OUT, 'manifest.json'), 'utf8'));
console.log('[manifest] items =', manifest.items.map((item) => `${item.index}:${item.status}`).join(', '));
console.log('[files]', (result.images || []).map((image) => path.basename(image.path)).join(', '));

// 续跑：三个条目里只有 FAIL 那条会重跑（其余两条 skipped）
const again = await definition.execute(
  { action: 'batch', prompts: ['第一张：雪山', 'FAIL 这一条应该失败', '第三张：孤舟'], outDir: OUT, filename: 'batch', resume: true, continueOnError: true },
  { signal },
);
console.log('[resume]', JSON.stringify({
  ok: again.ok,
  items: (again.batch.items || []).map((item) => `${item.index}:${item.status}`),
  jobs: jobCount,
}));

console.log('[render]', JSON.stringify(definition.output.render({}, result)));
console.log('[done]');
process.exit(0);
