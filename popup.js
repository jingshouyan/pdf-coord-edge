/* eslint-env browser */
const KEY = '接管开关';
const box = document.getElementById('takeover');
const VIEWER = chrome.runtime.getURL('viewer.html');

chrome.storage.local.get({ [KEY]: true }, (d) => { box.checked = !!d[KEY]; });

box.addEventListener('change', () => {
  chrome.storage.local.set({ [KEY]: box.checked });
});

/*
 * 「允许访问文件 URL」状态查询，仅供参考。
 * 官方文档警告 chrome.extension.isAllowedFileSchemeAccess 的结果
 * "may not always accurately reflect the user's actual preference"，
 * 因此这里不作为判定依据 —— 是否能打开本地 PDF 以实际读取结果为准，
 * 查看器在读不到时会给出可操作的引导。
 */
function loadFileAccessState() {
  const el = document.getElementById('fileAccess');
  const show = (text, ok) => {
    el.textContent = text;
    el.style.color = ok === null ? '#9aa2b1' : (ok ? '#7ee2ab' : '#ff8a8a');
  };
  try {
    if (!chrome.extension || typeof chrome.extension.isAllowedFileSchemeAccess !== 'function') {
      show('无法检测，以能否打开为准', null); return;
    }
    const paint = (allowed) => show((allowed ? '已开启' : '未开启') + '（仅供参考）', !!allowed);
    const r = chrome.extension.isAllowedFileSchemeAccess((a) => paint(!!a));
    if (r && typeof r.then === 'function') {
      r.then(paint).catch(() => show('无法检测，以能否打开为准', null));
    }
    setTimeout(() => { if (el.textContent === '检测中…') show('无法检测，以能否打开为准', null); }, 1200);
  } catch (e) {
    show('无法检测，以能否打开为准', null);
  }
}
loadFileAccessState();

// 直达本扩展的详情开关页。部分浏览器禁止扩展打开 edge:// 页面，
// 因此失败时降级为复制地址，并给出可见提示，不静默无效。
document.getElementById('openFilePage').addEventListener('click', async () => {
  const el = document.getElementById('openFilePage');
  const url = 'edge://extensions/?id=' + encodeURIComponent(chrome.runtime.id);
  try {
    await chrome.tabs.create({ url });
    el.textContent = '已打开扩展管理页，请点该扩展的「详情」';
  } catch (e) {
    let copied = false;
    try { await navigator.clipboard.writeText(url); copied = true; } catch (e2) { copied = false; }
    el.textContent = copied
      ? '无法直接打开，地址已复制，请到地址栏粘贴回车'
      : '请手动在地址栏输入：' + url;
  }
  setTimeout(() => { el.textContent = '打开扩展详情页去开启'; }, 3200);
});

document.getElementById('open').addEventListener('click', () => {
  chrome.tabs.create({ url: VIEWER });
});

document.getElementById('openCurrent').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab && tab.url ? tab.url : '';
  if (/\.pdf($|[?#])/i.test(decodeURIComponent(url))) {
    chrome.tabs.update(tab.id, { url: VIEWER + '?file=' + encodeURIComponent(url) });
  } else {
    chrome.tabs.create({ url: VIEWER });
  }
});
