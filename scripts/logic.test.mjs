/**
 * 不依赖浏览器的逻辑自测：插件入口能否正常注册工具、参数/输出是否成形。
 */
import { apply } from '../index.js';

let definition;
const disposers = [];
const ctx = {
  get(key) {
    if (key === 'tools') {
      return {
        register(def) {
          definition = def;
          return () => {
            definition = undefined;
          };
        },
      };
    }
    return undefined;
  },
  effect(fn) {
    const dispose = fn();
    if (typeof dispose === 'function') disposers.push(dispose);
    return dispose;
  },
  logger: { warn: console.warn },
};

apply(ctx, { surface: 'web' });

console.log('registered:', definition?.name);
console.log('description length:', definition?.description?.length);
console.log('params:', Object.keys(definition?.parameters?.properties || {}));

const closeResult = await definition.execute({ action: 'close' }, { signal: new AbortController().signal });
console.log('close:', JSON.stringify(closeResult));

const badAction = await definition.execute({ action: 'nope' }, { signal: new AbortController().signal });
console.log('bad action:', JSON.stringify(badAction));

const noPrompt = await definition.execute({ action: 'generate' }, { signal: new AbortController().signal });
console.log('no prompt:', JSON.stringify(noPrompt));

console.log('render(ok):', JSON.stringify(definition.output.render({}, {
  ok: true,
  action: 'generate',
  message: 'Gemini 生成了 1 张图片，已保存到 D:\\x。',
  images: [{ path: 'D:\\x\\a.png', width: 1024, height: 1024, bytes: 2048, method: 'network' }],
  complete: true,
})));

console.log('render(fail):', JSON.stringify(definition.output.render({}, { ok: false, action: 'generate', message: '未登录' })));

for (const dispose of disposers) dispose();
console.log('disposed, definition =', definition);
