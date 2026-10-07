// 連續匯出：第二次匯出時讓 blob.stream() 讀檔失敗（模擬 Android Chrome 的 TypeError: network error），
// 應自動改用分段讀取重試成功；也檢查每次匯出後讀檔器都已關閉。
//   node scripts/reexport-check.mjs <影片>
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { serve } from './serve.mjs';
const port = 8960 + Math.floor(Math.random() * 30), server = await serve(port);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`http://localhost:${port}/`);
await page.setInputFiles('#file', process.argv[2]);
await page.waitForFunction(() => window.__watertool.state.src?.kind === 'video');
await page.waitForFunction(() => document.getElementById('busy').hidden, null, { timeout: 60000 });
let fails = 0;
const ok = (c, m) => { console.log((c ? '✓ ' : '✗ ') + m); if (!c) fails++; };
const exportOnce = async (name) => {
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 600000 }), page.click('#export')]);
  const f = `/tmp/claude-reexport-${name}.mp4`;
  await dl.saveAs(f);
  await page.waitForFunction(() => !document.getElementById('export').disabled);
  return +execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', f]).toString().trim();
};
await page.evaluate(() => window.__watertool.select('fiveaplus'));
await page.waitForFunction(() => document.getElementById('busy').hidden && !document.getElementById('export').disabled, null, { timeout: 300000 });
const n1 = await exportOnce('1');
ok(n1 > 0 && (await page.evaluate(() => window.__watertool.openInputs())) === 0, `第一次匯出 ${n1} 格，讀檔器全部關閉`);
// 之後所有 blob.stream() 讀取都失敗
await page.evaluate(() => {
  Blob.prototype.stream = function () { return new ReadableStream({ pull(c) { c.error(new TypeError('network error')); } }); };
});
await page.selectOption('#trimMode', 'keep');
await page.evaluate(() => { for (const [id, v] of [['trimStart', 1], ['trimEnd', 3]]) { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('change')); el.dispatchEvent(new Event('input')); } });
const n2 = await exportOnce('2');
const note = await page.textContent('#exportNote');
ok(n2 > 0 && /完成/.test(note), `第二次匯出（剪輯＋讀檔串流失敗）自動改用分段讀取：${n2} 格，「${note.trim()}」`);
await page.click('#editReset');
const n3 = await exportOnce('3');
ok(n3 === n1 && (await page.evaluate(() => window.__watertool.openInputs())) === 0, `第三次匯出 ${n3} 格（與第一次相同），讀檔器全部關閉`);
ok(errors.length === 0, `沒有頁面錯誤 ${errors.join(' | ')}`);
await browser.close(); server.close();
process.exit(fails ? 1 : 0);
