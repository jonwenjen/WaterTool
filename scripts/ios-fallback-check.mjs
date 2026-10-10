// 模擬 iPhone 第二次匯出：WebCodecs 解碼暫時失敗（剛匯出完大影片，解碼器與記憶體還沒釋放）、
// 程式另開的看不見 <video> 又永遠不載入 → 關鍵幀分析應借用畫面上的播放器完成，匯出成功、播放器跳回原來的時間。
//   node scripts/ios-fallback-check.mjs <影片>
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { serve } from './serve.mjs';
const port = 9020 + Math.floor(Math.random() * 30), server = await serve(port);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.addInitScript(() => {
  // 程式另外建立的 <video>（關鍵幀備援）永遠不載入（iPhone 不替看不見的新 <video> 載入資料）
  const orig = document.createElement.bind(document);
  document.createElement = (tag, ...a) => {
    const el = orig(tag, ...a);
    if (String(tag).toLowerCase() === 'video') { const ae = el.addEventListener.bind(el); el.addEventListener = (ev, fn, o) => (ev === 'loadeddata' ? undefined : ae(ev, fn, o)); }
    return el;
  };
  // window.__failDecode > 0 時，WebCodecs 回報無法解碼（每次查詢減 1）
  window.__failDecode = 0;
  const isc = VideoDecoder.isConfigSupported.bind(VideoDecoder);
  VideoDecoder.isConfigSupported = async (cfg) => {
    if (window.__failDecode > 0) { window.__failDecode--; return { supported: false, config: cfg }; }
    return isc(cfg);
  };
});
await page.goto(`http://localhost:${port}/`);
await page.setInputFiles('#file', process.argv[2]);
await page.waitForFunction(() => window.__watertool.state.src?.kind === 'video');
await page.waitForFunction(() => document.getElementById('busy').hidden, null, { timeout: 60000 });
let fails = 0;
const ok = (c, m) => { console.log((c ? '✓ ' : '✗ ') + m); if (!c) fails++; };
const exportOnce = async (name) => {
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 600000 }), page.click('#export')]);
  const f = `/tmp/claude-iosfb-${name}.mp4`;
  await dl.saveAs(f);
  await page.waitForFunction(() => !document.getElementById('export').disabled);
  return +execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', f]).toString().trim();
};
for (const id of ['fiveaplus', 'diverout']) {
  await page.evaluate((m) => window.__watertool.select(m), id);
  await page.waitForFunction(() => document.getElementById('busy').hidden && !document.getElementById('export').disabled, null, { timeout: 300000 });
  const n1 = await exportOnce(id + '1');
  // 停在 1.2 秒；接下來 WebCodecs 前 3 次查詢都失敗（關鍵幀分析的 3 次嘗試），之後恢復（匯出本身可以解碼）
  await page.evaluate(() => { document.getElementById('video').currentTime = 1.2; });
  await page.waitForFunction(() => document.getElementById('busy').hidden, null, { timeout: 60000 });
  if (id === 'diverout') {
    // Diverout_sim 的關鍵幀在切換方法時就分析好了；換參數讓它重新分析（這時 WebCodecs 失敗）
    await page.evaluate(() => { window.__failDecode = 3; const el = document.getElementById('post'); el.value = '0.3'; el.dispatchEvent(new Event('input')); });
  } else await page.evaluate(() => { window.__failDecode = 3; });
  const n2 = await exportOnce(id + '2');
  const st = await page.evaluate(() => ({ t: document.getElementById('video').currentTime, note: document.getElementById('exportNote').textContent, left: window.__failDecode }));
  ok(n2 === n1 && /完成/.test(st.note) && st.left === 0, `${id}：WebCodecs 失敗時借用播放器分析關鍵幀，第二次匯出 ${n2} 格（第一次 ${n1}）「${st.note.trim()}」`);
  ok(Math.abs(st.t - 1.2) < 0.05, `${id}：播放器跳回原來的時間（${st.t.toFixed(2)} 秒）`);
}
ok(errors.length === 0, '沒有頁面錯誤' + (errors.length ? '：' + errors.join('；') : ''));
await browser.close();
server.close();
process.exit(fails ? 1 : 0);
