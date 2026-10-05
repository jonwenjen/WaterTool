// 方法 5：RGHS — 相對全域直方圖拉伸（淺水影像）
// Huang, Wang, Song, Sequeira, Mavromatis, "Shallow-water Image Enhancement Using Relative Global Histogram
// Stretching Based on Adaptive Parameter Acquisition", MMM 2018 (LNCS 10704).
// 參考實作：github.com/wangyanckxx/Single-Underwater-Image-Enhancement-and-Color-Restoration（RGHS）
//
// 1. G、B 通道等化：乘上 0.5 / mean（參考碼 128/mean）
// 2. 每通道相對拉伸：[I_min, I_max]（0.5%、99.5%）→ [I_min, 1]，保留各通道原本的暗端
// 3. CIELAB：L 以 1%/99% 線性拉伸到 0..100；a、b 以 S 型曲線 x·1.3^(1−|x|/128) 提高彩度
import * as C from '../core.js';

export default {
  id: 'rghs',
  name: 'RGHS 相對直方圖拉伸',
  short: 'RGHS',
  cite: 'Huang et al., MMM 2018',
  kind: '增強（非物理）',
  params: [
    { key: 'eq', label: 'G/B 等化強度', min: 0, max: 1, step: 0.05, def: 1 },
    { key: 'sat', label: 'a/b 曲線底數', min: 1, max: 1.6, step: 0.05, def: 1.3 },
  ],

  estimate(low, p) {
    const m = low.c.map(C.mean);
    const ratio = [1, eqGain(m[1], p.eq), eqGain(m[2], p.eq)];
    const st = stage1(low, { ratio, lo: [0, 0, 0], hi: [1, 1, 1] }, true);
    const lo = [], hi = [];
    for (let c = 0; c < 3; c++) {
      const [a, b] = C.percentiles(st.c[c], [0.005, 0.995]);
      lo.push(a);
      hi.push(Math.max(b, a + 0.02));
    }
    const s2 = stage1(low, { ratio, lo, hi });
    const lab = C.rgb2lab(s2);
    const [Lmin, Lmax] = C.percentiles(lab.L, [0.01, 0.99], 0, 100);
    return { ratio, lo, hi, Lmin, Lmax: Math.max(Lmax, Lmin + 5) };
  },

  apply(img, g, p) {
    const s = stage1(img, g);
    const lab = C.rgb2lab(s), n = lab.L.length;
    const kL = 100 / (g.Lmax - g.Lmin);
    for (let i = 0; i < n; i++) {
      lab.L[i] = Math.min(100, Math.max(0, (lab.L[i] - g.Lmin) * kL));
      const a = lab.A[i], b = lab.B[i];
      lab.A[i] = a * Math.pow(p.sat, 1 - Math.abs(a) / 128);
      lab.B[i] = b * Math.pow(p.sat, 1 - Math.abs(b) / 128);
    }
    return C.lab2rgb(lab);
  },
};

const eqGain = (m, k) => 1 + (Math.min(4, 0.5 / Math.max(m, 1e-3)) - 1) * k;

function stage1(img, g, eqOnly = false) {
  const out = C.create(img.w, img.h);
  for (let c = 0; c < 3; c++) {
    const s = img.c[c], d = out.c[c], k = g.ratio[c], lo = g.lo[c], hi = g.hi[c];
    const sc = (1 - lo) / (hi - lo);
    for (let i = 0; i < s.length; i++) {
      const v = C.clamp01(s[i] * k);
      d[i] = eqOnly ? v : v < lo ? v : v > hi ? 1 : (v - lo) * sc + lo;
    }
  }
  return out;
}
