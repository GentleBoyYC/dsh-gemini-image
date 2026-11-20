/**
 * 开发脚本共用的小工具：把截图/测试产物放到系统临时目录，
 * 不写死任何本机绝对路径（这些脚本不随插件发布）。
 */
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const scriptDir = path.dirname(fileURLToPath(import.meta.url));

/** 截图/调试产物的落盘路径，例如 shotPath('attach-shot.png')。 */
export function shotPath(name) {
  return path.join(os.tmpdir(), `dsh-gemini-${name}`);
}

/** 测试用的输出目录。 */
export function tempDir(name) {
  return path.join(os.tmpdir(), `dsh-gemini-${name}`);
}
