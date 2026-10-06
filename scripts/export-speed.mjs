// 匯出速度量測：node scripts/export-speed.mjs <影片> <輸出目錄> fiveaplus nu2net …（720p 匯出，印出秒數與是否走快速路徑）
// Q=?sw COI=0：模擬 GitHub Pages（伺服器沒有隔離標頭，由 sw.js 補上）
import { chromium } from 'playwright';
import { serve } from './serve.mjs';
import { execFileSync } from 'node:child_process';
const [VIDEO, OUTDIR, ...ids] = process.argv.slice(2);
const port = 8990, server = await serve(port);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage();
await page.goto(`http://localhost:${port}/${process.env.Q || ''}`);
if (process.env.Q) await page.waitForFunction(() => self.crossOriginIsolated, null, { timeout: 30000 });
await page.setInputFiles('#file', VIDEO);
await page.waitForFunction(() => window.__watertool.state.src?.kind === 'video');
await page.selectOption('#outRes', process.env.OUTRES || '1080'); // App 預設 1080p
for (const id of ids) {
  await page.evaluate((id) => window.__watertool.select?.(id), id);
  const NETS = ['funie', 'nu2net', 'uiec2net', 'uwcnn', 'fiveaplus', 'waternet', 'uvenet'];
  await page.waitForFunction(([id, net]) => window.__watertool.state.method === id && (!net || [...window.__watertool.state.models].some((f) => f.includes(id))), [id, NETS.includes(id)], { timeout: 180000 });
  if (id === 'diverout') await page.waitForFunction(() => window.__watertool.keyInfo().ready, null, { timeout: 180000 });
  await page.waitForFunction(() => document.getElementById('busy').hidden, null, { timeout: 180000 });
  const t0 = Date.now();
  await page.evaluate(() => { window.__watertool.state.lastExport = null; });
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 1800000 }), page.click('#export')]);
  const sec = (Date.now() - t0) / 1000;
  const out = `${OUTDIR}/${id}.mp4`;
  await dl.saveAs(out);
  const n = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', out]).toString().trim();
  console.log(`${id}: ${sec.toFixed(1)} s for ${n} frames  (${await page.textContent('#exportNote')}) ${JSON.stringify(await page.evaluate(() => window.__watertool.state.lastExport))}`);
}
await browser.close(); server.close();
