/**
 * 后台：接管在 Edge 中直接打开的 PDF，改由扩展内的坐标查看器渲染。
 * Edge 内置 PDF 阅读器是内核页面，扩展无法注入脚本，因此必须"换渲染器"。
 * MV3 下使用 tabs.onUpdated + tabs.update 做重定向（webRequest 阻断能力已不可用）。
 */

const VIEWER_BASE = chrome.runtime.getURL('viewer.html');
const KEY_ENABLED = '接管开关';

function viewerFor(url) {
  return VIEWER_BASE + '?file=' + encodeURIComponent(url);
}

/** 是否是一个"应该被接管"的 PDF 地址 */
function isPdfTarget(url) {
  if (!url || typeof url !== 'string') return false;
  if (url.startsWith(VIEWER_BASE)) return false;
  if (url.startsWith('chrome-extension://') || url.startsWith('edge-extension://')) return false;
  if (url.startsWith('blob:') || url.startsWith('data:') || url.startsWith('view-source:')) return false;
  let path;
  try {
    const u = new URL(url);
    if (u.protocol !== 'file:' && u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    path = decodeURIComponent(u.pathname).toLowerCase();
  } catch (e) {
    return false;
  }
  if (!path.endsWith('.pdf')) return false;
  // 排除扩展自身资源
  return !path.includes('/pdf-coord-edge/');
}

async function isEnabled() {
  const data = await chrome.storage.local.get({ [KEY_ENABLED]: true });
  return data[KEY_ENABLED];
}

/** 标签页导航拦截 */
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  const url = changeInfo.url;
  if (!url) return;
  if (!isPdfTarget(url)) return;
  if (!(await isEnabled())) return;
  try {
    await chrome.tabs.update(tabId, { url: viewerFor(url) });
  } catch (e) {
    /* 某些页面（如浏览器内部页）不允许改写，忽略即可 */
  }
});

/** 右键菜单：手动用坐标查看器打开 */
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'open-in-coord-viewer',
      title: '用 PDF 坐标查看器打开',
      contexts: ['link', 'image', 'page']
    });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const target = isPdfTarget(info.linkUrl) ? info.linkUrl
    : isPdfTarget(info.srcUrl) ? info.srcUrl
    : isPdfTarget(info.pageUrl) ? info.pageUrl
    : tab && isPdfTarget(tab.url) ? tab.url : null;

  if (!target) {
    chrome.tabs.create({ url: VIEWER_BASE });
    return;
  }
  const url = viewerFor(target);
  if (tab && tab.id != null && isPdfTarget(tab.url || '')) await chrome.tabs.update(tab.id, { url });
  else await chrome.tabs.create({ url });
});
