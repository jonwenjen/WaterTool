// 深度模型推論速度：onnxruntime-web WASM 單執行緒（接近手機瀏覽器的條件），只量網路本身（不含擬合、套用）。
//   node scripts/net-speed.mjs [--extra] > speed.json
// 每個模型：暖機 2 次，量 8 次取中位數；可變尺寸的模型另外量 1280×704（約 720p 原畫面；FGDPA 要求邊長為 32 的倍數）。
import { readFileSync } from 'node:fs';
import { METHODS, register } from '../lib/methods/index.js';
import { netSize } from '../lib/methods/net.js';

const EXTRA = process.argv.includes('--extra') ? (await import('../lib/methods/mobile-nets.js')).CANDIDATES : [];
register(...EXTRA);
const ort = await import('onnxruntime-web/wasm').catch(() => import('../node_modules/onnxruntime-web/dist/ort.wasm.min.mjs'));
ort.env.wasm.numThreads = 1;
const nets = [...METHODS.filter((m) => m.needsModel), ...EXTRA];
const out = {};
const time = async (s, w, h, ch) => {
  const x = new ort.Tensor('float32', new Float32Array(ch * w * h).map(() => Math.random()), [1, ch, h, w]);
  for (let i = 0; i < 2; i++) await s.run({ x });
  const t = [];
  for (let i = 0; i < 8; i++) { const t0 = performance.now(); await s.run({ x }); t.push(performance.now() - t0); }
  return t.sort((a, b) => a - b)[4];
};
for (const m of nets) {
  const s = await ort.InferenceSession.create(readFileSync(new URL('../' + m.model.file, import.meta.url)), { executionProviders: ['wasm'] });
  const ch = m.id === 'waternet' ? 12 : 3; // WaterNet 吃 4 張 RGB（原圖＋3 種前處理）
  const [w, h] = netSize(1280, 720, m);
  const r = { size: `${w}×${h}`, ms: await time(s, w, h, ch), mb: readFileSync(new URL('../' + m.model.file, import.meta.url)).length / 2 ** 20 };
  if (m.size !== 'square256' && m.id !== 'waternet' && m.id !== 'uvenet' && m.id !== 'funie') r.ms720 = await time(s, 1280, 704, ch);
  out[m.id] = r;
  process.stderr.write(`${m.id.padEnd(15)} ${r.size} ${r.ms.toFixed(1)} ms${r.ms720 ? `  1280×704 ${r.ms720.toFixed(0)} ms` : ''}  ${r.mb.toFixed(2)} MB\n`);
}
process.stdout.write(JSON.stringify(out, null, 1) + '\n');
