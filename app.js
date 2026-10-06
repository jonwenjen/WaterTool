// WaterTool 介面：載入影片/照片 → 背景執行緒還原 → 分割比較 → 匯出。
import { METHODS, byId, defaults } from './lib/methods/index.js';
import { INFO } from './lib/methods/info.js';
import { syntheticClip } from './lib/synth.js';
import * as C from './lib/core.js';
import { GLPlayer } from './player-gl.js';
import { diverMatrix } from './lib/methods/diverout.js';
import { interpKeys, keyframeTimes, keyframeIndices } from './lib/keyframes.js';

const $ = (id) => document.getElementById(id);
const fmtTime = (s) => (Number.isFinite(s) ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '0:00');
const LONG_EDGE = { 480: 854, 720: 1280, 1080: 1920, 2160: 3840 };

// ---------------- 背景執行緒 ----------------
let worker = null;
let seq = 0;
const pending = new Map();
let lastHeard = 0; // 最後一次收到背景執行緒訊息的時間（看門狗用）
function call(msg, transfer = []) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    if (!pending.size) lastHeard = performance.now(); // 閒置期間不算
    pending.set(id, { resolve, reject });
    worker.postMessage({ ...msg, id }, transfer);
  });
}
function onWorkerMessage(e) {
  const m = e.data;
  // 只有回覆請求（或 alive）才算「有在處理」；模型下載進度不算，否則卡死時看門狗會被騙過
  if (m.type !== 'prefetch' && m.type !== 'model') lastHeard = performance.now();
  if (m.type === 'alive') return;
  if (m.type === 'model') return onModel(m);
  if (m.type === 'prefetch') return onPrefetch(m);
  const p = pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  if (m.type === 'error') p.reject(new Error(m.message));
  else p.resolve(m);
}
function startWorker() {
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = onWorkerMessage;
  worker.onerror = (e) => showError('背景執行緒錯誤：' + (e.message || e));
}
startWorker();

// 看門狗：有請求在等、背景執行緒卻超過 WATCHDOG 毫秒沒有任何回應 → 視為卡死，重新啟動並重算目前畫面
// （手機記憶體不足或執行環境卡住時，以前會一直轉圈、設定也不再套用）
let WATCHDOG = 40000;
setInterval(() => {
  if (pending.size && performance.now() - lastHeard > WATCHDOG) restartWorker();
}, 1000);
function restartWorker() {
  state.restarts = (state.restarts || 0) + 1;
  worker.terminate();
  const waiting = [...pending.values()];
  pending.clear();
  startWorker();
  state.models.clear(); // 新的執行緒要重新載入模型（已存在本機，很快）
  track = null;
  for (const p of waiting) p.reject(new Error('背景運算沒有回應，已自動重新啟動'));
  const m = byId[state.method];
  if (m.needsModel) worker.postMessage({ type: 'loadModel', file: m.model.file });
  console.warn('背景執行緒沒有回應，已重新啟動');
  setTimeout(() => {
    resetTemporal();
    if (state.src && !state.playing) processFrame(null);
    if (state.playing && glActive()) fitLoop();
    ensureTrack();
  }, 0);
}

// ---------------- 狀態 ----------------
const saved = (() => {
  try { return JSON.parse(localStorage.getItem('watertool') || '{}'); } catch { return {}; }
})();
const state = {
  src: null, // {kind:'image'|'video'|'demo', w, h, ...}
  method: byId[saved.method] ? saved.method : 'ancuti',
  params: Object.fromEntries(METHODS.map((m) => [m.id, { ...defaults(m), ...((saved.params || {})[m.id] || {}) }])),
  view: 'split',
  split: 0.5,
  playing: false,
  models: new Set(), // 已載入的模型檔
};
function save() {
  try {
    localStorage.setItem('watertool', JSON.stringify({ method: state.method, params: state.params, ui: readUi() }));
  } catch { /* 私密模式等：略過 */ }
}

// ---------------- 畫布 ----------------
const view = $('view'), vctx = view.getContext('2d');
const orig = document.createElement('canvas'), octx = orig.getContext('2d', { willReadFrequently: true });
const res = document.createElement('canvas'), rctx = res.getContext('2d');
let hasResult = false;
let resFresh = false; // res 是否就是 orig 這一格的結果（處理中 orig 已換成新的一格時為 false）

function previewSize() {
  const { w, h } = state.src;
  // 播放中最多以 480p 計算，維持預覽流暢；暫停 / 照片用選定的預覽解析度
  const edge = Math.min(LONG_EDGE[$('prevRes').value] || 1280, state.playing ? LONG_EDGE[480] : Infinity);
  let [pw, ph] = C.fitSize(w, h, edge);
  return [pw & ~1 || 2, ph & ~1 || 2];
}

function draw() {
  if (!state.src) return;
  if (glActive()) { renderGL(); placeOverlay(); return; }
  const w = orig.width, h = orig.height;
  if (view.width !== w || view.height !== h) { view.width = w; view.height = h; }
  const mode = state.view === 'compare' ? 'split' : state.view;
  if (mode === 'original' || !hasResult) vctx.drawImage(orig, 0, 0);
  else if (mode === 'result') vctx.drawImage(res, 0, 0);
  else {
    const x = Math.round(state.split * w);
    vctx.drawImage(orig, 0, 0);
    if (x < w) vctx.drawImage(res, x, 0, w - x, h, x, 0, w - x, h);
  }
  placeOverlay();
}

/** 畫布以 object-fit: contain 顯示；把分割線與標籤放到實際影像範圍內 */
function contentRect() {
  const vr = $('viewer').getBoundingClientRect();
  const s = Math.min(vr.width / view.width, vr.height / view.height);
  const w = view.width * s, h = view.height * s;
  return { left: (vr.width - w) / 2, top: (vr.height - h) / 2, width: w, height: h, vr };
}
function placeOverlay() {
  const r = contentRect(), split = state.view === 'split' || state.view === 'compare';
  const handle = $('handle');
  handle.hidden = !split || !state.src;
  handle.style.left = `${r.left + state.split * r.width}px`;
  handle.style.top = `${r.top}px`;
  handle.style.height = `${r.height}px`;
  handle.style.bottom = 'auto';
  handle.setAttribute('aria-valuenow', String(Math.round(state.split * 100)));
  $('tagL').hidden = !state.src || state.view === 'result';
  $('tagR').hidden = !state.src || state.view === 'original';
  $('tagL').textContent = '原始';
  $('tagR').textContent = byId[state.method].short;
  $('tagL').style.left = `${r.left + 10}px`;
  $('tagR').style.right = `${r.vr.width - r.left - r.width + 10}px`;
  $('tagL').style.top = $('tagR').style.top = `${r.top + 10}px`;
}
new ResizeObserver(placeOverlay).observe($('viewer'));

// ---------------- 取得目前畫面 ----------------
const video = $('video');
let demo = null; // { frames: ImageData[], fps, idx, canvas }

function grab() {
  const [w, h] = previewSize();
  if (orig.width !== w || orig.height !== h) {
    orig.width = res.width = w;
    orig.height = res.height = h;
  }
  const s = state.src;
  resFresh = false;
  if (s.kind === 'image') octx.drawImage(s.bitmap, 0, 0, w, h);
  else if (s.kind === 'video') octx.drawImage(video, 0, 0, w, h);
  else {
    demo.canvas.getContext('2d').putImageData(demo.frames[demo.idx], 0, 0);
    octx.drawImage(demo.canvas, 0, 0, w, h);
  }
  return [w, h];
}

// ---------------- 處理 ----------------
function readUi() {
  return {
    tOn: $('tOn').checked, tTau: +$('tTau').value, tDef: +$('tDef').value, tEvery: +$('tEvery').value,
    mix: +$('mix').value, post: +$('post').value, prevRes: $('prevRes').value, outRes: $('outRes').value, netExp: $('netExp').value,
  };
}
function buildOpts(dt, t = current()) {
  const u = readUi();
  const o = { method: state.method, params: state.params[state.method], mix: u.mix, post: u.post };
  if (dt !== null && u.tOn) o.video = { dt: dt || 1 / 30, tau: u.tTau, deflicker: u.tDef, every: u.tEvery };
  const g = keyG(t);
  if (g) { o.g = g; delete o.video; } // Diverout_sim：用整支片的關鍵幀內插，不做逐幀估計與平滑
  return o;
}

// ---------------- Diverout_sim：整支片的關鍵幀 ----------------
// 和 DIVEROUT 一樣先看過整支片：每隔 T 秒取一個關鍵幀估計色階，中間幀線性內插（預覽、播放、匯出都用同一組）。
const KEY_EDGE = 1280;
let track = null; // { src, pkey, keys: [{ t, g }], ready, promise }
let trackGen = 0;
const usesKeys = () => !!byId[state.method].keyframes && !!state.src && state.src.kind !== 'image';
const paramKey = () => state.method + JSON.stringify(state.params[state.method]);
function keyG(t) {
  if (!usesKeys() || !track || !track.ready || track.src !== state.src || track.pkey !== paramKey()) return null;
  return interpKeys(track.keys, t);
}
function ensureTrack() {
  if (!usesKeys()) return Promise.resolve();
  if (track && track.src === state.src && track.pkey === paramKey()) return track.promise;
  const gen = ++trackGen;
  const t = { src: state.src, pkey: paramKey(), keys: [], ready: false };
  track = t;
  t.promise = buildTrack(t, () => gen !== trackGen).then(() => {
    if (gen !== trackGen) return;
    t.ready = true;
    if (byId[state.method].keyframes) $('modelState').hidden = true;
    if (!state.playing) processFrame(null);
    else if (glActive()) $('stTime').textContent = `播放：GPU 即時套用 · ${t.keys.length} 個關鍵幀線性內插`;
  }).catch((err) => {
    if (gen !== trackGen) return;
    track = null;
    showError('關鍵幀分析失敗：' + err.message);
  });
  return t.promise;
}
async function buildTrack(t, stale) {
  const { method } = state, params = state.params[method];
  t.keys = await collectKeys(t.src, method, params, params.interval, KEY_EDGE, stale,
    (i, n) => { if (state.method === method) showModelNote(`${byId[method].short}：分析整支片的關鍵幀 ${i}/${n}…`); });
}

/**
 * 整支片每隔 interval 秒取一個關鍵幀（長邊 edge），由背景執行緒估計參數 → [{ t, g }]。
 * 影片另開一個看不見的 <video> 逐一跳過去（不影響正在看的畫面）。stale() 為真時中止。
 */
async function collectKeys(src, method, params, interval, edge, stale, note, msg = { type: 'estimate', method, params }) {
  const keys = [];
  const estimateAt = async (draw, time) => {
    const [w, h] = C.fitSize(src.w, src.h, edge);
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const x = c.getContext('2d', { willReadFrequently: true });
    draw(x, w, h);
    const data = x.getImageData(0, 0, w, h);
    const r = await call({ ...msg, rgba: data.data.buffer, w, h }, [data.data.buffer]);
    keys.push({ t: time, g: r.g });
  };
  if (src.kind === 'demo') {
    const n = demo.frames.length, idx = keyframeIndices(n, demo.fps, interval);
    const tmp = document.createElement('canvas');
    tmp.width = src.w;
    tmp.height = src.h;
    for (const [j, i] of idx.entries()) {
      if (stale()) return keys;
      note(j + 1, idx.length);
      tmp.getContext('2d').putImageData(demo.frames[i], 0, 0);
      await estimateAt((x, w, h) => x.drawImage(tmp, 0, 0, w, h), i / demo.fps);
    }
    return keys;
  }
  // 影片：用 Mediabunny（WebCodecs）直接解出關鍵幀 —— 不必播放、不必跳轉 <video>。
  // 手機瀏覽器常常不替看不見的 <video> 載入資料（loadeddata 永遠不來），以前會一直停在「分析關鍵幀」。
  try {
    const MB = await loadMediabunny();
    const input = new MB.Input({ source: new MB.BlobSource(src.file), formats: MB.ALL_FORMATS });
    const vt = await input.getPrimaryVideoTrack();
    if (!vt || !(await vt.canDecode())) throw new Error('無法解碼');
    const t0 = await vt.getFirstTimestamp(), D = (await vt.computeDuration()) - t0;
    const times = keyframeTimes(D, interval), [w, h] = C.fitSize(src.w, src.h, edge);
    const sink = new MB.CanvasSink(vt, { width: w, height: h, fit: 'fill', poolSize: 1 });
    let j = 0;
    // 最後一個關鍵幀取最後一幀（時間 = 片長時解碼器回傳最後一幀）
    for await (const wc of sink.canvasesAtTimestamps(times.map((t) => t0 + Math.min(t, Math.max(0, D - 0.001))))) {
      if (stale()) return keys;
      note(j + 1, times.length);
      if (wc) await estimateAt((x, cw, ch) => x.drawImage(wc.canvas, 0, 0, cw, ch), times[j]);
      j++;
    }
    if (keys.length) return keys;
    throw new Error('沒有解出任何關鍵幀');
  } catch (err) {
    if (stale()) return keys;
    console.warn('Mediabunny 取關鍵幀失敗，改用 <video> 跳轉：', err);
    keys.length = 0;
  }
  // 備援：看不見的 <video> 逐一跳轉（每一步都有逾時，不會無限等待）
  const kv = document.createElement('video');
  kv.muted = true;
  kv.playsInline = true;
  kv.preload = 'auto';
  kv.src = video.src;
  const wait = (target, ev, ms, msg) => new Promise((ok, bad) => {
    const timer = setTimeout(() => bad(new Error(msg)), ms);
    target.addEventListener(ev, () => { clearTimeout(timer); ok(); }, { once: true });
  });
  try {
    const loaded = wait(kv, 'loadeddata', 10000, '瀏覽器沒有載入影片資料，無法分析關鍵幀');
    kv.load();
    await loaded;
    const D = kv.duration || video.duration || 0, times = keyframeTimes(D, interval);
    for (const [j, time] of times.entries()) {
      if (stale()) return keys;
      note(j + 1, times.length);
      const seeked = wait(kv, 'seeked', 5000, '影片跳轉逾時，無法分析關鍵幀');
      kv.currentTime = Math.min(time, Math.max(0, D - 0.04)); // 最後一個關鍵幀 = 最後一幀
      await seeked;
      await estimateAt((x, w, h) => x.drawImage(kv, 0, 0, w, h), time);
    }
  } finally {
    kv.removeAttribute('src');
    kv.load();
  }
  return keys;
}

let busy = false, again = undefined; // again：處理中又收到的請求（其 dt）
async function processFrame(dt = null) {
  if (!state.src || (state.playing && glActive())) return;
  if (busy) { again = dt; return; }
  busy = true;
  $('busy').hidden = false;
  try {
    for (;;) {
      const [w, h] = grab();
      const data = octx.getImageData(0, 0, w, h);
      const r = await call({ type: 'process', slot: 'preview', rgba: data.data.buffer, w, h, opts: buildOpts(dt) }, [data.data.buffer]);
      rctx.putImageData(new ImageData(new Uint8ClampedArray(r.rgba), w, h), 0, 0);
      hasResult = true;
      resFresh = true;
      draw();
      const ms = r.info.ms;
      $('stMethod').innerHTML = `<b>${byId[state.method].name}</b>`;
      $('stTime').textContent = `${w}×${h} · 估計 ${ms.estimate.toFixed(0)} ms · 套用 ${ms.apply.toFixed(0)} ms${r.info.cut && dt !== null ? ' · 換鏡頭' : ''}`;
      if (again === undefined || state.playing) break;
      dt = again;
      again = undefined;
    }
    if (!state.playing) scheduleMeasure();
  } catch (err) {
    showError(err.message);
  } finally {
    busy = false;
    again = undefined;
    $('busy').hidden = true;
  }
}

let measureTimer = 0;
function scheduleMeasure() {
  clearTimeout(measureTimer);
  measureTimer = setTimeout(measure, 250);
}
async function measure() {
  if (!state.src || !hasResult) return;
  const w = orig.width, h = orig.height;
  const a = octx.getImageData(0, 0, w, h), b = rctx.getImageData(0, 0, w, h);
  try {
    const [qa, qb] = await Promise.all([
      call({ type: 'metrics', rgba: a.data.buffer, w, h }, [a.data.buffer]),
      call({ type: 'metrics', rgba: b.data.buffer, w, h }, [b.data.buffer]),
    ]);
    $('stQuality').innerHTML = `UIQM ${qa.uiqm.toFixed(2)} → <b>${qb.uiqm.toFixed(2)}</b> · UCIQE ${qa.uciqe.toFixed(3)} → <b>${qb.uciqe.toFixed(3)}</b>`;
  } catch (err) {
    showError(err.message);
  }
}

function resetTemporal() {
  worker.postMessage({ type: 'reset', slot: 'preview' });
  lastMediaTime = null;
  lastFitTime = null;
}

// ---------------- GPU 播放（WebGL2） ----------------
// 播放中：背景執行緒用完整演算法處理一張小圖（長邊 320），擬合成局部色彩轉換係數；
// 每一格影片由 GPU 套用最新係數，所以畫面跟原片一樣順。暫停時改回完整計算。
const glview = $('glview');
const fitCanvas = document.createElement('canvas'), fctx = fitCanvas.getContext('2d', { willReadFrequently: true });
const FIT_EDGE = 320;
let gl = null; // null = 還沒試；false = 不支援（改用逐幀處理）
// 手機記憶體吃緊或切到背景時，瀏覽器會收回 WebGL 畫布（context lost）：畫面會停住不動。
// 收回時改用逐幀處理；恢復後下次播放再用 GPU。
glview.addEventListener('webglcontextlost', (e) => {
  e.preventDefault();
  const wasGL = glActive();
  gl = false;
  if (wasGL) {
    glview.hidden = true;
    view.hidden = false;
    lastMediaTime = null;
    if (state.playing && state.src?.kind === 'video') nextFrame();
    else processFrame(null);
  }
});
glview.addEventListener('webglcontextrestored', () => { gl = null; });
function glPlayer() {
  if (gl === null) {
    try { gl = new GLPlayer(glview); } catch (err) { console.warn('GPU 播放不可用，改用逐幀處理：', err); gl = false; }
  }
  return gl || null;
}
const glActive = () => !!gl && !glview.hidden;
const playSource = () => (state.src.kind === 'video' ? video : demo.canvas);

function startGL() {
  const g = glPlayer();
  if (!g) return false;
  let [w, h] = C.fitSize(state.src.w, state.src.h, LONG_EDGE[$('prevRes').value] || 1280);
  w = w & ~1 || 2;
  h = h & ~1 || 2;
  glview.width = view.width = w; // 兩個畫布同尺寸，分割線位置才一致
  glview.height = view.height = h;
  g.resetCoeffs();
  const seeded = hasResult && resFresh && orig.width > 0 ? seedFromPaused() : Promise.resolve();
  $('stTime').textContent = matrixG() ? `播放：GPU 即時套用 · ${track.keys.length} 個關鍵幀線性內插` : '播放：GPU 即時套用 · 色彩計算中…';
  glview.hidden = false;
  view.hidden = true;
  renderGL();
  seeded.finally(fitLoop);
  return true;
}

/** 用暫停時的完整結果（orig → res）立即擬合一組係數，播放第一格就有還原後的顏色 */
async function seedFromPaused() {
  const [w, h] = C.fitSize(orig.width, orig.height, FIT_EDGE);
  const take = (cv) => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(cv, 0, 0, w, h);
    return x.getImageData(0, 0, w, h).data.buffer;
  };
  try {
    const src = take(orig), out = take(res);
    const r = await call({ type: 'fitPair', src, out, w, h }, [src, out]);
    if (glActive()) gl.setCoeffs(new Float32Array(r.a), new Float32Array(r.b), r.w, r.h);
  } catch { /* 沒有也沒關係，等第一次更新 */ }
}
/** 播放時可以直接用全域色彩矩陣的情況（Diverout_sim 關鍵幀已備妥、沒開共用自動色階） */
function matrixG(t = current()) {
  return +$('post').value === 0 ? keyG(t) : null;
}
function renderGL(t) {
  if (!glActive()) return;
  state.glFrames = (state.glFrames || 0) + 1;
  const g = matrixG(t ?? current());
  gl.setMatrix(g ? diverMatrix(g) : null);
  gl.draw(playSource(), { split: state.split, mode: state.view === 'compare' ? 'split' : state.view, amount: g ? +$('mix').value : 1 });
}
function stopGL() {
  if (!glActive()) return;
  // 暫停瞬間：把「這一格」的原片與 GPU 結果存成暫時畫面 —— 切換時不閃，完整計算完成前拖分隔線也是同一格
  // （以前會露出上一次暫停時算好的舊畫面）。完整計算完成後由 processFrame 取代。
  const w = glview.width, h = glview.height, g = matrixG();
  orig.width = res.width = w;
  orig.height = res.height = h;
  octx.drawImage(playSource(), 0, 0, w, h);
  gl.setMatrix(g ? diverMatrix(g) : null);
  gl.draw(playSource(), { mode: 'result', amount: g ? +$('mix').value : 1 });
  rctx.drawImage(glview, 0, 0, w, h);
  hasResult = true;
  resFresh = false;
  glview.hidden = true;
  view.hidden = false;
  draw();
}

let fitRunning = false, lastFitTime = null;
async function fitLoop() {
  if (fitRunning) return;
  fitRunning = true;
  let failed = false;
  try {
    while (state.playing && glActive() && !matrixG()) {
      const [w, h] = C.fitSize(state.src.w, state.src.h, FIT_EDGE);
      if (fitCanvas.width !== w || fitCanvas.height !== h) { fitCanvas.width = w; fitCanvas.height = h; }
      fctx.drawImage(playSource(), 0, 0, w, h);
      const t = current();
      const dt = lastFitTime === null ? 0 : Math.max(0, Math.min(0.5, t - lastFitTime));
      lastFitTime = t;
      const data = fctx.getImageData(0, 0, w, h);
      const t0 = performance.now();
      const r = await call({ type: 'fit', rgba: data.data.buffer, w, h, opts: buildOpts(dt) }, [data.data.buffer]);
      if (!state.playing || !glActive() || matrixG()) break;
      gl.setCoeffs(new Float32Array(r.a), new Float32Array(r.b), r.w, r.h);
      state.fits = (state.fits || 0) + 1;
      if (state.src.kind === 'demo') renderGL();
      $('stMethod').innerHTML = `<b>${byId[state.method].name}</b>`;
      $('stTime').textContent = `播放：GPU 即時套用 · 色彩每 ${(performance.now() - t0).toFixed(0)} ms 由完整演算法更新（${w}×${h}）`;
    }
  } catch (err) {
    showError(err.message);
    failed = true;
  } finally {
    fitRunning = false;
  }
  // 出錯（例如背景執行緒剛被重新啟動）而且還在播放：稍後自己接回來，不要停在「色彩計算中…」
  if (failed && state.playing && glActive()) setTimeout(fitLoop, 300);
}

// ---------------- 播放 ----------------
let lastMediaTime = null, demoTimer = 0;
function onVideoFrame(_now, meta) {
  if (!state.playing) return;
  if (glActive()) renderGL(meta ? meta.mediaTime : undefined);
  else if (!busy) {
    const t = meta ? meta.mediaTime : video.currentTime;
    const dt = lastMediaTime === null ? 0 : Math.max(0, Math.min(0.5, t - lastMediaTime));
    lastMediaTime = t;
    processFrame(dt);
  }
  updateTime();
  nextFrame();
}
function nextFrame() {
  if ('requestVideoFrameCallback' in video) video.requestVideoFrameCallback(onVideoFrame);
  else requestAnimationFrame(() => onVideoFrame(0, null));
}

function play() {
  if (!state.src || state.src.kind === 'image') return;
  state.playing = true;
  $('play').textContent = '⏸';
  $('play').setAttribute('aria-label', '暫停');
  resetTemporal();
  startGL();
  if (state.src.kind === 'video') {
    const p = video.play();
    if (p) p.catch((e) => {
      if (!state.playing) return; // 使用者已經按了暫停
      if (e.name === 'AbortError' && !video.paused) return;
      stopPlaybackUi();
      showError(e.name === 'NotAllowedError' ? '瀏覽器擋下了播放，請再按一次 ▶。' : '播放被中斷，請再按一次 ▶。（' + e.message + '）');
    });
    nextFrame();
  } else {
    let last = performance.now(), lastIdx = demo.idx, acc = 0;
    const tick = (now) => {
      if (!state.playing) return;
      acc += (now - last) / 1000;
      last = now;
      const adv = Math.floor(acc * demo.fps);
      if (adv > 0 && glActive()) {
        acc -= adv / demo.fps;
        const prev = demo.idx;
        demo.idx = (demo.idx + adv) % demo.frames.length;
        if (demo.idx < prev) resetTemporal(); // 循環回開頭 = 換鏡頭
        demo.canvas.getContext('2d').putImageData(demo.frames[demo.idx], 0, 0);
        renderGL();
        updateTime();
      } else if (adv > 0 && !busy) {
        acc -= adv / demo.fps;
        demo.idx = (demo.idx + adv) % demo.frames.length;
        if (demo.idx < lastIdx) resetTemporal(); // 循環回開頭 = 換鏡頭
        const dt = demo.idx >= lastIdx ? (demo.idx - lastIdx) / demo.fps : 0;
        lastIdx = demo.idx;
        processFrame(dt);
        updateTime();
      }
      demoTimer = requestAnimationFrame(tick);
    };
    demoTimer = requestAnimationFrame(tick);
  }
}
function pause() {
  state.playing = false;
  $('play').textContent = '▶';
  $('play').setAttribute('aria-label', '播放');
  stopGL();
  if (state.src?.kind === 'video') video.pause();
  cancelAnimationFrame(demoTimer);
  resetTemporal();
  processFrame(null);
}
$('play').onclick = () => (state.playing ? pause() : play());
video.onended = () => { if (state.playing) pause(); };
// 不是我們自己暫停（例如瀏覽器省電、來電、耳機拔除）：介面回到暫停狀態並處理目前畫面
video.addEventListener('pause', () => {
  if (state.playing && state.src?.kind === 'video' && !video.ended) stopPlaybackUi();
});
function stopPlaybackUi() {
  state.playing = false;
  stopGL();
  $('play').textContent = '▶';
  $('play').setAttribute('aria-label', '播放');
  resetTemporal();
  processFrame(null);
}

// 聲音：預設開（靜音又看不見的影片會被 Android Chrome 自動暫停，所以用音量 0 代替 muted）
function setSound(on) {
  video.muted = false;
  video.volume = on ? 1 : 0;
  $('mute').textContent = on ? '🔊' : '🔈';
  $('mute').setAttribute('aria-label', on ? '關閉聲音' : '開啟聲音');
  $('mute').setAttribute('aria-pressed', String(!on));
}
$('mute').onclick = () => setSound(video.volume === 0);
setSound(true);

function duration() {
  if (!state.src) return 0;
  if (state.src.kind === 'video') return video.duration || 0;
  if (state.src.kind === 'demo') return demo.frames.length / demo.fps;
  return 0;
}
function current() {
  if (state.src?.kind === 'video') return video.currentTime;
  if (state.src?.kind === 'demo') return demo.idx / demo.fps;
  return 0;
}
function updateTime() {
  const d = duration(), c = current();
  $('time').textContent = `${fmtTime(c)} / ${fmtTime(d)}`;
  if (!seeking) $('seek').value = d ? String(Math.round((c / d) * 1000)) : '0';
}
let seeking = false;
$('seek').addEventListener('input', async () => {
  seeking = true;
  const t = (+$('seek').value / 1000) * duration();
  if (state.src?.kind === 'video') {
    video.currentTime = t;
  } else if (state.src?.kind === 'demo') {
    demo.idx = Math.min(demo.frames.length - 1, Math.round(t * demo.fps));
    resetTemporal();
    processFrame(null);
  }
  updateTime();
});
$('seek').addEventListener('change', () => { seeking = false; });
video.addEventListener('seeked', () => {
  if (!state.playing) {
    resetTemporal();
    processFrame(null);
  }
  updateTime();
});

// ---------------- 載入素材 ----------------
async function openFile(file) {
  if (!file) return;
  pause0();
  try {
    if (file.type.startsWith('image/') || /\.(jpe?g|png|webp|heic|bmp)$/i.test(file.name)) {
      const bitmap = await createImageBitmap(file);
      setSource({ kind: 'image', bitmap, w: bitmap.width, h: bitmap.height, file, name: file.name });
    } else {
      if (video.src) URL.revokeObjectURL(video.src);
      video.src = URL.createObjectURL(file);
      await new Promise((ok, bad) => {
        video.onloadeddata = ok;
        video.onerror = () => bad(new Error('瀏覽器無法解碼這個影片格式（可試 MP4/H.264；開源版 Chromium 不含 H.264）'));
      });
      // loadeddata 時第一幀不一定已可繪製；跳到 0 秒等 seeked 後再取畫面
      await new Promise((ok) => {
        video.addEventListener('seeked', ok, { once: true });
        video.currentTime = 0;
      });
      setSource({ kind: 'video', w: video.videoWidth, h: video.videoHeight, file, name: file.name });
    }
  } catch (err) {
    showError(err.message);
  }
}
function pause0() {
  if (state.playing) {
    state.playing = false;
    stopGL();
    video.pause();
    cancelAnimationFrame(demoTimer);
    $('play').textContent = '▶';
  }
}
function setSource(src) {
  state.src = src;
  hasResult = false;
  $('empty').hidden = true;
  // 播放區跟著影片比例（直式影片也能看到全貌）；太高時由 CSS max-height 限制，畫面以 contain 縮放
  viewer.style.aspectRatio = `${src.w} / ${src.h}`;
  $('play').disabled = $('seek').disabled = src.kind === 'image';
  $('mute').disabled = src.kind !== 'video';
  video.hidden = src.kind !== 'video';
  $('export').disabled = false;
  $('exportNote').textContent = src.kind === 'image' ? `照片 ${src.w}×${src.h}，匯出 PNG。` : `影片 ${src.w}×${src.h}，匯出 MP4（H.264，保留音軌）。`;
  if (src.kind === 'demo') $('exportNote').textContent = '合成示範影片，匯出 MP4。';
  $('stQuality').textContent = '';
  resetTemporal();
  updateTime();
  processFrame(null);
  ensureTrack();
  if (state.view === 'compare') runCompare();
}

$('file').addEventListener('change', (e) => openFile(e.target.files[0]));
const viewer = $('viewer');
viewer.addEventListener('dragover', (e) => { e.preventDefault(); viewer.classList.add('drag'); });
viewer.addEventListener('dragleave', () => viewer.classList.remove('drag'));
viewer.addEventListener('drop', (e) => {
  e.preventDefault();
  viewer.classList.remove('drag');
  openFile(e.dataTransfer.files[0]);
});

$('demo').onclick = () => {
  pause0();
  $('demo').disabled = true;
  $('demo').textContent = '產生中…';
  // 讓按鈕狀態先畫出來，再做 CPU 運算
  setTimeout(() => {
    const w = 480, h = 270, frames = [];
    for (const { frame } of syntheticClip({ w, h, frames: 96, pan: 2, water: 'blue', jitter: 0.04 })) {
      frames.push(new ImageData(C.toRGBA(frame), w, h));
    }
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    demo = { frames, fps: 24, idx: 0, canvas };
    $('demo').disabled = false;
    $('demo').textContent = '合成示範';
    setSource({ kind: 'demo', w, h, name: 'demo' });
  }, 30);
};

// ---------------- 分割線 ----------------
function setSplitFromEvent(e) {
  const r = contentRect(), vr = r.vr;
  state.split = Math.min(1, Math.max(0, (e.clientX - vr.left - r.left) / r.width));
  draw();
}
let dragging = false;
viewer.addEventListener('pointerdown', (e) => {
  if (!state.src || !(state.view === 'split' || state.view === 'compare')) return;
  dragging = true;
  viewer.setPointerCapture(e.pointerId);
  setSplitFromEvent(e);
});
viewer.addEventListener('pointermove', (e) => dragging && setSplitFromEvent(e));
viewer.addEventListener('pointerup', () => { dragging = false; });
$('handle').addEventListener('keydown', (e) => {
  const d = e.key === 'ArrowLeft' ? -0.02 : e.key === 'ArrowRight' ? 0.02 : 0;
  if (d) { state.split = Math.min(1, Math.max(0, state.split + d)); draw(); e.preventDefault(); }
});
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && e.target === document.body && state.src && state.src.kind !== 'image') {
    e.preventDefault();
    state.playing ? pause() : play();
  }
});

// ---------------- 檢視方式 ----------------
for (const b of document.querySelectorAll('.seg button')) {
  b.onclick = () => {
    state.view = b.dataset.view;
    for (const x of document.querySelectorAll('.seg button')) x.classList.toggle('on', x === b);
    $('compare').hidden = state.view !== 'compare';
    draw();
    if (state.view === 'compare') runCompare();
  };
}

async function runCompare() {
  if (!state.src) return;
  const box = $('compare');
  box.innerHTML = `<p class="note">${METHODS.length} 種方法計算中…（深度模型第一次載入需要幾秒）</p>`;
  const [w, h] = C.fitSize(orig.width, orig.height, 480);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d').drawImage(orig, 0, 0, w, h);
  const data = c.getContext('2d').getImageData(0, 0, w, h);
  try {
    const r = await call({ type: 'compare', rgba: data.data.buffer, w, h, methods: METHODS.map((m) => m.id), params: state.params, post: +$('post').value }, [data.data.buffer]);
    box.innerHTML = '';
    for (const t of r.tiles) {
      const m = byId[t.id];
      const tile = document.createElement('button');
      tile.type = 'button';
      tile.className = 'tile' + (t.id === state.method ? ' on' : '');
      const cv = document.createElement('canvas');
      cv.width = w;
      cv.height = h;
      if (t.rgba) cv.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(t.rgba), w, h), 0, 0);
      tile.append(cv);
      const meta = t.rgba ? `UIQM ${t.uiqm.toFixed(2)} · UCIQE ${t.uciqe.toFixed(3)} · ${t.ms.toFixed(0)} ms` : t.error;
      const info = document.createElement('div');
      info.innerHTML = `<div class="nm">${m.name}</div><div class="meta">${meta}</div>`;
      tile.append(info);
      tile.onclick = () => selectMethod(t.id);
      box.append(tile);
    }
  } catch (err) {
    box.innerHTML = `<p class="note err">${err.message}</p>`;
  }
}

// ---------------- 方法與參數 ----------------
function renderMethods() {
  const box = $('methods');
  box.innerHTML = '';
  METHODS.forEach((m, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'method';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(m.id === state.method));
    b.innerHTML = `<span class="n">${i + 1}</span><span class="t">${m.name}<span class="k">${m.kind}</span></span><span class="s">${m.cite}</span>`;
    b.onclick = () => selectMethod(m.id);
    box.append(b);
  });
}
function selectMethod(id) {
  state.method = id;
  renderMethods();
  renderParams();
  for (const t of document.querySelectorAll('.tile')) t.classList.toggle('on', t.querySelector('.nm')?.textContent === byId[id].name);
  const m = byId[id];
  if (m.needsModel && !state.models.has(m.model.file)) {
    worker.postMessage({ type: 'loadModel', file: m.model.file }); // 選了就開始載入，不必等有畫面
    const mb = m.model.mb + (state.models.size ? 0 : 14); // 第一個模型還要下載 ONNX 執行環境（14 MB）
    showModelNote(`第一次使用會下載 ${m.short} 模型${state.models.size ? '' : '與 ONNX 執行環境'}（約 ${mb < 1 ? mb.toFixed(1) : Math.round(mb)} MB），存在本機後就不用再下載。`);
  }
  // 深度模型在影片中預設每 4 幀重算一次網路（其餘幀沿用並平滑係數）
  if (m.needsModel && +$('tEvery').value === 1) setRange('tEvery', 4);
  save();
  resetTemporal();
  processFrame(null);
  ensureTrack();
}
function setRange(id, v) {
  $(id).value = String(v);
  $(id).dispatchEvent(new Event('input'));
}
function renderParams() {
  const m = byId[state.method], box = $('params'), vals = state.params[m.id];
  box.innerHTML = '';
  for (const p of m.params) {
    const wrap = document.createElement('div');
    wrap.className = 'ctl';
    const id = `p_${p.key}`;
    if (p.options) {
      wrap.innerHTML = `<label for="${id}">${p.label}</label><select id="${id}">${p.options.map(([v, t]) => `<option value="${v}"${v === vals[p.key] ? ' selected' : ''}>${t}</option>`).join('')}</select>`;
      wrap.querySelector('select').addEventListener('change', (e) => { vals[p.key] = +e.target.value; onParamChange(); });
      box.append(wrap);
      continue;
    }
    const isAuto = p.auto && vals[p.key] < 0;
    wrap.innerHTML = `<label for="${id}">${p.label} <output>${isAuto ? '自動' : fmt(vals[p.key], p.step)}</output></label>
      <input type="range" id="${id}" min="${p.min}" max="${p.max}" step="${p.step}" value="${isAuto ? (p.min + p.max) / 2 : vals[p.key]}" ${isAuto ? 'disabled' : ''}>
      ${p.auto ? `<label class="auto"><input type="checkbox" ${isAuto ? 'checked' : ''}> 自動判斷</label>` : ''}`;
    const range = wrap.querySelector('input[type=range]'), out = wrap.querySelector('output');
    range.addEventListener('input', () => {
      vals[p.key] = +range.value;
      out.textContent = fmt(+range.value, p.step);
      onParamChange();
    });
    const auto = wrap.querySelector('.auto input');
    if (auto) auto.addEventListener('change', () => {
      range.disabled = auto.checked;
      vals[p.key] = auto.checked ? -1 : +range.value;
      out.textContent = auto.checked ? '自動' : fmt(+range.value, p.step);
      onParamChange();
    });
    box.append(wrap);
  }
  if (m.keyframes) {
    const n = document.createElement('p');
    n.className = 'hint';
    n.textContent = '影片會先分析整支片：每隔所選秒數取一個關鍵幀，中間線性內插（同 DIVEROUT）。下方「影片時間一致性」對這個方法不作用。';
    box.append(n);
  }
  $('modelState').hidden = !(m.needsModel && !state.models.has(m.model.file)) && !(m.keyframes && usesKeys() && !(track && track.ready && track.pkey === paramKey()));
}
const fmt = (v, step) => (step >= 1 ? String(Math.round(v)) : (+v).toFixed(step < 0.1 ? 2 : 1));
let paramTimer = 0;
function onParamChange() {
  save();
  clearTimeout(paramTimer);
  paramTimer = setTimeout(() => {
    resetTemporal();
    ensureTrack();
    if (!state.playing) processFrame(null);
    if (state.view === 'compare') runCompare();
  }, 60);
}
$('resetParams').onclick = () => {
  state.params[state.method] = defaults(byId[state.method]);
  renderParams();
  onParamChange();
};

function onModel(m) {
  if (m.state === 'ready') state.models.add(m.file);
  const cur = byId[state.method];
  if (!cur.needsModel || cur.model.file !== m.file) return; // 只顯示目前方法的模型狀態
  if (m.state === 'progress') {
    const pct = m.total ? ` ${Math.round((m.got / m.total) * 100)}%` : '';
    showModelNote(`下載模型中… ${(m.got / 1e6).toFixed(1)} MB${pct}`);
  } else if (m.state === 'ready') {
    showModelNote(m.fromCache ? '模型已從本機載入（不需下載）。' : '模型已下載並存在本機，之後不用再下載。');
    // 請瀏覽器把資料列為永久儲存，空間不足時較不會被清除（瀏覽器可能自動決定或忽略）
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    setTimeout(() => { $('modelState').hidden = true; }, 2500);
  } else if (m.state === 'error') {
    showModelNote('模型載入失敗：' + m.message, true);
  }
}
// ---------------- 預先下載全部模型 ----------------
// 第一次開啟就在背景把 ONNX 執行環境與全部深度模型存進本機（已存在的略過），之後選用免等待、可離線。
function onPrefetch(m) {
  const box = $('prefetch'), bar = $('prefetchBar');
  if (!m.done) {
    box.hidden = false;
    bar.hidden = false;
    bar.value = m.total ? Math.min(1, m.got / m.total) : 0;
    $('prefetchText').textContent = `第一次使用：下載深度模型存到本機 ${(m.got / 1e6).toFixed(1)} / ${(m.total / 1e6).toFixed(0)} MB（之後不用再下載）`;
    return;
  }
  if (!m.downloaded && !m.failed) { box.hidden = true; return; }
  bar.hidden = true;
  box.hidden = false;
  $('prefetchText').textContent = m.failed
    ? `有 ${m.failed} 個模型下載失敗，選用時會再試一次。`
    : `${METHODS.filter((x) => x.needsModel).length} 個深度模型都已存在本機，之後可離線使用。`;
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  setTimeout(() => { box.hidden = true; }, 5000);
}
setTimeout(() => worker.postMessage({ type: 'prefetch' }), 1000);

function showModelNote(text, err = false) {
  const n = $('modelState');
  n.hidden = false;
  n.textContent = text;
  n.classList.toggle('err', err);
}

// ---------------- 其他控制 ----------------
function bindRange(id, fmtFn) {
  const el = $(id), out = $(id + 'V');
  const upd = () => { if (out) out.textContent = fmtFn(+el.value); };
  el.addEventListener('input', () => { upd(); onParamChange(); });
  upd();
}
const ui = saved.ui || {};
if (ui.tOn !== undefined) $('tOn').checked = ui.tOn;
for (const k of ['tTau', 'tDef', 'tEvery', 'mix', 'post']) if (ui[k] !== undefined) $(k).value = String(ui[k]);
for (const k of ['prevRes', 'outRes', 'netExp']) if (ui[k] !== undefined) $(k).value = ui[k];
bindRange('tTau', (v) => (v === 0 ? '關' : `${v.toFixed(2)} 秒`));
bindRange('tDef', (v) => (v === 0 ? '關' : `${Math.round(v * 100)}%`));
bindRange('tEvery', (v) => `${v}`);
bindRange('mix', (v) => `${Math.round(v * 100)}%`);
bindRange('post', (v) => (v === 0 ? '關' : `${Math.round(v * 100)}%`));
$('tOn').addEventListener('change', onParamChange);
$('prevRes').addEventListener('change', () => { save(); resetTemporal(); processFrame(null); });
$('outRes').addEventListener('change', save);
$('netExp').addEventListener('change', save);
$('measure').onclick = measure;

// ---------------- 匯出 ----------------
let cancelExport = null;
function outSize(w, h) {
  const v = +$('outRes').value;
  let [ow, oh] = v ? C.fitSize(w, h, LONG_EDGE[v]) : [w, h];
  return [ow & ~1 || 2, oh & ~1 || 2];
}
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}
const baseName = () => (state.src.name || 'watertool').replace(/\.[^.]+$/, '') + `_${state.method}`;

$('export').onclick = async () => {
  if (!state.src) return;
  pause0();
  const prog = $('prog');
  prog.hidden = false;
  prog.value = 0;
  $('export').disabled = true;
  $('cancel').hidden = false;
  const t0 = performance.now();
  try {
    worker.postMessage({ type: 'reset', slot: 'export' });
    if (usesKeys()) {
      $('exportNote').textContent = '分析關鍵幀…';
      await ensureTrack();
      if (!keyG(0)) throw new Error('關鍵幀分析未完成');
    }
    if (state.src.kind === 'image') await exportImage();
    else if (state.src.kind === 'video') await (fastExport() ? exportVideoFast() : exportVideo());
    else await exportDemo();
    $('exportNote').textContent = `完成，用時 ${((performance.now() - t0) / 1000).toFixed(1)} 秒。`;
  } catch (err) {
    if (err && err.name === 'ConversionCanceledError') $('exportNote').textContent = '已取消。';
    else showError('匯出失敗：' + err.message);
  } finally {
    $('export').disabled = false;
    $('cancel').hidden = true;
    prog.hidden = true;
    cancelExport = null;
  }
};
$('cancel').onclick = () => cancelExport && cancelExport();

async function processExport(ctx2d, w, h, dt, t = 0) {
  const data = ctx2d.getImageData(0, 0, w, h);
  const u = readUi();
  const opts = buildOpts(dt, t);
  if (dt !== null && !u.tOn) delete opts.video;
  const r = await call({ type: 'process', slot: 'export', rgba: data.data.buffer, w, h, opts }, [data.data.buffer]);
  ctx2d.putImageData(new ImageData(new Uint8ClampedArray(r.rgba), w, h), 0, 0);
}

async function exportImage() {
  const { bitmap, w, h } = state.src;
  const [ow, oh] = +$('outRes').value ? outSize(w, h) : [w, h];
  const c = document.createElement('canvas');
  c.width = ow;
  c.height = oh;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(bitmap, 0, 0, ow, oh);
  $('exportNote').textContent = `處理 ${ow}×${oh}…`;
  let canceled = false;
  cancelExport = () => { canceled = true; };
  await processExport(x, ow, oh, null);
  if (canceled) throw Object.assign(new Error('canceled'), { name: 'ConversionCanceledError' });
  $('prog').value = 1;
  const blob = await new Promise((ok) => c.toBlob(ok, 'image/png'));
  download(blob, baseName() + '.png');
}

async function loadMediabunny() {
  return import('./vendor/mediabunny.min.mjs');
}

async function exportVideo() {
  if (!('VideoEncoder' in window)) throw new Error('此瀏覽器不支援 WebCodecs 影片編碼（請用新版 Chrome / Edge / Safari 17+）');
  const MB = await loadMediabunny();
  const { w, h } = state.src;
  const [ow, oh] = outSize(w, h);
  const input = new MB.Input({ source: new MB.BlobSource(state.src.file), formats: MB.ALL_FORMATS });
  const output = new MB.Output({ format: new MB.Mp4OutputFormat({ fastStart: 'in-memory' }), target: new MB.BufferTarget() });
  const codec = await MB.getFirstEncodableVideoCodec(['avc', 'hevc', 'vp9', 'av1'], { width: ow, height: oh });
  if (!codec) throw new Error(`無法以 ${ow}×${oh} 編碼影片，請降低匯出解析度`);
  const c = new OffscreenCanvas(ow, oh), x = c.getContext('2d', { willReadFrequently: true });
  let prevTs = null;
  const conv = await MB.Conversion.init({
    input,
    output,
    video: {
      codec,
      quality: MB.QUALITY_HIGH,
      forceTranscode: true,
      processedWidth: ow,
      processedHeight: oh,
      process: async (sample) => {
        sample.draw(x, 0, 0, ow, oh);
        const dt = prevTs === null ? 0 : sample.timestamp - prevTs;
        prevTs = sample.timestamp;
        await processExport(x, ow, oh, dt, sample.timestamp);
        return c;
      },
    },
  });
  if (!conv.isValid) throw new Error('無法轉檔：' + conv.discardedTracks.map((d) => d.reason).join(', '));
  conv.onProgress = (p) => {
    $('prog').value = p;
    $('exportNote').textContent = `處理中 ${Math.round(p * 100)}%（${ow}×${oh}，${codec.toUpperCase()}）`;
  };
  cancelExport = () => conv.cancel();
  await conv.execute();
  download(new Blob([output.target.buffer], { type: 'video/mp4' }), baseName() + '.mp4');
}

// ---- 快速影片匯出（所有方法）----
// 每隔 0.5 / 1 秒的關鍵幀完整計算一次，得到「原片 → 結果」的色彩轉換，匯出每一格時把前後關鍵幀線性內插，由 GPU 套到原解析度：
//   深度模型：網路本身輸出的局部仿射係數（net.js，與逐格版逐像素相差 ≤ 1）
//   Diverout_sim：整支片的關鍵幀色階 → 全域 3×4 色彩矩陣（與逐格版相同）
//   其他方法：關鍵幀在長邊 640 的圖上完整處理，擬合成局部仿射係數（細部對比較柔，詳見 README）
// 每一格只剩 GPU 繪製與編碼。「逐格完整計算」保留舊做法。
function fastExport() {
  return state.src.kind === 'video' && +$('netExp').value > 0 && typeof OffscreenCanvas !== 'undefined' && glPlayer() !== null;
}
async function exportVideoFast() {
  if (!('VideoEncoder' in window)) throw new Error('此瀏覽器不支援 WebCodecs 影片編碼（請用新版 Chrome / Edge / Safari 17+）');
  const method = state.method, m = byId[method], params = { ...state.params[method] }, interval = +$('netExp').value;
  const post = +$('post').value;
  const kind = m.keyframes && post === 0 ? 'matrix' : m.needsModel && post === 0 ? 'net' : 'fit';
  let canceled = false;
  cancelExport = () => { canceled = true; };
  const t0 = performance.now();
  let keys;
  if (kind === 'matrix') {
    await ensureTrack(); // Diverout_sim 自己的關鍵幀（模式決定間隔）
    keys = track.keys;
  } else {
    const msg = kind === 'net' ? undefined : { type: 'keyfit', opts: { method, params, post } };
    keys = await collectKeys(state.src, method, params, interval, 640, () => canceled, (i, n) => {
      $('prog').value = ((i - 1) / n) * 0.5;
      $('exportNote').textContent = `${m.short}：關鍵幀 ${i}/${n}（每 ${interval} 秒完整計算一次）`;
    }, msg);
  }
  if (canceled) throw Object.assign(new Error('canceled'), { name: 'ConversionCanceledError' });
  const tKeys = (performance.now() - t0) / 1000;
  const MB = await loadMediabunny();
  const { w, h } = state.src;
  const [ow, oh] = outSize(w, h);
  const input = new MB.Input({ source: new MB.BlobSource(state.src.file), formats: MB.ALL_FORMATS });
  const output = new MB.Output({ format: new MB.Mp4OutputFormat({ fastStart: 'in-memory' }), target: new MB.BufferTarget() });
  const codec = await MB.getFirstEncodableVideoCodec(['avc', 'hevc', 'vp9', 'av1'], { width: ow, height: oh });
  if (!codec) throw new Error(`無法以 ${ow}×${oh} 編碼影片，請降低匯出解析度`);
  const c = new OffscreenCanvas(ow, oh), x = c.getContext('2d');
  const glc = new OffscreenCanvas(ow, oh), g = new GLPlayer(glc, { preserve: true });
  const mix = +$('mix').value, pre = kind === 'net' ? params.amount : 1;
  let frames = 0, seg = -1, firstTs = null;
  // 係數：目前所在區段的前後兩個關鍵幀各上傳一次，GPU 依時間比例內插
  const setKeyPair = (t) => {
    let j = keys.findIndex((k) => k.t >= t);
    if (j < 0) j = keys.length - 1;
    const i = Math.max(0, j - 1), a = j === i ? 0 : Math.min(1, Math.max(0, (t - keys[i].t) / (keys[j].t - keys[i].t || 1)));
    if (j * keys.length + i !== seg) {
      seg = j * keys.length + i;
      g.setNetCoeffs(keys[i].g, 0);
      g.setNetCoeffs(keys[j].g, 1);
    }
    g.setKeyMix(a);
  };
  const conv = await MB.Conversion.init({
    input,
    output,
    video: {
      codec,
      quality: MB.QUALITY_HIGH,
      forceTranscode: true,
      processedWidth: ow,
      processedHeight: oh,
      process: (sample) => {
        sample.draw(x, 0, 0, ow, oh);
        if (firstTs === null) firstTs = sample.timestamp;
        const t = sample.timestamp - firstTs; // 關鍵幀時間從影片第一格起算
        if (kind === 'matrix') g.setMatrix(diverMatrix(interpKeys(keys, t)));
        else setKeyPair(t);
        g.draw(c, { mode: 'result', amount: mix, pre });
        frames++;
        return glc;
      },
    },
  });
  if (!conv.isValid) throw new Error('無法轉檔：' + conv.discardedTracks.map((d) => d.reason).join(', '));
  conv.onProgress = (p) => {
    $('prog').value = 0.5 + p / 2;
    $('exportNote').textContent = `GPU 套用並編碼 ${Math.round(p * 100)}%（${ow}×${oh}，${codec.toUpperCase()}，${keys.length} 個關鍵幀）`;
  };
  cancelExport = () => conv.cancel();
  try {
    await conv.execute();
  } finally {
    g.dispose();
  }
  state.lastExport = { fast: true, kind, keys: keys.length, frames, keySec: tKeys };
  download(new Blob([output.target.buffer], { type: 'video/mp4' }), baseName() + '.mp4');
}

async function exportDemo() {
  if (!('VideoEncoder' in window)) throw new Error('此瀏覽器不支援 WebCodecs 影片編碼');
  const MB = await loadMediabunny();
  const { w, h } = state.src;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const x = c.getContext('2d', { willReadFrequently: true });
  const output = new MB.Output({ format: new MB.Mp4OutputFormat({ fastStart: 'in-memory' }), target: new MB.BufferTarget() });
  const codec = await MB.getFirstEncodableVideoCodec(['avc', 'vp9', 'av1'], { width: w, height: h });
  if (!codec) throw new Error('此瀏覽器無可用的影片編碼器');
  const src = new MB.CanvasSource(c, { codec, bitrate: MB.QUALITY_HIGH });
  output.addVideoTrack(src, { frameRate: demo.fps });
  await output.start();
  let canceled = false;
  cancelExport = () => { canceled = true; };
  for (let i = 0; i < demo.frames.length; i++) {
    if (canceled) {
      await output.cancel();
      throw Object.assign(new Error('canceled'), { name: 'ConversionCanceledError' });
    }
    x.putImageData(demo.frames[i], 0, 0);
    await processExport(x, w, h, i ? 1 / demo.fps : 0, i / demo.fps);
    await src.add(i / demo.fps, 1 / demo.fps);
    $('prog').value = (i + 1) / demo.frames.length;
  }
  src.close();
  await output.finalize();
  download(new Blob([output.target.buffer], { type: 'video/mp4' }), 'watertool_demo_' + state.method + '.mp4');
}

// ---------------- 說明區 ----------------
function renderAbout() {
  const box = $('about');
  box.innerHTML = '';
  METHODS.forEach((m, i) => {
    const info = INFO[m.id];
    const d = document.createElement('details');
    d.innerHTML = `<summary>${i + 1}. ${m.name}</summary>
      <p>${info.summary}</p>
      <p>論文：<a href="${info.paper[1]}" target="_blank" rel="noopener">${m.cite}（${info.paper[0]}）</a></p>
      <p>程式碼：${info.code.map(([t, u]) => `<a href="${u}" target="_blank" rel="noopener">${t}</a>`).join('、')}</p>`;
    box.append(d);
  });
}

function showError(msg) {
  console.error(msg);
  const n = $('exportNote');
  n.textContent = msg;
  n.classList.add('err');
  setTimeout(() => n.classList.remove('err'), 6000);
}

// ---------------- PWA ----------------
// 「安裝 App」一直顯示（已安裝則隱藏）：瀏覽器支援就直接跳安裝視窗，否則依裝置與瀏覽器說明該怎麼做。
let installEvt = null;
const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
$('install').hidden = standalone();
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installEvt = e;
});
window.addEventListener('appinstalled', () => { $('install').hidden = true; });
$('install').onclick = async () => {
  if (installEvt) {
    installEvt.prompt();
    const { outcome } = await installEvt.userChoice;
    installEvt = null;
    if (outcome === 'accepted') $('install').hidden = true;
    return;
  }
  $('installText').innerHTML = installHelp(navigator.userAgent);
  $('installHelp').showModal();
};
$('installClose').onclick = () => $('installHelp').close();

export function installHelp(ua) {
  const url = location.href.split('#')[0];
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const inApp = /FBAN|FBAV|Instagram|Line\/|MicroMessenger|GitHub|Claude|; wv\)|WebView/i.test(ua);
  const step = (t) => `<li>${t}</li>`;
  if (inApp) {
    return `<p>你現在是在其他 App 裡的內建瀏覽器開啟，這種瀏覽器不能安裝 App。</p><ol>${
      step('按右上角選單（⋮ 或 ⋯），選「用瀏覽器開啟」' + (ios ? '（Safari）' : '（Chrome）') + '；或複製下面的網址貼到瀏覽器。') +
      step(ios ? '在 Safari 按下方「分享」□↑ → 「加入主畫面」。' : '在 Chrome 按右上角 ⋮ → 「安裝應用程式」或「加到主畫面」。')
    }</ol><p class="url">${url}</p>`;
  }
  if (ios) {
    return /CriOS|FxiOS|EdgiOS/.test(ua)
      ? `<ol>${step('iPhone / iPad 的 Chrome、Edge 也可以：按網址列旁的「分享」□↑。') + step('選「加入主畫面」→「新增」。')}</ol>`
      : `<ol>${step('在 Safari 按下方（或上方）的「分享」□↑。') + step('往下滑，選「加入主畫面」→ 右上角「新增」。')}</ol><p>iPhone 不會出現「安裝應用程式」，「加入主畫面」就是安裝。</p>`;
  }
  if (/SamsungBrowser/.test(ua)) return `<ol>${step('按右下角選單 ≡。') + step('選「新增頁面至」→「主畫面」。')}</ol>`;
  if (/Firefox/.test(ua)) return `<ol>${step('按右上角 ⋮。') + step('選「安裝」或「加到主畫面」。')}</ol>`;
  if (/Android/.test(ua)) {
    return `<ol>${step('按 Chrome 右上角 ⋮。') + step('選「安裝應用程式」；若只看到「加到主畫面」，選它再選「安裝」也一樣。')}</ol>` +
      '<p>若兩者都沒有：確認不是無痕分頁，並重新整理頁面再試一次（Chrome 需要先完整載入一次）。</p>';
  }
  return `<ol>${step('Chrome / Edge：網址列右側的「安裝」圖示 ⊕，或選單 ⋮ →「投放、儲存及分享」→「安裝網頁應用程式」。') + step('Safari（macOS）：「檔案」→「加入 Dock」。')}</ol>`;
}

if ('serviceWorker' in navigator && (location.protocol === 'https:' || /[?&]sw\b/.test(location.search))) { // ?sw：本機測試用
  navigator.serviceWorker.register('sw.js').catch(() => {});
  // Service Worker 接手後頁面才有跨來源隔離標頭（深度模型多執行緒）。第一次開啟或剛更新時重新整理一次 ——
  // 只在還沒開任何素材時做，不打斷使用者；sessionStorage 防止不支援的瀏覽器一直重整。
  const reloadOnce = () => {
    if (self.crossOriginIsolated || state.src) return;
    try {
      if (sessionStorage.getItem('watertool-coi')) return;
      sessionStorage.setItem('watertool-coi', '1');
    } catch { return; }
    location.reload();
  };
  navigator.serviceWorker.addEventListener('controllerchange', reloadOnce);
}

renderMethods();
renderParams();
renderAbout();
placeOverlay();
window.__watertool = { // 給自動化測試用
  state, call, renderGL, select: (id) => selectMethod(id),
  origCanvas: () => orig,
  glState: () => (gl === null ? 'null' : gl === false ? 'false' : 'ok') + (glview.hidden ? ' hidden' : ' shown'),
  hangWorker: (ms) => { WATCHDOG = ms; worker.postMessage({ type: 'hang', debug: 'hang-test' }); },
  keyInfo: () => ({ ready: !!(track && track.ready && keyG(0)), keys: track ? track.keys.length : 0, matrix: glActive() && !!matrixG() }),
};
