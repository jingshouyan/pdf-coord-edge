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
  renderGen++; // 作废上一个文档的在途渲染
  state.geomRot = null; // 新文档需重算页面 pt 尺寸
  clearTimeout(repaintTimer);
  repaintAgain = false;
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
  host.className = 'page-host pending';
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
    // alpha 必须为 true：false 时未绘制区域是不透明黑，缩放/首屏会闪黑
    ctx: canvas.getContext('2d', { alpha: true }),
    rctx: ruler.getContext('2d'),
    k: 1, baseK: 1, wPt: 0, hPt: 0, viewport: null,
    rendered: false, renderSeq: 0, stale: false, dpr: 1
  };
}

/* 单页位图边长上限：超过则降 DPR 渲染，避免显存/内存抖动 */
const MAX_CANVAS_SIDE = 6000;

/* ============================ 渲染 ============================ */

/**
 * 缩放为什么要分两段：
 *   relayout()  —— 同步，只改几何。位图尺寸保持不变，靠 CSS 拉伸旧画面，
 *                   所以滚轮期间画面立刻跟着变大变小，既不黑也不重画，坐标读数依旧准确。
 *   renderPage() —— 异步，滚轮停下后只重画视口附近的页面；先在离屏画布画好，
 *                   再同帧替换到位图画布，避免"清空后等待渲染"的黑/白中间态。
 */
let repaintTimer = null;
let repaintBusy = false;
let repaintAgain = false;
let renderGen = 0; // 换文档时递增，用于作废在途渲染

async function redrawAll() {
  relayout();
  clearTimeout(repaintTimer); // relayout 已调度，避免紧接着重复渲染一轮
  await runRepaint();
}

/**
 * 纯几何：更新 px/pt 标定与 CSS 布局（不触碰位图）。
 * 这是滚轮热路径，故页面 pt 尺寸按旋转缓存，只在旋转变化时重算。
 */
function relayout() {
  const rot = ((state.rotation % 360) + 360) % 360;
  const swap = rot === 90 || rot === 270;
  const geomDirty = state.geomRot !== rot;
  if (geomDirty) state.geomRot = rot;

  for (const rec of pages.values()) {
    // 1) pt 尺寸：来自 PDF 用户空间，与缩放无关，仅随旋转变化 -> 缓存
    if (geomDirty || !rec.cachedPt) {
      const v1 = rec.page.getViewport({ scale: 1, rotation: state.rotation });
      const view = rec.page.view || [0, 0, v1.width, v1.height];
      const rawW = Math.abs(view[2] - view[0]);
      const rawH = Math.abs(view[3] - view[1]);
      rec.wPt = swap ? rawH : rawW;
      rec.hPt = swap ? rawW : rawH;
      rec.baseK = rec.wPt > 0 ? v1.width / rec.wPt : 1;
      rec.cachedPt = true;
    }

    // 2) 显示尺寸与标定：k 基于 CSS 像素，与位图分辨率无关，故读数不受 dpr 影响
    const viewport = rec.page.getViewport({ scale: state.scale, rotation: state.rotation });
    rec.viewport = viewport;
    rec.k = rec.wPt > 0 ? viewport.width / rec.wPt : 1;

    rec.canvas.style.width = viewport.width + 'px';
    rec.canvas.style.height = viewport.height + 'px';
    // 显式收缩容器宽度：使白底恰好等于页面，超宽时由 margin:auto 退化为贴左
    rec.host.style.width = viewport.width + 'px';
    rec.ruler.style.width = viewport.width + 'px';
    rec.ruler.style.height = viewport.height + 'px';

    positionOriginDot(rec);
    if (state.pins.length) repaintPins(rec);
    rec.stale = true; // 位图与新的显示尺寸不再匹配，待重画
  }

  els.zoomValue.textContent = Math.round(state.scale * 100) + '%';
  updatePageMeta();
  scheduleRepaint();
}

/** 视口内（含上下 margin 屏预取）的页码集合 */
function visiblePageSet(margin) {
  const rect = els.scrollArea.getBoundingClientRect();
  const pad = rect.height * (margin == null ? 1 : margin);
  const top = rect.top - pad;
  const bot = rect.bottom + pad;
  const set = new Set();
  for (const rec of pages.values()) {
    const r = rec.canvas.getBoundingClientRect();
    if (r.bottom >= top && r.top <= bot) set.add(rec.n);
  }
  if (!set.size) set.add(state.curPage || 1);
  return set;
}

function scheduleRepaint(delay) {
  clearTimeout(repaintTimer);
  repaintTimer = setTimeout(runRepaint, delay == null ? 140 : delay);
}

/** 只重画视口附近的页面，串行进行，避免与 pdf.js worker 抢资源 */
async function runRepaint() {
  if (repaintBusy) { repaintAgain = true; return; }
  repaintBusy = true;
  const gen = renderGen;
  try {
    do {
      repaintAgain = false;
      const vis = visiblePageSet(1);
      for (const rec of pages.values()) {
        if (gen !== renderGen) return;
        if (!vis.has(rec.n) || !rec.viewport) continue;
        if (rec.rendered && !rec.stale) continue;
        await renderPage(rec);
        if (rec.rendered) rec.stale = false;
      }
    } while (repaintAgain && gen === renderGen);
  } finally {
    repaintBusy = false;
  }
}

/** 该页位图用的设备像素比：位图边长超上限时自动降采样，防止显存抖动 */
function pickDpr(rec) {
  const base = Math.min(window.devicePixelRatio || 1, 2);
  const w = rec.viewport.width, h = rec.viewport.height;
  const cap = MAX_CANVAS_SIDE / Math.max(w, h, 1);
  return Math.max(0.5, Math.min(base, cap));
}

async function renderPage(rec) {
  if (!rec.viewport) return false;
  const seq = ++rec.renderSeq;
  const gen = renderGen;
  const dpr = pickDpr(rec);
  const bw = Math.max(1, Math.floor(rec.viewport.width * dpr));
  const bh = Math.max(1, Math.floor(rec.viewport.height * dpr));

  // 离屏渲染：可见画布在渲染完成前保持上一帧画面，不会出现空白中间态
  const back = document.createElement('canvas');
  back.width = bw;
  back.height = bh;
  const bctx = back.getContext('2d');
  bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  try {
    await rec.page.render({ canvasContext: bctx, viewport: rec.viewport }).promise;
  } catch (e) {
    back.width = back.height = 0;
    return false;
  }
  if (seq !== rec.renderSeq || gen !== renderGen) { back.width = back.height = 0; return false; }

  // 同帧替换：改尺寸会清空画布，但紧接着 drawImage，浏览器不会绘制中间状态
  rec.dpr = dpr;
  rec.canvas.width = bw;
  rec.canvas.height = bh;
  rec.ctx.setTransform(1, 0, 0, 1, 0, 0);
  rec.ctx.clearRect(0, 0, bw, bh);
  rec.ctx.drawImage(back, 0, 0);
  back.width = back.height = 0; // 释放大画布

  rec.rendered = true;
  rec.host.classList.remove('pending');
  drawRuler(rec, dpr);
  return true;
}

/** 只重画刻度尺（切换原点、开关刻度尺时无需重渲染 PDF） */
function repaintRulers() {
  for (const rec of pages.values()) {
    if (rec.viewport && rec.rendered) drawRuler(rec, rec.dpr || Math.min(window.devicePixelRatio || 1, 2));
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

  // 未开启刻度尺时直接隐藏，避免为每页分配一张与页面等大的画布
  if (!els.rulerChk.checked) {
    rec.ruler.style.display = 'none';
    if (rec.ruler.width !== 1 || rec.ruler.height !== 1) { rec.ruler.width = 1; rec.ruler.height = 1; }
    return;
  }
  rec.ruler.style.display = '';
  rec.ruler.width = Math.max(1, Math.floor(w * dpr));
  rec.ruler.height = Math.max(1, Math.floor(h * dpr));
  rec.ruler.style.width = w + 'px';
  rec.ruler.style.height = h + 'px';

  const c = rec.rctx;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, w, h);

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
  document.addEventListener('mousemove', onMouseMove, { passive: true });
  els.scrollArea.addEventListener('mouseleave', () => { state.mouse = null; setActive(null); renderReadout(); });
  els.viewport.addEventListener('click', onPageClick);
  document.addEventListener('keydown', onKey);
  bindZoomWheel();
  bindPanDrag();
}

/* mousemove 按帧节流：高分屏事件可达 120Hz+，逐帧重建 DOM 会造成明显掉帧 */
let pendingMove = null;
let moveRaf = 0;
function onMouseMove(e) {
  if (pan && pan.moved) return; // 拖拽平移期间不更新读数，画面跟手即可
  pendingMove = { x: e.clientX, y: e.clientY };
  if (moveRaf) return;
  moveRaf = requestAnimationFrame(() => {
    moveRaf = 0;
    const pt = pendingMove;
    pendingMove = null;
    if (pt) applyMove(pt.x, pt.y);
  });
}

function applyMove(clientX, clientY, force) {
  if (!force && pan && pan.moved) return; // 拖拽平移期间不更新读数
  const hit = locateAt(clientX, clientY);
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
  moveTag(clientX, clientY, p);
}

/** 命中测试：先查当前页（多数情况），再回退遍历 */
function locateAt(clientX, clientY) { return hitAt(clientX, clientY); }

/* ============================ 左键拖拽平移 ============================ */

const PAN_THRESHOLD = 4; // px，超过该位移才认定为"拖动"，避免手抖误判为没点击

let pan = null;        // { startX, startY, left0, top0, moved }
let suppressClick = false; // 拖动结束时浏览器仍会派发 click，需忽略这一次

function bindPanDrag() {
  els.scrollArea.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;                                 // 只响应鼠标左键
    if (!state.doc) return;                                     // 未打开文档时保留浏览器默认行为
    if (e.target.closest('button, select, input, a')) return;   // 控件仍可正常点击
    if (!locateAt(e.clientX, e.clientY)) return;                // 只在页面上拖拽，空白处不接管

    pan = {
      startX: e.clientX, startY: e.clientY,
      left0: els.scrollArea.scrollLeft, top0: els.scrollArea.scrollTop,
      moved: false
    };
    // 不在 mousedown 里 preventDefault：否则浏览器不会派发 click，打点会失效。
    // 拖动选中文字改由 .panning-active 的 user-select:none 抑制。
  });

  window.addEventListener('mousemove', (e) => {
    if (!pan) return;
    const dx = e.clientX - pan.startX;
    const dy = e.clientY - pan.startY;
    if (!pan.moved && Math.hypot(dx, dy) < PAN_THRESHOLD) return;
    if (!pan.moved) {
      pan.moved = true;
      els.scrollArea.classList.add('panning-active');            // 由 CSS 关闭文字选择
    }

    els.scrollArea.scrollLeft = pan.left0 - dx;
    els.scrollArea.scrollTop = pan.top0 - dy;

    // 用当前事件坐标刷新读数：onMouseMove 在拖动中已被守卫停掉，
    // pendingMove 会停留在进入拖动前的旧坐标，不能复用。
    applyMove(e.clientX, e.clientY, true);
  }, { passive: true });

  const end = (ev) => {
    if (!pan) return;
    suppressClick = pan.moved; // 拖动结束不要当成一次打点
    const wasMoved = pan.moved;
    const cx = ev && ev.clientX, cy = ev && ev.clientY;
    pan = null;
    els.scrollArea.classList.remove('panning-active');
    if (suppressClick) setTimeout(() => { suppressClick = false; }, 0);
    if (wasMoved && ev && ev.type === 'mouseup' && typeof cx === 'number' && typeof cy === 'number') {
      applyMove(cx, cy, true); // 松手即恢复该点读数
    }
  };
  window.addEventListener('mouseup', end);
  els.scrollArea.addEventListener('mouseleave', end);
  window.addEventListener('blur', end);
}

/* Ctrl + 滚轮 / 触摸板捏合 -> 组件内缩放（阻止浏览器整页缩放） */
function bindZoomWheel() {
  const PER_MODE = [0.0018, 0.05, 0.6]; // 像素 / 行 / 页
  window.addEventListener('wheel', (e) => {
    if (!e.ctrlKey || !state.doc) return; // 未打开文档时保留浏览器默认行为
    e.preventDefault(); // 必须在非 passive 监听里调用，才能挡掉浏览器整页缩放
    const per = PER_MODE[e.deltaMode] != null ? PER_MODE[e.deltaMode] : PER_MODE[0];
    queueZoom(Math.exp(-e.deltaY * per), e.clientX, e.clientY);
  }, { passive: false });
}

/* 滚轮事件每秒可达数十次，逐次重排全部页面会掉帧 -> 合并到每帧一次 */
let zoomRaf = 0;
let zoomFactor = 1;
let zoomAnchor = [null, null];
function queueZoom(factor, x, y) {
  zoomFactor *= factor;
  zoomAnchor = [x, y];
  if (zoomRaf) return;
  zoomRaf = requestAnimationFrame(() => {
    zoomRaf = 0;
    const f = zoomFactor, a = zoomAnchor;
    zoomFactor = 1;
    zoomAt(f, a[0], a[1]);
  });
}

function setActive(hit, p) {
  if (!hit || !els.crossChk.checked) {
    if (activeRec) { activeRec.host.classList.remove('active'); activeRec = null; }
    return;
  }
  if (activeRec && activeRec !== hit.rec) activeRec.host.classList.remove('active');
  activeRec = hit.rec;
  activeRec.host.classList.add('active');
  activeRec.gh.style.transform = 'translateY(' + hit.cssY + 'px)';
  activeRec.gv.style.transform = 'translateX(' + hit.cssX + 'px)';
}

function moveTag(cx, cy, p) {
  const t = els.cursorTag;
  const html = 'X <em>' + fmt(p.xPt) + '</em> · Y <em>' + fmt(p.yPt) + '</em> ' + UNIT_LABEL[state.unit];
  if (html !== t.dataset.txt) { t.innerHTML = html; t.dataset.txt = html; }
  t.style.display = 'block';
  let x = cx + 16, y = cy + 18;
  if (x + t.offsetWidth > window.innerWidth - 6) x = cx - t.offsetWidth - 12;
  if (y + t.offsetHeight > window.innerHeight - 6) y = cy - t.offsetHeight - 12;
  t.style.transform = 'translate(' + x + 'px,' + y + 'px)';
}

function onPageClick(e) {
  if (suppressClick) return; // 拖拽平移后的那一次 click 不算打点
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

/* 状态栏使用常驻节点，只更新文本，避免每帧重建 DOM 造成整条状态栏重排 */
let ro = null;
function ensureReadoutDom() {
  if (ro) return ro;
  const mk = (cls, txt) => { const s = document.createElement('span'); s.className = cls; if (txt) s.textContent = txt; return s; };
  const page = mk('ro-page');
  const xw = mk('ro-coord'); const xi = document.createElement('i'); const xu = document.createTextNode('');
  xw.append(document.createTextNode('X '), xi, xu);
  const yw = mk('ro-coord'); const yi = document.createElement('i'); const yu = document.createTextNode('');
  yw.append(document.createTextNode('Y '), yi, yu);
  const hintEl = mk('ro-hint', '鼠标移到页面上读数，单击打点');
  els.readout.append(page, xw, yw, hintEl);
  ro = { page, xi, xu, yi, yu, hintEl, unit: null, shown: false };
  return ro;
}

function renderReadout() {
  const r = ensureReadoutDom();
  const u = UNIT_LABEL[state.unit];
  if (r.unit !== u) {
    r.xu.textContent = ' ' + u;
    r.yu.textContent = ' ' + u;
    r.unit = u;
  }
  const has = !!state.mouse;
  r.page.textContent = '第 ' + (has ? state.mouse.page : (state.curPage || '-')) + ' 页';
  r.xi.textContent = has ? fmt(state.mouse.xPt) : '—';
  r.yi.textContent = has ? fmt(state.mouse.yPt) : '—';
  if (has === r.shown) { r.hintEl.style.display = has ? 'none' : ''; r.shown = has; }
  else { r.hintEl.style.display = has ? 'none' : ''; r.shown = has; }

  // 测距栏只随打点/单位变化，不必每帧重建
  const sig = state.pins.length + '|' + state.unit + '|' + state.decimals;
  if (sig === els.deltaBox.dataset.sig) return;
  els.deltaBox.dataset.sig = sig;

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
  // 缩放时每帧都会调用，标定值又连续变化 -> 用签名避免无谓的 innerHTML 重排
  const html = '第 ' + rec.n + ' 页尺寸 <b>' + conv(rec.wPt) + ' × ' + conv(rec.hPt) + ' ' + u +
    '</b> &nbsp;·&nbsp; 原点：' + originLabel() + ' &nbsp;·&nbsp; 标定 ' + rec.k.toFixed(3) + ' px/pt';
  if (html !== els.pagePt.dataset.sig) { els.pagePt.innerHTML = html; els.pagePt.dataset.sig = html; }
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

  els.originSel.addEventListener('change', () => {
    state.origin = els.originSel.value; savePref('origin', state.origin);
    for (const rec of pages.values()) {
      if (!rec.viewport) continue;
      positionOriginDot(rec);
      if (rec.rendered) drawRuler(rec, rec.dpr);
      repaintPins(rec);
    }
    updatePageMeta(); renderReadout();
  });
  els.unitSel.addEventListener('change', () => { state.unit = els.unitSel.value; savePref('unit', state.unit); renderReadout(); updatePageMeta(); });
  els.decSel.addEventListener('change', () => { state.decimals = parseInt(els.decSel.value, 10); savePref('decimals', state.decimals); renderReadout(); updatePageMeta(); });
  els.rotSel.addEventListener('change', async () => {
    state.rotation = parseInt(els.rotSel.value, 10); savePref('rotation', state.rotation);
    hint('重新渲染中…'); await redrawAll(); hint(null);
  });
  els.crossChk.addEventListener('change', () => { savePref('cross', els.crossChk.checked); setActive(null); });
  els.rulerChk.addEventListener('change', () => {
    savePref('ruler', els.rulerChk.checked);
    repaintRulers();
  });
  els.resetPin.addEventListener('click', () => { state.pins = []; for (const r of pages.values()) repaintPins(r); renderReadout(); });

  // 窗口尺寸或 DPI 变化后位图需要重画
  window.addEventListener('resize', debounce(() => { setActive(null); scheduleRepaint(0); }, 200));
}

async function setZoom(s) {
  state.scale = Math.max(0.2, Math.min(8, s));
  savePref('scale', state.scale);
  relayout();
  await runRepaint();
}

/**
 * 以屏幕某个锚点为中心缩放。
 * 不能用"文档偏移等比放大"的公式：页面是 margin:auto 居中的，缩放后居中偏移本身也会变，
 * 等比公式会让光标指向的位置漂移。正确做法是重排后量出该点新的屏幕位置，再反推滚动量。
 */
async function zoomAt(factor, anchorX, anchorY) {
  const target = Math.max(0.2, Math.min(8, state.scale * factor));
  if (Math.abs(target - state.scale) < 1e-4) return;

  const area = els.scrollArea;
  const rect = area.getBoundingClientRect();
  const ax = anchorX == null ? rect.left + rect.width / 2 : anchorX;
  const ay = anchorY == null ? rect.top + rect.height / 2 : anchorY;

  // 先把锚点解析成页内 pt 坐标（与缩放无关，可在重排后复用）
  const before = hitAt(ax, ay);
  const anchor = before ? { rec: before.rec, pt: pointFrom(before.rec, before.cssX, before.cssY) } : null;
  const fallbackDocY = area.scrollTop + (ay - rect.top);
  const ratio = target / state.scale;

  state.scale = target;
  savePref('scale', target);
  relayout();

  void area.scrollHeight; // 强制同步 reflow，否则下面赋的滚动位置会被旧布局吞掉

  if (anchor && anchor.rec.viewport) {
    const pos = pxFromPt(anchor.rec, anchor.pt.xPt, anchor.pt.yPt);
    const r = anchor.rec.canvas.getBoundingClientRect();
    area.scrollLeft += (r.left + pos.cssX) - ax;
    area.scrollTop += (r.top + pos.cssY) - ay;
  } else {
    area.scrollTop = fallbackDocY * ratio - (ay - rect.top);
  }

  const hit = hitAt(ax, ay);
  if (hit) {
    const p = pointFrom(hit.rec, hit.cssX, hit.cssY);
    state.mouse = p;
    setActive(hit, p);
  } else {
    state.mouse = null;
    setActive(null);
  }
  renderReadout();
  // 位图重画由 relayout() 统一延后调度：滚轮期间只靠 CSS 拉伸，停下后才渲染清晰画面
}

/** 用屏幕坐标重新命中页面（缩放后刷新读数用）；优先命中当前页，避免遍历全文档 */
function hitAt(clientX, clientY) {
  if (clientX == null) return null;
  const order = activeRec ? [activeRec, ...pages.values()] : pages.values();
  for (const cand of order) {
    if (!cand || !cand.viewport) continue;
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
    scheduleRepaint(60); // 新进入视口的页面及时换成清晰位图
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
