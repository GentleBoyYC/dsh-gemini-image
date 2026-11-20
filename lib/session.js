/**
 * 从用户日常使用的 Chrome / Edge 里"借"登录态。
 *
 * 为什么不直接在受控窗口里登录：Google 会拒绝在附带远程调试端口的浏览器里
 * 登录（signin/rejected → “此浏览器或应用可能不安全”）。所以更省事的做法是
 * 把已经登录好的 cookie 复制到插件专用用户目录里——同一台机器、同一个 Windows
 * 用户、同一个 chrome.exe，DPAPI 能正常解密。
 */

import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';

/** 找出用户日常使用的浏览器用户目录（含 Local State 的那个）。 */
export function findSourceUserDataDir(explicit) {
  if (explicit) {
    if (existsSync(explicit)) return explicit;
    throw new Error(`指定的用户目录不存在：${explicit}`);
  }
  const localAppData = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local');
  const candidates =
    process.platform === 'win32'
      ? [
          path.join(localAppData, 'Google', 'Chrome', 'User Data'),
          path.join(localAppData, 'Google', 'Chrome Beta', 'User Data'),
          path.join(localAppData, 'Microsoft', 'Edge', 'User Data'),
        ]
      : [
          path.join(process.env.HOME || '', 'Library', 'Application Support', 'Google', 'Chrome'),
          path.join(process.env.HOME || '', 'Library', 'Application Support', 'Microsoft Edge'),
          path.join(process.env.HOME || '', '.config', 'google-chrome'),
          path.join(process.env.HOME || '', '.config', 'chromium'),
          path.join(process.env.HOME || '', '.config', 'microsoft-edge'),
        ];
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, 'Local State'))) return candidate;
  }
  return undefined;
}

const COOKIE_CANDIDATES = ['Network/Cookies', 'Cookies'];

function copyIfExists(source, target) {
  if (!existsSync(source)) return false;
  mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(source, target);
  return true;
}

/**
 * 把源用户目录里的加密密钥（Local State）与 cookie 库复制到插件目录。
 * 只复制这几样：动作最小、不碰历史记录和密码库。
 */
export function importCookies(sourceUserDataDir, targetUserDataDir, options = {}) {
  const copied = [];
  const skipped = [];
  const profileName = options.profileName || 'Default';

  const localStateSource = path.join(sourceUserDataDir, 'Local State');
  if (existsSync(localStateSource)) {
    const target = path.join(targetUserDataDir, 'Local State');
    mkdirSync(targetUserDataDir, { recursive: true });
    copyFileSync(localStateSource, target);
    copied.push('Local State');
  } else {
    skipped.push('Local State（找不到，cookie 可能无法解密）');
  }

  for (const relative of COOKIE_CANDIDATES) {
    const source = path.join(sourceUserDataDir, profileName, relative);
    const target = path.join(targetUserDataDir, profileName, relative);
    let found = false;
    if (copyIfExists(source, target)) {
      copied.push(`${profileName}/${relative}`);
      found = true;
    }
    // SQLite 的 WAL/SHM：一起带上，最近的写入才不会丢
    for (const suffix of ['-wal', '-shm']) {
      if (copyIfExists(`${source}${suffix}`, `${target}${suffix}`)) {
        copied.push(`${profileName}/${relative}${suffix}`);
        found = true;
      }
    }
    if (found) break;
  }

  if (!copied.some((item) => item.includes('Cookies'))) {
    skipped.push(`${profileName} 里没有找到 Cookies 数据库`);
  }

  const size = existsSync(path.join(targetUserDataDir, profileName, 'Network', 'Cookies'))
    ? statSync(path.join(targetUserDataDir, profileName, 'Network', 'Cookies')).size
    : 0;

  return { copied, skipped, cookieBytes: size };
}
