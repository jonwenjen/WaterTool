// 播放預覽和「那一格的精確結果」差多少：播放中定時擷取原片與 GPU 預覽，之後逐格用完整演算法算出精確結果比較。
// 誤差大或忽大忽小 = 顏色亂跳。FIT_DELAY 模擬慢裝置（每次色彩更新多等幾毫秒）。
//   [FIT_DELAY=800] [FIT_DIV=32] [NORAMP=1] node scripts/preview-accuracy.mjs <影片> [方法 id]
import { chromium } from 'playwright';
import { serve } from './serve.mjs';
const [VIDEO, METHOD = 'rghs'] = process.argv.slice(2);
const port = 8992, server = await serve(port);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage();
await page.addInitScript((e) => { globalThis.__fitDelay = +e.d || 0; globalThis.__fitDiv = +e.v || 0; globalThis.__noRamp = !!e.n; },
  { d: process.env.FIT_DELAY, v: process.env.FIT_DIV, n: process.env.NORAMP });
await page.goto(`http://localhost:${port}/`);
await page.setInputFiles('#file', VIDEO);
await page.waitForFunction(() => window.__watertool.state.src?.kind === 'video');
await page.evaluate((m) => window.__watertool.select(m), METHOD);
await page.waitForFunction(() => document.getElementById('busy').hidden, null, { timeout: 120000 });
await page.waitForTimeout(1500);
await page.click('[data-view=result]');
await page.click('#play');
await page.waitForTimeout(2500);
const r = await page.evaluate(async (method) => {
  const W = 160, H = 90, gv = document.getElementById('glview'), v = document.getElementById('video');
  const grab = (src) => { const c = document.createElement('canvas'); c.width = W; c.height = H; const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(src, 0, 0, W, H); return x.getImageData(0, 0, W, H); };
  const caps = [];
  for (let i = 0; i < 40; i++) {
    window.__watertool.renderGL();
    caps.push({ out: grab(gv), src: grab(v) });
    await new Promise((ok) => setTimeout(ok, 150));
  }
  document.getElementById('play').click();
  const { call, state } = window.__watertool;
  const errs = [];
  for (const c of caps) {
    const ref = await call({ type: 'process', slot: 'export', rgba: c.src.data.buffer.slice(0), w: W, h: H, opts: { method, params: state.params[method], mix: 1, post: 0 } });
    const a = new Uint8Array(ref.rgba), b = c.out.data;
    let e = 0, n = 0;
    for (let i = 0; i < a.length; i++) { if (i % 4 === 3) continue; e += Math.abs(a[i] - b[i]); n++; }
    errs.push(e / n);
  }
  return errs;
}, METHOD);
const mean = r.reduce((s, v) => s + v, 0) / r.length, sorted = [...r].sort((a, b) => a - b);
let jump = 0;
for (let i = 1; i < r.length; i++) jump += Math.abs(r[i] - r[i - 1]);
console.log(`${METHOD} delay=${process.env.FIT_DELAY || 0} div=${process.env.FIT_DIV || "12（預設）"}${process.env.NORAMP ? ' 無過渡' : ' 平滑過渡'}: 與精確結果差 平均 ${mean.toFixed(2)}、90% ${sorted[Math.floor(r.length * 0.9)].toFixed(2)}、忽大忽小 ${(jump / (r.length - 1)).toFixed(2)}`);
await browser.close(); server.close();
