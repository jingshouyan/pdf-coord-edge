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

/*
 * 本地文件权限（「允许访问文件 URL」）不做预检：
 * 官方文档警告 chrome.extension.isAllowedFileSchemeAccess 的结果
 * "may not always accurately reflect the user's actual preference"，
 * 并建议不要用该 API 判断扩展能否访问本地文件。
 * 因此接管照常进行，以"实际能否读到"为唯一判定：
 * 查看器读取失败时会显示引导横幅，给出免权限的打开方式与开启步骤。
 */

/* 用户主动要求"用 Edge 内置阅读器打开"的本地文件，短时间跳过接管。
 * 必须消费掉，否则跳回 file:// 会再次被本扩展接管，形成来回跳转。 */
const BYPASS_PREFIX = 'bypass:';
const BYPASS_TTL = 30000;

async function bypassOnce(url) {
  await chrome.storage.session.set({ [BYPASS_PREFIX + url]: Date.now() });
}

async function consumeBypass(url) {
  const key = BYPASS_PREFIX + url;
  const data = await chrome.storage.session.get(key);
  const ts = data[key];
  if (!ts) return false;
  if (Date.now() - ts >= BYPASS_TTL) { await chrome.storage.session.remove(key); return false; }
  // 不立即删除：一次导航可能连续触发多次 onUpdated，
  // 取出即删会让后续那次重新接管，形成 viewer <-> file:// 来回跳转。
  return true;
}

/** 标签页导航拦截 */
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  const url = changeInfo.url;
  if (!url) return;
  if (!isPdfTarget(url)) return;
  if (!(await isEnabled())) return;
  if (await consumeBypass(url)) return; // 用户刚选择了"用内置阅读器打开"
  try {
    await chrome.tabs.update(tabId, { url: viewerFor(url) });
  } catch (e) {
    /* 某些页面（如浏览器内部页）不允许改写，忽略即可 */
  }
});

/** 查看器请求：放弃接管，把本地 PDF 交回 Edge 内置阅读器 */
chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (!msg || msg.type !== 'use-native-reader') { respond(false); return; }
  const url = msg.url;
  if (!url || !isPdfTarget(url)) { respond(false); return; }
  const tabId = sender && sender.tab ? sender.tab.id : (msg.tabId || null);
  bypassOnce(url).then(() => {
    if (tabId == null) { respond(false); return; }
    chrome.tabs.update(tabId, { url }).then(() => respond(true)).catch(() => respond(false));
  });
  return true; // 异步应答
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
