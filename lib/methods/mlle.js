// 方法 2：MLLE — 最小色彩損失 + 局部自適應對比增強
// Zhang, Zhuang, Sun, Li, Kwong, Li, "Underwater Image Enhancement via Minimal Color Loss and
// Locally Adaptive Contrast Enhancement", IEEE TIP 31:3997–4010, 2022.
// 官方程式（MATLAB p-code）：github.com/Li-Chongyi/MMLE_code
// Python 重現：github.com/nomi30701/Underwater-image-color-correction-adaptive-contrast-enhancemention-and-yolo-detect-python
//
// LACC（局部自適應色彩校正）：以平均值最大的通道為參考，把另外兩個通道往它補償；
//   補償量由「最大衰減圖」1 − I_small^1.2 決定，並加回細節層。
//   原始碼以迭代 medium += (L̄ − mean(medium))·L 直到收斂；其收斂值有封閉解
//   K = (L̄ − mean(medium)) / L̄，這裡直接使用（結果相同，且每幀時間固定）。
// LACE（局部自適應對比增強）：L 通道依「全域變異數 / 局部變異數」放大局部對比（上限 β），
//   局部均值/變異數用積分圖（這裡用 O(n) 方框濾波逐像素計算，無區塊接縫），再做引導濾波；
//   最後在 CIELAB 平衡 a、b 兩軸。
import * as C from '../core.js';

export default {
  id: 'mlle',
  name: 'MLLE 最小色損＋局部對比',
  short: 'MLLE',
  cite: 'Zhang et al., IEEE TIP 2022',
  kind: '增強（非物理）',
  params: [
    { key: 'beta', label: '對比上限 β', min: 1, max: 3, step: 0.1, def: 1.5 },
    { key: 'block', label: '局部視窗（像素@640）', min: 9, max: 61, step: 2, def: 25 },
  ],

  estimate(low) {
    const m = low.c.map(C.mean);
    const order = [0, 1, 2].sort((a, b) => m[a] - m[b]); // small, medium, large
    const [s, md, l] = order;
    const [lmin, lmax] = C.percentiles(low.c[l], [0.001, 0.999]);
    // 正規化後的大通道平均
    const P = low.c[l], k = 1 / Math.max(lmax - lmin, 1e-3);
    let Lm = 0;
    for (let i = 0; i < P.length; i++) Lm += C.clamp01((P[i] - lmin) * k);
    Lm = Math.max(Lm / P.length, 1e-3);
    const Km = (Lm - m[md]) / Lm, Ks = (Lm - m[s]) / Lm;
    // 對低解析度做一次 LACC，取得 LACE 需要的全域統計（L 變異數、a/b 平均）
    const cc = lacc(low, { order, lmin, lmax, Km, Ks });
    const lab = C.rgb2lab(cc);
    const L8 = lab.L.map((v) => (v * 255) / 100);
    const mL = C.mean(L8);
    let v = 0;
    for (let i = 0; i < L8.length; i++) v += (L8[i] - mL) ** 2;
    return { order, lmin, lmax, Km, Ks, gvar: v / L8.length, aMean: C.mean(lab.A) + 128, bMean: C.mean(lab.B) + 128 };
  },

  apply(img, g, p) {
    const { w, h } = img;
    const cc = lacc(img, g);
    // ---- LACE ----
    const lab = C.rgb2lab(cc);
    const n = w * h, L = new Float32Array(n);
    for (let i = 0; i < n; i++) L[i] = (lab.L[i] * 255) / 100;
    const r = Math.max(2, Math.round(((p.block - 1) / 2) * (Math.max(w, h) / 640)));
    const mu = C.boxMean(L, w, h, r);
    const sq = new Float32Array(n);
    for (let i = 0; i < n; i++) sq[i] = L[i] * L[i];
    const mu2 = C.boxMean(sq, w, h, r);
    const Lp = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const lv = Math.max(mu2[i] - mu[i] * mu[i], 1e-3);
      const a = Math.min(g.gvar / lv, p.beta);
      Lp[i] = Math.min(255, Math.max(0, mu[i] + a * (L[i] - mu[i])));
    }
    // 引導濾波（引導 = 原 L）去除放大的雜訊
    const gr = Math.max(2, Math.round(10 * (Math.max(w, h) / 640)));
    const Lg = C.fastGuidedFilter(L.map((v) => v / 255), Lp.map((v) => v / 255), w, h, gr, 1e-4, 2);
    for (let i = 0; i < n; i++) lab.L[i] = C.clamp01(Lg[i]) * 100;
    // a/b 色彩平衡（OpenCV 8-bit Lab 的 +128 偏移表示法，與參考碼相同）
    const { aMean, bMean } = g;
    if (aMean > bMean) {
      const k = (aMean - bMean) / (aMean + bMean);
      for (let i = 0; i < n; i++) lab.B[i] = Math.min(127, (lab.B[i] + 128) * (1 + k) - 128);
    } else {
      const k = (bMean - aMean) / (aMean + bMean);
      for (let i = 0; i < n; i++) lab.A[i] = Math.min(127, (lab.A[i] + 128) * (1 + k) - 128);
    }
    return C.lab2rgb(lab);
  },
};

function lacc(img, g) {
  const { w, h } = img, n = w * h;
  const [s, md, l] = g.order;
  const small = img.c[s];
  const out = C.create(w, h);
  const k = 1 / Math.max(g.lmax - g.lmin, 1e-3);
  const Ln = new Float32Array(n);
  for (let i = 0; i < n; i++) Ln[i] = C.clamp01((img.c[l][i] - g.lmin) * k);
  for (let c = 0; c < 3; c++) {
    const src = img.c[c], dst = out.c[c];
    const blur = C.convSep(src, w, h, K7);
    for (let i = 0; i < n; i++) {
      let cor;
      if (c === l) cor = Ln[i];
      else if (c === md) cor = src[i] + g.Km * Ln[i];
      else cor = src[i] + g.Ks * Ln[i];
      const att = 1 - Math.pow(small[i], 1.2); // 最大衰減圖
      dst[i] = C.clamp01(src[i] - blur[i] + att * cor + (1 - att) * src[i]);
    }
  }
  return out;
}

// OpenCV GaussianBlur((7,7), 0) 的核：σ = 0.3·((7−1)·0.5 − 1) + 0.8 = 1.4
const K7 = (() => {
  const s = 1.4, k = new Float32Array(7);
  let t = 0;
  for (let i = -3; i <= 3; i++) t += k[i + 3] = Math.exp((-i * i) / (2 * s * s));
  return k.map((v) => v / t);
})();
