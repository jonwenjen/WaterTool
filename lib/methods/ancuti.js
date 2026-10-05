// 方法 1：色彩平衡 + 多尺度融合
// Ancuti, Ancuti, De Vleeschouwer, Bekaert, "Color Balance and Fusion for Underwater Image
// Enhancement", IEEE TIP 27(1):379–393, 2018.
// 參考實作：github.com/fergaletto/Color-Balance-and-fusion-for-underwater-image-enhancement.-.（MATLAB）
//           github.com/fowles/underwater-color（Python）
import * as C from '../core.js';

export default {
  id: 'ancuti',
  name: '色彩平衡＋多尺度融合',
  short: 'Fusion',
  cite: 'Ancuti et al., IEEE TIP 2018',
  kind: '增強（非物理）',
  params: [
    { key: 'alpha', label: '紅色補償 α', min: 0, max: 2, step: 0.05, def: 1 },
    { key: 'blueComp', label: '藍色補償（綠水/混濁）', min: 0, max: 1, step: 0.05, def: -1, auto: true },
    { key: 'gamma', label: '輸入一 γ', min: 1, max: 3, step: 0.1, def: 2 },
  ],

  /** 全域量（可做時間平滑）：通道平均、補償後的灰色世界增益。 */
  estimate(low, p) {
    const [r, g, b] = low.c;
    const mR = C.mean(r), mG = C.mean(g), mB = C.mean(b);
    // 綠水（G 明顯 > B）時論文建議同時補償藍色
    const blue = p.blueComp >= 0 ? p.blueComp : C.clamp01((mG - mB - 0.05) / 0.15);
    const comp = compensate(low, mR, mG, mB, p.alpha, blue);
    const m = comp.c.map(C.mean);
    const avg = (m[0] + m[1] + m[2]) / 3;
    const gain = m.map((v) => Math.min(4, avg / Math.max(v, 1e-3)));
    return { mR, mG, mB, blue, gain };
  },

  apply(img, g, p) {
    const { w, h } = img;
    // 1. 紅（藍）通道補償 + 2. 灰色世界白平衡
    const wb = compensate(img, g.mR, g.mG, g.mB, p.alpha, g.blue);
    for (let c = 0; c < 3; c++) {
      const q = wb.c[c], k = g.gain[c];
      for (let i = 0; i < q.length; i++) q[i] = C.clamp01(q[i] * k);
    }
    // 輸入一：Gamma 校正（加強全域對比）
    const in1 = C.create(w, h);
    for (let c = 0; c < 3; c++) {
      const s = wb.c[c], d = in1.c[c];
      for (let i = 0; i < s.length; i++) d[i] = Math.pow(s[i], p.gamma);
    }
    // 輸入二：正規化反銳化遮罩 S = (I + N{I − G*I}) / 2
    const in2 = C.create(w, h);
    const sigma = Math.max(3, 0.02 * Math.max(w, h));
    for (let c = 0; c < 3; c++) {
      const s = wb.c[c], blur = C.gaussBlur(s, w, h, sigma), d = in2.c[c];
      const diff = new Float32Array(s.length);
      for (let i = 0; i < s.length; i++) diff[i] = s[i] - blur[i];
      const [lo, hi] = C.percentiles(diff, [0.005, 0.995], -1, 1);
      const k = 1 / Math.max(hi - lo, 1e-4);
      for (let i = 0; i < s.length; i++) d[i] = (s[i] + C.clamp01((diff[i] - lo) * k)) / 2;
    }
    // 權重：拉普拉斯對比、顯著性、飽和度；正規化 (W_k + δ)/(ΣW + Kδ)
    const W1 = weights(in1), W2 = weights(in2);
    const d = 0.1;
    for (let i = 0; i < W1.length; i++) {
      const s = W1[i] + W2[i] + 2 * d;
      W1[i] = (W1[i] + d) / s;
      W2[i] = (W2[i] + d) / s;
    }
    // 多尺度融合：權重的高斯金字塔 × 輸入的拉普拉斯金字塔
    const levels = C.pyrLevels(w, h, 6);
    const G1 = C.gaussPyramid(W1, w, h, levels), G2 = C.gaussPyramid(W2, w, h, levels);
    const out = C.create(w, h);
    for (let c = 0; c < 3; c++) {
      const L1 = C.laplacianPyramid(in1.c[c], w, h, levels), L2 = C.laplacianPyramid(in2.c[c], w, h, levels);
      const F = L1.map((lv, k) => {
        const o = new Float32Array(lv.p.length);
        const a = G1[k].p, b = G2[k].p, x = lv.p, y = L2[k].p;
        for (let i = 0; i < o.length; i++) o[i] = a[i] * x[i] + b[i] * y[i];
        return { p: o, w: lv.w, h: lv.h };
      });
      out.c[c] = C.collapse(F);
    }
    return C.clampImg(out);
  },
};

function compensate(img, mR, mG, mB, alpha, blue) {
  const out = C.clone(img);
  const [r, g, b] = out.c;
  const dR = alpha * (mG - mR), dB = alpha * blue * (mG - mB);
  for (let i = 0; i < r.length; i++) {
    r[i] = r[i] + dR * (1 - r[i]) * g[i];
    if (dB > 0) b[i] = b[i] + dB * (1 - b[i]) * g[i];
  }
  return out;
}

function weights(img) {
  const { w, h } = img, n = w * h;
  const L = C.gray(img);
  // 拉普拉斯對比權重 |∇²L|
  const WL = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    const ym = y > 0 ? y - 1 : 0, yp = y < h - 1 ? y + 1 : h - 1;
    for (let x = 0; x < w; x++) {
      const xm = x > 0 ? x - 1 : 0, xp = x < w - 1 ? x + 1 : w - 1, i = y * w + x;
      WL[i] = Math.abs(L[ym * w + x] + L[yp * w + x] + L[y * w + xm] + L[y * w + xp] - 4 * L[i]);
    }
  }
  // 顯著性（Achanta et al. 2009）：‖Lab 平均 − 輕度模糊 Lab‖，正規化到 [0,1]
  const bl = { w, h, c: img.c.map((p) => C.gaussBlur(p, w, h, 1)) };
  const lab = C.rgb2lab(bl);
  const mL = C.mean(lab.L), mA = C.mean(lab.A), mB = C.mean(lab.B);
  const WS = new Float32Array(n);
  let maxS = 1e-6;
  for (let i = 0; i < n; i++) {
    const s = (lab.L[i] - mL) ** 2 + (lab.A[i] - mA) ** 2 + (lab.B[i] - mB) ** 2;
    WS[i] = s;
    if (s > maxS) maxS = s;
  }
  // 飽和度權重 sqrt(1/3 Σ(C_k − L)²)
  const [r, g, b] = img.c;
  const W = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const l = L[i];
    const sat = Math.sqrt(((r[i] - l) ** 2 + (g[i] - l) ** 2 + (b[i] - l) ** 2) / 3);
    W[i] = WL[i] + WS[i] / maxS + sat;
  }
  return W;
}
