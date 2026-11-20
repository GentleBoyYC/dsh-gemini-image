/**
 * 批量出图的清单（manifest）与入参规范化。
 *
 * manifest 每完成一条就落盘一次：Gemini 有额度限制，批量常常跑到一半开始失败，
 * 有了这份文件就能"断点续跑"，而不是从头再来。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

export const MAX_PROMPTS = 30;
export const MAX_ROUNDS = 4;
export const MANIFEST_NAME = 'manifest.json';

export function pad(index, width = 2) {
  return String(index).padStart(width, '0');
}

/** 把输入里的 prompts 规范成 [{ prompt, filename }]，兼容只给一个 prompt。 */
export function normalizePrompts(input) {
  const raw = Array.isArray(input && input.prompts)
    ? input.prompts
    : input && typeof input.prompt === 'string' && input.prompt.trim()
      ? [input.prompt]
      : [];
  const items = [];
  for (const entry of raw) {
    if (items.length >= MAX_PROMPTS) break;
    if (typeof entry === 'string') {
      const prompt = entry.trim();
      if (prompt) items.push({ prompt, filename: '' });
      continue;
    }
    if (entry && typeof entry === 'object' && typeof entry.prompt === 'string') {
      const prompt = entry.prompt.trim();
      if (!prompt) continue;
      items.push({
        prompt,
        filename: typeof entry.filename === 'string' ? entry.filename.trim() : '',
      });
    }
  }
  return items;
}

export function readManifest(file) {
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (!parsed || !Array.isArray(parsed.items)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeManifest(file, data) {
  const payload = {
    version: 1,
    createdAt: data.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    outDir: data.outDir || '',
    rounds: data.rounds || 1,
    items: (data.items || []).map((item) => ({
      index: item.index,
      prompt: item.prompt,
      status: item.status,
      files: item.files || [],
      error: item.error || undefined,
      ms: item.ms || 0,
    })),
  };
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return payload;
}

/** 续跑时判断某条是否已经完成（以文件仍然存在为准）。 */
export function alreadyDone(previous, index, exists) {
  if (!previous || !Array.isArray(previous.items)) return null;
  const item = previous.items.find((entry) => entry.index === index);
  if (!item || item.status !== 'ok') return null;
  const files = item.files || [];
  if (files.length === 0) return null;
  return files.every((file) => exists(file)) ? item : null;
}
