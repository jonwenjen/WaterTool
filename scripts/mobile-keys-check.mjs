// 模擬手機：App 另外建立的 <video>（看不見）永遠不載入資料。關鍵幀分析與 Diverout_sim 匯出仍要完成。
//   node scripts/mobile-keys-check.mjs <影片>
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { serve } from './serve.mjs';
const port = 8994, server = await serve(port);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage();
await page.addInitScript(() => {
  const orig = Document.prototype.createElement;
  Document.prototype.createElement = function (tag, ...rest) {
    const el = orig.call(this, tag, ...rest);
    if (String(tag).toLowerCase() === 'video') {
      Object.defineProperty(el, 'src', { set() {}, get() { return ''; } }); // 不載入
      el.load = () => {};
    }
    return el;
  };
});
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`http://localhost:${port}/`);
await page.setInputFiles('#file', process.argv[2]);
await page.waitForFunction(() => window.__watertool.state.src?.kind === 'video');
await page.evaluate(() => window.__watertool.select('diverout'));
let fails = 0;
const ok = (c, m) => { console.log((c ? '✓ ' : '✗ ') + m); if (!c) fails++; };
const ready = await page.waitForFunction(() => window.__watertool.keyInfo().ready, null, { timeout: 60000 }).then(() => true, () => false);
const ki = await page.evaluate(() => window.__watertool.keyInfo());
ok(ready, `隱藏 <video> 不載入時，關鍵幀仍由 Mediabunny 解出（${ki.keys} 個）`);
await page.selectOption('#outRes', '720');
const dl = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), page.click('#export')]).then(([d]) => d, () => null);
if (dl) {
  await dl.saveAs('/tmp/claude-mobile-keys.mp4');
  const n = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', '/tmp/claude-mobile-keys.mp4']).toString().trim();
  ok(+n > 0, `Diverout_sim 匯出完成（${n} 格）`);
} else ok(false, `Diverout_sim 匯出完成（${await page.textContent('#exportNote')}）`);
// 其他方法的快速匯出也用同一套關鍵幀
await page.evaluate(() => window.__watertool.select('rghs'));
await page.waitForFunction(() => document.getElementById('busy').hidden, null, { timeout: 60000 });
const dl2 = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), page.click('#export')]).then(([d]) => d, () => null);
ok(!!dl2, `RGHS 快速匯出完成（${await page.evaluate(() => JSON.stringify(window.__watertool.state.lastExport))}）`);
ok(errors.length === 0, `沒有頁面錯誤 ${errors.join(' | ')}`);
await browser.close(); server.close();
process.exit(fails ? 1 : 0);
