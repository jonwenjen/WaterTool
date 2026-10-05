import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../lib/core.js';

const rnd = (n, s = 1) => Float32Array.from({ length: n }, () => ((s = (s * 16807) % 2147483647) / 2147483647));

test('boxMean 等於逐點暴力平均（含邊界）', () => {
  const w = 13, h = 9, p = rnd(w * h), r = 2, q = C.boxMean(p, w, h, r);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0, k = 0;
    for (let yy = Math.max(0, y - r); yy <= Math.min(h - 1, y + r); yy++)
      for (let xx = Math.max(0, x - r); xx <= Math.min(w - 1, x + r); xx++) { s += p[yy * w + xx]; k++; }
    assert.ok(Math.abs(q[y * w + x] - s / k) < 1e-5);
  }
});

test('minFilter 等於暴力局部最小值', () => {
  const w = 17, h = 11, p = rnd(w * h, 7), r = 3, q = C.minFilter(p, w, h, r);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let m = Infinity;
    for (let yy = Math.max(0, y - r); yy <= Math.min(h - 1, y + r); yy++)
      for (let xx = Math.max(0, x - r); xx <= Math.min(w - 1, x + r); xx++) m = Math.min(m, p[yy * w + xx]);
    assert.equal(q[y * w + x], m);
  }
});

test('拉普拉斯金字塔可完美重建', () => {
  const w = 37, h = 23, p = rnd(w * h, 3);
  const r = C.collapse(C.laplacianPyramid(p, w, h, 4));
  for (let i = 0; i < p.length; i++) assert.ok(Math.abs(r[i] - p[i]) < 1e-5);
});

test('引導濾波：以自身為引導、eps 極小時近似恆等', () => {
  const w = 20, h = 20, p = rnd(w * h, 5), q = C.guidedFilter(p, p, w, h, 2, 1e-8);
  for (let i = 0; i < p.length; i++) assert.ok(Math.abs(q[i] - p[i]) < 1e-3);
});

test('sRGB ↔ Lab 來回誤差 < 0.5/255，白色 L=100', () => {
  const img = C.create(64, 1);
  const r = rnd(64, 9), g = rnd(64, 11), b = rnd(64, 13);
  img.c = [r, g, b];
  const back = C.lab2rgb(C.rgb2lab(img));
  for (let c = 0; c < 3; c++) for (let i = 0; i < 64; i++) assert.ok(Math.abs(back.c[c][i] - img.c[c][i]) < 0.5 / 255);
  const white = { w: 1, h: 1, c: [new Float32Array([1]), new Float32Array([1]), new Float32Array([1])] };
  assert.ok(Math.abs(C.rgb2lab(white).L[0] - 100) < 0.05);
});

test('縮放：常數影像維持常數；百分位數合理', () => {
  const p = new Float32Array(100 * 60).fill(0.3);
  for (const [nw, nh] of [[33, 20], [250, 150]]) for (const v of C.resizePlane(p, 100, 60, nw, nh)) assert.ok(Math.abs(v - 0.3) < 1e-5);
  const lin = Float32Array.from({ length: 1001 }, (_, i) => i / 1000);
  const [a, b] = C.percentiles(lin, [0.1, 0.9]);
  assert.ok(Math.abs(a - 0.1) < 0.002 && Math.abs(b - 0.9) < 0.002);
});
