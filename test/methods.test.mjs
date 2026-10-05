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
