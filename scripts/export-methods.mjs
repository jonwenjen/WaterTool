// 用 App 依序以各方法匯出同一支影片（App 預設的快速匯出），存成 <輸出目錄>/<方法 id>.mp4，給 export-identity-check.mjs 比對。
//   node scripts/export-methods.mjs <影片> <輸出目錄> id1 id2 …
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { serve } from './serve.mjs';
const [VIDEO, OUT, ...IDS] = process.argv.slice(2);
mkdirSync(OUT, { recursive: true });
const port = 8840 + Math.floor(Math.random() * 40), server = await serve(port);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ acceptDownloads: true });
await page.addInitScript(() => localStorage.setItem('watertool', JSON.stringify({ mode: 'advanced', ui: { outRes: '0', vcodec: 'avc' } })));
await page.goto(`http://localhost:${port}/`);
await page.setInputFiles('#file', VIDEO);
await page.waitForFunction(() => window.__watertool.state.src?.kind === 'video', null, { timeout: 30000 });
for (const id of IDS) {
  await page.evaluate((id) => window.__watertool.select(id), id);
  await page.waitForFunction(() => document.getElementById('busy').hidden && !document.getElementById('export').disabled, null, { timeout: 300000 });
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 900000 }), page.click('#export')]);
  await dl.saveAs(join(OUT, `${id}.mp4`));
  const le = await page.evaluate(() => window.__watertool.state.lastExport);
  console.log(`${id}: ${le ? `${le.kind}，${le.keys} 個關鍵幀` : '逐格'} → ${id}.mp4`);
}
await browser.close();
server.close();
