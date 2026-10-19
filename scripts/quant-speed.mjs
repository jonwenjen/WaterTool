// 量化版本的速度：onnxruntime-web WASM 單執行緒，原版／fp16／int8 輪流跑（避免先後順序、機器負載變化造成偏差），取中位數。
//   node scripts/quant-speed.mjs [方法,…]
import { readFileSync, existsSync } from 'node:fs';
import { METHODS } from '../lib/methods/index.js';
import { testInput } from '../lib/methods/gpu-ref.js';

const ids = (process.argv[2] || 'fiveaplus,uiec2net,nu2net,waternet,uvenet,uwcnn').split(',');
const ort = await import('../node_modules/onnxruntime-web/dist/ort.wasm.min.mjs');
ort.env.wasm.numThreads = 1;
console.log('| 方法 | 原版 | fp16（GPU 用） | int8（CPU 用） | int8 加速 |');
console.log('|---|---|---|---|---|');
for (const id of ids) {
  const m = METHODS.find((x) => x.id === id), { x, w, h } = testInput(m);
  const files = [m.model.file, m.model.file.replace('.onnx', '.fp16.onnx'), m.model.file.replace('.onnx', '.int8.onnx')];
  const ss = await Promise.all(files.map(async (f) => (existsSync(f) ? ort.InferenceSession.create(readFileSync(f), { executionProviders: ['wasm'] }) : null)));
  const t = ss.map(() => []);
  const feed = { x: new ort.Tensor('float32', x, [1, x.length / (w * h), h, w]) };
  for (const s of ss) if (s) await s.run(feed); // 暖機
  for (let r = 0; r < 7; r++) for (const [i, s] of ss.entries()) {
    if (!s) continue;
    const t0 = performance.now();
    await s.run(feed);
    t[i].push(performance.now() - t0);
  }
  const med = t.map((a) => (a.length ? a.sort((p, q) => p - q)[a.length >> 1] : NaN));
  const f = (v) => (Number.isNaN(v) ? '—' : `${v.toFixed(0)} ms`);
  console.log(`| ${id} | ${f(med[0])} | ${f(med[1])} | ${f(med[2])} | ${Number.isNaN(med[2]) ? '—' : (med[0] / med[2]).toFixed(2) + '×'} |`);
}
