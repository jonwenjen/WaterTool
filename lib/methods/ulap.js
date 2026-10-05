// 方法 3：ULAP — 水下光衰減先驗（物理模型復原）
// Song, Wang, Huang, Tjondronegoro, "A Rapid Scene Depth Estimation Model Based on Underwater
// Light Attenuation Prior for Underwater Image Restoration", PCM 2018 (LNCS 11164).
// 參考實作：github.com/wangyanckxx/Single-Underwater-Image-Enhancement-and-Color-Restoration（ULAP）
//
// 深度 d = θ0 + θ1·max(G,B) + θ2·R（線性回歸係數，紅光衰減最快 → 越遠 R 越低）
// 背景光 = 最遠 0.1% 像素中向量長度最大者；最近深度 d0 = 1 − max_c max|I_c − B_c| / max(B_c, 1 − B_c)
// d_f = 8·(d + d0)，透射率 t_c = {0.83, 0.95, 0.97}^d_f（R、G、B）
// J_c = (I_c − B_c) / t_c + B_c
import * as C from '../core.js';

const TH = [0.51157954, 0.50516165, -0.90511117];

export function ulapDepth(img) {
  const [r, g, b] = img.c, n = r.length, d = new Float32Array(n);
  for (let i = 0; i < n; i++) d[i] = TH[0] + TH[1] * Math.max(g[i], b[i]) + TH[2] * r[i];
  return d;
}

/** 深度圖（0 近 … 1 遠），用給定的拉伸範圍並以引導濾波細化。 */
export function refinedDepth(img, dLo, dHi) {
  const { w, h } = img;
  const d = ulapDepth(img), k = 1 / Math.max(dHi - dLo, 1e-3);
  for (let i = 0; i < d.length; i++) d[i] = C.clamp01((d[i] - dLo) * k);
  const r = Math.max(4, Math.round(50 * (Math.max(w, h) / 1000)));
  const q = C.fastGuidedFilter(C.gray(img), d, w, h, r, 1e-3, 4);
  for (let i = 0; i < q.length; i++) q[i] = C.clamp01(q[i]);
  return q;
}

export function depthRange(low) {
  const d = ulapDepth(low);
  return C.percentiles(d, [0.0005, 0.9995], -1, 2);
}

export default {
  id: 'ulap',
  name: 'ULAP 光衰減先驗復原',
  short: 'ULAP',
  cite: 'Song et al., PCM 2018',
  kind: '物理復原',
  params: [
    { key: 'scale', label: '距離尺度（d_f = s·(d+d0)）', min: 2, max: 16, step: 0.5, def: 8 },
    { key: 'tmin', label: '透射率下限', min: 0.05, max: 0.5, step: 0.01, def: 0.1 },
  ],

  estimate(low) {
    const [dLo, dHi] = depthRange(low);
    const D = refinedDepth(low, dLo, dHi);
    // 背景光：最遠 0.1% 像素中 ‖I‖ 最大者
    const n = D.length, cnt = Math.max(1, Math.ceil(0.001 * n));
    const idx = topK(D, cnt);
    let best = idx[0], bm = -1;
    for (const i of idx) {
      const m = low.c[0][i] ** 2 + low.c[1][i] ** 2 + low.c[2][i] ** 2;
      if (m > bm) { bm = m; best = i; }
    }
    const BL = low.c.map((p) => p[best]);
    let K = 0;
    for (let c = 0; c < 3; c++) {
      const p = low.c[c];
      let mx = 0;
      for (let i = 0; i < n; i++) mx = Math.max(mx, Math.abs(p[i] - BL[c]));
      K = Math.max(K, mx / Math.max(BL[c], 1 - BL[c]));
    }
    return { dLo, dHi, BL, d0: 1 - K };
  },

  apply(img, g, p) {
    const { w, h } = img, n = w * h;
    const D = refinedDepth(img, g.dLo, g.dHi);
    const guide = C.gray(img);
    const r = Math.max(4, Math.round(50 * (Math.max(w, h) / 1000)));
    const base = [0.83, 0.95, 0.97];
    const out = C.create(w, h);
    for (let c = 0; c < 3; c++) {
      let t = new Float32Array(n);
      const lb = Math.log(base[c]);
      for (let i = 0; i < n; i++) t[i] = Math.exp(lb * p.scale * (D[i] + g.d0));
      t = C.fastGuidedFilter(guide, t, w, h, r, 1e-3, 4);
      const src = img.c[c], dst = out.c[c], B = g.BL[c];
      for (let i = 0; i < n; i++) dst[i] = C.clamp01((src[i] - B) / Math.max(t[i], p.tmin) + B);
    }
    return out;
  },
};

/** 取值最大的 k 個索引（k 很小時用門檻 + 篩選） */
export function topK(p, k) {
  const [thr] = C.percentiles(p, [1 - k / p.length], -1, 2);
  const out = [];
  for (let i = 0; i < p.length; i++) if (p[i] >= thr) out.push(i);
  out.sort((a, b) => p[b] - p[a]);
  return out.slice(0, Math.max(k, 1));
}
