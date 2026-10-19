// 量化模型檢查：同一個方法換用不同的 ONNX 檔（原版、fp16 儲存、int8），比較檔案大小、WASM 單執行緒速度、
// 以及 App 實際輸出（網路 → 擬合的局部色彩轉換 → 套到原圖）和原版差多少、和參考格的 PSNR。
//   node scripts/quant-check.mjs <bench-video --dump 目錄> <量化模型目錄> [方法,…]
// 量化模型目錄裡是 <檔名>.fp16.onnx、<檔名>.int8.onnx（scripts/quantize_models.py 產生）。
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import * as C from '../lib/core.js';
import { byId, defaults } from '../lib/methods/index.js';
import { psnr } from '../lib/metrics.js';
import { Processor } from '../lib/pipeline.js';

const [dump, qdir, only] = process.argv.slice(2);
const ids = (only || 'fiveaplus,uiec2net,nu2net,waternet,uvenet,uwcnn,fgdpa').split(',');
const ort = await import('../node_modules/onnxruntime-web/dist/ort.wasm.min.mjs');
ort.env.wasm.numThreads = 1;
const meta = JSON.parse(readFileSync(join(dump, 'meta.json'), 'utf8'));
// 每段取 3 格（頭、中、尾）
const frames = [];
for (const [clip, m] of Object.entries(meta)) {
  const load = (id) => readFileSync(join(dump, id, `${clip}.u8`));
  const raw = load('input'), ref = load('reference'), n = m.w * m.h;
  for (const t of [0, Math.floor(m.frames / 2), m.frames - 1]) {
    const toImg = (buf) => { const im = C.create(m.w, m.h); for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) im.c[c][i] = buf[(t * n + i) * 3 + c] / 255; return im; };
    frames.push({ raw: toImg(raw), ref: toImg(ref) });
  }
}
// 影片檢查用：dive 段的前 40 格
const clipFrames = (() => {
  const m = meta.dive, n = m.w * m.h, buf = readFileSync(join(dump, 'input', 'dive.u8')), out = [];
  for (let t = 0; t < 40; t++) { const im = C.create(m.w, m.h); for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) im.c[c][i] = buf[(t * n + i) * 3 + c] / 255; out.push(im); }
  return out;
})();
const sessions = new Map(), times = new Map();
const runNetFor = (path) => async (_file, x, w, h) => {
  if (!sessions.has(path)) sessions.set(path, await ort.InferenceSession.create(readFileSync(path), { executionProviders: ['wasm'] }));
  const s = sessions.get(path), t0 = performance.now();
  const y = (await s.run({ x: new ort.Tensor('float32', x, [1, x.length / (w * h), h, w]) })).y.data;
  (times.get(path) || times.set(path, []).get(path)).push(performance.now() - t0);
  return y;
};
const rows = [];
for (const id of ids) {
  const m = byId[id], p = defaults(m), base = new URL('../' + m.model.file, import.meta.url).pathname;
  const stem = basename(m.model.file, '.onnx').replace(/\.fp16$/, '');
  const variants = [['原版', base], ['fp16', join(qdir, `${stem}.fp16.onnx`)], ['int8', join(qdir, `${stem}.int8.onnx`)]].filter(([, f]) => existsSync(f));
  let baseOuts = null, baseVid = null;
  for (const [label, file] of variants) {
    const ctx = { runNet: runNetFor(file) }, outs = [];
    try {
      for (const f of frames) outs.push(m.apply(f.raw, await m.estimate(f.raw, p, ctx), p));
    } catch (e) { rows.push({ id, label, err: e.message.slice(0, 80) }); continue; }
    baseOuts ??= outs;
    // 影片：同一段連續 40 格（影片模式、時間平滑），量量化版本相鄰格變化和原版差多少（0–255；越小越不會多出閃爍）
    const proc = new Processor({ runNet: runNetFor(file) }), vout = [];
    for (const f of clipFrames) vout.push((await proc.run(f, { method: id, params: p, video: { dt: 1 / 30, tau: 0.5, deflicker: 0.7, every: 1 } })).out);
    baseVid ??= vout;
    let et = 0, k = 0;
    for (let t = 1; t < vout.length; t++) for (let c = 0; c < 3; c++) {
      const a1 = vout[t].c[c], a0 = vout[t - 1].c[c], b1 = baseVid[t].c[c], b0 = baseVid[t - 1].c[c];
      for (let i = 0; i < a1.length; i++) { et += Math.abs(a1[i] - a0[i] - (b1[i] - b0[i])); k++; }
    }
    const t = times.get(file).slice(2).sort((a, b) => a - b);
    rows.push({ id, label, mb: statSync(file).size / 2 ** 20, ms: t[t.length >> 1],
      vsBase: outs.map((o, i) => psnr(o, baseOuts[i])).reduce((a, b) => a + Math.min(b, 99), 0) / outs.length,
      vsRef: outs.map((o, i) => psnr(o, frames[i].ref)).reduce((a, b) => a + b, 0) / outs.length, et: (et / k) * 255 });
    process.stderr.write(`${id} ${label} done\n`);
  }
}
console.log('| 方法 | 版本 | 檔案 | 推論（WASM 單執行緒） | 與原版輸出的 PSNR | 與參考格 PSNR | 影片格間變化與原版差（0–255） |');
console.log('|---|---|---|---|---|---|---|');
for (const r of rows) console.log(r.err ? `| ${r.id} | ${r.label} | 失敗：${r.err} | | | |`
  : `| ${r.id} | ${r.label} | ${r.mb.toFixed(2)} MB | ${r.ms.toFixed(0)} ms | ${r.vsBase >= 99 ? '相同' : r.vsBase.toFixed(1) + ' dB'} | ${r.vsRef.toFixed(2)} | ${r.et.toFixed(3)} |`);
