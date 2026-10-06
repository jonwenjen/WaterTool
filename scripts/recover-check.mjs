// 故障恢復測試：(1) 背景執行緒卡死 → 看門狗重啟並重算畫面；(2) 播放中 WebGL 畫布被收回 → 改逐幀處理，影片繼續動、設定照樣套用。
//   node scripts/recover-check.mjs <影片>
import { chromium } from 'playwright';
import { serve } from './serve.mjs';
const port = 8999, server = await serve(port);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`http://localhost:${port}/`);
await page.setInputFiles('#file', process.argv[2]);
await page.waitForFunction(() => window.__watertool.state.src?.kind === 'video');
await page.evaluate(() => window.__watertool.select('fiveaplus'));
await page.waitForFunction(() => [...window.__watertool.state.models].some((f) => f.includes('fiveaplus')) && document.getElementById('busy').hidden, null, { timeout: 120000 });
let fails = 0;
const ok = (c, msg) => { console.log((c ? '✓ ' : '✗ ') + msg); if (!c) fails++; };

// (1) 卡死 → 3 秒看門狗
await page.evaluate(() => window.__watertool.hangWorker(3000));
await page.evaluate(() => { const el = document.getElementById('mix'); el.value = '0.7'; el.dispatchEvent(new Event('input')); });
const t0 = Date.now();
await page.waitForFunction(() => !document.getElementById('busy').hidden, null, { timeout: 10000 });
const recovered = await page.waitForFunction(() => window.__watertool.state.restarts === 1 && document.getElementById('busy').hidden && /估計/.test(document.getElementById('stTime').textContent)
  && [...window.__watertool.state.models].some((f) => f.includes('fiveaplus')), null, { timeout: 60000 }).then(() => true, () => false);
ok(recovered, `背景卡死後 ${((Date.now() - t0) / 1000).toFixed(1)} 秒自動重啟、模型重新載入、畫面重算完成`);

// (2) 播放中 GPU 畫布被收回
await page.evaluate(() => { const v = document.getElementById('video'); v.currentTime = 0; });
await page.waitForTimeout(300);
await page.click('#play');
await page.waitForTimeout(800);
await page.evaluate(() => { window.__lose = document.getElementById('glview').getContext('webgl2').getExtension('WEBGL_lose_context'); window.__lose.loseContext(); });
const ta = await page.evaluate(() => document.getElementById('video').currentTime);
await page.waitForTimeout(1200);
const st = await page.evaluate(() => ({ t: document.getElementById('video').currentTime, gl: !document.getElementById('glview').hidden, view: !document.getElementById('view').hidden, playing: window.__watertool.state.playing }));
ok(st.playing && st.t > ta + 0.5 && !st.gl && st.view, `GPU 畫布被收回後改逐幀處理、影片繼續播放（${ta.toFixed(2)} → ${st.t.toFixed(2)} 秒）`);
await page.click('#play');
await page.waitForFunction(() => document.getElementById('busy').hidden, null, { timeout: 60000 });
await page.evaluate(() => window.__lose.restoreContext()); // GPU 恢復 → 下次播放再用 GPU
await page.waitForTimeout(300);

// (3) 播放中背景卡死 → 重啟後播放時的色彩計算要自己接回來（不能停在「色彩計算中…」）
await page.evaluate(() => window.__watertool.select('rghs'));
await page.waitForFunction(() => document.getElementById('busy').hidden, null, { timeout: 60000 });
await page.evaluate(() => { const v = document.getElementById('video'); v.currentTime = 0; });
await page.waitForTimeout(300);
await page.click('#play');
await page.waitForFunction(() => /色彩每/.test(document.getElementById('stTime').textContent), null, { timeout: 20000 }).catch(() => {});
await page.evaluate(() => window.__watertool.hangWorker(2000));
const fitsBefore = await page.evaluate(() => window.__watertool.state.fits || 0);
const resumed = await page.waitForFunction((n) => window.__watertool.state.restarts === 2 && (window.__watertool.state.fits || 0) > n + 1, fitsBefore, { timeout: 30000 }).then(() => true, () => false);
const st3 = await page.textContent('#stTime');
ok(resumed, `播放中背景卡死 → 重啟後色彩計算自動接回（${st3}）`);
// (4) 播放中換方法 → 下一次計算就用新方法
await page.evaluate(() => window.__watertool.select('mlle'));
const switched = await page.waitForFunction(() => /MLLE/.test(document.getElementById('stMethod').textContent) && /色彩每/.test(document.getElementById('stTime').textContent), null, { timeout: 20000 }).then(() => true, () => false);
ok(switched, '播放中換方法 → 色彩改用新方法計算');
// (5) 暫停瞬間的暫時畫面必須是「這一格」：原片暫時畫面 = 目前影片畫面
await page.click('#play');
const same = await page.evaluate(() => {
  const o = document.createElement('canvas'), v = document.getElementById('video');
  const w = 160, h = 90;
  o.width = w; o.height = h;
  const x = o.getContext('2d', { willReadFrequently: true });
  x.drawImage(v, 0, 0, w, h);
  const a = x.getImageData(0, 0, w, h).data;
  x.drawImage(window.__watertool.origCanvas(), 0, 0, w, h);
  const b = x.getImageData(0, 0, w, h).data;
  let d = 0;
  for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]);
  return d / a.length;
});
ok(same < 6, `暫停後分割畫面用的是目前這一格（平均差 ${same.toFixed(2)}）`);
await page.waitForFunction(() => document.getElementById('busy').hidden && /估計/.test(document.getElementById('stTime').textContent), null, { timeout: 60000 });
ok(errors.length === 0, `沒有頁面錯誤 ${errors.join(' | ')}`);
await browser.close(); server.close();
process.exit(fails ? 1 : 0);
