// 把執行期需要的第三方檔案從 node_modules 複製到 vendor/（網站不需要建置步驟即可執行）
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const nm = new URL('../node_modules/', import.meta.url), v = new URL('../vendor/', import.meta.url);
mkdirSync(new URL('ort/', v), { recursive: true });
for (const f of ['ort.wasm.bundle.min.mjs', 'ort-wasm-simd-threaded.wasm'])
  copyFileSync(new URL('onnxruntime-web/dist/' + f, nm), new URL('ort/' + f, v));
const ortVer = JSON.parse(readFileSync(new URL('onnxruntime-web/package.json', nm))).version;
writeFileSync(new URL('ort/LICENSE', v), `onnxruntime-web ${ortVer} — Copyright (c) Microsoft Corporation. MIT License.\nhttps://github.com/microsoft/onnxruntime/blob/main/LICENSE\n`);
copyFileSync(new URL('mediabunny/dist/bundles/mediabunny.min.mjs', nm), new URL('mediabunny.min.mjs', v));
copyFileSync(new URL('mediabunny/LICENSE', nm), new URL('mediabunny-LICENSE', v));
console.log('vendor/ updated');
