// 產生 lib/methods/gpu-ref.js 的 GPU_REF：每個 App 深度模型在固定測試畫面上的網路輸出指紋（onnxruntime-web WASM，單執行緒）。
//   node scripts/gpu-ref.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { METHODS } from '../lib/methods/index.js';
import { testInput, fingerprint } from '../lib/methods/gpu-ref.js';
import { modelFile } from '../lib/methods/net.js';

const ort = await import('../node_modules/onnxruntime-web/dist/ort.wasm.min.mjs');
ort.env.wasm.numThreads = 1;
const ref = {};
for (const m of METHODS) {
  if (!m.needsModel || ref[m.model.file]) continue;
  const spec = m.blend ? m.blend.a : m, { x, w, h } = testInput(spec);
  // GPU 載入的是 fp16 版（m.model.webgpu）：指紋用同一個檔案在 CPU 上算
  const s = await ort.InferenceSession.create(readFileSync(new URL('../' + modelFile(m.model, 'webgpu').file, import.meta.url)), { executionProviders: ['wasm'] });
  const y = (await s.run({ x: new ort.Tensor('float32', x, [1, x.length / (w * h), h, w]) })).y.data;
  ref[m.model.file] = fingerprint(y, w, h);
  console.error(m.model.file, `${w}×${h}`, ref[m.model.file].slice(0, 4).join(', '), '…');
}
const file = new URL('../lib/methods/gpu-ref.js', import.meta.url), src = readFileSync(file, 'utf8');
const head = src.slice(0, src.indexOf('// ---- 以下由 scripts/gpu-ref.mjs 產生 ----'));
writeFileSync(file, head + '// ---- 以下由 scripts/gpu-ref.mjs 產生 ----\nexport const GPU_REF = {\n' +
  Object.entries(ref).map(([k, v]) => `  '${k}': [${v.join(', ')}],`).join('\n') + '\n};\n');
