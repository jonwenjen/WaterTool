// 背景執行緒：所有影像運算都在這裡，介面不卡頓。
// 訊息：
//   { type:'process', id, slot, rgba, w, h, opts }  → { type:'result', id, rgba, w, h, info }
//   { type:'compare', id, rgba, w, h, methods, params, post } → { type:'compare', id, tiles:[{id, rgba, ms}] }
//   { type:'metrics', id, rgba, w, h }  → { type:'metrics', id, uiqm, uciqe }
//   { type:'reset', slot }
//   { type:'loadModel' } → { type:'model', state:'progress'|'ready'|'error', ... }
import * as C from './lib/core.js';
import { Processor } from './lib/pipeline.js';
import { byId, defaults } from './lib/methods/index.js';
import { uiqm, uciqe } from './lib/metrics.js';

const ctx = { runNet: null };
const slots = { preview: new Processor(ctx), export: new Processor(ctx) };
let modelPromise = null;

async function download(url, onBytes) {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`下載失敗 ${url}（HTTP ${res.status}）`);
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader(), parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    onBytes(got, total);
  }
  const out = new Uint8Array(got);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function loadModel() {
  if (modelPromise) return modelPromise;
  modelPromise = (async () => {
    const seen = {};
    const prog = (k) => (g, t) => {
      seen[k] = [g, t];
      const v = Object.values(seen);
      postMessage({ type: 'model', state: 'progress', got: v.reduce((s, x) => s + x[0], 0), total: v.reduce((s, x) => s + x[1], 0) });
    };
    const base = new URL('./', self.location.href);
    const ort = await import(new URL('vendor/ort/ort.wasm.bundle.min.mjs', base).href);
    const [wasm, model] = await Promise.all([
      download(new URL('vendor/ort/ort-wasm-simd-threaded.wasm', base).href, prog('wasm')),
      download(new URL('models/funie-gan.fp16.onnx', base).href, prog('model')),
    ]);
    ort.env.wasm.numThreads = 1; // 多執行緒需要 COOP/COEP 標頭，GitHub Pages 沒有
    ort.env.wasm.wasmBinary = wasm;
    const session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'] });
    ctx.runNet = async (x, w, h) => (await session.run({ x: new ort.Tensor('float32', x, [1, 3, h, w]) })).y.data;
    postMessage({ type: 'model', state: 'ready' });
  })().catch((err) => {
    modelPromise = null;
    postMessage({ type: 'model', state: 'error', message: String(err && err.message ? err.message : err) });
    throw err;
  });
  return modelPromise;
}

async function ensureModel(method) {
  if (byId[method]?.needsModel && !ctx.runNet) await loadModel();
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'reset') {
      (slots[m.slot] || slots.preview).reset();
    } else if (m.type === 'loadModel') {
      await loadModel().catch(() => {});
    } else if (m.type === 'process') {
      await ensureModel(m.opts.method);
      const img = C.fromRGBA(new Uint8ClampedArray(m.rgba), m.w, m.h);
      const r = await slots[m.slot || 'preview'].run(img, m.opts);
      const rgba = C.toRGBA(r.out);
      postMessage({ type: 'result', id: m.id, rgba: rgba.buffer, w: m.w, h: m.h, info: { ms: r.ms, cut: r.cut, estimated: r.estimated } }, [rgba.buffer]);
    } else if (m.type === 'compare') {
      const img = C.fromRGBA(new Uint8ClampedArray(m.rgba), m.w, m.h);
      const tiles = [];
      for (const id of m.methods) {
        if (byId[id].needsModel && !ctx.runNet) {
          tiles.push({ id, error: '需先載入模型' });
          continue;
        }
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
};
