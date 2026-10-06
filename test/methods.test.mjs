import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../lib/core.js';
import { makeScene, degrade, syntheticClip } from '../lib/synth.js';
import { METHODS, defaults } from '../lib/methods/index.js';
import { deltaE, uiqm, uciqe } from '../lib/metrics.js';
import { Processor } from '../lib/pipeline.js';
import { blend } from '../lib/temporal.js';
import { nodeRunNet } from '../scripts/node-net.mjs';

const ctx = { runNet: await nodeRunNet() };
const scene = makeScene(320, 180);
const blue = degrade(scene, 'blue');

for (const m of METHODS) {
  test(`${m.id}：輸出尺寸正確、數值有限且在 [0,1]、結果可重現`, async () => {
    const run = async () => (await new Processor(ctx).run(blue, { method: m.id, params: defaults(m) })).out;
    const a = await run(), b = await run();
    assert.equal(a.w, blue.w);
    assert.equal(a.h, blue.h);
    for (let c = 0; c < 3; c++) for (let i = 0; i < a.c[c].length; i++) {
      const v = a.c[c][i];
      assert.ok(Number.isFinite(v) && v >= 0 && v <= 1, `${m.id} c${c}[${i}] = ${v}`);
      assert.equal(v, b.c[c][i]);
    }
  });
}

test('色彩校正方法在藍水合成場景都降低與真值的色差', async () => {
  const base = deltaE(blue, scene.img);
  for (const id of ['ancuti', 'mlle', 'seathru', 'funie', 'nu2net', 'uiec2net', 'uwcnn', 'fiveaplus']) {
    const { out } = await new Processor(ctx).run(blue, { method: id });
    const de = deltaE(out, scene.img);
    assert.ok(de < base * 0.85, `${id}: ΔE ${de.toFixed(1)} 應 < ${(base * 0.85).toFixed(1)}`);
  }
});

test('品質指標：增強後 UIQM 上升', async () => {
  const { out } = await new Processor(ctx).run(blue, { method: 'ancuti' });
  assert.ok(uiqm(out).uiqm > uiqm(blue).uiqm);
  assert.ok(Number.isFinite(uciqe(out)));
});

test('時間穩定化降低逐幀方法的亮度閃爍', async () => {
  const clip = [...syntheticClip({ w: 160, h: 90, frames: 20, pan: 1 })];
  const flicker = async (video) => {
    const p = new Processor(ctx);
    let prev = null, s = 0;
    for (const { frame } of clip) {
      const m = C.mean(C.gray((await p.run(frame, { method: 'udcp', video })).out));
      if (prev !== null) s += Math.abs(m - prev);
      prev = m;
    }
    return s;
  };
  const raw = await flicker(null), stab = await flicker({ dt: 1 / 30, tau: 0.5, deflicker: 0.7 });
  assert.ok(stab < raw * 0.6, `穩定後 ${stab.toFixed(4)} 應 < 0.6 × ${raw.toFixed(4)}`);
});

test('換鏡頭時參數立即重設', async () => {
  const p = new Processor(ctx);
  const video = { dt: 1 / 30, tau: 2 };
  await p.run(blue, { method: 'ancuti', video });
  const r = await p.run(degrade(scene, 'green'), { method: 'ancuti', video });
  assert.ok(r.cut, '藍水→綠水應判定為換鏡頭');
});

test('blend 遞迴內插數字 / 陣列 / TypedArray', () => {
  const r = blend({ a: 0, b: [0, 10], c: new Float32Array([2, 4]) }, { a: 1, b: [1, 20], c: new Float32Array([4, 8]) }, 0.5);
  assert.deepEqual([r.a, r.b, [...r.c]], [0.5, [0.5, 15], [3, 6]]);
});

test('Diverout_sim：關鍵幀位置、內插、色彩矩陣與紅色合成', async () => {
  const { keyframeIndices, keyframeTimes, interpKeys, diverEstimate, diverApply, diverMatrix } = await import('../lib/methods/diverout.js');
  // 與 diverout_cc.py 相同：N = ceil(片長 / T)，N+1 個平均分布（最後一個 = 最後一幀）
  assert.deepEqual(keyframeIndices(90, 30, 1), [0, 30, 60, 89]);
  assert.deepEqual(keyframeIndices(90, 30, 2), [0, 45, 89]);
  assert.equal(keyframeIndices(1306, 60, 1).length, 23);
  assert.equal(keyframeTimes(3.02, 1).length, 4); // 瀏覽器片長含音軌的幾十毫秒
  const A = { lo: [0, 10, 20], hi: [200, 210, 220], w: 1, k: 1 }, B = { lo: [10, 20, 30], hi: [210, 230, 240], w: 0.5, k: 0.5 };
  const mid = interpKeys([{ t: 0, g: A }, { t: 1, g: B }], 0.5);
  assert.deepEqual(mid.lo, [5, 15, 25]);
  assert.equal(mid.w, 0.75);
  // 深藍綠水（紅色幾乎沒有）→ 紅色由綠、藍合成，輸出紅色明顯回來
  const deep = C.create(64, 64);
  for (let i = 0; i < 64 * 64; i++) { deep.c[0][i] = 0.01; deep.c[1][i] = 0.3 + 0.4 * (i % 64) / 64; deep.c[2][i] = 0.5 + 0.2 * Math.floor(i / 64) / 64; }
  const g = diverEstimate(deep);
  assert.ok(Math.abs(g.w - 0.249) < 0.01, `紅色平均 3 → w ≈ 0.25（表格內插），實得 ${g.w}`);
  const out = diverApply(deep, g), M = diverMatrix(g);
  assert.ok(C.mean(out.c[0]) > 0.2, '紅色應被合成回來');
  const i = 1234, v = M[0][0] * deep.c[0][i] + M[0][1] * deep.c[1][i] + M[0][2] * deep.c[2][i] + M[0][3];
  assert.ok(Math.abs(C.clamp01(v) - out.c[0][i]) < 1e-6, 'GPU 矩陣與 CPU 套用一致');
});

test('關鍵幀內插：數字、陣列、Float32Array、物件都逐欄位線性內插', async () => {
  const { lerpG, interpKeys } = await import('../lib/keyframes.js');
  const A = { nw: 2, nh: 1, a: [Float32Array.of(0, 2)], b: [Float32Array.of(1, 1)] };
  const B = { nw: 2, nh: 1, a: [Float32Array.of(2, 4)], b: [Float32Array.of(3, 1)] };
  const m = lerpG(A, B, 0.25);
  assert.equal(m.nw, 2);
  assert.deepEqual([...m.a[0]], [0.5, 2.5]);
  assert.deepEqual([...m.b[0]], [1.5, 1]);
  const keys = [{ t: 0, g: A }, { t: 0.5, g: B }];
  assert.deepEqual([...interpKeys(keys, 0.25).a[0]], [1, 3]);
  assert.equal(interpKeys(keys, -1), A);
  assert.equal(interpKeys(keys, 9), B);
});

test('每個滑桿與下拉選單都有說明（從小到大、適用情境、建議值）', async () => {
  const { HELP, paramHelp } = await import('../lib/help.js');
  for (const id of ['tTau', 'tDef', 'tEvery', 'mix', 'post', 'speed', 'panX', 'panY']) assert.ok(HELP[id], `共用設定 ${id} 缺說明`);
  for (const m of METHODS) for (const p of m.params) {
    const h = paramHelp(m, p.key);
    assert.ok(h, `${m.id}.${p.key} 缺說明`);
    for (const k of ['low', 'high', 'use', 'rec']) assert.ok(h[k] && h[k].length > 4, `${m.id}.${p.key}.${k} 空白`);
  }
});
