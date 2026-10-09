// 影片評測：UVE-38K（Multimedia Tools and Applications 2023）成對影片 —— 原始影片與逐格參考影片。
//   node scripts/bench-video.mjs <UVE-38K 的 imgs 目錄> [--frames 48] [--methods a,b,c] [--out 結果.json]
// 資料：github.com/TrentQiQ/UVE-38K 倉庫附的 5 段成對預覽（*-raw.gif / *-ref.gif，320 px）。完整資料集在網盤，
//       這個環境連不到；GIF 是 256 色，原始與參考都經過同樣的量化，分數只適合方法間互相比較。
// 每個方法以 App 預設的影片模式處理（時間穩定化開：τ 0.5 s、去閃爍 0.7，每格都重新估計），量測：
//   PSNR / SSIM（與參考格）、時間誤差 E_t = 平均 |(O_t − O_{t−1}) − (R_t − R_{t−1})|（0–255，越低越接近參考影片的時間變化）、
//   亮度閃爍 = 相鄰格平均亮度差（0–255）。
//   --dump <目錄>：另外把每個方法的輸出格與參考格存成原始 RGB（給 tools/perceptual_eval.py 算 LPIPS 與 FID）。
//   --extra：另外評測 lib/methods/mobile-nets.js 的候選模型（不在 App 清單裡）。
import { execFileSync } from 'node:child_process';
import { readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as C from '../lib/core.js';
import { METHODS, defaults, register } from '../lib/methods/index.js';
import { psnr, ssim } from '../lib/metrics.js';
import { Processor } from '../lib/pipeline.js';
import { nodeRunNet } from './node-net.mjs';
import { keysFromFrames } from '../lib/methods/diverout.js';
import { keyframeIndices, interpKeys } from '../lib/keyframes.js';

const args = process.argv.slice(2);
const dir = args[0];
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const N = +opt('--frames', 48);
const only = opt('--methods', '');
const out = opt('--out', '');
const dump = opt('--dump', '');
const KEYS = +opt('--keys', 0); // >0：深度模型只在每 KEYS 秒的關鍵幀跑網路，中間內插（App 的快速匯出）
const EXTRA = args.includes('--extra') ? (await import('../lib/methods/mobile-nets.js')).CANDIDATES : [];
register(...EXTRA);
const ALL = [...METHODS, ...EXTRA];
const methods = ['input', ...ALL.map((m) => m.id)].filter((id) => !only || only.split(',').includes(id));

function decode(file) {
  const info = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate', '-of', 'csv=p=0', file]).toString().trim().split(',');
  const [w, h] = [+info[0], +info[1]], [a, b] = info[2].split('/').map(Number);
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-frames:v', String(N), '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 30 });
  const frames = [], sz = w * h * 3;
  for (let o = 0; o + sz <= raw.length; o += sz) {
    const img = C.create(w, h);
    for (let i = 0; i < w * h; i++) for (let c = 0; c < 3; c++) img.c[c][i] = raw[o + i * 3 + c] / 255;
    frames.push(img);
  }
  return { frames, fps: a / (b || 1), w, h };
}

const clips = readdirSync(dir).filter((f) => f.endsWith('-raw.gif')).map((f) => f.replace('-raw.gif', '')).sort();
const data = clips.map((name) => {
  const raw = decode(join(dir, `${name}-raw.gif`)), ref = decode(join(dir, `${name}-ref.gif`));
  const n = Math.min(raw.frames.length, ref.frames.length);
  return { name, raw: raw.frames.slice(0, n), ref: ref.frames.slice(0, n), fps: raw.fps };
});

// 原始 RGB：N 格 × h × w × 3（uint8），尺寸寫在 meta.json
const toU8 = (frames) => {
  const { w, h } = frames[0], buf = Buffer.alloc(frames.length * w * h * 3);
  frames.forEach((f, t) => { for (let i = 0; i < w * h; i++) for (let c = 0; c < 3; c++) buf[(t * w * h + i) * 3 + c] = Math.round(Math.min(1, Math.max(0, f.c[c][i])) * 255); });
  return buf;
};
const save = (id, clip, frames) => {
  mkdirSync(join(dump, id), { recursive: true });
  writeFileSync(join(dump, id, `${clip}.u8`), toU8(frames));
};
if (dump) {
  writeFileSync(join(mkdirSync(dump, { recursive: true }) || dump, 'meta.json'), JSON.stringify(Object.fromEntries(data.map((c) => [c.name, { w: c.raw[0].w, h: c.raw[0].h, frames: c.raw.length }]))));
  for (const clip of data) save('reference', clip.name, clip.ref);
}

const ctx = { runNet: await nodeRunNet() };
const meanLum = (im) => C.mean(C.gray(im));
const results = {};
for (const id of methods) {
  results[id] = {};
  for (const clip of data) {
    const proc = new Processor(ctx), outs = [];
    const t0 = performance.now();
    const m = ALL.find((x) => x.id === id);
    // 關鍵幀方法（Diverout_sim）：先看過整段，關鍵幀＋線性內插（同 App 與 DIVEROUT）
    let keys = m && m.keyframes ? keysFromFrames(clip.raw, clip.fps, defaults(m)) : null;
    if (m && m.needsModel && KEYS > 0) {
      keys = [];
      for (const i of keyframeIndices(clip.raw.length, clip.fps, KEYS)) keys.push({ t: i / clip.fps, g: await m.estimate(clip.raw[i], defaults(m), ctx) });
    }
    for (const [i, f] of clip.raw.entries()) {
      if (id === 'input') { outs.push(f); continue; }
      const opts = keys ? { method: id, params: defaults(m), g: interpKeys(keys, i / clip.fps) }
        : { method: id, params: defaults(m), video: { dt: 1 / clip.fps, tau: 0.5, deflicker: 0.7, every: 1 } };
      outs.push((await proc.run(f, opts)).out);
    }
    const ms = (performance.now() - t0) / clip.raw.length;
    if (dump) save(id, clip.name, outs);
    let p = 0, s = 0, et = 0, fl = 0;
    for (let t = 0; t < outs.length; t++) {
      p += psnr(outs[t], clip.ref[t]);
      s += ssim(outs[t], clip.ref[t]);
      if (t) {
        let d = 0, k = 0;
        for (let c = 0; c < 3; c++) {
          const o1 = outs[t].c[c], o0 = outs[t - 1].c[c], r1 = clip.ref[t].c[c], r0 = clip.ref[t - 1].c[c];
          for (let i = 0; i < o1.length; i++) { d += Math.abs(o1[i] - o0[i] - (r1[i] - r0[i])); k++; }
        }
        et += (d / k) * 255;
        fl += Math.abs(meanLum(outs[t]) - meanLum(outs[t - 1])) * 255;
      }
    }
    const T = outs.length;
    results[id][clip.name] = { psnr: p / T, ssim: s / T, etemp: et / (T - 1), flicker: fl / (T - 1), frames: T, ms };
    process.stderr.write(`${id} ${clip.name} PSNR ${(p / T).toFixed(2)} SSIM ${(s / T).toFixed(3)} E_t ${(et / (T - 1)).toFixed(2)} ${ms.toFixed(0)} ms/格\n`);
  }
}
// 參考影片本身的亮度閃爍（作為對照）
results.reference = {};
for (const clip of data) {
  let fl = 0;
  for (let t = 1; t < clip.ref.length; t++) fl += Math.abs(meanLum(clip.ref[t]) - meanLum(clip.ref[t - 1])) * 255;
  results.reference[clip.name] = { flicker: fl / (clip.ref.length - 1), frames: clip.ref.length };
}
const json = JSON.stringify(results, null, 1);
if (out) writeFileSync(out, json);
else process.stdout.write(json + '\n');
