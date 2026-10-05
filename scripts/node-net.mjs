// 在 Node 中執行 ONNX 模型（onnxruntime-web 的 WASM 後端），供測試與評測腳本使用。
// 回傳 runNet(file, x, w, h)，與 worker.js 的介面相同；每個模型只建立一次 session。
import { readFileSync } from 'node:fs';
export async function nodeRunNet() {
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
