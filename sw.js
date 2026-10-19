// 離線快取＋跨來源隔離標頭。
// - App 程式（HTML/JS/CSS…）：快取優先 —— 開啟時直接用本機的一整套檔案（不必等網路），網路差也立即顯示。
//   部署時 scripts/stamp-sw.mjs 把 APP_CACHE 換成全部檔案內容的雜湊：任何檔案改了 sw.js 就跟著變，
//   瀏覽器安裝新版 Service Worker 時一次下載整套新檔案（install），裝好才切換（activate），不會新舊檔案混用；
//   頁面在沒開素材時自動重新整理成新版（app.js）。
// - 深度模型（models/*.onnx）與 ONNX 執行環境 WASM：由 worker.js 存在獨立的 MODEL_CACHE，
//   App 更新不會清掉，只下載一次；這裡不攔截這兩個檔案。
const APP_CACHE = 'watertool-app-dev'; // 部署時換成內容雜湊
const MODEL_CACHE = 'watertool-models-v1'; // 與 worker.js 相同
const PERSISTENT = /\/(models\/[^/]+\.onnx|vendor\/ort\/ort-wasm-simd-threaded(\.asyncify)?\.wasm)$/;
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'player-gl.js', 'worker.js', 'copy-worker.js', 'manifest.webmanifest', 'icons/icon.svg',
  'lib/core.js', 'lib/pipeline.js', 'lib/temporal.js', 'lib/metrics.js', 'lib/synth.js',
  'lib/keyframes.js', 'lib/help.js', 'lib/edit.js', 'lib/methods/index.js', 'lib/methods/info.js', 'lib/methods/ancuti.js', 'lib/methods/mlle.js', 'lib/methods/ulap.js',
  'lib/methods/udcp.js', 'lib/methods/rghs.js', 'lib/methods/seathru.js', 'lib/methods/ibla.js', 'lib/methods/net.js',
  'lib/methods/funie.js', 'lib/methods/uieb-nets.js', 'lib/methods/waternet.js', 'lib/methods/diverout.js', 'lib/methods/fgdpa.js', 'lib/methods/blend.js', 'lib/methods/gpu-ref.js', 'vendor/ort/ort.wasm.bundle.min.mjs', 'vendor/ort/ort.webgpu.bundle.min.mjs',
  'vendor/mediabunny.min.mjs'];

self.addEventListener('install', (e) => {
  // cache: 'reload'：不要拿瀏覽器 HTTP 快取裡的舊檔（GitHub Pages 會讓檔案快取 10 分鐘）
  e.waitUntil(caches.open(APP_CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const models = await caches.open(MODEL_CACHE);
    for (const k of await caches.keys()) {
      if (k === APP_CACHE || k === MODEL_CACHE) continue;
      // 舊版（watertool-v1/v2）把模型和程式放在同一個快取：先把模型搬過來，免得使用者再下載一次
      const old = await caches.open(k);
      for (const req of await old.keys()) {
        if (PERSISTENT.test(new URL(req.url).pathname) && !(await models.match(req.url))) {
          const res = await old.match(req);
          if (res && res.ok) await models.put(req.url, res);
        }
      }
      await caches.delete(k);
    }
    await self.clients.claim();
  })());
});

// GitHub Pages 不能設 HTTP 標頭：由這裡補上跨來源隔離（COOP/COEP）→ 頁面可用 SharedArrayBuffer，
// ONNX 執行環境就能多執行緒（深度模型快 2–3 倍）。所有資源都是同源，不受 require-corp 影響。
function isolate(res) {
  if (!res || res.status === 0 || res.type === 'opaque') return res;
  const h = new Headers(res.headers);
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('Cross-Origin-Embedder-Policy', 'require-corp');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || PERSISTENT.test(url.pathname)) return;
  e.respondWith((async () => {
    const cache = await caches.open(APP_CACHE);
    // 頁面本身（./、index.html、帶查詢字串）都對應到快取的 ./；其他檔案依路徑（忽略 ?retry= 之類的查詢字串）
    const hit = await cache.match(req.mode === 'navigate' ? './' : req, { ignoreSearch: true });
    if (hit) return isolate(hit);
    const res = await fetch(req);
    if (res.ok && !url.search) cache.put(req, res.clone()).catch(() => {});
    return isolate(res);
  })());
});
