// WebGPU 與 CPU（WASM）算出的深度模型結果是否相同。
//   node scripts/webgpu-check.mjs [方法,…]
// 無頭 Chromium 用 SwiftShader（CPU 模擬的 Vulkan）提供 WebGPU：只驗證正確性與「GPU 失敗時改用 CPU」的流程，速度不代表真的 GPU。
import { chromium } from 'playwright';
import { serve } from './serve.mjs';
const ids = (process.argv[2] || 'fiveaplus,nu2net,uiec2net,waternet,fgdpa,uvenet,uwcnn,funie').split(',');
const port = 8960 + Math.floor(Math.random() * 30), server = await serve(port);
const GPU = ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--use-webgpu-adapter=swiftshader', '--disable-vulkan-surface'];
let fails = 0;
const ok = (c, msg) => { console.log((c ? '✓ ' : '✗ ') + msg); if (!c) fails++; };
async function run(args, gpu) {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  if (process.env.DEBUG) page.on('console', (m) => console.log('[console]', m.type(), m.text().slice(0, 200)));
  await page.addInitScript((g) => localStorage.setItem('watertool', JSON.stringify({ ui: { gpu: g } })), gpu);
  await page.goto(`http://localhost:${port}/`);
  await page.waitForFunction(() => window.__watertool);
  await page.evaluate(() => window.__watertool.setWatchdog(900000));
  const out = {};
  for (const id of ids) {
    // 同一張合成畫面（固定），直接交給背景執行緒處理
    out[id] = await page.evaluate(async (id) => {
      const W = window.__watertool, w = 320, h = 180, rgba = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        rgba[i] = 20 + (x * 60) / w; rgba[i + 1] = 90 + (y * 100) / h; rgba[i + 2] = 110 + ((x + y) % 40); rgba[i + 3] = 255;
      }
      const t0 = performance.now();
      const r = await W.call({ type: 'process', slot: 'export', rgba: rgba.buffer, w, h, opts: { method: id, params: undefined, mix: 1, post: 0 } });
      return { px: Array.from(new Uint8ClampedArray(r.rgba)), ms: performance.now() - t0, backend: W.state.backend };
    }, id);
  }
  let toggled = null;
  if (gpu) { // 關掉「GPU 加速」：背景執行緒重新啟動，之後用 CPU
    await page.click('#gpuOn');
    toggled = await page.evaluate(async (id) => {
      const W = window.__watertool, w = 64, h = 36, rgba = new Uint8ClampedArray(w * h * 4).fill(120);
      await W.call({ type: 'process', slot: 'export', rgba: rgba.buffer, w, h, opts: { method: id, mix: 1, post: 0 } });
      return { backend: W.state.backend, note: document.getElementById('gpuNote').textContent };
    }, ids[0]);
  }
  await browser.close();
  return { out, errors, toggled };
}
const cpu = await run([], false), gpu = await run(GPU, true);
for (const id of ids) {
  const a = cpu.out[id].px, b = gpu.out[id].px;
  let max = 0, sum = 0;
  for (let i = 0; i < a.length; i++) { if (i % 4 === 3) continue; const d = Math.abs(a[i] - b[i]); max = Math.max(max, d); sum += d; }
  // GPU 自我檢查沒通過的模型會自動改用 CPU（backend = wasm）：結果仍必須和 CPU 相同
  ok(max <= 2, `${id}：${gpu.out[id].backend === 'webgpu' ? 'GPU' : 'GPU 自我檢查不通過 → 自動改用 CPU'}，與 CPU 的結果最大差 ${max}、平均 ${(sum / (a.length * 0.75)).toFixed(3)}（0–255）`);
}
ok(gpu.toggled && gpu.toggled.backend === 'wasm', `關掉 GPU 加速後改用 CPU（${JSON.stringify(gpu.toggled)}）`);
ok(!cpu.errors.length && !gpu.errors.length, '沒有頁面錯誤' + [...cpu.errors, ...gpu.errors].join(' / '));
await server.close?.();
process.exit(fails ? 1 : 0);
