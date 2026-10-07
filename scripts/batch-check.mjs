// 多部匯出：目前的影片＋另外加入的影片，用同一組方法與設定一部一部匯出。
//   node scripts/batch-check.mjs <影片A> <影片B> <直式影片C>
// 檢查：每部都下載、尺寸與格數各自正確、目前影片的剪輯只用在它自己（或勾選後套到其他影片）、結束後回到原本的影片與剪輯設定、
//       每部影片各自用模型計算（Diverout_sim 各自分析關鍵幀）、取消會略過其餘。
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { serve } from './serve.mjs';
const [A, B, Cv] = process.argv.slice(2);
const port = 8930 + Math.floor(Math.random() * 30), server = await serve(port);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ acceptDownloads: true });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
let fails = 0;
const ok = (c, m) => { console.log((c ? '✓ ' : '✗ ') + m); if (!c) fails++; };
const probe = (f) => execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=width,height,nb_read_frames', '-of', 'csv=p=0', f]).toString().trim();
const meanRGB = (f) => {
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-ss', '1', '-i', f, '-frames:v', '1', '-vf', 'scale=64:64', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  const s = [0, 0, 0];
  for (let i = 0; i < raw.length; i += 3) for (let c = 0; c < 3; c++) s[c] += raw[i + c];
  return s.map((v) => v / (raw.length / 3));
};
await page.goto(`http://localhost:${port}/`);
const open = async (f) => {
  await page.setInputFiles('#file', f);
  await page.waitForFunction((n) => window.__watertool.state.src?.name === n, f.split('/').pop());
  await page.waitForFunction(() => document.getElementById('busy').hidden, null, { timeout: 60000 });
};
const runBatch = async (n, tag) => {
  const files = [];
  const onDl = async (d) => { const f = `/tmp/claude-batch-${tag}-${files.length}-${d.suggestedFilename()}`; files.push(f); await d.saveAs(f); };
  page.on('download', onDl);
  await page.click('#batchRun');
  await page.waitForFunction(() => !document.getElementById('batchRun').textContent.includes('中'), null, { timeout: 900000 });
  await page.waitForTimeout(500);
  page.off('download', onDl);
  return { files, last: await page.evaluate(() => window.__watertool.state.lastBatch), n };
};

// 1. Five A⁺ 強度 0.8，目前的影片右轉 90°，加入兩部；不勾「套用剪輯」
await open(A);
await page.evaluate(() => window.__watertool.select('fiveaplus'));
await page.waitForFunction(() => document.getElementById('busy').hidden && !document.getElementById('export').disabled, null, { timeout: 300000 });
await page.selectOption('#outRes', '0');
await page.click('#rotR');
await page.evaluate(() => { document.getElementById('batchBox').open = true; });
await page.setInputFiles('#batchFiles', [B, Cv]);
ok((await page.textContent('#batchRun')).includes('3 部'), `按鈕顯示「${(await page.textContent('#batchRun')).trim()}」`);
const r1 = await runBatch(3, 'a');
ok(r1.files.length === 3 && r1.last.every((j) => j.status === 'ok'), `3 部都完成並下載：${r1.last.map((j) => j.name + ' ' + j.status).join('、')}`);
const p1 = r1.files.map(probe);
ok(p1[0] === '360,640,180' && p1[1] === '640,360,90' && p1[2] === '360,640,90', `尺寸與格數各自正確（目前的影片轉 90°，其他不轉）：${p1.join(' | ')}`);
ok(r1.files.every((f) => /_fiveaplus\.mp4$/.test(f)), '檔名各自用原檔名＋方法');
const back = await page.evaluate(() => ({ name: window.__watertool.state.src.name, rot: window.__watertool.state.edit.rot }));
ok(back.name === A.split('/').pop() && back.rot === 90, `結束後回到原本的影片（${back.name}）與剪輯設定（旋轉 ${back.rot}°）`);
// 每部影片各自計算：B 的輸出 = 單獨開 B 用同一方法匯出的結果
await open(B);
const [dlB] = await Promise.all([page.waitForEvent('download'), page.click('#export')]);
await dlB.saveAs('/tmp/claude-batch-single-B.mp4');
await page.waitForFunction(() => !document.getElementById('export').disabled);
const mb = meanRGB(r1.files[1]), ms = meanRGB('/tmp/claude-batch-single-B.mp4');
ok(mb.every((v, c) => Math.abs(v - ms[c]) < 1.5), `其他影片的結果與單獨開啟匯出相同：${mb.map((v) => v.toFixed(1))} vs ${ms.map((v) => v.toFixed(1))}`);

// 2. 勾「其他影片也套用」：1:1 裁切 → 每部都是正方形；Diverout_sim 各自分析關鍵幀
await open(A);
await page.evaluate(() => window.__watertool.select('diverout'));
await page.waitForFunction(() => document.getElementById('busy').hidden && !document.getElementById('export').disabled, null, { timeout: 300000 });
await page.selectOption('#aspect', '1:1');
await page.check('#batchEdit');
const r2 = await runBatch(3, 'b');
const p2 = r2.files.map(probe);
ok(r2.last.every((j) => j.status === 'ok') && p2.every((x) => { const [w, h] = x.split(',').map(Number); return w === h; }), `勾選後其他影片也裁成 1:1：${p2.join(' | ')}`);
const raw = [A, B, Cv].map(meanRGB), outs = r2.files.map(meanRGB);
ok(outs.every((o, i) => o.some((v, c) => Math.abs(v - raw[i][c]) > 3)), 'Diverout_sim 每部都有調色（各自的關鍵幀）');

// 3. 取消：第一部進行中按取消 → 其餘略過、回到原本的影片
await page.uncheck('#batchEdit');
await page.click('#editReset');
await page.evaluate(() => window.__watertool.select('nu2net'));
await page.waitForFunction(() => document.getElementById('busy').hidden && !document.getElementById('export').disabled, null, { timeout: 300000 });
await page.selectOption('#netExp', '0'); // 逐格：夠慢，來得及取消
await page.click('#batchRun');
await page.waitForFunction(() => document.querySelector('#batchList li.run'), null, { timeout: 60000 });
await page.waitForTimeout(1500);
await page.click('#cancel');
await page.waitForFunction(() => !document.getElementById('batchRun').textContent.includes('中'), null, { timeout: 300000 });
const last3 = await page.evaluate(() => window.__watertool.state.lastBatch), name3 = await page.evaluate(() => window.__watertool.state.src.name);
ok(last3.every((j) => j.status === 'skip') && name3 === A.split('/').pop(), `取消後其餘略過：${last3.map((j) => j.status).join('、')}，回到 ${name3}`);
const exportOn = await page.evaluate(() => !document.getElementById('export').disabled && !document.getElementById('file').disabled);
ok(exportOn, '結束後按鈕恢復可用');
ok(errors.length === 0, `沒有頁面錯誤 ${errors.join(' | ')}`);
await browser.close(); server.close();
process.exit(fails ? 1 : 0);
