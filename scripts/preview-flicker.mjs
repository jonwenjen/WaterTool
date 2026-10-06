// 播放預覽的顏色跳動量：播放中每 80 ms 取 GPU 預覽（結果模式）與原片，比較相鄰取樣的平均顏色變化。
// 每次取樣把「當下的色彩轉換」套到同一張固定畫面：輸出的變化只來自轉換本身。跳動 = 相鄰取樣平均顏色差（0–255，三通道加總）。
//   [THROTTLE=6] node scripts/preview-flicker.mjs <影片> [方法 id，預設 rghs] [自動色階 0–1，預設 0]（THROTTLE：CPU 降速倍數，模擬手機）
import { chromium } from 'playwright';
import { serve } from './serve.mjs';
const [VIDEO, METHOD = 'rghs', POST = '0'] = process.argv.slice(2);
const port = 8993, server = await serve(port);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage();
if (process.env.THROTTLE) await (await page.context().newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: +process.env.THROTTLE }); // 模擬手機
if (process.env.NORAMP) await page.addInitScript(() => { globalThis.__noRamp = true; }); // 關掉平滑過渡（比較用）
await page.goto(`http://localhost:${port}/`);
await page.setInputFiles('#file', VIDEO);
await page.waitForFunction(() => window.__watertool.state.src?.kind === 'video');
await page.evaluate(([m, p]) => {
  window.__watertool.select(m);
  const el = document.getElementById('post'); el.value = p; el.dispatchEvent(new Event('input'));
}, [METHOD, POST]);
await page.waitForFunction(() => document.getElementById('busy').hidden && [...window.__watertool.state.models].length >= 0, null, { timeout: 120000 });
await page.waitForTimeout(500);
await page.click('[data-view=result]');
await page.click('#play');
await page.waitForTimeout(1500);
const r = await page.evaluate(async () => {
  const gv = document.getElementById('glview'), v = document.getElementById('video');
  const c = document.createElement('canvas'); c.width = 64; c.height = 36;
  const x = c.getContext('2d', { willReadFrequently: true });
  const mean = (src) => { x.drawImage(src, 0, 0, 64, 36); const d = x.getImageData(0, 0, 64, 36).data; const m = [0, 0, 0]; for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) m[k] += d[i + k]; return m.map((s) => s / (d.length / 4)); };
  // 固定畫面：開始時的那一格。每次取樣都用「當下的色彩轉換」套到這張固定畫面上 → 輸出的變化 = 轉換本身的跳動
  const still = document.createElement('canvas'); still.width = gv.width; still.height = gv.height;
  still.getContext('2d').drawImage(v, 0, 0, still.width, still.height);
  const outs = [];
  for (let i = 0; i < 60; i++) {
    window.__watertool.probeGL(still);
    outs.push(mean(gv));
    window.__watertool.renderGL();
    await new Promise((ok) => setTimeout(ok, 80));
  }
  let sum = 0, mx = 0;
  for (let i = 1; i < outs.length; i++) {
    let d = 0;
    for (let k = 0; k < 3; k++) d += Math.abs(outs[i][k] - outs[i - 1][k]);
    sum += d; mx = Math.max(mx, d);
  }
  return { mean: sum / (outs.length - 1), max: mx, fits: window.__watertool.state.fits };
});
console.log(`${METHOD} post=${POST}: 跳動 平均 ${r.mean.toFixed(2)}、最大 ${r.max.toFixed(1)}（${r.fits} 次色彩更新）`);
await browser.close(); server.close();
