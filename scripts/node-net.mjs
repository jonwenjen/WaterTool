// 在 Node 中執行 ONNX 模型（onnxruntime-web 的 WASM 後端），供測試與評測腳本使用。
// 回傳 runNet(file, x, w, h)，與 worker.js 的介面相同；每個模型只建立一次 session。
// 環境變數 ORT_NODE=<onnxruntime-node 套件路徑>：改用原生 ONNX Runtime（多執行緒，執行緒數 ORT_THREADS）。
// 只用來加快評測大型模型（PromptIR 等 WASM 單執行緒每格要數十秒）；輸入、前後處理與 WASM 版完全相同。
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
export async function nodeRunNet() {
  if (process.env.ORT_NODE) {
    const ort = createRequire(import.meta.url)(process.env.ORT_NODE);
    const opts = { executionProviders: ['cpu'], intraOpNumThreads: +(process.env.ORT_THREADS || 2) };
    const sessions = new Map();
    return async (file, x, w, h) => {
      if (!sessions.has(file)) sessions.set(file, await ort.InferenceSession.create(new URL('../' + file, import.meta.url).pathname, opts));
      return (await sessions.get(file).run({ x: new ort.Tensor('float32', x, [1, x.length / (w * h), h, w]) })).y.data;
    };
  }
  const ort = await import('onnxruntime-web/wasm').catch(() => import('../node_modules/onnxruntime-web/dist/ort.wasm.min.mjs'));
  ort.env.wasm.numThreads = 1;
  const sessions = new Map();
  return async (file, x, w, h) => {
    if (!sessions.has(file)) {
      sessions.set(file, await ort.InferenceSession.create(readFileSync(new URL('../' + file, import.meta.url)), { executionProviders: ['wasm'] }));
    }
    return (await sessions.get(file).run({ x: new ort.Tensor('float32', x, [1, x.length / (w * h), h, w]) })).y.data;
  };
}
