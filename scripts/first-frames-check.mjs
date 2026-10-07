// 匯出開頭是否閃色（例：相機剛開錄時白平衡／曝光還沒穩定的幾格，被關鍵幀內插帶到後面的正常畫面）。
//   node scripts/first-frames-check.mjs <乾淨的影片> [方法,方法…] [匯出方式 0.5|1|0] [開頭偏色幾格，預設 4]
// 自動做一支「開頭 N 格偏暗偏紅」的版本，兩支都用同一方法匯出：第 N 格之後的原片一模一樣，
// 輸出也應該一樣 —— 相差越多代表開頭的偏色「漏」到後面越多（逐格平均 RGB 的最大差，0–255）。
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { serve } from './serve.mjs';
const [CLEAN, ONLY, EXP = '0.5', NT = '4'] = process.argv.slice(2);
const TINT = `/tmp/claude-ff-tinted-${NT}.mp4`;
execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', CLEAN, '-vf', `colorchannelmixer=rr=0.85:gg=0.6:bb=0.5:enable='lt(n,${NT})'`, '-c:v', 'libvpx-vp9', '-b:v', '2M', '-c:a', 'copy', TINT]);
const port = 8900 + Math.floor(Math.random() * 80), server = await serve(port);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`http://localhost:${port}/`);
const ids = ONLY ? ONLY.split(',') : ['uiec2net', 'fiveaplus', 'nu2net', 'uwcnn', 'funie', 'waternet', 'uvenet', 'ancuti', 'mlle', 'ulap', 'udcp', 'rghs', 'seathru', 'ibla', 'diverout'];
const means = (f) => {
  const [w, h] = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', f]).toString().trim().split(',').map(Number);
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', f, '-t', '2', '-vf', 'scale=160:-2', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 28 });
  const sw = 160, sh = Math.round((h * 160) / w / 2) * 2, sz = sw * sh * 3, out = [];
  for (let o = 0; o + sz <= raw.length; o += sz) {
    const s = [0, 0, 0];
    for (let i = 0; i < sz; i += 3) for (let c = 0; c < 3; c++) s[c] += raw[o + i + c];
    out.push(s.map((v) => v / (sw * sh)));
  }
  return out;
};
const exportAll = async (video, tag) => {
  await page.setInputFiles('#file', video);
  await page.waitForFunction((n) => window.__watertool.state.src?.kind === 'video' && window.__watertool.state.src.file?.name === n, video.split('/').pop());
  await page.waitForFunction(() => document.getElementById('busy').hidden, null, { timeout: 60000 });
  await page.selectOption('#outRes', '720');
  await page.selectOption('#netExp', EXP);
  const res = {};
  for (const id of ids) {
    await page.evaluate((id) => window.__watertool.select(id), id);
    await page.waitForFunction(() => document.getElementById('busy').hidden && !document.getElementById('export').disabled, null, { timeout: 300000 });
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 900000 }), page.click('#export')]);
    const f = `/tmp/claude-ff-${tag}-${id}.mp4`;
    await dl.saveAs(f);
    res[id] = { m: means(f), keys: (await page.evaluate(() => window.__watertool.state.lastExport))?.keys ?? '-' };
  }
  return res;
};
const A = await exportAll(CLEAN, 'clean'), B = await exportAll(TINT, 'tint');
const n0 = +NT;
let bad = 0;
for (const id of ids) {
  const a = A[id].m, b = B[id].m, diff = (i) => Math.max(...a[i].map((x, c) => Math.abs(x - b[i][c])));
  const leak = [];
  for (let i = n0; i < Math.min(a.length, b.length, 45); i++) leak.push(diff(i));
  const worst = Math.max(...leak), frames = leak.filter((v) => v > 3).length, flag = worst > 6;
  if (flag) bad++;
  const r = (v) => v.map((x) => x.toFixed(0)).join('/');
  console.log(`${flag ? '✗' : '✓'} ${id.padEnd(10)} 偏色漏到後面：最大 ${worst.toFixed(1)}、${frames} 格 > 3  （關鍵幀 ${B[id].keys} 個；第 ${n0 + 1} 格 乾淨 ${r(a[n0 + 1])} vs 偏色版 ${r(b[n0 + 1])}）`);
}
console.log(errors.length ? '頁面錯誤：' + errors.join(' | ') : '沒有頁面錯誤');
await browser.close(); server.close();
process.exit(bad ? 1 : 0);
