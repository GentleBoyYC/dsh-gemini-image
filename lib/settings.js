/**
 * 插件自己记住"上次用的浏览器/用户目录"。
 *
 * 这些不是用户要在 cordis.patch.yml 里手改的配置项，而是运行时事实：
 * 比如第一次用 Edge 导入登录态后，后面所有调用都应该继续用 Edge + 那个目录，
 * 不该让用户每次都重复传参。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { dshHome } from './browser.js';

const PERSISTED_KEYS = ['browserPath', 'profileDir', 'proxyServer', 'surface'];

function runtimeFile() {
  return path.join(dshHome(), 'gemini-image', 'runtime.json');
}

export function loadRuntimeSettings() {
  const file = runtimeFile();
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return {};
    const picked = {};
    for (const key of PERSISTED_KEYS) {
      if (typeof parsed[key] === 'string' && parsed[key]) picked[key] = parsed[key];
    }
    return picked;
  } catch {
    return {};
  }
}

export function saveRuntimeSettings(patch) {
  const file = runtimeFile();
  const current = loadRuntimeSettings();
  const next = { ...current };
  for (const key of PERSISTED_KEYS) {
    if (typeof patch[key] === 'string' && patch[key]) next[key] = patch[key];
  }
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    return next;
  } catch {
    return current;
  }
}
