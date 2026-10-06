// 介面壓力測試：播放 / 暫停 / 連續調參數 / 換方法，之後畫面必須回到可用狀態（沒有卡住、套用最新設定）。
//   node scripts/stress-ui.mjs <影片> [方法 id，預設 nu2net] [回合數]
import { chromium } from 'playwright';
import { serve } from './serve.mjs';
const [VIDEO, METHOD = 'nu2net', ROUNDS = '12'] = process.argv.slice(2);
const port = 8998, server = await serve(port);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await page.goto(`http://localhost:${port}/`);
await page.setInputFiles('#file', VIDEO);
await page.waitForFunction(() => window.__watertool.state.src?.kind === 'video');
await page.evaluate((id) => window.__watertool.select(id), METHOD);
await page.waitForFunction(() => document.getElementById('busy').hidden, null, { timeout: 180000 });
const setRange = (sel, v) => page.evaluate(([sel, v]) => { const el = document.querySelector(sel); el.value = String(v); el.dispatchEvent(new Event('input', { bubbles: true })); }, [sel, v]);
const idle = async (ms = 60000) => {
  const t0 = Date.now();
  try {
    await page.waitForFunction(() => document.getElementById('busy').hidden && !/播放：/.test(document.getElementById('stTime').textContent), null, { timeout: ms });
    return Date.now() - t0;
  } catch { return -1; }
};
let stuck = 0;
for (let r = 0; r < +ROUNDS; r++) {
  await page.click('#play');
  await page.waitForTimeout(300 + (r % 3) * 400);
  const rng = await page.$$('#params input[type=range]');
  if (rng.length) await setRange('#params input[type=range]', r % 2 ? 0.6 : 1.2);
  await setRange('#tTau', (r % 4) * 0.5);
  await page.click('#play'); // 暫停
  for (let k = 0; k < 5; k++) { await setRange('#mix', 0.5 + k * 0.1); await page.waitForTimeout(40); }
  if (rng.length) await setRange('#params input[type=range]', 0.8 + (r % 5) * 0.1);
  const ms = await idle();
  const st = await page.textContent('#stTime');
  if (ms < 0) stuck++;
  console.log(`round ${r}: ${ms < 0 ? 'STUCK' : 'idle after ' + ms + ' ms'} | ${st}`);
}
console.log({ stuck, errors: errors.slice(0, 5) });
await browser.close(); server.close();
process.exit(stuck ? 1 : 0);
