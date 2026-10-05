// 方法 8：IBLA — 影像模糊度與光吸收（物理模型復原）
// Peng & Cosman, "Underwater Image Restoration Based on Image Blurriness and Light Absorption",
// IEEE TIP 26(4):1579–1594, 2017。
// 參考實作：github.com/wangyanckxx/Single-Underwater-Image-Enhancement-and-Color-Restoration（IBLA）
//
// 深度由三張圖融合：紅通道最大值圖 d_R、紅 − max(G,B) 的 MIP 圖 d_D、模糊度圖 d_B，
// 權重依背景光亮度 Θa = S(mean B∞, 0.5) 與紅色量 Θb = S(mean R, 0.1) 決定（S 為斜率 32 的 sigmoid）：
//   d = Θb·(Θa·d_D + (1 − Θa)·d_R) + (1 − Θb)·d_B
// 背景光由三個候選（暗通道最亮 0.1%、亮度四分樹、模糊度四分樹）依通道亮度比例在最大/最小間內插。
// t_R = e^{−d_f/7}（d_f = 8(d + d0)），t_G、t_B 由背景光比例換算（Zhao et al. 2015 的波長關係），
// 引導濾波細化後 J = (I − B∞)/t + B∞。
// 與參考碼的差異：sigmoid 用論文的 [0,1] 正規化值（參考碼誤用 0–255）；雙邊濾波改為自引導的引導濾波；
// 所有視窗依解析度縮放（參考碼以 9 px 視窗處理原圖）。
import * as C from '../core.js';

const LAMBDA = [620, 540, 450]; // R G B 波長（nm）
const sig = (a, s) => 1 / (1 + Math.exp(-32 * (a - s)));

function scale(w, h) {
  return Math.max(w, h) / 640;
}

function maxFilter(p, w, h, r) {
  const neg = new Float32Array(p.length);
  for (let i = 0; i < p.length; i++) neg[i] = -p[i];
  const m = C.minFilter(neg, w, h, r);
  for (let i = 0; i < m.length; i++) m[i] = -m[i];
  return m;
}

/** 模糊度圖：原圖與 4 個尺度高斯模糊差的平均 → 灰階 → 局部最大 → 保邊平滑 */
function blurriness(img) {
  const { w, h } = img, n = w * h, sc = scale(w, h);
  const B = new Float32Array(n);
  for (let c = 0; c < 3; c++) {
    const p = img.c[c];
    const acc = new Float32Array(n);
    for (let i = 1; i < 5; i++) {
      const r = (2 ** i * 4 + 1) * sc; // 參考碼 ksize = σ = 2^i·(n−1)+1
      const b = C.gaussBlur(p, w, h, r / 2);
      for (let k = 0; k < n; k++) acc[k] += Math.abs(p[k] - b[k]);
    }
    const wgt = [0.299, 0.587, 0.114][c];
    for (let k = 0; k < n; k++) B[k] += (wgt * acc[k]) / 4;
  }
  const rough = maxFilter(B, w, h, Math.max(1, Math.round(4 * sc)));
  return C.guidedFilter(rough, rough, w, h, Math.max(2, Math.round(4 * sc)), 1e-4);
}

/** 四分樹：重複 5 次挑變異數最小的象限，回傳該區塊的平均顏色 */
function quadTree(img, map) {
  let x0 = 0, y0 = 0, w = img.w, h = img.h;
  for (let it = 0; it < 5 && w >= 2 && h >= 2; it++) {
    const hw = w >> 1, hh = h >> 1;
    let best = null, bv = Infinity;
    for (const [qx, qy] of [[0, 0], [hw, 0], [0, hh], [hw, hh]]) {
      let s = 0, s2 = 0, k = 0;
      for (let y = y0 + qy; y < y0 + qy + hh; y++) for (let x = x0 + qx; x < x0 + qx + hw; x++) {
        const v = map[y * img.w + x];
        s += v; s2 += v * v; k++;
      }
      const v = s2 / k - (s / k) ** 2;
      if (v < bv) { bv = v; best = [x0 + qx, y0 + qy]; }
    }
    [x0, y0] = best;
    w = hw; h = hh;
  }
  const out = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    let s = 0;
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) s += img.c[c][y * img.w + x];
    out[c] = s / (w * h);
  }
  return out;
}

function depthMaps(img) {
  const { w, h } = img, n = w * h, r = Math.max(1, Math.round(4 * scale(w, h)));
  const [R, G, B] = img.c;
  const Rmap = maxFilter(R, w, h, r);
  const gb = new Float32Array(n);
  for (let i = 0; i < n; i++) gb[i] = Math.max(G[i], B[i]);
  const gbMax = maxFilter(gb, w, h, r);
  const mip = new Float32Array(n);
  for (let i = 0; i < n; i++) mip[i] = Rmap[i] - gbMax[i];
  return { Rmap, mip, blur: blurriness(img) };
}

export default {
  id: 'ibla',
  name: 'IBLA 模糊度＋光吸收',
  short: 'IBLA',
  cite: 'Peng & Cosman, IEEE TIP 2017',
  kind: '物理復原',
  params: [
    { key: 'scale', label: '距離尺度（d_f = s·(d+d0)）', min: 2, max: 16, step: 0.5, def: 8 },
    { key: 'tmin', label: '透射率下限', min: 0.05, max: 0.5, step: 0.01, def: 0.2 },
  ],

  estimate(low) {
    const { w, h } = low, n = w * h;
    const maps = depthMaps(low);
    const range = (p) => C.minMax(p);
    // 背景光候選 1：RGB 暗通道最亮 0.1% 的平均
    const minc = new Float32Array(n);
    for (let i = 0; i < n; i++) minc[i] = Math.min(low.c[0][i], low.c[1][i], low.c[2][i]);
    const dark = C.minFilter(minc, w, h, Math.max(1, Math.round(4 * scale(w, h))));
    const [thr] = C.percentiles(dark, [0.999]);
    const bl1 = [0, 0, 0];
    let k1 = 0;
    for (let i = 0; i < n; i++) if (dark[i] >= thr) { for (let c = 0; c < 3; c++) bl1[c] += low.c[c][i]; k1++; }
    for (let c = 0; c < 3; c++) bl1[c] /= Math.max(k1, 1);
    // 候選 2：亮度四分樹；候選 3：模糊度四分樹
    const bl2 = quadTree(low, C.gray(low));
    const bl3 = quadTree(low, maps.blur);
    const BL = [0, 1, 2].map((c) => {
      let bright = 0;
      for (let i = 0; i < n; i++) if (low.c[c][i] > 0.5) bright++;
      const a = sig(bright / n, 0.2);
      const v = [bl1[c], bl2[c], bl3[c]];
      return a * Math.max(...v) + (1 - a) * Math.min(...v);
    });
    const ta = sig((BL[0] + BL[1] + BL[2]) / 3, 0.5), tb = sig(C.mean(low.c[0]), 0.1);
    let K = 0;
    for (let c = 0; c < 3; c++) {
      const [lo, hi] = C.minMax(low.c[c]);
      K = Math.max(K, Math.max(Math.abs(hi - BL[c]), Math.abs(lo - BL[c])) / Math.max(BL[c], 1 - BL[c]));
    }
    return { BL, ta, tb, d0: 1 - K, rR: range(maps.Rmap), rM: range(maps.mip), rB: range(maps.blur) };
  },

  apply(img, g, p) {
    const { w, h } = img, n = w * h;
    const { Rmap, mip, blur } = depthMaps(img);
    const norm = (v, [lo, hi]) => 1 - C.clamp01((v - lo) / Math.max(hi - lo, 1e-4));
    const tR = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const dR = norm(Rmap[i], g.rR), dD = norm(mip[i], g.rM), dB = norm(blur[i], g.rB);
      const d = g.tb * (g.ta * dD + (1 - g.ta) * dR) + (1 - g.tb) * dB;
      tR[i] = Math.min(1, Math.max(0.1, Math.exp((-1 / 7) * p.scale * (d + g.d0))));
    }
    // t_G、t_B：t_R^k，k = B_R(−0.00113λ_c + 1.62517) / (B_c(−0.00113λ_R + 1.62517))
    const coef = (l) => -0.00113 * l + 1.62517;
    const guide = C.gray(img), r = Math.max(4, Math.round(50 * (Math.max(w, h) / 1000)));
    const out = C.create(w, h);
    for (let c = 0; c < 3; c++) {
      let t = tR;
      if (c > 0) {
        const k = (g.BL[0] * coef(LAMBDA[c])) / (Math.max(g.BL[c], 1e-3) * coef(LAMBDA[0]));
        t = new Float32Array(n);
        for (let i = 0; i < n; i++) t[i] = Math.min(1, Math.max(0.1, Math.pow(tR[i], k)));
      }
      const tf = C.fastGuidedFilter(guide, t, w, h, r, 1e-3, 4);
      const s = img.c[c], d = out.c[c], B = g.BL[c];
      for (let i = 0; i < n; i++) {
        const tt = Math.min(0.9, Math.max(p.tmin, tf[i]));
        d[i] = C.clamp01((s[i] - B) / tt + B);
      }
    }
    return out;
  },
};
