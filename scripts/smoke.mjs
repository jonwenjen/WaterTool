import * as C from '../lib/core.js';
import { makeScene, degrade, WATERS } from '../lib/synth.js';
import { METHODS, defaults } from '../lib/methods/index.js';
import { uiqm, uciqe, deltaE } from '../lib/metrics.js';
import { savePNG } from './png.mjs';
const OUT = process.argv[2] || '/tmp/wt';
import { mkdirSync } from 'node:fs';
mkdirSync(OUT, { recursive: true });
const scene = makeScene(640, 360);
for (const wk of Object.keys(WATERS)) {
  const deg = degrade(scene, wk);
  const tiles = [scene.img, deg];
  console.log(`\n== ${wk}  input ΔE ${deltaE(deg, scene.img).toFixed(1)}  UIQM ${uiqm(deg).uiqm.toFixed(2)} UCIQE ${uciqe(deg).toFixed(3)}`);
  for (const m of METHODS) {
    if (m.needsModel) continue;
    const p = defaults(m);
    const t = performance.now();
    const low = C.resize(deg, ...C.fitSize(640, 360, 320));
    const g = await m.estimate(low, p);
    const t1 = performance.now();
    const out = m.apply(deg, g, p);
    const t2 = performance.now();
    tiles.push(out);
    console.log(`${m.id.padEnd(8)} ΔE ${deltaE(out, scene.img).toFixed(1).padStart(5)}  UIQM ${uiqm(out).uiqm.toFixed(2)}  UCIQE ${uciqe(out).toFixed(3)}  est ${(t1 - t).toFixed(0)}ms apply ${(t2 - t1).toFixed(0)}ms`);
  }
  // 拼圖：2 欄
  const cols = 2, rows = Math.ceil(tiles.length / cols), tw = 320, th = 180;
  const sheet = C.create(tw * cols, th * rows);
  tiles.forEach((im, k) => {
    const s = C.resize(im, tw, th);
    const ox = (k % cols) * tw, oy = ((k / cols) | 0) * th;
    for (let c = 0; c < 3; c++) for (let y = 0; y < th; y++) sheet.c[c].set(s.c[c].subarray(y * tw, (y + 1) * tw), (oy + y) * sheet.w + ox);
  });
  savePNG(`${OUT}/sheet-${wk}.png`, C.toRGBA(sheet), sheet.w, sheet.h);
}
