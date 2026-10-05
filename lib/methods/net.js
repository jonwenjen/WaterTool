// 深度學習方法的共同外殼：在小圖上跑 ONNX 網路，再把它的效果擬合成「局部仿射色彩轉換」
// （引導濾波係數 a、b：out ≈ a·in + b，逐通道、空間平滑），放大後套到原解析度 ——
// 顏色來自網路、細節保留原片，係數也能做時間平滑（影片不閃）。
//
// spec.input  'pm1'：輸入 [-1,1]（FUnIE-GAN）；'01'：輸入 [0,1]（UIEB 系列）
// spec.size   'aspect32'：保持長寬比、長邊 256、32 的倍數；'square256'：壓成 256×256（與 UIEB 測試流程相同）
// spec.output 'pm1'：輸出 [-1,1]；'norm'：與 ddz16/UIE_Benckmark 測試相同 —— 若超出 [0,1] 就逐通道 min-max 正規化
import * as C from '../core.js';

export function netSize(w, h, spec) {
  if (spec.size === 'square256') return [256, 256];
  const s = 256 / Math.max(w, h);
  return [Math.max(32, Math.round((w * s) / 32) * 32), Math.max(32, Math.round((h * s) / 32) * 32)];
}

export function netMethod(spec) {
  return {
    ...spec,
    needsModel: true,
    wantsFull: true, // 估計用原圖（網路自己決定輸入大小）
    params: [
      { key: 'amount', label: '強度', min: 0, max: 1.5, step: 0.05, def: 1 },
      { key: 'detail', label: '色彩擬合細緻度', min: 4, max: 32, step: 1, def: 12 },
    ],

    async estimate(img, p, ctx) {
      if (!ctx || !ctx.runNet) throw new Error(`${spec.short} 模型尚未載入`);
      const [nw, nh] = netSize(img.w, img.h, spec);
      const small = C.resize(img, nw, nh), n = nw * nh;
      const x = new Float32Array(3 * n);
      const toIn = spec.input === 'pm1' ? (v) => v * 2 - 1 : (v) => v;
      for (let c = 0; c < 3; c++) for (let i = 0; i < n; i++) x[c * n + i] = toIn(small.c[c][i]);
      const y = await ctx.runNet(spec.model.file, x, nw, nh);
      const out = toUnit(y, n, spec.output);
      const r = Math.max(2, Math.round(Math.max(nw, nh) / p.detail));
      const a = [], b = [];
      for (let c = 0; c < 3; c++) {
        const [ac, bc] = affine(small.c[c], out[c], nw, nh, r, 2e-3);
        a.push(ac);
        b.push(bc);
      }
      return { nw, nh, a, b };
    },

    apply(img, g, p) {
      const { w, h } = img, n = w * h, out = C.create(w, h);
      for (let c = 0; c < 3; c++) {
        const A = C.resizePlane(g.a[c], g.nw, g.nh, w, h), B = C.resizePlane(g.b[c], g.nw, g.nh, w, h);
        const s = img.c[c], d = out.c[c];
        for (let i = 0; i < n; i++) {
          const v = A[i] * s[i] + B[i];
          d[i] = C.clamp01(s[i] + (v - s[i]) * p.amount);
        }
      }
      return out;
    },
  };
}

/** 網路輸出（CHW）→ 三個 [0,1] 平面 */
export function toUnit(y, n, mode) {
  const out = [0, 1, 2].map((c) => new Float32Array(n));
  if (mode === 'pm1') {
    for (let c = 0; c < 3; c++) for (let i = 0; i < n; i++) out[c][i] = C.clamp01((y[c * n + i] + 1) / 2);
    return out;
  }
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < 3 * n; i++) { if (y[i] < lo) lo = y[i]; if (y[i] > hi) hi = y[i]; }
  const norm = hi > 1 || lo < 0; // normalize_img：只有超出範圍才正規化（逐通道）
  for (let c = 0; c < 3; c++) {
    let cl = 0, ch = 1;
    if (norm) {
      cl = Infinity; ch = -Infinity;
      for (let i = 0; i < n; i++) { const v = y[c * n + i]; if (v < cl) cl = v; if (v > ch) ch = v; }
    }
    const k = 1 / (ch - cl + 1e-7);
    for (let i = 0; i < n; i++) out[c][i] = C.clamp01((y[c * n + i] - cl) * k);
  }
  return out;
}

/** 引導濾波係數（He et al.）：局部線性 O ≈ a·I + b，回傳平滑後的 a、b。 */
function affine(I, O, w, h, r, eps) {
  const n = w * h;
  const mI = C.boxMean(I, w, h, r), mO = C.boxMean(O, w, h, r);
  const IO = new Float32Array(n), II = new Float32Array(n);
  for (let i = 0; i < n; i++) { IO[i] = I[i] * O[i]; II[i] = I[i] * I[i]; }
  const mIO = C.boxMean(IO, w, h, r), mII = C.boxMean(II, w, h, r);
  const a = new Float32Array(n), b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    a[i] = (mIO[i] - mI[i] * mO[i]) / (mII[i] - mI[i] * mI[i] + eps);
    b[i] = mO[i] - a[i] * mI[i];
  }
  return [C.boxMean(a, w, h, r), C.boxMean(b, w, h, r)];
}
