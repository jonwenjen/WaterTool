// 在 Node 中執行 FUnIE-GAN（onnxruntime-web 的 WASM 後端），供測試與評測腳本使用。
import { readFileSync } from 'node:fs';
export async function nodeRunNet() {
  const ort = await import('onnxruntime-web/wasm').catch(() => import('../node_modules/onnxruntime-web/dist/ort.wasm.min.mjs'));
  ort.env.wasm.numThreads = 1;
  const session = await ort.InferenceSession.create(readFileSync(new URL('../models/funie-gan.fp16.onnx', import.meta.url)), { executionProviders: ['wasm'] });
  return async (x, w, h) => (await session.run({ x: new ort.Tensor('float32', x, [1, 3, h, w]) })).y.data;
}
