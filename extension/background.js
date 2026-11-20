/* global chrome */
importScripts('./config.js');

/**
 * 后台只做两件事：告诉内容脚本桥接端口/令牌；点图标时把 Gemini 标签页打开并聚焦。
 *
 * 为什么不在后台轮询：MV3 的 service worker 会被浏览器随时挂起，
 * 长轮询放在这里会表现为"扩展掉线"。轮询现在由 contentscript 负责，
 * 它跟着标签页活着，稳定得多。
 */
const bridge = (self.DSH_BRIDGE && self.DSH_BRIDGE.port)
  ? self.DSH_BRIDGE
  : { port: 47623, token: '', version: '0.0.0' };

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message && message.type === 'dsh-config') {
    sendResponse({ port: bridge.port, basePort: bridge.basePort || bridge.port, token: bridge.token, version: bridge.version });
    return false;
  }
  return false;
});

chrome.action.onClicked.addListener(async () => {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://gemini.google.com/*' });
    if (tabs.length > 0) {
      await chrome.tabs.update(tabs[0].id, { active: true });
      return;
    }
    await chrome.tabs.create({ url: 'https://gemini.google.com/app', active: true });
  } catch {
    // 打不开就算了
  }
});
