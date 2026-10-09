// 從 --dump 存下的輸出（bench-video.mjs、euvp-dump.mjs）算 PSNR / SSIM（與 bench.mjs 同一套 lib/metrics.js）。
//   node scripts/dump-scores.mjs <dump 目錄> > scores.json
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as C from '../lib/core.js';
import { psnr, ssim } from '../lib/metrics.js';

const dir = process.argv[2];
const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
const load = (id, clip) => {
  const { w, h } = meta[clip], buf = readFileSync(join(dir, id, `${clip}.u8`)), n = w * h, out = [];
  for (let o = 0; o + n * 3 <= buf.length; o += n * 3) {
    const im = C.create(w, h);
    for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) im.c[c][i] = buf[o + i * 3 + c] / 255;
    out.push(im);
  }
  return out;
};
const ref = Object.fromEntries(Object.keys(meta).map((c) => [c, load('reference', c)]));
const res = {};
for (const id of readdirSync(dir).filter((d) => d !== 'reference' && existsSync(join(dir, d, `${Object.keys(meta)[0]}.u8`)))) {
  let p = 0, s = 0, n = 0;
  for (const c of Object.keys(meta)) {
    const o = load(id, c);
    o.forEach((im, i) => { p += psnr(im, ref[c][i]); s += ssim(im, ref[c][i]); n++; });
  }
  res[id] = { psnr: p / n, ssim: s / n, n };
  process.stderr.write(`${id.padEnd(15)} PSNR ${(p / n).toFixed(2)} SSIM ${(s / n).toFixed(3)}\n`);
}
process.stdout.write(JSON.stringify(res, null, 1) + '\n');
