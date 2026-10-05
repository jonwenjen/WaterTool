// 離線快取。
// - App 程式（HTML/JS/CSS…）：網路優先，失敗時用快取；快取名稱隨版本更新（APP_CACHE），舊版自動清除。
// - 深度模型（models/*.onnx）與 ONNX 執行環境 WASM：由 worker.js 存在獨立的 MODEL_CACHE，
//   App 更新不會清掉，只下載一次；這裡不攔截這兩個檔案。
const APP_CACHE = 'watertool-app-v8';
const MODEL_CACHE = 'watertool-models-v1'; // 與 worker.js 相同
const PERSISTENT = /\/(models\/[^/]+\.onnx|vendor\/ort\/ort-wasm-simd-threaded\.wasm)$/;
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'player-gl.js', 'worker.js', 'manifest.webmanifest', 'icons/icon.svg',
  'lib/core.js', 'lib/pipeline.js', 'lib/temporal.js', 'lib/metrics.js', 'lib/synth.js',
  'lib/methods/index.js', 'lib/methods/info.js', 'lib/methods/ancuti.js', 'lib/methods/mlle.js', 'lib/methods/ulap.js',
  'lib/methods/udcp.js', 'lib/methods/rghs.js', 'lib/methods/seathru.js', 'lib/methods/ibla.js', 'lib/methods/net.js',
  'lib/methods/funie.js', 'lib/methods/uieb-nets.js', 'lib/methods/waternet.js', 'vendor/ort/ort.wasm.bundle.min.mjs',
  'vendor/mediabunny.min.mjs'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(APP_CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
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

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || PERSISTENT.test(url.pathname)) return;
  e.respondWith(fetch(req).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(APP_CACHE).then((c) => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req, { ignoreSearch: true })));
});
