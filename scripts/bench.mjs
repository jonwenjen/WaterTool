// 評測：node scripts/bench.mjs [EUVP 目錄] > docs/results.md
// 1. 合成真值（3 種水質）：與真值的 CIEDE76 色差、UIQM、UCIQE、速度
// 2. EUVP 真實照片（若提供目錄 data/test：A 原圖、GTr_A 參考）：UIQM、UCIQE、與參考的色差
//    PERC_EUVP=<json>：加上 LPIPS 欄（scripts/euvp-dump.mjs → tools/perceptual_eval.py 的結果）
// 3. 影片時間一致性：合成平移影片，逐幀 vs 時間穩定（參數 EMA + 去閃爍）的扭曲誤差與亮度閃爍
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import jpeg from 'jpeg-js';
import * as C from '../lib/core.js';
import { makeScene, degrade, WATERS, syntheticClip } from '../lib/synth.js';
import { METHODS, defaults } from '../lib/methods/index.js';
import { uiqm, uciqe, deltaE, psnr, ssim } from '../lib/metrics.js';
import { Processor } from '../lib/pipeline.js';
import { nodeRunNet } from './node-net.mjs';
import { keysFromFrames, interpKeys } from '../lib/methods/diverout.js';

// ONLY=a,b 只跑指定的方法（例：ONLY=diverout）
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;
const LIST = METHODS.filter((m) => !ONLY || ONLY.includes(m.id));

const ctx = { runNet: await nodeRunNet() };
const euvp = process.argv[2];
const f = (v, d = 2) => v.toFixed(d);
const log = (s = '') => process.stdout.write(s + '\n');

log('# 評測結果\n');
log(`由 \`node scripts/bench.mjs\` 產生（Node ${process.version}，單執行緒 CPU）。\n`);

// ---------- 1. 合成真值 ----------
log('## 1. 合成場景（有真值）\n');
log('色差 ΔE = 與水上真值的平均 CIEDE76（越低越好）；UIQM / UCIQE 越高通常越好（但會獎勵過度飽和）。解析度 640×360。\n');
const scene = makeScene(640, 360);
const rows = {};
const head = ['方法', ...Object.values(WATERS).map((w) => `${w.name} ΔE`), '平均 ΔE', 'UIQM', 'UCIQE', '每幀 ms'];
const inputs = Object.keys(WATERS).map((k) => degrade(scene, k));
if (!ONLY) rows['（未處理）'] = { de: inputs.map((d) => deltaE(d, scene.img)), q: inputs.map(uiqm).map((x) => x.uiqm), c: inputs.map(uciqe), ms: 0 };
for (const m of LIST) {
  const p = defaults(m), de = [], q = [], c = [];
  let ms = 0;
  for (const deg of inputs) {
    const proc = new Processor(ctx);
    const t = performance.now();
    const { out } = await proc.run(deg, { method: m.id, params: p });
    ms += performance.now() - t;
    de.push(deltaE(out, scene.img));
    q.push(uiqm(out).uiqm);
    c.push(uciqe(out));
  }
  rows[m.name] = { de, q, c, ms: ms / inputs.length };
}
log('| ' + head.join(' | ') + ' |');
log('|' + head.map(() => '---').join('|') + '|');
const avg = (a) => a.reduce((s, v) => s + v, 0) / a.length;
for (const [name, r] of Object.entries(rows))
  log(`| ${name} | ${r.de.map((v) => f(v, 1)).join(' | ')} | **${f(avg(r.de), 1)}** | ${f(avg(r.q))} | ${f(avg(r.c), 3)} | ${r.ms ? f(r.ms, 0) : '—'} |`);

// ---------- 2. EUVP ----------
if (euvp && existsSync(`${euvp}/A`)) {
  log('\n## 2. 真實水下照片（EUVP 測試集）\n');
  const names = readdirSync(`${euvp}/A`).filter((n) => /\.jpe?g$/i.test(n)).sort((a, b) => parseInt(a) - parseInt(b));
  log(`${names.length} 張（256×256，Islam et al. 2020）。PSNR / SSIM / ΔE 都是與資料集附的參考增強圖（GTr_A）比較 —— 參考圖本身是挑選過的增強結果，不是真值，只作參考。\n`);
  const load = (p) => {
    const j = jpeg.decode(readFileSync(p), { useTArray: true });
    return C.fromRGBA(j.data, j.width, j.height);
  };
  const imgs = names.map((n) => [load(`${euvp}/A/${n}`), existsSync(`${euvp}/GTr_A/${n}`) ? load(`${euvp}/GTr_A/${n}`) : null]);
  const perc = process.env.PERC_EUVP ? JSON.parse(readFileSync(process.env.PERC_EUVP, 'utf8')) : null;
  if (perc) log('LPIPS（AlexNet v0.1，越低越像參考）由 `scripts/euvp-dump.mjs` + `tools/perceptual_eval.py` 計算；23 張太少，不算 FID（分佈距離需要大量樣本，見影片評測）。\n');
  log('| 方法 | PSNR ↑ | SSIM ↑ |' + (perc ? ' LPIPS ↓ |' : '') + ' ΔE ↓ | UIQM ↑ | UCIQE ↑ |');
  log('|---|---|---|' + (perc ? '---|' : '') + '---|---|---|');
  const score = (outs, id) => {
    const ref = outs.map((o, i) => [o, imgs[i][1]]).filter((x) => x[1]);
    const lp = perc ? ` ${perc[id] ? f(perc[id].lpips, 3) : '—'} |` : '';
    return `${f(avg(ref.map(([o, r]) => psnr(o, r))))} | ${f(avg(ref.map(([o, r]) => ssim(o, r))), 3)} |${lp} ${f(avg(ref.map(([o, r]) => deltaE(o, r))), 1)} | ${f(avg(outs.map((o) => uiqm(o).uiqm)))} | ${f(avg(outs.map(uciqe)), 3)}`;
  };
  if (!ONLY) log(`| （未處理） | ${score(imgs.map((x) => x[0]), 'input')} |`);
  for (const m of LIST) {
    const outs = [];
    for (const [img] of imgs) outs.push((await new Processor(ctx).run(img, { method: m.id, params: defaults(m) })).out);
    log(`| ${m.name} | ${score(outs, m.id)} |`);
  }
}

// ---------- 3. 時間一致性 ----------
log('\n## 3. 影片時間一致性（合成平移影片）\n');
log('320×180、40 幀、每幀平移 2 px、每幀感光雜訊與 ±3% 曝光抖動。扭曲誤差 = 把前一幀輸出平移對齊後與這一幀的平均絕對差（0–255，Lai et al. 2018 的 E_warp 概念；越低越穩）；亮度閃爍 = 相鄰幀平均亮度差的平均（0–255）。\n');
const clip = [...syntheticClip({ frames: 40 })];
const warp = (frames, s) => {
  let e = 0, fl = 0;
  for (let t = 1; t < frames.length; t++) {
    const a = frames[t - 1], b = frames[t];
    let d = 0, k = 0;
    for (let c = 0; c < 3; c++)
      for (let y = 0; y < b.h; y++)
        for (let x = 0; x < b.w - s; x++) { d += Math.abs(b.c[c][y * b.w + x] - a.c[c][y * a.w + x + s]); k++; }
    e += d / k;
    fl += Math.abs(C.mean(C.gray(b)) - C.mean(C.gray(a)));
  }
  return [(e / (frames.length - 1)) * 255, (fl / (frames.length - 1)) * 255];
};
const [iw, ifl] = warp(clip.map((c) => c.frame), 2);
log(`輸入本身：扭曲誤差 ${f(iw)}、亮度閃爍 ${f(ifl)}。\n`);
log('| 方法 | 逐幀：扭曲誤差 | 逐幀：亮度閃爍 | 時間穩定：扭曲誤差 | 時間穩定：亮度閃爍 | 閃爍降低 |');
log('|---|---|---|---|---|---|');
for (const m of LIST) {
  // 關鍵幀方法（Diverout_sim）的「時間穩定」= 它自己的關鍵幀＋線性內插（30 fps）
  const keys = m.keyframes ? keysFromFrames(clip.map((c) => c.frame), 30, defaults(m)) : null;
  const run = async (video) => {
    const proc = new Processor(ctx), outs = [];
    for (const [i, c] of clip.entries()) {
      const g = video && keys ? interpKeys(keys, i / 30) : undefined;
      outs.push((await proc.run(c.frame, { method: m.id, params: defaults(m), video: g ? null : video, g })).out);
    }
    return warp(outs, 2);
  };
  const [w0, f0] = await run(null);
  const [w1, f1] = await run({ dt: 1 / 30, tau: 0.5, deflicker: 0.7, every: 1 });
  log(`| ${m.name} | ${f(w0)} | ${f(f0)} | ${f(w1)} | ${f(f1)} | ${f((1 - f1 / f0) * 100, 0)}% |`);
}
