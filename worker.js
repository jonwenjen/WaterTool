// 背景執行緒：所有影像運算都在這裡，介面不卡頓。
// 訊息：
//   { type:'process', id, slot, rgba, w, h, opts }  → { type:'result', id, rgba, w, h, info }
//   { type:'compare', id, rgba, w, h, methods, params, post } → { type:'compare', id, tiles:[{id, rgba, ms}] }
//   { type:'metrics', id, rgba, w, h }  → { type:'metrics', id, uiqm, uciqe }
//   { type:'reset', slot }
//   { type:'loadModel', file } → { type:'model', file, state:'progress'|'ready'|'error', ... }
import * as C from './lib/core.js';
import { Processor } from './lib/pipeline.js';
import { METHODS, byId, defaults } from './lib/methods/index.js';
import { affine, fitG } from './lib/methods/net.js';
import { uiqm, uciqe } from './lib/metrics.js';

const sessions = new Map(); // 模型檔 → InferenceSession
const ctx = {
  runNet: async (file, x, w, h) => {
    const s = sessions.get(file);
    if (!s) throw new Error('模型尚未載入：' + file);
    return (await s.session.run({ x: new s.ort.Tensor('float32', x, [1, x.length / (w * h), h, w]) })).y.data;
  },
};
const slots = { preview: new Processor(ctx), export: new Processor(ctx) };
const loading = new Map(); // 模型檔 → Promise
let runtime = null;

// 模型與 ONNX 執行環境存在獨立、不隨 App 版本清除的快取（Cache Storage），只下載一次。
// 只有這兩個檔案本身改變時才改 MODEL_CACHE 的版本號（sw.js 也用同一個名字）。
const MODEL_CACHE = 'watertool-models-v1';

const inflight = new Map(); // 同一個檔案同時只下載一次（預先下載與選用方法可能同時要）
function cachedDownload(url, onBytes) {
  if (!inflight.has(url)) {
    const p = cachedDownloadOnce(url, onBytes);
    inflight.set(url, p);
    p.finally(() => inflight.delete(url)).catch(() => {});
  }
  return inflight.get(url);
}

async function cachedDownloadOnce(url, onBytes) {
  const cache = await openModelCache();
  const hit = cache && (await cache.match(url).catch(() => null));
  if (hit) {
    const bytes = new Uint8Array(await hit.arrayBuffer());
    onBytes(bytes.length, bytes.length, true);
    return bytes;
  }
  const bytes = await download(url, (g, t) => onBytes(g, t, false));
  if (cache) {
    await cache.put(url, new Response(bytes, { headers: { 'content-type': 'application/octet-stream', 'content-length': String(bytes.length) } })).catch(() => {});
  }
  return bytes;
}

async function openModelCache() {
  try {
    return 'caches' in self ? await caches.open(MODEL_CACHE) : null;
  } catch {
    return null; // 私密模式等不能用 Cache Storage：照常下載，只是不保存
  }
}

async function download(url, onBytes) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok || !res.body) throw new Error(`下載失敗 ${url}（HTTP ${res.status}）`);
  const total = res.headers.get('content-encoding') ? 0 : Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader(), parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    onBytes(got, total);
  }
  if (total && got !== total) throw new Error(`下載不完整 ${url}（${got}/${total} bytes）`);
  const out = new Uint8Array(got);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** ONNX 執行環境（所有模型共用，只載一次）。onBytes 給 WASM 的下載進度。 */
function loadRuntime(onBytes) {
  if (runtime) return runtime;
  runtime = (async () => {
    const base = new URL('./', self.location.href);
    const ort = await importRuntime(new URL('vendor/ort/ort.wasm.bundle.min.mjs', base).href);
    const wasm = await cachedDownload(new URL('vendor/ort/ort-wasm-simd-threaded.wasm', base).href, onBytes);
    // 多執行緒需要跨來源隔離（COOP/COEP 標頭）：GitHub Pages 不能設標頭，由 sw.js 補上；沒有就單執行緒
    // 桌機最多 4 條。手機一律單執行緒：多執行緒在手機上會讓背景執行緒卡死（實際回報），穩定優先
    const mobile = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
    ort.env.wasm.numThreads = self.crossOriginIsolated && !mobile ? Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1)) : 1;
    ort.env.wasm.wasmBinary = wasm;
    return ort;
  })();
  runtime.catch(() => { runtime = null; });
  return runtime;
}

/** 載入 ONNX 執行環境的 JS 模組。行動網路偶爾斷線時 import() 會失敗，而瀏覽器會把同一網址的失敗結果記住
 *  （之後再 import 也立刻失敗、所有模型一起壞掉），所以失敗時換一個查詢字串重試；Service Worker 的離線快取忽略查詢字串。 */
async function importRuntime(url) {
  let err;
  for (let i = 0; i < 4; i++) {
    try {
      return await import(i ? `${url}?retry=${Date.now()}` : url);
    } catch (e) {
      err = e;
      await new Promise((r) => setTimeout(r, 500 * 2 ** i));
    }
  }
  throw err;
}

function loadModel(file) {
  if (loading.has(file)) return loading.get(file);
  const p = (async () => {
    const seen = {};
    let fromCache = true;
    const prog = (k) => (g, t, cached) => {
      seen[k] = [g, t];
      if (!cached) fromCache = false;
      const v = Object.values(seen);
      if (!cached) postMessage({ type: 'model', file, state: 'progress', got: v.reduce((s, x) => s + x[0], 0), total: v.reduce((s, x) => s + x[1], 0) });
    };
    const [ort, model] = await Promise.all([
      loadRuntime(prog('wasm')),
      cachedDownload(new URL(file, new URL('./', self.location.href)).href, prog('model')),
    ]);
    const session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'] });
    sessions.set(file, { ort, session });
    postMessage({ type: 'model', file, state: 'ready', fromCache });
  })().catch((err) => {
    loading.delete(file);
    postMessage({ type: 'model', file, state: 'error', message: String(err && err.message ? err.message : err) });
    throw err;
  });
  loading.set(file, p);
  return p;
}

async function ensureModel(method) {
  const m = byId[method];
  if (m?.needsModel && !sessions.has(m.model.file)) await loadModel(m.model.file);
}

let lastFit = null;
/** 原圖 → 結果 的逐通道局部仿射係數（RGBA float32，可直接上傳成紋理）；非換鏡頭時與上一組做輕度平滑 */
function fitCoeffs(src, out, cut, div = 32) {
  const { w, h } = src, n = w * h, r = Math.max(2, Math.round(Math.max(w, h) / div));
  const A = new Float32Array(n * 4), B = new Float32Array(n * 4);
  for (let c = 0; c < 3; c++) {
    const [ac, bc] = affine(src.c[c], out.c[c], w, h, r, 1e-4);
    for (let i = 0; i < n; i++) { A[i * 4 + c] = ac[i]; B[i * 4 + c] = bc[i]; }
  }
  if (lastFit && !cut && lastFit.a.length === A.length) {
    for (let i = 0; i < A.length; i++) {
      A[i] = lastFit.a[i] + (A[i] - lastFit.a[i]) * 0.6;
      B[i] = lastFit.b[i] + (B[i] - lastFit.b[i]) * 0.6;
    }
  }
  lastFit = { a: A.slice(), b: B.slice() };
  return { a: A, b: B };
}

/** 第一次開啟：把 ONNX 執行環境與所有模型下載進本機快取（已存在的會略過，不建立推論 session） */
let prefetching = null;
function prefetchAll() {
  if (prefetching) return prefetching;
  prefetching = (async () => {
    const base = new URL('./', self.location.href);
    const files = [['vendor/ort/ort-wasm-simd-threaded.wasm', 14.2], ...METHODS.filter((m) => m.needsModel).map((m) => [m.model.file, m.model.mb])];
    const total = files.reduce((s, f) => s + f[1], 0) * 1e6;
    let done = 0, downloaded = false, failed = 0;
    for (const [file, mb] of files) {
      try {
        await cachedDownload(new URL(file, base).href, (got, _t, cached) => {
          if (cached) return;
          downloaded = true;
          postMessage({ type: 'prefetch', got: done + got, total, file });
        });
      } catch {
        failed++;
      }
      done += mb * 1e6;
    }
    // 執行環境的 JS 模組也先載一次，讓 Service Worker 把它存進離線快取
    await loadRuntime(() => {}).catch(() => { failed++; });
    postMessage({ type: 'prefetch', done: true, downloaded, failed, total });
  })().finally(() => { prefetching = null; });
  return prefetching;
}

// 會用到演算法或模型的訊息一個一個排隊處理：同一個 ONNX session 不能同時推論（多執行緒時可能互相卡死），
// 預覽與播放共用的時間平滑狀態也不能交錯更新。下載（prefetch / loadModel）不排隊。
const SERIAL = new Set(['reset', 'process', 'fit', 'fitPair', 'estimate', 'keyfit', 'compare', 'metrics', 'hang']);
let queue = Promise.resolve();
self.onmessage = (e) => {
  if (SERIAL.has(e.data.type)) queue = queue.then(() => handle(e));
  else handle(e);
};

async function handle(e) {
  const m = e.data;
  try {
    if (m.type === 'hang' && m.debug === 'hang-test') for (;;); // 測試看門狗用：模擬背景卡死
    if (m.type === 'reset') {
      (slots[m.slot] || slots.preview).reset();
      if (m.slot !== 'export') lastFit = null;
    } else if (m.type === 'loadModel') {
      await loadModel(m.file).catch(() => {});
    } else if (m.type === 'process') {
      await ensureModel(m.opts.method);
      const img = C.fromRGBA(new Uint8ClampedArray(m.rgba), m.w, m.h);
      const r = await slots[m.slot || 'preview'].run(img, m.opts);
      const rgba = C.toRGBA(r.out);
      postMessage({ type: 'result', id: m.id, rgba: rgba.buffer, w: m.w, h: m.h, info: { ms: r.ms, cut: r.cut, estimated: r.estimated } }, [rgba.buffer]);
    } else if (m.type === 'fit') {
      // 播放用：小圖完整處理 → 擬合局部仿射色彩轉換，交給 GPU 套到每一格
      await ensureModel(m.opts.method);
      const img = C.fromRGBA(new Uint8ClampedArray(m.rgba), m.w, m.h);
      const r = await slots.preview.run(img, m.opts);
      // 真的換鏡頭（畫面直方圖差很多）才直接切換；方法內部不可內插的參數改變（例如 MLLE 的通道排序）照樣平滑過渡
      const cut = r.cut && r.dist > 0.5;
      const { a, b } = fitCoeffs(img, r.out, cut, m.div);
      postMessage({ type: 'fit', id: m.id, a: a.buffer, b: b.buffer, w: m.w, h: m.h, info: { ms: r.ms, cut } }, [a.buffer, b.buffer]);
    } else if (m.type === 'fitPair') {
      // 播放一開始：直接用暫停畫面已算好的完整結果擬合係數（不必等方法重算，深度模型也立即有顏色）
      const src = C.fromRGBA(new Uint8ClampedArray(m.src), m.w, m.h), out = C.fromRGBA(new Uint8ClampedArray(m.out), m.w, m.h);
      lastFit = null;
      const { a, b } = fitCoeffs(src, out, true);
      postMessage({ type: 'fit', id: m.id, a: a.buffer, b: b.buffer, w: m.w, h: m.h }, [a.buffer, b.buffer]);
    } else if (m.type === 'estimate') {
      // 只估計全域參數（Diverout_sim 的關鍵幀）
      const meth = byId[m.method];
      await ensureModel(m.method);
      const img = C.fromRGBA(new Uint8ClampedArray(m.rgba), m.w, m.h);
      const g = await meth.estimate(img, { ...defaults(meth), ...(m.params || {}) }, ctx);
      postMessage({ type: 'estimate', id: m.id, g });
    } else if (m.type === 'keyfit') {
      // 快速匯出的關鍵幀：小圖完整處理 → 擬合局部仿射係數
      await ensureModel(m.opts.method);
      const img = C.fromRGBA(new Uint8ClampedArray(m.rgba), m.w, m.h);
      const r = await new Processor(ctx).run(img, { ...m.opts, video: null, mix: 1 });
      postMessage({ type: 'keyfit', id: m.id, g: fitG(img, r.out) });
    } else if (m.type === 'prefetch') {
      await prefetchAll();
    } else if (m.type === 'compare') {
      const img = C.fromRGBA(new Uint8ClampedArray(m.rgba), m.w, m.h);
      const tiles = [];
      for (const id of m.methods) {
        try {
          await ensureModel(id); // 模型已預先下載時直接從本機載入
        } catch (err) {
          tiles.push({ id, error: '模型載入失敗：' + (err && err.message ? err.message : err) });
          continue;
        }
        postMessage({ type: 'alive' }); // 全部比較很久：讓看門狗知道還在算
        const t = performance.now();
        const r = await new Processor(ctx).run(img, { method: id, params: (m.params && m.params[id]) || defaults(byId[id]), post: m.post });
        const rgba = C.toRGBA(r.out);
        tiles.push({ id, rgba: rgba.buffer, ms: performance.now() - t, uiqm: uiqm(r.out).uiqm, uciqe: uciqe(r.out) });
      }
      postMessage({ type: 'compare', id: m.id, w: m.w, h: m.h, tiles }, tiles.filter((t) => t.rgba).map((t) => t.rgba));
    } else if (m.type === 'metrics') {
      const img = C.fromRGBA(new Uint8ClampedArray(m.rgba), m.w, m.h);
      postMessage({ type: 'metrics', id: m.id, uiqm: uiqm(img).uiqm, uciqe: uciqe(img) });
    }
  } catch (err) {
    postMessage({ type: 'error', id: m.id, message: String(err && err.message ? err.message : err) });
  }
}
