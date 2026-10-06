// 匯出是否真的用了所選方法：把每支匯出影片的幾格，和每種方法對同一格的完整計算結果比對（PSNR 矩陣）。
// 每一列（匯出）最接近的那一欄應該就是它自己的方法。
//   node scripts/export-identity-check.mjs <原片> <匯出目錄（含 <方法 id>.mp4）> id1 id2 …
import { execFileSync } from 'node:child_process';
import * as C from '../lib/core.js';
import { METHODS, defaults } from '../lib/methods/index.js';
import { Processor } from '../lib/pipeline.js';
import { psnr } from '../lib/metrics.js';
import { nodeRunNet } from './node-net.mjs';
import { diverEstimate, diverApply } from '../lib/methods/diverout.js';
const [SRC, DIR, ...IDS] = process.argv.slice(2);
const FRAMES = [15, 45, 75];
const decode = (file, w, h) => {
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', `scale=${w}:${h}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 30 });
  const sz = w * h * 3;
  return FRAMES.map((f) => { const im = C.create(w, h); for (let i = 0; i < w * h; i++) for (let c = 0; c < 3; c++) im.c[c][i] = raw[f * sz + i * 3 + c] / 255; return im; });
};
const W = 320, H = 180, ctx = { runNet: await nodeRunNet() };
const src = decode(SRC, W, H);
const ref = {};
for (const id of IDS) {
  const m = METHODS.find((x) => x.id === id);
  ref[id] = [];
  for (const f of src) ref[id].push(id === 'diverout' ? diverApply(f, diverEstimate(f)) : (await new Processor(ctx).run(f, { method: id, params: defaults(m) })).out);
}
const short = (id) => METHODS.find((x) => x.id === id).short.slice(0, 9).padEnd(9);
console.log('匯出＼方法 ' + IDS.map(short).join(' ') + '  未處理');
let wrong = 0;
for (const e of IDS) {
  const ex = decode(`${DIR}/${e}.mp4`, W, H);
  const row = IDS.map((j) => FRAMES.reduce((s, _, k) => s + psnr(ex[k], ref[j][k]), 0) / FRAMES.length);
  const raw = FRAMES.reduce((s, _, k) => s + psnr(ex[k], src[k]), 0) / FRAMES.length;
  const best = IDS[row.indexOf(Math.max(...row))];
  if (best !== e) wrong++;
  console.log(`${short(e)}  ${row.map((v, i) => (IDS[i] === e ? `[${v.toFixed(1)}]` : ` ${v.toFixed(1)} `).padStart(9)).join('')}  ${raw.toFixed(1).padStart(6)}  ${best === e ? '✓ 最接近自己的方法' : '✗ 最接近 ' + best}`);
}
process.exit(wrong ? 1 : 0);
