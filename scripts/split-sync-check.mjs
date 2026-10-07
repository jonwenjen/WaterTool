// 分割畫面兩半是否為同一個時刻：播放時擷取畫面上看得到的預覽（分割 50%），左右兩半分別和「當下影片畫面」比對邊緣結構
// （顏色會被方法改變，但物體的邊緣位置不會）。兩半都要高度相關；右半若是別的時刻，相關會很低。
//   [THROTTLE=4] node scripts/split-sync-check.mjs <影片>
import { chromium } from 'playwright';
import { serve } from './serve.mjs';
const port = 8982, server = await serve(port);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage();
if (process.env.THROTTLE) await (await page.context().newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: +process.env.THROTTLE });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`http://localhost:${port}/`);
await page.setInputFiles('#file', process.argv[2]);
await page.waitForFunction(() => window.__watertool.state.src?.kind === 'video');
await page.waitForFunction(() => document.getElementById('busy').hidden, null, { timeout: 60000 });
await page.evaluate(() => {
  // 擷取畫面上「看得到」的那張畫布，左右兩半各與影片當下畫面比對梯度（Sobel 強度）的相關係数
  window.__sync = () => {
    const vis = !document.getElementById('glview').hidden ? document.getElementById('glview') : document.getElementById('view');
    const v = document.getElementById('video'), W = 160, H = 90;
    const g = (src) => {
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      const x = c.getContext('2d', { willReadFrequently: true });
      if (src === vis && vis.id === 'glview') window.__watertool.renderGL();
      x.drawImage(src, 0, 0, W, H);
      const d = x.getImageData(0, 0, W, H).data, L = new Float32Array(W * H), G = new Float32Array(W * H);
      for (let i = 0; i < W * H; i++) L[i] = d[i * 4] * 0.3 + d[i * 4 + 1] * 0.59 + d[i * 4 + 2] * 0.11;
      for (let y = 1; y < H - 1; y++) for (let x2 = 1; x2 < W - 1; x2++) {
        const i = y * W + x2;
        G[i] = Math.abs(L[i + 1] - L[i - 1]) + Math.abs(L[i + W] - L[i - W]);
      }
      return G;
    };
    const a = g(vis), b = g(v);
    const ncc = (x0, x1) => {
      let sa = 0, sb = 0, n = 0;
      for (let y = 2; y < H - 2; y++) for (let x = x0; x < x1; x++) { sa += a[y * W + x]; sb += b[y * W + x]; n++; }
      const ma = sa / n, mb = sb / n;
      let c = 0, va = 0, vb = 0;
      for (let y = 2; y < H - 2; y++) for (let x = x0; x < x1; x++) { const p = a[y * W + x] - ma, q = b[y * W + x] - mb; c += p * q; va += p * p; vb += q * q; }
      return c / Math.sqrt(va * vb + 1e-9);
    };
    return { left: ncc(4, 76), right: ncc(84, 156), canvas: vis.id, t: v.currentTime };
  };
});
const sample = async (label, n = 6) => {
  let worst = 1, worstL = 1;
  for (let i = 0; i < n; i++) {
    await page.waitForTimeout(250);
    const r = await page.evaluate(() => window.__sync());
    // 兩半都低 = 擷取時剛好遇到換鏡頭（畫面差一格），不算；只有「左半正常、右半對不上」才是兩半不同時刻
    if (r.left >= 0.7 && r.right < 0.5) { // 存下異常畫面
      const f = `/tmp/claude-sync-${label.replace(/[^a-z0-9]/gi, '_')}-${i}.png`;
      await page.locator('#viewer').screenshot({ path: f });
      console.log(`  異常：左 ${r.left.toFixed(2)} 右 ${r.right.toFixed(2)} 畫布 ${r.canvas} t=${r.t.toFixed(2)} → ${f}`);
    }
    if (r.left >= 0.7) worst = Math.min(worst, r.right);
    worstL = Math.min(worstL, r.left);
  }
  console.log(`${label}: 左半相關最低 ${worstL.toFixed(2)}、右半相關最低 ${worst.toFixed(2)}${worst < 0.5 ? '  ← 右半不是同一個時刻' : ''}`);
  return worst;
};
const select = (id) => page.evaluate((id) => window.__watertool.select(id), id);
let bad = 0;
// 1. 暫停時換成 Diverout_sim，馬上播放
await select('diverout');
await page.click('#play');
if (await sample('換成 Diverout_sim 後馬上播放') < 0.5) bad++;
// 2. 播放中換方法
for (const id of ['rghs', 'fiveaplus', 'diverout', 'mlle']) { await select(id); if (await sample(`播放中換成 ${id}`) < 0.5) bad++; }
// 3. 暫停、換方法、再播放（重複幾次）
for (const id of ['diverout', 'ancuti', 'diverout', 'nu2net']) {
  await page.click('#play');
  await page.waitForTimeout(150);
  await select(id);
  await page.waitForTimeout(100);
  await page.click('#play');
  if (await sample(`暫停→換成 ${id}→播放`) < 0.5) bad++;
}
// 4. Diverout_sim 關鍵幀已備妥（GPU 用色彩矩陣）時播放中換成別的方法：色彩計算要重新開始、標籤要更新
const setPlaying = async (want) => { if ((await page.evaluate(() => window.__watertool.state.playing)) !== want) await page.click('#play'); };
await setPlaying(false);
await select('diverout');
await page.waitForFunction(() => window.__watertool.keyInfo().ready, null, { timeout: 60000 });
await page.evaluate(() => new Promise((ok) => { const v = document.getElementById('video'); v.addEventListener('seeked', ok, { once: true }); v.currentTime = 0.5; }));
await page.waitForFunction(() => document.getElementById('busy').hidden, null, { timeout: 30000 });
await setPlaying(true);
await page.waitForTimeout(600);
const m0 = await page.evaluate(() => window.__watertool.keyInfo().matrix);
await select('rghs');
const fits0 = await page.evaluate(() => window.__watertool.state.fits || 0);
await page.waitForTimeout(1500);
const sw = await page.evaluate((f0) => ({ fits: (window.__watertool.state.fits || 0) - f0, tag: document.getElementById('tagR').textContent, st: document.getElementById('stTime').textContent }), fits0);
const okSw = m0 && sw.fits >= 3 && sw.tag === 'RGHS' && /色彩每/.test(sw.st);
console.log(`${okSw ? '✓' : '✗'} Diverout_sim（矩陣模式）播放中換成 RGHS：1.5 秒內色彩更新 ${sw.fits} 次、標籤「${sw.tag}」、狀態「${sw.st.slice(0, 30)}…」`);
if (!okSw) bad++;
console.log({ bad, errors });
await browser.close(); server.close();
process.exit(bad ? 1 : 0);
