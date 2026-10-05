// 離線快取：程式檔「網路優先」（更新立即生效），大型檔案（模型、WASM、mediabunny）「快取優先」。
const CACHE = 'watertool-v1';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'worker.js', 'manifest.webmanifest', 'icons/icon.svg',
  'lib/core.js', 'lib/pipeline.js', 'lib/temporal.js', 'lib/metrics.js', 'lib/synth.js',
  'lib/methods/index.js', 'lib/methods/info.js', 'lib/methods/ancuti.js', 'lib/methods/mlle.js', 'lib/methods/ulap.js',
  'lib/methods/udcp.js', 'lib/methods/rghs.js', 'lib/methods/seathru.js', 'lib/methods/funie.js'];
const BIG = /\/(models|vendor)\//;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  if (BIG.test(new URL(req.url).pathname)) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    })));
    return;
  }
  e.respondWith(fetch(req).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req)));
});
