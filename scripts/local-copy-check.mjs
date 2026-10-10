// 原片存到 App 裡：iPhone 從相簿選的影片，匯出一部大影片後常常就讀不到了（NotReadableError），播放器也不能跳轉。
// 開啟影片後應在背景複製到 OPFS、播放器與匯出改讀副本 → 原檔讀不到之後仍能再匯出。
// 另外檢查：背景執行緒不能用時改用 createWritable、換開別的影片時舊副本被刪掉。
//   node scripts/local-copy-check.mjs <影片A> <影片B>
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { serve } from './serve.mjs';
const [A, B] = process.argv.slice(2);
const port = 9100 + Math.floor(Math.random() * 30), server = await serve(port);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const errors = [];
let fails = 0;
const ok = (c, m) => { console.log((c ? '✓ ' : '✗ ') + m); if (!c) fails++; };
const frames = (f) => +execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', f]).toString().trim();
const srcFiles = (page) => page.evaluate(async () => {
  try { const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('src'); const n = []; for await (const k of d.keys()) n.push(k); return n; } catch { return []; }
});

async function run(label, init) {
  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  if (init) await page.addInitScript(init);
  await page.goto(`http://localhost:${port}/`);
  await page.setInputFiles('#file', A);
  await page.waitForFunction(() => window.__watertool.state.src?.kind === 'video');
  // 等複製完成、換成副本
  await page.waitForFunction(() => window.__watertool.state.src.file !== document.getElementById('file').files[0] && /已存到/.test(document.getElementById('localNote').textContent), null, { timeout: 60000 });
  const note = await page.textContent('#localNote');
  ok(/已存到 App 裡/.test(note) && (await page.evaluate(() => document.getElementById('video').src.startsWith('blob:'))), `${label}：影片已複製到 App 裡、播放器改讀副本（「${note.trim()}」）`);
  await page.evaluate(() => window.__watertool.select('fiveaplus'));
  await page.waitForFunction(() => document.getElementById('busy').hidden && !document.getElementById('export').disabled, null, { timeout: 300000 });
  const exportOnce = async (name) => {
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 300000 }), page.click('#export')]);
    const f = `/tmp/claude-localcopy-${name}.mp4`;
    await dl.saveAs(f);
    await page.waitForFunction(() => !document.getElementById('export').disabled);
    return frames(f);
  };
  const n1 = await exportOnce(label + '1');
  // 模擬 iPhone：原檔之後完全讀不到
  await page.evaluate(() => {
    const f = document.getElementById('file').files[0];
    const err = () => new DOMException('The requested file could not be read, typically due to permission problems that have occurred after a reference to a file was acquired.', 'NotReadableError');
    const deny = (b) => { b.arrayBuffer = () => Promise.reject(err()); b.stream = () => new ReadableStream({ pull(c) { c.error(err()); } }); b.text = b.arrayBuffer; b.slice = function () { return deny(Blob.prototype.slice.apply(this, arguments)); }; return b; };
    deny(f);
  });
  const denied = await page.evaluate(() => document.getElementById('file').files[0].slice(0, 16).arrayBuffer().then(() => 'readable', (e) => e.name));
  ok(denied === 'NotReadableError', `${label}：原檔已讀不到（${denied}）`);
  const n2 = await exportOnce(label + '2');
  const st = await page.textContent('#exportNote');
  ok(n1 > 0 && n2 === n1 && /完成/.test(st), `${label}：原檔讀不到之後再匯出仍成功（${n1} → ${n2} 格，「${st.trim()}」）`);
  const before = await srcFiles(page);
  await page.setInputFiles('#file', B);
  await page.waitForFunction(() => window.__watertool.state.src?.file?.name?.length && window.__watertool.state.src.file !== document.getElementById('file').files[0], null, { timeout: 60000 });
  await page.waitForTimeout(500);
  const after = await srcFiles(page);
  ok(before.length === 1 && after.length === 1 && after[0] !== before[0], `${label}：換開別的影片後只留新影片的副本（${before} → ${after}）`);
  await page.close();
}
await run('背景執行緒複製');
// 背景執行緒不能用（例如瀏覽器不支援）：改用主執行緒 createWritable
await run('createWritable 備援', () => {
  const W = window.Worker;
  window.Worker = function (url, o) { if (String(url).includes('copy-worker')) throw new Error('no worker'); return new W(url, o); };
});
ok(errors.length === 0, '沒有頁面錯誤' + (errors.length ? '：' + errors.join('；') : ''));
await browser.close();
server.close();
process.exit(fails ? 1 : 0);
