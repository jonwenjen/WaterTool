// 方法 4：UDCP — 水下暗通道先驗（物理模型復原）
// Drews, Nascimento, Moraes, Botelho, Campos, "Transmission Estimation in Underwater Single
// Images", ICCV Workshops 2013；及 Drews et al., IEEE CG&A 36(2), 2016。
// 參考實作：github.com/wangyanckxx/Single-Underwater-Image-Enhancement-and-Color-Restoration（UDCP）
//
// 紅光在水中幾乎全被吸收，暗通道只用 G、B：dark = min_patch(min(G,B))
// 背景光 A = 暗通道最大處的顏色；t = 1 − min_patch(min_{G,B}(I_c/A_c))，限制在 [0.1, 0.9]，
// 以引導濾波細化；J = (I − A)/t + A。
// 原方法不處理色偏，選項「後置白平衡」用灰色世界把 UDCP 結果拉回中性（預設開）。
import * as C from '../core.js';
import { topK } from './ulap.js';

function patchR(w, h) {
  return Math.max(1, Math.round(4 * (Math.max(w, h) / 640))); // 參考碼 blockSize = 9
}

function gbMin(img, A) {
  const [, g, b] = img.c, n = g.length, out = new Float32Array(n);
  const ag = A ? 1 / Math.max(A[1], 1e-3) : 1, ab = A ? 1 / Math.max(A[2], 1e-3) : 1;
  for (let i = 0; i < n; i++) out[i] = Math.min(g[i] * ag, b[i] * ab);
  return out;
}

export default {
  id: 'udcp',
  name: 'UDCP 水下暗通道',
  short: 'UDCP',
  cite: 'Drews et al., ICCVW 2013',
  kind: '物理復原',
  params: [
    { key: 'omega', label: '去霧強度 ω', min: 0.3, max: 1, step: 0.05, def: 1 },
    { key: 'wb', label: '後置白平衡', min: 0, max: 1, step: 0.05, def: 1 },
  ],

  estimate(low, p) {
    const { w, h } = low;
    const dark = C.minFilter(gbMin(low), w, h, patchR(w, h));
    // 原碼取暗通道最大的單一像素；低解析度已是區域平均，再取前 0.1% 平均更穩定
    const idx = topK(dark, Math.max(1, Math.ceil(0.001 * dark.length)));
    const A = [0, 1, 2].map((c) => idx.reduce((s, i) => s + low.c[c][i], 0) / idx.length);
    // 後置白平衡增益：在低解析度上先跑一次復原取灰色世界
    const J = restore(low, A, p.omega);
    const m = J.c.map(C.mean), avg = (m[0] + m[1] + m[2]) / 3;
    const gain = m.map((v) => Math.min(3, avg / Math.max(v, 1e-3)));
    return { A, gain };
  },

  apply(img, g, p) {
    const J = restore(img, g.A, p.omega);
    if (p.wb > 0) {
      for (let c = 0; c < 3; c++) {
        const k = 1 + (g.gain[c] - 1) * p.wb, q = J.c[c];
        for (let i = 0; i < q.length; i++) q[i] = C.clamp01(q[i] * k);
      }
    }
    return J;
  },
};

function restore(img, A, omega) {
  const { w, h } = img, n = w * h;
  const dn = C.minFilter(gbMin(img, A), w, h, patchR(w, h));
  let t = new Float32Array(n);
  for (let i = 0; i < n; i++) t[i] = Math.min(0.9, Math.max(0.1, 1 - omega * dn[i]));
  const r = Math.max(4, Math.round(50 * (Math.max(w, h) / 1000)));
  t = C.fastGuidedFilter(C.gray(img), t, w, h, r, 1e-3, 4);
  const out = C.create(w, h);
  for (let c = 0; c < 3; c++) {
    const s = img.c[c], d = out.c[c], a = A[c];
    for (let i = 0; i < n; i++) d[i] = C.clamp01((s[i] - a) / Math.min(0.9, Math.max(0.2, t[i])) + a);
  }
  return out;
}
