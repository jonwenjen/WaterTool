// WaterTool 介面：載入影片/照片 → 背景執行緒還原 → 分割比較 → 匯出。
import { METHODS, byId, defaults } from './lib/methods/index.js';
import { INFO } from './lib/methods/info.js';
import { syntheticClip } from './lib/synth.js';
import * as C from './lib/core.js';

const $ = (id) => document.getElementById(id);
const fmtTime = (s) => (Number.isFinite(s) ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '0:00');
const LONG_EDGE = { 480: 854, 720: 1280, 1080: 1920, 2160: 3840 };

// ---------------- 背景執行緒 ----------------
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
let seq = 0;
const pending = new Map();
function call(msg, transfer = []) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ ...msg, id }, transfer);
  });
}
worker.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'model') return onModel(m);
  const p = pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  if (m.type === 'error') p.reject(new Error(m.message));
  else p.resolve(m);
};
worker.onerror = (e) => showError('背景執行緒錯誤：' + (e.message || e));

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
  modelReady: false,
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

function previewSize() {
  const { w, h } = state.src;
  // 播放中最多以 480p 計算，維持預覽流暢；暫停 / 照片用選定的預覽解析度
  const edge = Math.min(LONG_EDGE[$('prevRes').value] || 1280, state.playing ? LONG_EDGE[480] : Infinity);
  let [pw, ph] = C.fitSize(w, h, edge);
  return [pw & ~1 || 2, ph & ~1 || 2];
}

function draw() {
  if (!state.src) return;
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
    mix: +$('mix').value, post: +$('post').value, prevRes: $('prevRes').value, outRes: $('outRes').value,
  };
}
function buildOpts(dt) {
  const u = readUi();
  const o = { method: state.method, params: state.params[state.method], mix: u.mix, post: u.post };
  if (dt !== null && u.tOn) o.video = { dt: dt || 1 / 30, tau: u.tTau, deflicker: u.tDef, every: u.tEvery };
  return o;
}

let busy = false, again = undefined; // again：處理中又收到的請求（其 dt）
async function processFrame(dt = null) {
  if (!state.src) return;
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
}

// ---------------- 播放 ----------------
let lastMediaTime = null, demoTimer = 0;
function onVideoFrame(_now, meta) {
  if (!state.playing) return;
  if (!busy) {
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
  if (state.src.kind === 'video') {
    video.play().catch((e) => showError('無法播放：' + e.message));
    nextFrame();
  } else {
    let last = performance.now(), lastIdx = demo.idx, acc = 0;
    const tick = (now) => {
      if (!state.playing) return;
      acc += (now - last) / 1000;
      last = now;
      const adv = Math.floor(acc * demo.fps);
      if (adv > 0 && !busy) {
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
  if (state.src?.kind === 'video') video.pause();
  cancelAnimationFrame(demoTimer);
  resetTemporal();
  processFrame(null);
}
$('play').onclick = () => (state.playing ? pause() : play());
video.onended = () => { if (state.playing) pause(); };

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
    video.pause();
    cancelAnimationFrame(demoTimer);
    $('play').textContent = '▶';
  }
}
function setSource(src) {
  state.src = src;
  hasResult = false;
  $('empty').hidden = true;
  $('play').disabled = $('seek').disabled = src.kind === 'image';
  $('export').disabled = false;
  $('exportNote').textContent = src.kind === 'image' ? `照片 ${src.w}×${src.h}，匯出 PNG。` : `影片 ${src.w}×${src.h}，匯出 MP4（H.264，保留音軌）。`;
  if (src.kind === 'demo') $('exportNote').textContent = '合成示範影片，匯出 MP4。';
  $('stQuality').textContent = '';
  resetTemporal();
  updateTime();
  processFrame(null);
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
  box.innerHTML = '<p class="note">七種方法計算中…（FUnIE-GAN 需先載入模型）</p>';
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
  if (byId[id].needsModel && !state.modelReady) {
    showModelNote('第一次使用會下載 FUnIE-GAN 模型與 ONNX 執行環境（約 28 MB），之後由瀏覽器快取。');
    // 影片預設每 4 幀重算一次網路（其餘幀沿用並平滑係數）
    if (+$('tEvery').value === 1) setRange('tEvery', 4);
  }
  save();
  resetTemporal();
  processFrame(null);
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
    const isAuto = p.auto && vals[p.key] < 0;
    const id = `p_${p.key}`;
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
  $('modelState').hidden = !m.needsModel || state.modelReady;
}
const fmt = (v, step) => (step >= 1 ? String(Math.round(v)) : (+v).toFixed(step < 0.1 ? 2 : 1));
let paramTimer = 0;
function onParamChange() {
  save();
  clearTimeout(paramTimer);
  paramTimer = setTimeout(() => {
    resetTemporal();
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
  if (m.state === 'progress') {
    const pct = m.total ? ` ${Math.round((m.got / m.total) * 100)}%` : '';
    showModelNote(`下載模型中… ${(m.got / 1e6).toFixed(1)} MB${pct}`);
  } else if (m.state === 'ready') {
    state.modelReady = true;
    showModelNote('模型已載入（WASM）。');
    setTimeout(() => { $('modelState').hidden = true; }, 2500);
  } else if (m.state === 'error') {
    showModelNote('模型載入失敗：' + m.message, true);
  }
}
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
for (const k of ['prevRes', 'outRes']) if (ui[k] !== undefined) $(k).value = ui[k];
bindRange('tTau', (v) => (v === 0 ? '關' : `${v.toFixed(2)} 秒`));
bindRange('tDef', (v) => (v === 0 ? '關' : `${Math.round(v * 100)}%`));
bindRange('tEvery', (v) => `${v}`);
bindRange('mix', (v) => `${Math.round(v * 100)}%`);
bindRange('post', (v) => (v === 0 ? '關' : `${Math.round(v * 100)}%`));
$('tOn').addEventListener('change', onParamChange);
$('prevRes').addEventListener('change', () => { save(); resetTemporal(); processFrame(null); });
$('outRes').addEventListener('change', save);
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
    if (state.src.kind === 'image') await exportImage();
    else if (state.src.kind === 'video') await exportVideo();
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

async function processExport(ctx2d, w, h, dt) {
  const data = ctx2d.getImageData(0, 0, w, h);
  const u = readUi();
  const opts = buildOpts(dt);
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
        await processExport(x, ow, oh, dt);
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
    await processExport(x, w, h, i ? 1 / demo.fps : 0);
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

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

renderMethods();
renderParams();
renderAbout();
placeOverlay();
window.__watertool = { state, call }; // 給自動化測試用
