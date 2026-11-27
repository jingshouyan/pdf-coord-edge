/* eslint-env browser */
const KEY = '接管开关';
const box = document.getElementById('takeover');
const VIEWER = chrome.runtime.getURL('viewer.html');

chrome.storage.local.get({ [KEY]: true }, (d) => { box.checked = !!d[KEY]; });

box.addEventListener('change', () => {
  chrome.storage.local.set({ [KEY]: box.checked });
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
