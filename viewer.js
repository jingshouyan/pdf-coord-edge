/* eslint-env browser */
/**
 * PDF 坐标查看器 —— 以每页左下角为原点 (0,0)，实时显示鼠标坐标，单位 pt。
 *
 * 坐标标定（不依赖任何硬编码 DPI 假设）：
 *   page.view        -> 页面在 PDF 用户空间的宽/高，1 单位 = 1 pt
 *   getViewport(...) -> 该页在当前缩放下的 CSS 像素宽/高
 *   k = viewport.width / wPt  -> 当前显示下的 px/pt
 * 因此 pt 读数与缩放、旋转、屏幕 DPR、系统 DPI 全部无关。
 */

const PT_PER = { pt: 1, mm: 72 / 25.4, cm: 72 / 2.54, in: 72 }; // 每单位含多少 pt
const UNIT_LABEL = { pt: 'pt', mm: 'mm', cm: 'cm', in: 'in' };
const DEFAULT_TITLE = 'PDF 坐标查看器';

const state = {
  doc: null,
  fileName: null, // 原 PDF 文件名，用于标签页标题
  scale: 1.5,
  rotation: 0,
  origin: 'bottomLeft',
  unit: 'pt',
  decimals: 1,
  curPage: 1,
  mouse: null,   // {page,xPt,yPt}
  pins: []       // {page,x,y} 以当前原点表达的 pt
};

const pages = new Map(); // n -> rec
const els = {};
let activeRec = null;

/* ============================ 启动 ============================ */

document.addEventListener('DOMContentLoaded', async () => {
  ['fileInput', 'openFile', 'prev', 'next', 'pageNum', 'pageCount', 'fitWidth', 'zoomIn', 'zoomOut',
    'zoomValue', 'originSel', 'unitSel', 'decSel', 'rotSel', 'crossChk', 'rulerChk', 'resetPin',
    'pagePt', 'deltaBox', 'readout', 'banner', 'scrollArea', 'viewport', 'cursorTag']
    .forEach((id) => { els[id] = document.getElementById(id); });

  pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdf.worker.min.js');

  bindUI();
  bindPointer();
  await restorePrefs();
  renderReadout();

  const file = new URLSearchParams(location.search).get('file');
  if (file) {
    setDocTitle(urlToName(file)); // 先按文件名占位，打开成功后再校正
    await loadUrl(file);
  } else {
    hint('请点击「选择文件」打开本地 PDF；或直接访问 .pdf 链接，扩展会自动接管。');
  }
});

async function restorePrefs() {
  const p = await chrome.storage.local.get({
    scale: 1.5, rotation: 0, origin: 'bottomLeft', unit: 'pt',
    decimals: 1, cross: true, ruler: false
  });
  state.scale = p.scale; state.rotation = p.rotation; state.origin = p.origin;
  state.unit = p.unit; state.decimals = p.decimals;
  els.originSel.value = p.origin;
  els.unitSel.value = p.unit;
  els.decSel.value = String(p.decimals);
  els.rotSel.value = String(p.rotation);
  els.crossChk.checked = p.cross;
  els.rulerChk.checked = p.ruler;
  els.zoomValue.textContent = Math.round(p.scale * 100) + '%';
}

function savePref(key, val) { chrome.storage.local.set({ [key]: val }); }

/* ============================ 加载 ============================ */

async function loadUrl(url) {
  hint('正在载入：' + shorten(url));
  try {
    const doc = await pdfjsLib.getDocument({ url, isEvalSupported: false }).promise;
    await mount(doc, urlToName(url));
  } catch (e) {
    hint('无法直接读取该地址（' + safeMsg(e) + '）。请在扩展详情页开启「允许访问文件 URL」，或点「选择文件」手动打开。');
  }
}

async function mount(doc, name) {
  state.doc = doc;
  setDocTitle(name);
  state.mouse = null;
  state.pins = [];
  activeRec = null;
  els.pageCount.textContent = '/ ' + doc.numPages;
  els.pageNum.max = String(doc.numPages);
  els.viewport.innerHTML = '';
  pages.clear();

  for (let n = 1; n <= doc.numPages; n++) {
    const rec = buildPageRecord(n, await doc.getPage(n));
    pages.set(n, rec);
    els.viewport.append(rec.host);
  }

  await redrawAll();
  observePages();
  hint(null);
  gotoPage(1, true);
}

function buildPageRecord(n, page) {
  const host = document.createElement('div');
  host.className = 'page-host';
  host.dataset.page = String(n);

  const canvas = document.createElement('canvas');
  canvas.className = 'page-canvas';
  const ruler = document.createElement('canvas');
  ruler.className = 'ruler';

  const gh = document.createElement('div'); gh.className = 'guide guide-h';
  const gv = document.createElement('div'); gv.className = 'guide guide-v';

  const originDot = document.createElement('div');
  originDot.className = 'origin-mark';
  originDot.innerHTML = '<span class="axis-x"></span><span class="axis-y"></span><b>0,0</b>';

  const label = document.createElement('div');
  label.className = 'page-label';
  label.textContent = '第 ' + n + ' 页';

  host.append(label, canvas, ruler, gh, gv, originDot);

  return {
    n, page, host, canvas, ruler, originDot, label, gh, gv,
    ctx: canvas.getContext('2d', { alpha: false }),
    rctx: ruler.getContext('2d'),
    k: 1, baseK: 1, wPt: 0, hPt: 0, viewport: null
  };
}

/* ============================ 渲染 ============================ */

/**
 * 分两步，保证滚轮连打时既跟手又不并发写同一 canvas：
 *   relayout() 同步更新所有几何尺寸与坐标标定（立刻可测、布局正确）
 *   repaint()  异步重画位图与刻度尺，连续请求会被合并成最后一次
 */
let rendering = false;
let repaintQueued = false;

async function redrawAll() {
  relayout();
  await repaint();
}

/** 纯几何：算出每页 pt 尺寸与 px/pt 标定，并同步布局（不做像素渲染） */
function relayout() {
  const rot = ((state.rotation % 360) + 360) % 360;
  const swap = rot === 90 || rot === 270;

  for (const rec of pages.values()) {
    // 1) pt 尺寸：来自 PDF 用户空间，旋转会交换宽高
    const v1 = rec.page.getViewport({ scale: 1, rotation: state.rotation });
    const view = rec.page.view || [0, 0, v1.width, v1.height];
    const rawW = Math.abs(view[2] - view[0]);
    const rawH = Math.abs(view[3] - view[1]);
    rec.wPt = swap ? rawH : rawW;
    rec.hPt = swap ? rawW : rawH;
    rec.baseK = rec.wPt > 0 ? v1.width / rec.wPt : 1;

    // 2) 当前显示尺寸与标定：k = 渲染像素宽 / pt 宽
    const viewport = rec.page.getViewport({ scale: state.scale, rotation: state.rotation });
    rec.viewport = viewport;
    rec.k = rec.wPt > 0 ? viewport.width / rec.wPt : 1;

    rec.canvas.style.width = viewport.width + 'px';
    rec.canvas.style.height = viewport.height + 'px';
    rec.ruler.style.width = viewport.width + 'px';
    rec.ruler.style.height = viewport.height + 'px';

    positionOriginDot(rec);
    repaintPins(rec);
  }

  els.zoomValue.textContent = Math.round(state.scale * 100) + '%';
  updatePageMeta();
}

/** 位图渲染：缩放过渡期间画面会被 CSS 短暂拉伸，渲染完自动恢复清晰 */
async function repaint() {
  if (rendering) { repaintQueued = true; return; }
  rendering = true;
  try {
    do {
      repaintQueued = false;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      for (const rec of pages.values()) {
        const vp = rec.viewport;
        if (!vp) continue;
        rec.canvas.width = Math.max(1, Math.floor(vp.width * dpr));
        rec.canvas.height = Math.max(1, Math.floor(vp.height * dpr));
        rec.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        await rec.page.render({ canvasContext: rec.ctx, viewport: vp }).promise;
        drawRuler(rec, dpr);
      }
    } while (repaintQueued);
  } finally {
    rendering = false;
  }
}

function positionOriginDot(rec) {
  const W = rec.viewport.width, H = rec.viewport.height;
  const at = { bottomLeft: [0, H], bottomRight: [W, H], topLeft: [0, 0], topRight: [W, 0] }[state.origin];
  rec.originDot.style.left = at[0] + 'px';
  rec.originDot.style.top = at[1] + 'px';
}

/* 刻度尺：10pt 一小格，50pt 标数值 */
function drawRuler(rec, dpr) {
  const w = rec.viewport.width, h = rec.viewport.height;
  rec.ruler.width = Math.max(1, Math.floor(w * dpr));
  rec.ruler.height = Math.max(1, Math.floor(h * dpr));
  rec.ruler.style.width = w + 'px';
  rec.ruler.style.height = h + 'px';

  const c = rec.rctx;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, w, h);
  if (!els.rulerChk.checked) return;

  c.strokeStyle = 'rgba(22,120,74,.6)';
  c.fillStyle = 'rgba(14,74,46,.9)';
  c.lineWidth = 1;
  c.font = '9px "Segoe UI", sans-serif';

  const right = state.origin === 'bottomRight' || state.origin === 'topRight';
  const top = state.origin === 'topLeft' || state.origin === 'topRight';
  const ox = right ? w : 0, oy = top ? 0 : h;
  const sx = right ? -1 : 1, sy = top ? 1 : -1;
  const stepPx = 10 * rec.k;

  for (let i = 1; i * stepPx < w; i++) {
    const x = ox + sx * i * stepPx;
    if (x < 1 || x > w - 1) continue;
    const major = (i * 10) % 50 === 0;
    c.beginPath(); c.moveTo(x, h - (major ? 10 : 4)); c.lineTo(x, h); c.stroke();
    if (major) c.fillText(String(i * 10), right ? x - 20 : x + 2, h - 12);
  }
  for (let i = 1; i * stepPx < h; i++) {
    const y = oy + sy * i * stepPx;
    if (y < 1 || y > h - 1) continue;
    const major = (i * 10) % 50 === 0;
    c.beginPath(); c.moveTo(0, y); c.lineTo(major ? 10 : 4, y); c.stroke();
    if (major) c.fillText(String(i * 10), 12, top ? y + 10 : y - 3);
  }
}

/* ============================ 坐标换算 ============================ */

/** 页面内 CSS 像素 -> pt 坐标（含原点选择） */
function pointFrom(rec, cssX, cssY) {
  let xPt = cssX / rec.k;
  let yPt = rec.hPt - cssY / rec.k; // 左下角原点，Y 向上为正
  if (state.origin === 'bottomRight' || state.origin === 'topRight') xPt = rec.wPt - xPt;
  if (state.origin === 'topLeft' || state.origin === 'topRight') yPt = rec.hPt - yPt;
  return { page: rec.n, xPt, yPt };
}

/** pt 坐标 -> 页面内 CSS 像素（原点变换的逆运算） */
function pxFromPt(rec, xPt, yPt) {
  let x = xPt, y = yPt;
  if (state.origin === 'bottomRight' || state.origin === 'topRight') x = rec.wPt - x;
  if (state.origin === 'topLeft' || state.origin === 'topRight') y = rec.hPt - y;
  return { cssX: x * rec.k, cssY: rec.viewport.height - y * rec.k };
}

/** 命中测试：优先用事件目标定位所在页，避免每帧遍历所有页 */
function locate(e) {
  const host = e.target && e.target.closest ? e.target.closest('.page-host') : null;
  const rec = host ? pages.get(parseInt(host.dataset.page, 10)) : null;
  if (rec && rec.viewport) {
    const r = rec.canvas.getBoundingClientRect();
    const cssX = e.clientX - r.left, cssY = e.clientY - r.top;
    if (cssX >= 0 && cssY >= 0 && cssX <= r.width && cssY <= r.height) return { rec, cssX, cssY };
    return null;
  }
  for (const cand of pages.values()) {
    if (!cand.viewport) continue;
    const r = cand.canvas.getBoundingClientRect();
    if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
      return { rec: cand, cssX: e.clientX - r.left, cssY: e.clientY - r.top };
    }
  }
  return null;
}

/* ============================ 鼠标交互 ============================ */

function bindPointer() {
  document.addEventListener('mousemove', onMouseMove);
  els.scrollArea.addEventListener('mouseleave', () => { state.mouse = null; setActive(null); renderReadout(); });
  els.viewport.addEventListener('click', onPageClick);
  document.addEventListener('keydown', onKey);
  bindZoomWheel();
}

/* Ctrl + 滚轮 / 触摸板捏合 -> 组件内缩放（阻止浏览器整页缩放） */
function bindZoomWheel() {
  const PER_MODE = [0.0018, 0.05, 0.6]; // 像素 / 行 / 页
  window.addEventListener('wheel', (e) => {
    if (!e.ctrlKey || !state.doc) return; // 未打开文档时保留浏览器默认行为
    e.preventDefault(); // 必须在非 passive 监听里调用，才能挡掉浏览器整页缩放
    const per = PER_MODE[e.deltaMode] != null ? PER_MODE[e.deltaMode] : PER_MODE[0];
    zoomAt(Math.exp(-e.deltaY * per), e.clientX, e.clientY);
  }, { passive: false });
}

function onMouseMove(e) {
  const hit = locate(e);
  if (!hit) {
    if (state.mouse) { state.mouse = null; setActive(null); renderReadout(); }
    els.cursorTag.style.display = 'none';
    return;
  }
  const p = pointFrom(hit.rec, hit.cssX, hit.cssY);
  state.mouse = p;
  setActive(hit, p);
  if (state.curPage !== p.page) {
    state.curPage = p.page;
    els.pageNum.value = String(p.page);
    updatePageMeta();
  }
  renderReadout();
  moveTag(e.clientX, e.clientY, p);
}

function setActive(hit, p) {
  if (!hit || !els.crossChk.checked) {
    if (activeRec) { activeRec.host.classList.remove('active'); activeRec = null; }
    return;
  }
  if (activeRec && activeRec !== hit.rec) activeRec.host.classList.remove('active');
  activeRec = hit.rec;
  activeRec.host.classList.add('active');
  activeRec.gh.style.top = hit.cssY + 'px';
  activeRec.gv.style.left = hit.cssX + 'px';
}

function moveTag(cx, cy, p) {
  const t = els.cursorTag;
  t.style.display = 'block';
  t.style.left = (cx + 16) + 'px';
  t.style.top = (cy + 18) + 'px';
  t.innerHTML = 'X <em>' + fmt(p.xPt) + '</em> · Y <em>' + fmt(p.yPt) + '</em> ' + UNIT_LABEL[state.unit];
  if (cx + 16 + t.offsetWidth > window.innerWidth - 6) t.style.left = (cx - t.offsetWidth - 12) + 'px';
  if (cy + 18 + t.offsetHeight > window.innerHeight - 6) t.style.top = (cy - t.offsetHeight - 12) + 'px';
}

function onPageClick(e) {
  const hit = locate(e);
  if (!hit) return;
  const p = pointFrom(hit.rec, hit.cssX, hit.cssY);
  state.pins.push({ page: p.page, x: p.xPt, y: p.yPt });
  repaintPins(hit.rec);
  renderReadout();
}

function onKey(e) {
  if (e.target && e.target.matches && e.target.matches('input, select, textarea')) return;
  if (e.key === 'Escape') { state.pins = []; for (const r of pages.values()) repaintPins(r); renderReadout(); }
  else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); gotoPage(state.curPage - 1); }
  else if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); gotoPage(state.curPage + 1); }
}

function repaintPins(rec) {
  rec.host.querySelectorAll('.pin').forEach((n) => n.remove());
  state.pins.forEach((m, idx) => {
    if (m.page !== rec.n) return;
    const el = document.createElement('div');
    el.className = 'pin';
    const pos = pxFromPt(rec, m.x, m.y);
    el.style.left = pos.cssX + 'px';
    el.style.top = pos.cssY + 'px';
    el.innerHTML = '<span>#' + (idx + 1) + ' ' + fmt(m.x) + ', ' + fmt(m.y) + '</span>';
    rec.host.append(el);
  });
}

/* ============================ 读数展示 ============================ */

function fmt(ptVal) {
  if (ptVal === null || ptVal === undefined || Number.isNaN(ptVal)) return '—';
  const v = ptVal / PT_PER[state.unit];
  const s = Math.abs(v).toFixed(state.decimals);
  return (v < 0 ? '-' : '') + s;
}

function renderReadout() {
  const u = UNIT_LABEL[state.unit];
  if (!state.mouse) {
    els.readout.innerHTML = '<span class="ro-page">第 ' + (state.curPage || '-') + ' 页</span>' +
      '<span class="ro-coord">X <i>—</i> ' + u + '</span>' +
      '<span class="ro-coord">Y <i>—</i> ' + u + '</span>' +
      '<span class="ro-hint">鼠标移到页面上读数，单击打点</span>';
  } else {
    els.readout.innerHTML = '<span class="ro-page">第 ' + state.mouse.page + ' 页</span>' +
      '<span class="ro-coord">X <i>' + fmt(state.mouse.xPt) + '</i> ' + u + '</span>' +
      '<span class="ro-coord">Y <i>' + fmt(state.mouse.yPt) + '</i> ' + u + '</span>';
  }

  const n = state.pins.length;
  if (n >= 2) {
    const a = state.pins[n - 2], b = state.pins[n - 1];
    const dx = (b.x - a.x) / PT_PER[state.unit];
    const dy = (b.y - a.y) / PT_PER[state.unit];
    const dist = Math.hypot(b.x - a.x, b.y - a.y) / PT_PER[state.unit];
    els.deltaBox.style.display = '';
    els.deltaBox.innerHTML = '#' + (n - 1) + ' → #' + n +
      ' &nbsp;ΔX <b>' + dx.toFixed(state.decimals) + '</b> ' + u +
      ' · ΔY <b>' + dy.toFixed(state.decimals) + '</b> ' + u +
      ' · 距离 <b>' + dist.toFixed(state.decimals) + '</b> ' + u +
      ' &nbsp;(' + n + ' 个点，Esc 清除)';
  } else if (n === 1) {
    els.deltaBox.style.display = '';
    els.deltaBox.innerHTML = '已打 1 个点，再点一次即可测距（Esc 清除）';
  } else {
    els.deltaBox.style.display = 'none';
  }
}

function updatePageMeta() {
  const rec = pages.get(state.curPage) || pages.values().next().value;
  if (!rec || !rec.wPt) { els.pagePt.textContent = ''; return; }
  const u = UNIT_LABEL[state.unit];
  const conv = (v) => (v / PT_PER[state.unit]).toFixed(state.decimals);
  els.pagePt.innerHTML = '第 ' + rec.n + ' 页尺寸 <b>' + conv(rec.wPt) + ' × ' + conv(rec.hPt) + ' ' + u +
    '</b> &nbsp;·&nbsp; 原点：' + originLabel() + ' &nbsp;·&nbsp; 标定 ' + rec.k.toFixed(3) + ' px/pt';
}

function originLabel() {
  return { bottomLeft: '左下角 (0,0)', bottomRight: '右下角 (0,0)', topLeft: '左上角 (0,0)', topRight: '右上角 (0,0)' }[state.origin];
}

/* ============================ 控制 ============================ */

function bindUI() {
  els.openFile.addEventListener('click', () => els.fileInput.click());
  els.fileInput.addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    hint('正在解析：' + f.name);
    try {
      const buf = new Uint8Array(await f.arrayBuffer());
      await mount(await pdfjsLib.getDocument({ data: buf, isEvalSupported: false }).promise, f.name);
    } catch (err) {
      hint('解析失败：' + safeMsg(err));
    }
  });

  els.prev.addEventListener('click', () => gotoPage(state.curPage - 1));
  els.next.addEventListener('click', () => gotoPage(state.curPage + 1));
  els.pageNum.addEventListener('change', () => gotoPage(parseInt(els.pageNum.value, 10) || 1));

  els.zoomIn.addEventListener('click', () => setZoom(state.scale * 1.2));
  els.zoomOut.addEventListener('click', () => setZoom(state.scale / 1.2));
  els.fitWidth.addEventListener('click', fitWidth);

  els.originSel.addEventListener('change', async () => {
    state.origin = els.originSel.value; savePref('origin', state.origin);
    for (const rec of pages.values()) { if (!rec.viewport) continue; positionOriginDot(rec); drawRuler(rec, Math.min(window.devicePixelRatio || 1, 2)); repaintPins(rec); }
    updatePageMeta(); renderReadout();
  });
  els.unitSel.addEventListener('change', () => { state.unit = els.unitSel.value; savePref('unit', state.unit); renderReadout(); updatePageMeta(); });
  els.decSel.addEventListener('change', () => { state.decimals = parseInt(els.decSel.value, 10); savePref('decimals', state.decimals); renderReadout(); updatePageMeta(); });
  els.rotSel.addEventListener('change', async () => {
    state.rotation = parseInt(els.rotSel.value, 10); savePref('rotation', state.rotation);
    hint('重新渲染中…'); await redrawAll(); hint(null);
  });
  els.crossChk.addEventListener('change', () => { savePref('cross', els.crossChk.checked); setActive(null); });
  els.rulerChk.addEventListener('change', async () => {
    savePref('ruler', els.rulerChk.checked);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    for (const rec of pages.values()) if (rec.viewport) drawRuler(rec, dpr);
  });
  els.resetPin.addEventListener('click', () => { state.pins = []; for (const r of pages.values()) repaintPins(r); renderReadout(); });

  window.addEventListener('resize', debounce(() => { if (activeRec) setActive(null); }, 200));
}

async function setZoom(s) {
  state.scale = Math.max(0.2, Math.min(8, s));
  savePref('scale', state.scale);
  relayout();
  await repaint();
}

/**
 * 以屏幕某个锚点为中心缩放：先同步重排并标定坐标，再把文档偏移校正回去，
 * 保证缩放前后鼠标指向的 PDF 位置不动；位图随后异步重画。
 */
async function zoomAt(factor, anchorX, anchorY) {
  const target = Math.max(0.2, Math.min(8, state.scale * factor));
  if (Math.abs(target - state.scale) < 1e-4) return;

  const area = els.scrollArea;
  const rect = area.getBoundingClientRect();
  const ax = (anchorX == null ? rect.left + rect.width / 2 : anchorX) - rect.left;
  const ay = (anchorY == null ? rect.top + rect.height / 2 : anchorY) - rect.top;
  const beforeDocX = area.scrollLeft + ax;
  const beforeDocY = area.scrollTop + ay;
  const ratio = target / state.scale;

  state.scale = target;
  savePref('scale', target);
  relayout();

  void area.scrollHeight; // 强制同步 reflow，否则下面赋的滚动位置会被旧布局吞掉
  area.scrollLeft = beforeDocX * ratio - ax;
  area.scrollTop = beforeDocY * ratio - ay;

  const hit = hitAt(anchorX, anchorY);
  if (hit) {
    const p = pointFrom(hit.rec, hit.cssX, hit.cssY);
    state.mouse = p;
    setActive(hit, p);
  } else {
    state.mouse = null;
    setActive(null);
  }
  renderReadout();

  repaint();
}

/** 用屏幕坐标重新命中页面（缩放后刷新读数用） */
function hitAt(clientX, clientY) {
  if (clientX == null) return null;
  for (const cand of pages.values()) {
    if (!cand.viewport) continue;
    const r = cand.canvas.getBoundingClientRect();
    if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) {
      return { rec: cand, gh: cand.gh, gv: cand.gv, cssX: clientX - r.left, cssY: clientY - r.top };
    }
  }
  return null;
}

async function fitWidth() {
  const rec = pages.get(state.curPage) || pages.values().next().value;
  if (!rec || !rec.wPt || !rec.baseK) return;
  const avail = els.scrollArea.clientWidth - 64;
  await setZoom(Math.max(0.2, Math.min(8, avail / (rec.wPt * rec.baseK))));
}

function gotoPage(n, instant) {
  if (!state.doc) return;
  n = Math.max(1, Math.min(state.doc.numPages, n));
  const rec = pages.get(n);
  if (rec) rec.host.scrollIntoView({ block: 'start', behavior: instant ? 'auto' : 'smooth' });
  state.curPage = n;
  els.pageNum.value = String(n);
  updatePageMeta();
  renderReadout();
}

/** 滚动时自动识别"当前页" */
let io = null;
function observePages() {
  if (io) io.disconnect();
  io = new IntersectionObserver((entries) => {
    let best = null;
    for (const en of entries) if (en.isIntersecting && (!best || en.intersectionRatio > best.intersectionRatio)) best = en;
    if (!best) return;
    const n = parseInt(best.target.dataset.page, 10);
    if (n && n !== state.curPage) {
      state.curPage = n;
      els.pageNum.value = String(n);
      updatePageMeta();
    }
  }, { root: els.scrollArea, threshold: [0.25, 0.5, 0.75] });
  for (const rec of pages.values()) io.observe(rec.host);
}

/* ============================ 工具 ============================ */

/** 标签页标题 = 原 PDF 文件名 */
function urlToName(url) {
  try {
    const u = new URL(url, location.href);
    const raw = decodeURIComponent(u.pathname.split(/[\\/]/).pop() || '');
    return raw || null;
  } catch (e) {
    const tail = String(url).split(/[?#]/)[0].split(/[\\/]/).pop() || '';
    try { return decodeURIComponent(tail) || null; } catch (e2) { return tail || null; }
  }
}

function setDocTitle(name) {
  state.fileName = name || null;
  document.title = state.fileName || DEFAULT_TITLE;
  const brand = document.querySelector('.brand');
  if (brand) {
    brand.innerHTML = '';
    brand.append(document.createTextNode(state.fileName || DEFAULT_TITLE));
    const badge = document.createElement('span');
    badge.className = 'unit-badge';
    badge.textContent = 'pt';
    brand.append(badge);
  }
}

function hint(t) {
  if (!t) { els.banner.style.display = 'none'; els.banner.textContent = ''; return; }
  els.banner.style.display = 'block'; els.banner.textContent = t;
}
function safeMsg(e) { return String((e && e.message) || e || '未知错误').slice(0, 160); }
function shorten(u) { try { return decodeURIComponent(u).split(/[\\/]/).pop() || u; } catch (e) { return u; } }
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
