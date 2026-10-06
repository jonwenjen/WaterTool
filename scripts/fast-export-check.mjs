// 快速匯出（關鍵幀＋局部仿射係數＋內插）與逐幀完整處理的差異。
//   node scripts/fast-export-check.mjs <影片> [UVE-38K imgs 目錄]
// 1. 保真度：同一支影片，快速版與逐幀版輸出的 PSNR（關鍵幀在長邊 640 與 320 上處理）
// 2. 若給 UVE-38K：快速版與參考影片的 PSNR / SSIM（可和 docs/results-video.md 的逐幀數字比較）
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as C from '../lib/core.js';
import { METHODS, defaults } from '../lib/methods/index.js';
import { Processor } from '../lib/pipeline.js';
import { psnr, ssim } from '../lib/metrics.js';
import { fitG, applyG } from '../lib/methods/net.js';
import { keyframeIndices, interpKeys } from '../lib/keyframes.js';

const [VIDEO, UVE] = process.argv.slice(2);
const IDS = (process.env.ONLY || 'ancuti,mlle,ulap,udcp,rghs,seathru,ibla').split(',');
function decode(file, N = 1e9) {
  const [w, h, fr] = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate', '-of', 'csv=p=0', file]).toString().trim().split(',');
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-frames:v', String(Math.min(N, 100000)), '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 30 });
  const sz = w * h * 3, frames = [];
  for (let o = 0; o + sz <= raw.length; o += sz) {
    const im = C.create(+w, +h);
    for (let i = 0; i < w * h; i++) for (let c = 0; c < 3; c++) im.c[c][i] = raw[o + i * 3 + c] / 255;
    frames.push(im);
  }
  const [a, b] = fr.split('/').map(Number);
  return { frames, fps: a / (b || 1) };
}
async function slow(id, frames, fps) {
  const m = METHODS.find((x) => x.id === id), proc = new Processor();
  const outs = [];
  for (const f of frames) outs.push((await proc.run(f, { method: id, params: defaults(m), video: { dt: 1 / fps, tau: 0.5, deflicker: 0.7, every: 1 } })).out);
  return outs;
}
async function fast(id, frames, fps, edge, interval = 0.5) {
  const m = METHODS.find((x) => x.id === id), keys = [];
  for (const i of keyframeIndices(frames.length, fps, interval)) {
    const small = C.resize(frames[i], ...C.fitSize(frames[i].w, frames[i].h, edge));
    const { out } = await new Processor().run(small, { method: id, params: defaults(m) });
    keys.push({ t: i / fps, g: fitG(small, out) });
  }
  return frames.map((f, i) => applyG(f, interpKeys(keys, i / fps)));
}
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const v = decode(VIDEO);
console.log(`| 方法 | 快速 vs 逐幀 PSNR（關鍵幀 640） | （關鍵幀 320） |${UVE ? ' UVE-38K 快速 PSNR / SSIM |' : ''}`);
for (const id of IDS) {
  const S = await slow(id, v.frames, v.fps);
  const F640 = await fast(id, v.frames, v.fps, 640), F320 = await fast(id, v.frames, v.fps, 320);
  let row = `| ${METHODS.find((x) => x.id === id).name} | ${mean(F640.map((o, i) => psnr(o, S[i]))).toFixed(1)} dB | ${mean(F320.map((o, i) => psnr(o, S[i]))).toFixed(1)} dB |`;
  if (UVE) {
    let p = 0, s = 0, n = 0;
    for (const clip of readdirSync(UVE).filter((f) => f.endsWith('-raw.gif')).map((f) => f.replace('-raw.gif', '')).sort()) {
      const raw = decode(join(UVE, `${clip}-raw.gif`), 48), ref = decode(join(UVE, `${clip}-ref.gif`), 48);
      const outs = await fast(id, raw.frames, raw.fps, 640);
      outs.forEach((o, i) => { p += psnr(o, ref.frames[i]); s += ssim(o, ref.frames[i]); n++; });
    }
    row += ` ${(p / n).toFixed(2)} / ${(s / n).toFixed(3)} |`;
  }
  console.log(row);
}
