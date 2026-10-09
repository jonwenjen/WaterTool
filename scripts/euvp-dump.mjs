// EUVP 測試集：把每個方法的輸出與參考圖存成原始 RGB，給 tools/perceptual_eval.py 算 LPIPS（格式同 bench-video.mjs --dump）。
//   node scripts/euvp-dump.mjs <EUVP data/test 目錄> <輸出目錄> [--extra 只跑 mobile-nets.js 的候選模型]
// 處理方式與 bench.mjs 第 2 節相同（每張照片各自用預設參數處理）。
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import jpeg from 'jpeg-js';
import * as C from '../lib/core.js';
import { METHODS, defaults, register } from '../lib/methods/index.js';
import { Processor } from '../lib/pipeline.js';
import { nodeRunNet } from './node-net.mjs';

const [dir, out] = process.argv.slice(2);
const EXTRA = process.argv.includes('--extra') ? (await import('../lib/methods/mobile-nets.js')).CANDIDATES : null;
if (EXTRA) register(...EXTRA);
const LIST = EXTRA || METHODS;
const names = readdirSync(join(dir, 'A')).filter((n) => /\.jpe?g$/i.test(n) && existsSync(join(dir, 'GTr_A', n))).sort((a, b) => parseInt(a) - parseInt(b));
const load = (p) => { const j = jpeg.decode(readFileSync(p), { useTArray: true }); return C.fromRGBA(j.data, j.width, j.height); };
const imgs = names.map((n) => [load(join(dir, 'A', n)), load(join(dir, 'GTr_A', n))]);
const { w, h } = imgs[0][0];
const save = (id, frames) => {
  const buf = Buffer.alloc(frames.length * w * h * 3);
  frames.forEach((f, t) => { for (let i = 0; i < w * h; i++) for (let c = 0; c < 3; c++) buf[(t * w * h + i) * 3 + c] = Math.round(Math.min(1, Math.max(0, f.c[c][i])) * 255); });
  mkdirSync(join(out, id), { recursive: true });
  writeFileSync(join(out, id, 'euvp.u8'), buf);
};
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'meta.json'), JSON.stringify({ euvp: { w, h, frames: imgs.length } }));
save('reference', imgs.map((x) => x[1]));
if (!EXTRA) save('input', imgs.map((x) => x[0]));
const ctx = { runNet: await nodeRunNet() };
for (const m of LIST) {
  const outs = [];
  for (const [img] of imgs) outs.push((await new Processor(ctx).run(img, { method: m.id, params: defaults(m) })).out);
  save(m.id, outs);
  process.stderr.write(`${m.id} ✓\n`);
}
