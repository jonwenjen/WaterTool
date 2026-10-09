// 從 bench-video.mjs --dump 存下的輸出格重算影片分數（PSNR / SSIM / E_t / 亮度閃爍，算法與 bench-video.mjs 相同），
// 給中途被中斷、JSON 沒寫出來的評測補資料用。輸出格已量化成 8 位元，與浮點直接算的差異見 docs。
//   node scripts/dump-video-scores.mjs <dump 目錄> <方法> <段,段…> > 結果.json
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as C from '../lib/core.js';
import { psnr, ssim } from '../lib/metrics.js';

const [dir, id, clipArg] = process.argv.slice(2);
const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
const load = (who, clip) => {
  const { w, h } = meta[clip], buf = readFileSync(join(dir, who, `${clip}.u8`)), n = w * h, out = [];
  for (let o = 0; o + n * 3 <= buf.length; o += n * 3) {
    const im = C.create(w, h);
    for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) im.c[c][i] = buf[o + i * 3 + c] / 255;
    out.push(im);
  }
  return out;
};
const meanLum = (im) => C.mean(C.gray(im));
const res = { [id]: {} };
for (const clip of clipArg.split(',')) {
  const outs = load(id, clip), ref = load('reference', clip);
  let p = 0, s = 0, et = 0, fl = 0;
  for (let t = 0; t < outs.length; t++) {
    p += psnr(outs[t], ref[t]);
    s += ssim(outs[t], ref[t]);
    if (t) {
      let d = 0, k = 0;
      for (let c = 0; c < 3; c++) {
        const o1 = outs[t].c[c], o0 = outs[t - 1].c[c], r1 = ref[t].c[c], r0 = ref[t - 1].c[c];
        for (let i = 0; i < o1.length; i++) { d += Math.abs(o1[i] - o0[i] - (r1[i] - r0[i])); k++; }
      }
      et += (d / k) * 255;
      fl += Math.abs(meanLum(outs[t]) - meanLum(outs[t - 1])) * 255;
    }
  }
  const T = outs.length;
  res[id][clip] = { psnr: p / T, ssim: s / T, etemp: et / (T - 1), flicker: fl / (T - 1), frames: T, fromDump: true };
  process.stderr.write(`${id} ${clip} PSNR ${(p / T).toFixed(3)} SSIM ${(s / T).toFixed(4)} E_t ${(et / (T - 1)).toFixed(3)} 閃爍 ${(fl / (T - 1)).toFixed(3)}\n`);
}
process.stdout.write(JSON.stringify(res, null, 1) + '\n');
