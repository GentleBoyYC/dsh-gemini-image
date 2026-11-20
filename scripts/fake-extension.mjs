/**
 * 冒充浏览器扩展，验证桥接协议：领取任务 → 回传一张真实 PNG。
 * node scripts/fake-extension.mjs [port]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const port = Number(process.argv[2]) || 47623;
const tokenFile = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'gemini-image', 'bridge-token.txt');
const token = readFileSync(tokenFile, 'utf8').trim();
const base = `http://127.0.0.1:${port}`;

/* 生成一张真实 PNG */
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
      raw[o] = 40 + (x * 180) / width;
      raw[o + 1] = 120 + (y * 100) / height;
      raw[o + 2] = 240;
    }
  }
  return Buffer.concat([header, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const PNG = makePng(640, 480);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function hello() {
  const response = await fetch(`${base}/hello?t=${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ version: 'fake-extension-0.1' }),
  });
  console.log('[hello]', response.status);
}

await hello();
console.log('[fake-extension] polling', base);

for (;;) {
  let job = null;
  try {
    const response = await fetch(`${base}/next?wait=20000&t=${token}`);
    const data = await response.json();
    job = data.job;
  } catch (error) {
    console.log('[poll error]', error.message);
    await sleep(2000);
    continue;
  }
  if (!job) continue;
  console.log('[job]', JSON.stringify({ id: job.id, prompt: job.prompt, newChat: job.newChat }));
  await sleep(1500);
  const payload = {
    id: job.id,
    ok: true,
    complete: true,
    text: '这是假扩展生成的测试图片。',
    images: [{ src: 'https://example.invalid/fake.png', width: 640, height: 480, mime: 'image/png', base64: PNG.toString('base64') }],
  };
  const response = await fetch(`${base}/result?t=${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  console.log('[result]', response.status, 'png bytes', PNG.length);
  writeFileSync(path.join(process.env.TEMP || os.tmpdir(), 'fake-extension-sent.png'), PNG);
}
