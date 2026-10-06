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

test('編輯：裁切比例、旋轉、時間區段、時間對應', async () => {
  const E = await import('../lib/edit.js');
  // 1920×1080 → 9:16：高度不變、寬 608，置中
  let c = E.cropRect(1920, 1080, 0, '9:16');
  assert.equal(c.ch, 1080); assert.equal(c.cw, 608); assert.equal(c.x, Math.round((1920 - 608) / 2)); assert.equal(c.y, 0);
  // 旋轉 90° 後是 1080×1920，4:5 → 1080×1350，panY = 0 貼齊頂端
  c = E.cropRect(1920, 1080, 90, '4:5', 0.5, 0);
  assert.deepEqual([c.rw, c.rh, c.cw, c.ch, c.x, c.y], [1080, 1920, 1080, 1350, 0, 0]);
  c = E.cropRect(1920, 1080, 270, 'orig');
  assert.deepEqual([c.rot, c.cw, c.ch], [270, 1080, 1920]);
  assert.deepEqual(E.keepSegments(10, { mode: 'none' }), [[0, 10]]);
  assert.deepEqual(E.keepSegments(10, { mode: 'keep', start: 2, end: 5 }), [[2, 5]]);
  assert.deepEqual(E.keepSegments(10, { mode: 'cut', start: 2, end: 5 }), [[0, 2], [5, 10]]);
  assert.deepEqual(E.keepSegments(10, { mode: 'cut', start: 0, end: 4 }), [[4, 10]]);
  const segs = [[0, 2], [5, 10]];
  assert.equal(E.outDuration(segs, 2), 3.5);
  assert.equal(E.mapTime(segs, 2, 6), 1.5); // (2 + 1) / 2
  assert.equal(E.mapTime(segs, 1, 3), null); // 被刪掉
  assert.equal(E.nextKept(segs, 3), 5);
  assert.equal(E.nextKept(segs, 10), null);
  assert.ok(!E.editActive(E.DEFAULT_EDIT));
  assert.ok(E.editActive({ ...E.DEFAULT_EDIT, speed: 2 }));
});

test('編輯：聲音變速重取樣 —— 長度正確、分塊連續', async () => {
  const { Resampler } = await import('../lib/edit.js');
  const sr = 48000, n = 48000, f = 440;
  const sig = Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * f * i) / sr));
  for (const speed of [0.25, 0.5, 2, 4]) {
    const r = new Resampler(1, speed), parts = [];
    for (let o = 0; o < n; o += 960) parts.push(r.push([sig.subarray(o, Math.min(n, o + 960))])[0]);
    const out = Float32Array.from(parts.flatMap((p) => [...p]));
    assert.ok(Math.abs(out.length - n / speed) <= Math.ceil(1 / speed) + 1, `${speed}×：長度 ${out.length}，應約 ${n / speed}`); // 最後一個輸入樣本之後無法內插
    // 與理想的 sin(2π f k·speed / sr) 比較：分塊邊界也不能有跳點
    let maxErr = 0;
    for (let k = 0; k < out.length; k++) maxErr = Math.max(maxErr, Math.abs(out[k] - Math.sin((2 * Math.PI * f * k * speed) / sr)));
    assert.ok(maxErr < 0.01, `${speed}×：最大誤差 ${maxErr}`);
  }
});

test('時間裁切後只在保留區段排關鍵幀', async () => {
  const { keyframeTimesIn } = await import('../lib/keyframes.js');
  assert.deepEqual(keyframeTimesIn([[0, 60]], 0.5).length, 121);
  assert.deepEqual(keyframeTimesIn([[2, 5]], 0.5), [2, 2.5, 3, 3.5, 4, 4.5, 5]); // 60 秒片只保留 3 秒：7 個而不是 121 個
  assert.deepEqual(keyframeTimesIn([[0, 1], [4, 5]], 1), [0, 1, 4, 5]);
});
