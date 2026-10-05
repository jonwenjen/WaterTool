// 真實照片拼圖：每列一張 EUVP 測試照片，欄 = 原圖 + 各方法
import { readFileSync, readdirSync } from 'node:fs';
import jpeg from 'jpeg-js';
import * as C from '../lib/core.js';
import { METHODS, defaults } from '../lib/methods/index.js';
import { savePNG } from './png.mjs';
import { nodeRunNet } from './node-net.mjs';
const ctx = { runNet: await nodeRunNet() };
const [dir, out, ...pick] = process.argv.slice(2);
const names = pick.length ? pick : readdirSync(dir).filter((f) => /\.jpg$/.test(f)).slice(0, 6);
const ms = METHODS;
const T = 160, cols = ms.length + 1;
const sheet = C.create(T * cols, T * names.length);
for (const [r, f] of names.entries()) {
  const j = jpeg.decode(readFileSync(`${dir}/${f}`), { useTArray: true });
  const img = C.fromRGBA(j.data, j.width, j.height);
  const tiles = [img];
  for (const m of ms) {
    const p = defaults(m);
    tiles.push(m.apply(img, await m.estimate(img, p, ctx), p));
  }
  tiles.forEach((im, k) => {
    const s = C.resize(im, T, T);
    for (let c = 0; c < 3; c++) for (let y = 0; y < T; y++) sheet.c[c].set(s.c[c].subarray(y * T, (y + 1) * T), (r * T + y) * sheet.w + k * T);
  });
}
savePNG(out, C.toRGBA(sheet), sheet.w, sheet.h);
console.log('cols: input,', ms.map((m) => m.id).join(', '));
