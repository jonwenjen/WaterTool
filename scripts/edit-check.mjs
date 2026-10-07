// 剪輯匯出測試：旋轉 + 裁切的幾何（還原強度 0% → 輸出 = 原片像素，與 ffmpeg 做同樣變換比對）、
// 時間裁切 + 變速後的片長與格數、聲音長度。  node scripts/edit-check.mjs <有聲音的影片（建議 ≥ 12 秒）>
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { serve } from './serve.mjs';
const VIDEO = process.argv[2];
const port = 8987, server = await serve(port);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`http://localhost:${port}/`);
await page.setInputFiles('#file', VIDEO);
await page.waitForFunction(() => window.__watertool.state.src?.kind === 'video');
await page.waitForFunction(() => document.getElementById('busy').hidden, null, { timeout: 60000 });
let fails = 0;
const ok = (c, m) => { console.log((c ? '✓ ' : '✗ ') + m); if (!c) fails++; };
const probe = (f, sel, entries) => execFileSync('ffprobe', ['-v', 'error', '-select_streams', sel, '-count_frames', '-show_entries', entries, '-of', 'csv=p=0', f]).toString().trim();
const setVal = (id, v, ev = 'input') => page.evaluate(([id, v, ev]) => { const el = document.getElementById(id); el.value = String(v); el.dispatchEvent(new Event(ev)); }, [id, v, ev]);
const exportTo = async (name) => {
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 600000 }), page.click('#export')]);
  const f = `/tmp/claude-edit-${name}.mp4`;
  await dl.saveAs(f);
  return f;
};
const srcDur = +probe(VIDEO, 'v:0', 'stream=duration') || 18;
await page.selectOption('#outRes', '0');

// 1. 幾何：右轉 90° + 4:5，垂直位置 0（貼齊上方），還原強度 0%
await setVal('mix', 0);
await page.click('#rotR');
await page.selectOption('#aspect', '4:5');
await setVal('panY', 0);
const f1 = await exportTo('geom');
const [w1, h1] = probe(f1, 'v:0', 'stream=width,height').split(',').map(Number);
ok(w1 === 360 && h1 === 450, `旋轉 90° + 4:5 → ${w1}×${h1}（應為 360×450）`);
// ffmpeg：同一格順時針轉 90°（transpose=1）、裁 360×450 貼齊上方
const grab = (f, vf) => execFileSync('ffmpeg', ['-v', 'error', '-ss', '1.0', '-i', f, '-frames:v', '1', '-vf', vf, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 28 });
const A = grab(f1, 'scale=360:450'), B = grab(VIDEO, 'transpose=1,crop=360:450:0:0');
let se = 0;
for (let i = 0; i < A.length; i++) se += (A[i] - B[i]) ** 2;
const ps = 10 * Math.log10(255 * 255 / (se / A.length));
ok(ps > 28, `畫面內容與 ffmpeg 同樣的旋轉＋裁切一致（PSNR ${ps.toFixed(1)} dB）`);

// 2. 刪除 4–8 秒 + 2 倍速
await page.click('#editReset');
await setVal('mix', 1);
await setVal('speed', 2);
await page.selectOption('#trimMode', 'cut');
await setVal('trimStart', 4);
await setVal('trimEnd', 8);
const f2 = await exportTo('cut2x');
const want2 = (srcDur - 4) / 2;
const d2 = +probe(f2, 'v:0', 'stream=duration'), n2 = +probe(f2, 'v:0', 'stream=nb_read_frames'), a2 = +probe(f2, 'a:0', 'stream=duration');
ok(Math.abs(d2 - want2) < 0.2, `刪除 4–8 秒 + 2×：片長 ${d2.toFixed(2)} 秒（應約 ${want2.toFixed(2)}）`);
ok(Math.abs(n2 - want2 * 30) <= 3, `快轉時略過多出來的格，格率維持 30：${n2} 格（應約 ${Math.round(want2 * 30)}）`);
ok(Math.abs(a2 - want2) < 0.25, `聲音也剪掉並變速：${a2.toFixed(2)} 秒`);

// 3. 只保留 2–5 秒 + 0.5 倍慢動作，移除聲音
await page.click('#editReset');
await setVal('speed', 0.5);
await page.selectOption('#audioMode', 'drop');
await page.selectOption('#trimMode', 'keep');
await setVal('trimStart', 2);
await setVal('trimEnd', 5);
const f3 = await exportTo('keep05');
const d3 = +probe(f3, 'v:0', 'stream=duration'), n3 = +probe(f3, 'v:0', 'stream=nb_read_frames');
const hasAudio = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', f3]).toString().trim();
ok(Math.abs(d3 - 6) < 0.2, `只保留 2–5 秒 + 0.5×：片長 ${d3.toFixed(2)} 秒（應約 6）`);
ok(Math.abs(n3 - 90) <= 2, `慢動作不補格：${n3} 格（3 秒 × 30 格）`);
ok(hasAudio === '', '選「移除」時沒有聲音軌');

// 4. 預覽：播放速度與跳過刪掉的區段
await page.click('#editReset');
await setVal('speed', 2);
await page.selectOption('#trimMode', 'cut');
await setVal('trimStart', 1);
await setVal('trimEnd', 6);
await page.evaluate(() => { document.getElementById('video').currentTime = 0.2; });
await page.waitForTimeout(300);
await page.click('#play');
await page.waitForTimeout(1500);
const pv = await page.evaluate(() => ({ rate: document.getElementById('video').playbackRate, t: document.getElementById('video').currentTime }));
await page.click('#play');
ok(pv.rate === 2 && pv.t > 6, `預覽：2× 播放並跳過 1–6 秒（播放 1.5 秒後位於 ${pv.t.toFixed(2)} 秒）`);
// 4b. 在裁切預覽上拖曳：9:16 的框往左拖到底 → 水平位置 0%，往右 → 100%
await page.click('#editReset');
await page.selectOption('#aspect', '9:16');
await page.waitForTimeout(200);
await page.locator('#editPreview').scrollIntoViewIfNeeded();
const box = await page.locator('#editPreview').boundingBox();
const drag = async (dx) => {
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  return page.evaluate(() => ({ panX: window.__watertool.state.edit.panX, slider: +document.getElementById('panX').value }));
};
const l = await drag(-box.width), r = await drag(box.width), m = await drag(-box.width * 0.2);
ok(l.panX === 0 && r.panX === 1 && m.panX > 0.2 && m.panX < 0.9 && Math.abs(m.slider - m.panX) <= 0.005, `拖曳裁切框：往左到底 ${l.panX}、往右到底 ${r.panX}、往回一點 ${m.panX.toFixed(2)}（滑桿同步）`);

// 4c. 拖右下角往中間 → 依比例縮小（比例不變、左上角不動）；滾輪放大；縮放後匯出尺寸跟著變
await page.click('#editReset');
await page.selectOption('#aspect', '9:16');
await page.waitForTimeout(200);
await page.locator('#editPreview').scrollIntoViewIfNeeded();
const b2 = await page.locator('#editPreview').boundingBox();
const before = await page.evaluate(() => ({ ...window.__watertool.state.edit }));
const g = await page.evaluate(() => { const c = document.getElementById('editPreview'), r = c.getBoundingClientRect(); return { k: r.width / c.width }; });
// 預覽 320×180、9:16 置中的框：寬 101、高 180 → 右下角在 (219.5, 180)（畫布像素）
const corner = { x: b2.x + (160 + 101 / 2) * g.k - 2, y: b2.y + 180 * g.k - 2 };
await page.mouse.move(corner.x, corner.y);
await page.mouse.down();
await page.mouse.move(corner.x - 50 * g.k, corner.y - 90 * g.k, { steps: 5 });
await page.mouse.up();
const after = await page.evaluate(() => {
  const E = window.__watertool.state.edit;
  return { zoom: E.zoom, slider: +document.getElementById('zoom').value };
});
ok(after.zoom > 0.45 && after.zoom < 0.55 && Math.abs(after.slider - after.zoom) <= 0.005, `拖右下角往內 → 裁切框縮成 ${Math.round(after.zoom * 100)}%（約 50%，滑桿同步）`);
await page.mouse.move(b2.x + b2.width / 2, b2.y + b2.height / 2);
for (let i = 0; i < 3; i++) await page.mouse.wheel(0, -100);
const z2 = await page.evaluate(() => window.__watertool.state.edit.zoom);
ok(z2 > after.zoom + 0.1, `滑鼠滾輪放大框：${Math.round(after.zoom * 100)}% → ${Math.round(z2 * 100)}%`);
// 雙指捏合（合成兩個觸控指標）：兩指距離變 1.5 倍 → 框放大約 1.5 倍
await setVal('zoom', 0.4);
const pinch = await page.evaluate(() => {
  const c = document.getElementById('editPreview'), r = c.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const ev = (type, id, x, y) => c.dispatchEvent(new PointerEvent(type, { pointerId: id, clientX: x, clientY: y, pointerType: 'touch', bubbles: true, cancelable: true }));
  const z0 = window.__watertool.state.edit.zoom;
  ev('pointerdown', 11, cx - 40, cy); ev('pointerdown', 12, cx + 40, cy);
  ev('pointermove', 12, cx + 80, cy); // 距離 80 → 120
  ev('pointerup', 11, cx - 40, cy); ev('pointerup', 12, cx + 80, cy);
  return { z0, z1: window.__watertool.state.edit.zoom };
});
ok(Math.abs(pinch.z1 / pinch.z0 - 1.5) < 0.05, `雙指捏合：兩指距離 ×1.5 → 框 ${Math.round(pinch.z0 * 100)}% → ${Math.round(pinch.z1 * 100)}%`);
await setVal('zoom', 0.5);
await setVal('mix', 0);
await page.selectOption('#outRes', '0');
const fz = await exportTo('zoom');
const [wz, hz] = probe(fz, 'v:0', 'stream=width,height').split(',').map(Number);
ok(Math.abs(wz - 100) <= 2 && hz === 180, `9:16 + 縮放 50% → ${wz}×${hz}（最大框 202×360 的一半）`);
await setVal('mix', 1);

// 4d. 時間裁切把手：拖「開始」到 25% → 開始時間 ≈ 片長 × 25%，影片跳到那一格
await page.click('#editReset');
await page.selectOption('#trimMode', 'keep');
await page.locator('#trimTrack').scrollIntoViewIfNeeded();
const rail = await page.locator('#trimTrack .trimrail').boundingBox(), hs = await page.locator('#thStart').boundingBox();
await page.mouse.move(hs.x + hs.width / 2, hs.y + hs.height / 2);
await page.mouse.down();
await page.mouse.move(rail.x + rail.width * 0.25, hs.y + hs.height / 2, { steps: 5 });
await page.mouse.up();
await page.waitForTimeout(400);
const tr = await page.evaluate(() => ({ start: window.__watertool.state.edit.trim.start, input: +document.getElementById('trimStart').value, t: document.getElementById('video').currentTime, label: document.getElementById('trimLabel').textContent }));
ok(Math.abs(tr.start - srcDur * 0.25) < 0.3 && Math.abs(tr.t - tr.start) < 0.1 && Math.abs(tr.input - tr.start) < 0.06, `拖曳時間把手：開始 ${tr.start.toFixed(2)} 秒（片長 25% ≈ ${(srcDur * 0.25).toFixed(2)}），影片跳到 ${tr.t.toFixed(2)} 秒，顯示「${tr.label}」`);

// 4e. 「結束跟著播放」：播放時結束點跟著走、按暫停定住；不會自動停在結束點；拖開始把手時自動停止跟隨
await page.click('#editReset');
await page.selectOption('#trimMode', 'keep');
await setVal('trimStart', 1);
await setVal('trimEnd', 3);
await page.evaluate(() => new Promise((ok) => { const v = document.getElementById('video'); v.addEventListener('seeked', ok, { once: true }); v.currentTime = 2; }));
await page.click('#trimFollow button[data-follow="end"]');
const q0 = await page.evaluate(() => window.__watertool.state.edit.trim.end);
await page.click('#play');
await page.waitForTimeout(2000);
await page.click('#play'); // 暫停
await page.waitForTimeout(300);
const q1 = await page.evaluate(() => ({ end: window.__watertool.state.edit.trim.end, t: document.getElementById('video').currentTime, input: +document.getElementById('trimEnd').value, playing: window.__watertool.state.playing }));
ok(Math.abs(q0 - 2) < 0.05 && q1.end > 3.2 && Math.abs(q1.end - q1.t) < 0.1 && Math.abs(q1.input - q1.end) < 0.06, `結束跟著播放：選取時跳到 ${q0.toFixed(2)} 秒，播放後停在 ${q1.end.toFixed(2)} 秒（目前位置 ${q1.t.toFixed(2)}，沒有在原本的 3 秒停下）`);
await page.evaluate(() => new Promise((ok) => { const v = document.getElementById('video'); v.addEventListener('seeked', ok, { once: true }); v.currentTime = 6; }));
await page.waitForTimeout(200);
const q2 = await page.evaluate(() => window.__watertool.state.edit.trim.end);
ok(Math.abs(q2 - 6) < 0.05, `暫停時拖時間軸，結束點也跟著到 ${q2.toFixed(2)} 秒`);
await page.locator('#trimTrack').scrollIntoViewIfNeeded();
const rail2 = await page.locator('#trimTrack .trimrail').boundingBox(), hs2 = await page.locator('#thStart').boundingBox();
await page.mouse.move(hs2.x + hs2.width / 2, hs2.y + hs2.height / 2);
await page.mouse.down();
await page.mouse.move(rail2.x + rail2.width * 0.1, hs2.y + hs2.height / 2, { steps: 3 });
await page.mouse.up();
await page.waitForTimeout(300);
const q3 = await page.evaluate(() => ({ end: window.__watertool.state.edit.trim.end, follow: document.querySelector('#trimFollow button.on').dataset.follow }));
ok(q3.follow === 'none' && Math.abs(q3.end - 6) < 0.05, `拖開始把手時自動停止跟隨，結束點仍在 ${q3.end.toFixed(2)} 秒`);

// 5. 逐格完整計算 + 4× + 1:1
await page.click('#editReset');
await page.selectOption('#netExp', '0');
await setVal('speed', 4);
await page.selectOption('#aspect', '1:1');
const f5 = await exportTo('frame4x');
const [w5, h5] = probe(f5, 'v:0', 'stream=width,height').split(',').map(Number), d5 = +probe(f5, 'v:0', 'stream=duration');
ok(w5 === 360 && h5 === 360 && Math.abs(d5 - srcDur / 4) < 0.2, `逐格完整計算 + 4× + 1:1：${w5}×${h5}、${d5.toFixed(2)} 秒（應約 ${(srcDur / 4).toFixed(2)}）`);
await page.selectOption('#netExp', '0.5');

// 6. 深度模型（Five A⁺）+ 9:16 + 0.25×，只保留 0–1 秒
await page.click('#editReset');
await page.evaluate(() => window.__watertool.select('fiveaplus'));
await page.waitForFunction(() => [...window.__watertool.state.models].some((f) => f.includes('fiveaplus')) && document.getElementById('busy').hidden, null, { timeout: 120000 });
await page.selectOption('#aspect', '9:16');
await setVal('speed', 0.25);
await page.selectOption('#trimMode', 'keep');
await setVal('trimStart', 0);
await setVal('trimEnd', 1);
const f6 = await exportTo('net025');
const [w6, h6] = probe(f6, 'v:0', 'stream=width,height').split(',').map(Number), d6 = +probe(f6, 'v:0', 'stream=duration'), a6 = +probe(f6, 'a:0', 'stream=duration');
const le6 = await page.evaluate(() => window.__watertool.state.lastExport);
ok(le6.keys === 3, `只保留 0–1 秒時只替這 1 秒算關鍵幀：${le6.keys} 個（整支 ${srcDur.toFixed(0)} 秒要 ${Math.ceil(srcDur / 0.5) + 1} 個）`);
ok(w6 === 202 && h6 === 360 && Math.abs(d6 - 4) < 0.2 && Math.abs(a6 - 4) < 0.25, `深度模型 + 9:16 + 0.25×：${w6}×${h6}、畫面 ${d6.toFixed(2)} 秒、聲音 ${a6.toFixed(2)} 秒（應約 4）`);

// 7. 照片：左轉 90° + 1:1
await page.click('#editReset');
await page.evaluate(() => window.__watertool.select('ancuti'));
const png = await page.evaluate(() => document.getElementById('view').toDataURL('image/png'));
const { writeFileSync } = await import('node:fs');
writeFileSync('/tmp/claude-edit-still.png', Buffer.from(png.split(',')[1], 'base64'));
await page.setInputFiles('#file', '/tmp/claude-edit-still.png');
await page.waitForFunction(() => window.__watertool.state.src?.kind === 'image');
await page.waitForFunction(() => document.getElementById('busy').hidden, null, { timeout: 60000 });
const vidHidden = await page.evaluate(() => document.querySelector('#editCard .vidonly').hidden);
await page.click('#rotL');
await page.selectOption('#aspect', '1:1');
const [dl7] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), page.click('#export')]);
await dl7.saveAs('/tmp/claude-edit-photo.png');
const [w7, h7] = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', '/tmp/claude-edit-photo.png']).toString().trim().split(',').map(Number);
ok(w7 === h7 && w7 > 0 && vidHidden, `照片：旋轉＋1:1 → ${w7}×${h7}（照片時隱藏速度與時間裁切）`);
ok(errors.length === 0, `沒有頁面錯誤 ${errors.join(' | ')}`);
await browser.close(); server.close();
process.exit(fails ? 1 : 0);
