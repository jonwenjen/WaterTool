// Service Worker：離線可用、快取優先、新版整批更新。
//   node scripts/sw-check.mjs
// 照 .github/workflows/pages.yml 的方式做出網站目錄並標記版本（scripts/stamp-sw.mjs），在 ?sw 模式（本機也註冊 Service Worker）下：
//   (1) 第一次開啟安裝完成、有跨來源隔離；(2) 斷網重新整理仍能開啟、方法清單正常；
//   (3) 改一個檔案、重新標記版本 → 回到前景時更新，還沒開素材 → 自動重新整理成新版。
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const site = mkdtempSync(join(tmpdir(), 'wt-site-'));
const repo = new URL('..', import.meta.url).pathname;
execFileSync('cp', ['-r', ...['index.html', 'app.js', 'player-gl.js', 'worker.js', 'copy-worker.js', 'style.css', 'sw.js', 'manifest.webmanifest', 'icons', 'lib', 'vendor'].map((f) => join(repo, f)), site]);
const stamp = () => execFileSync('node', [join(repo, 'scripts/stamp-sw.mjs'), site]).toString().trim();
const v1 = stamp();
process.env.ROOT = site;
process.env.COI = '0'; // 模擬 GitHub Pages：沒有隔離標頭，由 Service Worker 補上
const { serve } = await import('./serve.mjs');
const port = 8900 + Math.floor(Math.random() * 50), server = await serve(port);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const context = await browser.newContext();
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
let fails = 0;
const ok = (c, msg) => { console.log((c ? '✓ ' : '✗ ') + msg); if (!c) fails++; };
const url = `http://localhost:${port}/?sw`;

await page.goto(url);
await page.waitForFunction(() => navigator.serviceWorker.controller && self.crossOriginIsolated && document.querySelectorAll('.method').length > 0, null, { timeout: 30000 }).catch(() => {});
const s1 = await page.evaluate(async () => ({ ctl: !!navigator.serviceWorker.controller, coi: self.crossOriginIsolated, keys: await caches.keys(), n: document.querySelectorAll('.method').length }));
ok(s1.ctl && s1.coi && s1.keys.includes(v1) && s1.n > 0, `第一次開啟：Service Worker 接手、跨來源隔離（${JSON.stringify(s1)}）`);

await context.setOffline(true);
await page.reload();
await page.waitForFunction(() => document.querySelectorAll('.method').length > 0, null, { timeout: 15000 }).catch(() => {});
const s2 = await page.evaluate(() => ({ n: document.querySelectorAll('.method').length, coi: self.crossOriginIsolated }));
ok(s2.n > 0 && s2.coi, `斷網重新整理仍能開啟（${s2.n} 種方法、隔離 ${s2.coi}）`);
await context.setOffline(false);

// 新版：改 app.js（加一個標記）→ 重新標記版本
writeFileSync(join(site, 'app.js'), readFileSync(join(site, 'app.js'), 'utf8') + '\nwindow.__swVersion = 2;\n');
writeFileSync(join(site, 'sw.js'), readFileSync(join(repo, 'sw.js'), 'utf8'));
const v2 = stamp();
ok(v2 !== v1, `改了檔案，版本跟著變（${v1} → ${v2}）`);
// 回到前景 → reg.update() → 新版安裝、接手 → 頁面（沒開素材）自動重新整理
await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
const updated = await page.waitForFunction(() => window.__swVersion === 2, null, { timeout: 30000 }).then(() => true, () => false);
const s3 = await page.evaluate(async () => ({ keys: await caches.keys(), coi: self.crossOriginIsolated }));
ok(updated && s3.keys.includes(v2) && !s3.keys.includes(v1) && s3.coi, `有新版時自動更新成新版、舊快取清掉（${JSON.stringify(s3)}）`);
ok(!errors.length, '沒有頁面錯誤' + (errors.length ? '：' + errors.join(' / ') : ''));
await browser.close();
server.close();
rmSync(site, { recursive: true, force: true });
process.exit(fails ? 1 : 0);
