// 方法 7：FUnIE-GAN（深度學習）
// Islam, Xia, Sattar, "Fast Underwater Image Enhancement for Improved Visual Perception",
// IEEE RA-L 5(2):3227–3234, 2020。官方程式與權重：github.com/xahidbuffon/FUnIE-GAN（MIT）
// 模型：PyTorch 權重 → ONNX（float16），在瀏覽器以 onnxruntime-web（WASM）執行。
//
// 網路只在小圖（長邊 256，32 的倍數）上跑；它的效果用「局部仿射色彩轉換」擬合
// （即引導濾波的係數 a、b：out ≈ a·in + b，逐通道、空間平滑），
// 再放大套到全解析度 —— 顏色來自網路，細節保留原片，且係數可做時間平滑。
import * as C from '../core.js';

export const NET_EDGE = 256;

export function netSize(w, h, edge = NET_EDGE) {
  const s = edge / Math.max(w, h);
  return [Math.max(32, Math.round((w * s) / 32) * 32), Math.max(32, Math.round((h * s) / 32) * 32)];
}

export default {
  id: 'funie',
  name: 'FUnIE-GAN 深度學習',
  short: 'FUnIE-GAN',
  cite: 'Islam et al., IEEE RA-L 2020',
  kind: '深度學習（GAN）',
  needsModel: true,
  params: [
    { key: 'amount', label: '強度', min: 0, max: 1.5, step: 0.05, def: 1 },
    { key: 'detail', label: '色彩擬合細緻度', min: 4, max: 32, step: 1, def: 12 },
  ],
  // 估計用原圖而非 320 px 的低解析度（網路自己決定輸入大小）
  wantsFull: true,

  async estimate(img, p, ctx) {
    if (!ctx || !ctx.runNet) throw new Error('FUnIE-GAN 模型尚未載入');
    const [nw, nh] = netSize(img.w, img.h);
    const small = C.resize(img, nw, nh);
    const x = new Float32Array(3 * nw * nh), n = nw * nh;
    for (let c = 0; c < 3; c++) for (let i = 0; i < n; i++) x[c * n + i] = small.c[c][i] * 2 - 1;
    const y = await ctx.runNet(x, nw, nh);
    const r = Math.max(2, Math.round(Math.max(nw, nh) / p.detail));
    const a = [], b = [];
    for (let c = 0; c < 3; c++) {
      const I = small.c[c], O = new Float32Array(n);
      for (let i = 0; i < n; i++) O[i] = C.clamp01((y[c * n + i] + 1) / 2);
      const [ac, bc] = affine(I, O, nw, nh, r, 2e-3);
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
