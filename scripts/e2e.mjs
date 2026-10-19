// 端對端測試：在無頭 Chromium 中操作 App。
//   node scripts/e2e.mjs [影片檔] [截圖輸出目錄]
// 檢查：合成示範可播放並還原、七法比較、FUnIE-GAN 載入、照片匯出 PNG、影片匯出 MP4（ffprobe 驗證）。
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { serve } from './serve.mjs';

const VIDEO = process.argv[2];
const OUT = process.argv[3] || 'docs/screenshots';
mkdirSync(OUT, { recursive: true });
const TMP = join(tmpdir(), 'watertool-e2e');
mkdirSync(TMP, { recursive: true });
const port = 8700 + Math.floor(Math.random() * 200);
const server = await serve(port);
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined) });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
const ok = (cond, msg) => {
  if (!cond) throw new Error('失敗：' + msg);
  console.log('✓ ' + msg);
};
const { METHODS } = await import('../lib/methods/index.js');
// 點清單上某個方法的按鈕（清單依評測分數排序，用方法 ID 找位置）
const pick = (id) => page.locator('.method').nth(METHODS.findIndex((m) => m.id === id)).click();
const shot = async (o) => {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(200);
  await page.screenshot(o);
};
const waitIdle = () => page.waitForFunction(() => document.getElementById('busy').hidden && !document.getElementById('stTime').textContent.includes('undefined'), null, { timeout: 120000 });

try {
  await page.goto(`http://localhost:${port}/`);
  // 預設簡易模式：方法清單、方法與出處都只列前 6 名，選中的方法在清單裡
  const simple = await page.evaluate(() => ({
    n: document.querySelectorAll('.method').length,
    about: document.querySelectorAll('#about details').length,
    checked: document.querySelectorAll('.method[aria-checked="true"]').length,
    count: document.getElementById('methodCount').textContent,
  }));
  ok(simple.n === 6 && simple.about === 6 && simple.checked === 1 && simple.count === '6', `簡易模式列出 ${simple.n} 種方法、出處 ${simple.about} 項`);
  await page.click('#modeAdvanced');
  const N = await page.evaluate(() => document.querySelectorAll('.method').length);
  const about = await page.evaluate(() => document.querySelectorAll('#about details').length);
  ok(N === METHODS.length && about === METHODS.length, `進階模式列出 ${N} 種方法、出處 ${about} 項`);

  // 合成示範
  await page.click('#demo');
  await page.waitForFunction(() => document.getElementById('stTime').textContent.includes('ms'), null, { timeout: 60000 });
  ok(true, '合成示範產生並完成第一幀還原');
  await page.click('#play');
  await page.waitForTimeout(2500);
  const t = await page.textContent('#time');
  await page.click('#play');
  ok(!t.startsWith('0:00 /') || t !== '0:00 / 0:04', `示範播放中時間前進（${t}）`);
  await waitIdle();
  await shot({ path: join(TMP, 'demo-split.png') });

  // 每種方法都能在介面上跑
  // （清單依評測分數排序，按鈕位置會變，所以依方法 ID 找按鈕）
  const ids = await page.evaluate(() => [...document.querySelectorAll('.method .t')].map((e) => e.firstChild.textContent));
  const classic = METHODS.filter((m) => !m.needsModel && !m.keyframes), nets = METHODS.filter((m) => m.needsModel);
  ok(ids.length === METHODS.length && METHODS.every((m, i) => ids[i] === m.name), '方法清單依評測分數排序');
  for (const m of classic) {
    await pick(m.id);
    await waitIdle();
  }
  ok(true, `${classic.length} 種傳統方法都能在介面上處理`);

  // 換方法：參數、時間一致性、還原強度、自動色階回到預設；解析度、匯出方式、編碼不變；「恢復原本設定」按鈕同樣範圍
  const setVal = (sel, v) => page.evaluate(([sel, v]) => { const el = document.querySelector(sel); el.value = String(v); el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); }, [sel, v]);
  const readSet = () => page.evaluate(() => {
    const v = (id) => document.getElementById(id).value;
    return { tOn: document.getElementById('tOn').checked, tTau: v('tTau'), tEvery: v('tEvery'), mix: v('mix'), post: v('post'), mixV: document.getElementById('mixV').textContent,
      outRes: v('outRes'), netExp: v('netExp'), prevRes: v('prevRes'), param: document.querySelector('#params input[type=range]')?.value, method: window.__watertool.state.method };
  });
  const tweak = async () => {
    await setVal('#mix', 0.5); await setVal('#post', 0.4); await setVal('#tTau', 2); await setVal('#tEvery', 7);
    await page.evaluate(() => { const el = document.getElementById('tOn'); el.checked = false; el.dispatchEvent(new Event('change')); });
    const r = await page.$('#params input[type=range]');
    if (r) await setVal('#params input[type=range]', await r.evaluate((e) => e.min));
  };
  const [ma, mb] = classic.filter((m) => m.params.some((p) => !p.options)).map((m) => m.id); // 有滑桿參數的兩種方法
  await pick(ma); await waitIdle();
  const base = await readSet();
  await setVal('#outRes', '720'); await setVal('#netExp', '1'); await setVal('#prevRes', '480');
  await tweak();
  await pick(mb); await waitIdle();
  const sw = await readSet();
  ok(sw.method === mb && sw.tOn && sw.tTau === base.tTau && sw.tEvery === '1' && sw.mix === '1' && sw.mixV === '100%' && sw.post === '0'
    && sw.outRes === '720' && sw.netExp === '1' && sw.prevRes === '480', `換方法後設定恢復預設、輸出設定保留：${JSON.stringify(sw)}`);
  await pick(ma); await waitIdle();
  ok((await readSet()).param === base.param, '換回原方法時參數也是預設值');
  await tweak();
  await page.click('#resetAll'); await waitIdle();
  const rs = await readSet();
  ok(rs.method === ma && rs.tOn && rs.mix === '1' && rs.post === '0' && rs.tEvery === '1' && rs.param === base.param && rs.outRes === '720',
    `「恢復原本設定」按鈕：${JSON.stringify(rs)}`);
  const deep = METHODS.find((m) => m.needsModel);
  await page.evaluate((id) => window.__watertool.select(id), deep.id);
  ok((await readSet()).tEvery === '4', '換到深度模型時每 N 幀重新估計預設為 4');
  await setVal('#outRes', '1080'); await setVal('#netExp', '0.5'); await setVal('#prevRes', '720');
  await pick(ma); await waitIdle();

  // 全部深度學習模型（下載模型、WASM 推論）
  for (const m of nets) {
    await pick(m.id);
    const id = await page.evaluate(() => window.__watertool.state.method);
    await page.waitForFunction((file) => window.__watertool.state.models.has(file), m.model.file, { timeout: 180000 });
    await waitIdle();
    ok(true, `${id} 模型載入並完成推論`);
  }

  // 七法比較
  await page.click('[data-view=compare]');
  await page.waitForFunction((n) => document.querySelectorAll('.tile canvas').length === n, METHODS.length, { timeout: 600000 });
  ok(true, `全部比較顯示 ${METHODS.length} 張結果`);
  await shot({ path: join(TMP, 'compare.png'), fullPage: true });
  await page.click('[data-view=split]');

  // 示範匯出 MP4（色彩平衡融合）
  await pick('ancuti');
  await waitIdle();
  const lockOn = page.waitForFunction(() => document.getElementById('methods').closest('.card').inert && document.getElementById('mix').closest('.controls').inert, null, { timeout: 30000 }).then(() => true, () => false);
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 300000 }), page.click('#export')]);
  ok(await lockOn, '匯出中鎖住方法與設定');
  ok(await page.waitForFunction(() => !document.getElementById('methods').closest('.card').inert && !document.getElementById('mix').closest('.controls').inert && !document.getElementById('cancel').closest('.card').inert, null, { timeout: 10000 }).then(() => true, () => false), '匯出結束解除鎖定（取消鈕所在卡片不鎖）');
  const demoMp4 = join(TMP, 'demo-export.mp4');
  await dl.saveAs(demoMp4);
  const info = execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-show_entries', 'stream=codec_name,width,height,nb_read_frames', '-of', 'compact', demoMp4]).toString().trim();
  ok(/nb_read_frames=96/.test(info), `示範匯出 MP4：${info}`);

  // 真實影片
  if (VIDEO) {
    await page.setInputFiles('#file', VIDEO);
    await page.waitForFunction(() => window.__watertool.state.src?.kind === 'video', null, { timeout: 30000 });
    await waitIdle();
    await page.click('#play');
    await page.waitForTimeout(2000);
    await page.click('#play');
    await waitIdle();
    await shot({ path: join(OUT, 'video-split.png') });
    ok(true, '真實影片載入、播放、還原');
    await pick('fiveaplus'); // Five A⁺：深度模型的快速匯出
    await waitIdle();
    await page.selectOption('#outRes', '720');
    const [dl2] = await Promise.all([page.waitForEvent('download', { timeout: 600000 }), page.click('#export')]);
    const vOut = join(TMP, 'video-export.mp4');
    await dl2.saveAs(vOut);
    const src = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', VIDEO]).toString().trim();
    const dst = execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-show_entries', 'stream=codec_type,codec_name,width,height,nb_read_frames', '-of', 'compact', vOut]).toString().trim();
    ok(dst.includes(`nb_read_frames=${src}`), `影片匯出 MP4 幀數與原片相同（${src}）：${dst.replace(/\n/g, ' | ')}`);
    const le = await page.evaluate(() => window.__watertool.state.lastExport);
    ok(le && le.fast && le.frames === +src, `深度模型快速匯出：${le && le.keys} 個關鍵幀跑網路、${le && le.frames} 格由 GPU 套用`);

    // Diverout_sim：先分析整支片的關鍵幀 → 暫停預覽、GPU 色彩矩陣播放、匯出都用關鍵幀內插
    await pick('diverout');
    await page.waitForFunction(() => window.__watertool.keyInfo().ready, null, { timeout: 120000 });
    await waitIdle();
    const ki = await page.evaluate(() => window.__watertool.keyInfo());
    ok(ki.keys === 4, `Diverout_sim 關鍵幀分析完成（3 秒片、每 1 秒 → ${ki.keys} 個）`);
    await page.evaluate(() => new Promise((ok) => {
      const v = document.getElementById('video');
      v.addEventListener('seeked', ok, { once: true });
      v.currentTime = 0;
    }));
    await waitIdle();
    await page.click('#play');
    await page.waitForTimeout(1500);
    const mat = await page.evaluate(() => window.__watertool.keyInfo().matrix);
    await page.click('#play');
    await waitIdle();
    ok(mat, 'Diverout_sim 播放時由 GPU 套用關鍵幀內插的色彩矩陣');
    const [dl4] = await Promise.all([page.waitForEvent('download', { timeout: 600000 }), page.click('#export')]);
    const dOut = join(TMP, 'diverout-export.mp4');
    await dl4.saveAs(dOut);
    const dInfo = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', dOut]).toString().trim();
    ok(dInfo === src, `Diverout_sim 影片匯出幀數與原片相同（${dInfo}）`);

    // 組合方法（深度模型＋Diverout_sim 各半）：Diverout_sim 部分分析關鍵幀；播放時 GPU 同時套用矩陣與深度模型係數；快速匯出走 blend
    const mix = METHODS.find((m) => m.blend);
    await pick(mix.id);
    await page.waitForFunction(() => window.__watertool.keyInfo().ready, null, { timeout: 120000 });
    await waitIdle();
    await page.evaluate(() => new Promise((ok) => {
      const v = document.getElementById('video');
      v.addEventListener('seeked', ok, { once: true });
      v.currentTime = 0;
    }));
    await waitIdle();
    const fits0 = await page.evaluate(() => window.__watertool.state.fits || 0);
    await page.click('#play');
    await page.waitForFunction((n) => (window.__watertool.state.fits || 0) > n, fits0, { timeout: 20000 }).catch(() => {});
    const mp = await page.evaluate((n) => ({ matrix: window.__watertool.keyInfo().matrix, fits: (window.__watertool.state.fits || 0) - n }), fits0);
    await page.click('#play');
    await waitIdle();
    ok(mp.matrix && mp.fits > 0, `${mix.short}：播放時 GPU 同時套用 Diverout_sim 矩陣與深度模型係數（係數更新 ${mp.fits} 次）`);
    const [dl5] = await Promise.all([page.waitForEvent('download', { timeout: 600000 }), page.click('#export')]);
    const mOut = join(TMP, 'mix-export.mp4');
    await dl5.saveAs(mOut);
    const mInfo = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', mOut]).toString().trim();
    const me = await page.evaluate(() => window.__watertool.state.lastExport);
    ok(mInfo === src && me && me.kind === 'blend', `${mix.short} 快速匯出（${me && me.kind}，${me && me.keys} 個深度模型關鍵幀）幀數與原片相同（${mInfo}）`);
    await pick('ancuti');
    await waitIdle();
  }

  // 真實照片截圖（PHOTO=路徑）：分割檢視 + 七法比較
  if (process.env.PHOTO) {
    await page.setInputFiles('#file', process.env.PHOTO);
    await page.waitForFunction(() => window.__watertool.state.src?.kind === 'image', null, { timeout: 30000 });
    await waitIdle();
    await page.waitForTimeout(800);
    await shot({ path: join(OUT, 'photo-split.png') });
    await page.click('[data-view=compare]');
    await page.waitForFunction((n) => document.querySelectorAll('.tile canvas').length === n, METHODS.length, { timeout: 600000 });
    await page.locator('#compare').screenshot({ path: join(OUT, 'photo-compare.png') });
    await page.click('[data-view=split]');
    ok(true, '真實照片截圖');
  }

  // 照片：把示範第一幀存成 PNG 再開啟
  const png = await page.evaluate(() => document.getElementById('view').toDataURL('image/png'));
  const pngPath = join(TMP, 'still.png');
  writeFileSync(pngPath, Buffer.from(png.split(',')[1], 'base64'));
  await page.setInputFiles('#file', pngPath);
  await page.waitForFunction(() => window.__watertool.state.src?.kind === 'image', null, { timeout: 30000 });
  await waitIdle();
  const [dl3] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), page.click('#export')]);
  ok((await dl3.suggestedFilename()).endsWith('.png'), '照片匯出 PNG');

  // 手機版面
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  ok(!overflow, '手機寬度 390px 無水平捲動');
  await shot({ path: join(OUT, 'mobile.png') });

  ok(errors.length === 0, '沒有頁面錯誤' + (errors.length ? '：' + errors.join(' / ') : ''));
} finally {
  await browser.close();
  server.close();
}
