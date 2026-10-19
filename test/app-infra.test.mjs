// App 的基礎設施：離線快取清單、GPU 自我檢查的指紋、組合方法、綜合評分。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import * as C from '../lib/core.js';
import { METHODS, byId, defaults, composite, COMPOSITE, SCORES } from '../lib/methods/index.js';
import { GPU_REF, testInput, fingerprint, fingerprintDiff } from '../lib/methods/gpu-ref.js';
import { Processor } from '../lib/pipeline.js';
import { makeScene, degrade } from '../lib/synth.js';
import { nodeRunNet } from '../scripts/node-net.mjs';

const root = new URL('..', import.meta.url).pathname;
const runNet = await nodeRunNet();

test('sw.js 的離線快取清單：檔案都存在，且涵蓋 App 與背景執行緒會載入的全部模組', () => {
  const src = readFileSync(join(root, 'sw.js'), 'utf8');
  const shell = JSON.parse(src.match(/const SHELL = (\[[\s\S]*?\]);/)[1].replace(/'/g, '"')).filter((f) => f !== './').map((f) => normalize(f));
  for (const f of shell) assert.ok(existsSync(join(root, f)), `清單裡的 ${f} 不存在`);
  const seen = new Set(), todo = ['app.js', 'worker.js', 'copy-worker.js', 'player-gl.js'];
  while (todo.length) {
    const f = todo.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    const s = readFileSync(join(root, f), 'utf8');
    for (const m of s.matchAll(/(?:import[^'"]*?from\s*|import\(\s*|new URL\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g)) todo.push(normalize(join(dirname(f), m[1])));
  }
  const miss = [...seen].filter((f) => !shell.includes(f));
  assert.deepEqual(miss, [], '離線快取清單少了：' + miss.join(', '));
});

test('GPU 自我檢查的指紋與目前的模型檔一致（模型換了要執行 node scripts/gpu-ref.mjs）', async () => {
  const files = [...new Set(METHODS.filter((m) => m.needsModel).map((m) => m.model.file))];
  for (const file of files) {
    const m = METHODS.find((x) => x.model?.file === file), spec = m.blend ? m.blend.a : m;
    assert.ok(GPU_REF[file], `${file} 沒有指紋`);
    const { x, w, h } = testInput(spec), y = await runNet(file, x, w, h);
    assert.ok(fingerprintDiff(fingerprint(y, w, h), GPU_REF[file]) < 1e-3, `${file} 的指紋和模型不符`);
  }
  // 算錯的輸出要被抓到：每個值都偏一點點（1%）就超過門檻
  const ref = GPU_REF['models/fiveaplus.onnx'], range = Math.max(...ref) - Math.min(...ref);
  assert.ok(fingerprintDiff(ref.map((v, i) => v + (i % 2 ? 0.02 : -0.02) * range), ref) > 0.01);
});

test('組合方法：照片上 = (1 − 比例)·深度模型 + 比例·Diverout_sim，比例 0 / 1 時等於單獨的方法', async () => {
  const img = degrade(makeScene(160, 90), 'green');
  const ctx = { runNet };
  const run = async (method, params) => (await new Processor(ctx).run(img, { method, params })).out;
  const blends = METHODS.filter((m) => m.blend);
  assert.equal(blends.length, 3, 'App 裡有三種組合方法');
  for (const m of blends) {
    const a = await run(m.blend.a.id, defaults(m.blend.a)), d = await run('diverout', defaults(byId.diverout));
    for (const s of [0, 0.5, 1]) {
      const o = await run(m.id, { ...defaults(m), share: s });
      let worst = 0;
      for (let c = 0; c < 3; c++) for (let i = 0; i < o.c[c].length; i++) worst = Math.max(worst, Math.abs(o.c[c][i] - (a.c[c][i] * (1 - s) + d.c[c][i] * s)));
      assert.ok(worst < 1e-5, `${m.id} 比例 ${s}：差 ${worst}`);
    }
  }
});

test('綜合評分：四項各自最小–最大正規化後平均；最好的方法 100、最差 0，方法清單依它排序', () => {
  const c = composite({ a: [20, 0.7, 0.2, 30], b: [10, 0.3, 0.5, 90], m: [15, 0.5, 0.35, 60] });
  assert.deepEqual(c, { a: 100, b: 0, m: 50 });
  for (let i = 1; i < METHODS.length; i++) assert.ok(COMPOSITE[METHODS[i - 1].id] >= COMPOSITE[METHODS[i].id]);
  assert.deepEqual(Object.keys(COMPOSITE).sort(), Object.keys(SCORES).sort());
});
