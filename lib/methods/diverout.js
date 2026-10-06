// 方法：Diverout_sim — 重現 DIVEROUT App「高 / 超高 / 標準」影片調色的反推模型
//
// 依黑箱測試反推（見 docs/diverout-model.md、tools/diverout_cc.py），不是官方實作。內容是逐通道自動色階：
//   1. 關鍵幀：段數 N = ceil(片長 / T)，整支片平均分布 N+1 個關鍵幀（T = 1 秒高、0.5 秒超高、2 秒標準）
//   2. 每個關鍵幀估 R、G、B 的黑點 lo 與白點 hi（real：實拍擬合；synthetic：測試圖規則）
//   3. 紅色太弱時合成紅色 R' = w·R + (1−w)·(G − k·B)
//   4. 中間幀的 lo、hi、w、k 用前後關鍵幀線性內插；每個像素 out = clip((in − lo) / (hi − lo))
// 數值以 0–255 碼值計算，與 diverout_cc.py 相同。
import * as C from '../core.js';

const REAL_OFF = [[-7.6, -3.0], [-7.6, 4.3], [-4.5, -3.3]]; // R、G、B 的（黑點、白點）偏移
const SYN_OFF = [[-10.4, -3.9], [-13.1, -0.4], [-14.1, -1.0]];
const W_TAB = [[0.0, 0.0], [0.4, 0.0], [0.6, 0.10], [3.5, 0.28], [7.0, 0.34], [14.5, 0.37], [30.0, 0.50],
  [42.0, 0.58], [50.0, 0.64], [58.0, 0.70], [60.0, 1.0]];
const SYN_RED_OFF = [-1.8, 16.2];

/** np.interp */
export function redWeight(rmean) {
  if (rmean <= W_TAB[0][0]) return W_TAB[0][1];
  for (let i = 1; i < W_TAB.length; i++) {
    const [x1, y1] = W_TAB[i];
    if (rmean <= x1) {
      const [x0, y0] = W_TAB[i - 1];
      return y0 + ((y1 - y0) * (rmean - x0)) / (x1 - x0);
    }
  }
  return W_TAB[W_TAB.length - 1][1];
}

/** 直方圖百分位（numpy 預設的線性內插）。hist[i] = 落在 lo + i·step 的個數 */
function pctHist(hist, n, q, lo, step) {
  if (!n) return 0;
  const pos = (q / 100) * (n - 1), i0 = Math.floor(pos), f = pos - i0;
  let acc = 0, v0 = null;
  for (let b = 0; b < hist.length; b++) {
    acc += hist[b];
    if (v0 === null && acc > i0) {
      v0 = lo + b * step;
      if (f === 0 || acc > i0 + 1) return v0;
    } else if (v0 !== null && hist[b]) {
      return v0 + f * (lo + b * step - v0);
    }
  }
  return v0 ?? lo;
}

/**
 * 估計一個關鍵幀的參數。img：平面 [0,1]；profile：'real' | 'synthetic'。
 * 回傳 { lo: [3], hi: [3], w, k }（0–255 碼值）。
 */
export function diverEstimate(img, profile = 'real') {
  // 碼值（0–255 整數）；和 diverout_cc.py 一樣，高度 > 1200 先縮一半（2×2 平均 = cv2 INTER_AREA）再統計，
  // 這時數值是 0.25 的倍數，所以直方圖用 0.25 一格，百分位仍然精確
  let { w, h } = img;
  let P = img.c.map((p) => Float32Array.from(p, (v) => Math.round(Math.min(1, Math.max(0, v)) * 255)));
  let step = 1;
  if (h > 1200) {
    const nw = Math.max(1, w >> 1), nh = Math.max(1, h >> 1);
    P = P.map((p) => {
      const o = new Float32Array(nw * nh);
      for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
        const i = 2 * y * w + 2 * x;
        o[y * nw + x] = (p[i] + p[i + 1] + p[i + w] + p[i + w + 1]) / 4;
      }
      return o;
    });
    [w, h, step] = [nw, nh, 0.25];
  }
  const n = w * h, bins = Math.round(255 / step) + 1, bin = (v) => Math.round(v / step);
  const lo = [0, 0, 0], hi = [255, 255, 255];
  if (profile === 'synthetic') {
    // 只用「非平坦」像素：亮度與右側或下方鄰點相差 ≥ 1 碼值（float32 計算，與 numpy 相同）
    const f = Math.fround, mask = new Uint8Array(n), y = new Float32Array(n);
    const [kr, kg, kb] = [f(0.299), f(0.587), f(0.114)];
    for (let i = 0; i < n; i++) y[i] = f(f(f(P[0][i] * kr) + f(P[1][i] * kg)) + f(P[2][i] * kb));
    let cnt = 0;
    for (let r = 0; r < h; r++) for (let x = 0; x < w; x++) {
      const i = r * w + x;
      const gx = x + 1 < w ? Math.abs(f(y[i + 1] - y[i])) : 0, gy = r + 1 < h ? Math.abs(f(y[i + w] - y[i])) : 0;
      if (Math.max(gx, gy) >= 1) { mask[i] = 1; cnt++; }
    }
    if (cnt < 1000) mask.fill(1);
    for (let c = 0; c < 3; c++) {
      const hl = new Float64Array(bins), hh = new Float64Array(bins);
      let nl = 0, nh = 0;
      for (let i = 0; i < n; i++) {
        if (!mask[i]) continue;
        const v = P[c][i];
        if (v >= 32) { hl[bin(v)]++; nl++; }
        if (v <= 232) { hh[bin(v)]++; nh++; }
      }
      lo[c] = (nl ? pctHist(hl, nl, 2, 0, step) : 0) + SYN_OFF[c][0];
      hi[c] = (nh ? pctHist(hh, nh, 98, 0, step) : 255) + SYN_OFF[c][1];
    }
  } else {
    for (let c = 0; c < 3; c++) {
      const hm = new Float64Array(bins), ha = new Float64Array(bins);
      let nm = 0;
      for (let i = 0; i < n; i++) {
        const v = P[c][i], b = bin(v);
        ha[b]++;
        if (v >= 32 && v <= 232) { hm[b]++; nm++; }
      }
      lo[c] = (nm ? pctHist(hm, nm, 0.1, 0, step) : 0) + REAL_OFF[c][0];
      hi[c] = pctHist(ha, n, 99, 0, step) + REAL_OFF[c][1];
    }
  }
  let sr = 0, sg = 0, sb = 0;
  for (let i = 0; i < n; i++) { sr += P[0][i]; sg += P[1][i]; sb += P[2][i]; }
  const wr = redWeight(sr / n);
  const k = Math.min(1.5, Math.max(0.1, (1.18 * (sg / n)) / Math.max(sb / n, 1) - 0.4));
  if (wr < 1) {
    // R' 的值域約 −383…255：用 1/16 碼值的直方圖
    const LO = -400, STEP = 1 / 16, hist = new Float64Array(Math.ceil(700 / STEP));
    for (let i = 0; i < n; i++) {
      const rp = wr * P[0][i] + (1 - wr) * (P[1][i] - k * P[2][i]);
      hist[Math.min(hist.length - 1, Math.max(0, Math.round((rp - LO) / STEP)))]++;
    }
    lo[0] = pctHist(hist, n, 1, LO, STEP) + SYN_RED_OFF[0];
    hi[0] = pctHist(hist, n, 98, LO, STEP) + SYN_RED_OFF[1];
  }
  return { lo, hi, w: wr, k };
}

/**
 * 參數 → 3×4 仿射矩陣（[0,1] 色值）：out_c = m[c]·[R, G, B, 1]，再 clip。
 * 播放時 GPU 直接用這個矩陣，CPU 套用也用同一組數字。
 */
export function diverMatrix(g) {
  const rows = [];
  for (let c = 0; c < 3; c++) {
    const d = Math.max(g.hi[c] - g.lo[c], 1e-3), s = 255 / d, row = [0, 0, 0, -g.lo[c] / d];
    if (c === 0 && g.w < 1) {
      row[0] = s * g.w;
      row[1] = s * (1 - g.w);
      row[2] = -s * (1 - g.w) * g.k;
    } else row[c] = s;
    rows.push(row);
  }
  return rows;
}

export function diverApply(img, g) {
  const M = diverMatrix(g), out = C.create(img.w, img.h), [R, G, B] = img.c;
  for (let c = 0; c < 3; c++) {
    const [a, b, d, e] = M[c], o = out.c[c];
    for (let i = 0; i < o.length; i++) o[i] = C.clamp01(a * R[i] + b * G[i] + d * B[i] + e);
  }
  return out;
}

/** 關鍵幀位置（幀號）：N = ceil(片長 / T)，在 n 幀上平均分布 N+1 個（與 diverout_cc.py 相同） */
export function keyframeIndices(n, fps, interval) {
  const N = Math.max(1, Math.ceil(n / fps / interval - 1e-9));
  const set = new Set();
  for (let i = 0; i <= N; i++) set.add(Math.min(Math.max(n - 1, 0), Math.round((i * n) / N)));
  return [...set].sort((a, b) => a - b);
}

/** 不知道幀數時（瀏覽器的 <video>）：用時間平均分布。
 *  瀏覽器回報的片長常含音軌多出的幾十毫秒（例：3.00 秒的畫面回報 3.02 秒），留 0.05 秒容差免得多切一段 */
export function keyframeTimes(duration, interval, tol = 0.05) {
  const N = Math.max(1, Math.ceil(duration / interval - tol));
  return Array.from({ length: N + 1 }, (_, i) => (i * duration) / N);
}

/** 依時間在關鍵幀之間線性內插（keys：[{ t, g }]，依 t 排序） */
export function interpKeys(keys, t) {
  if (!keys.length) return null;
  if (t <= keys[0].t) return keys[0].g;
  const last = keys[keys.length - 1];
  if (t >= last.t) return last.g;
  let j = 1;
  while (keys[j].t < t) j++;
  const A = keys[j - 1], B = keys[j], a = (t - A.t) / (B.t - A.t || 1);
  const mix = (x, y) => x + a * (y - x);
  return {
    lo: A.g.lo.map((v, c) => mix(v, B.g.lo[c])),
    hi: A.g.hi.map((v, c) => mix(v, B.g.hi[c])),
    w: mix(A.g.w, B.g.w),
    k: mix(A.g.k, B.g.k),
  };
}

/** 整支片（已解碼的幀）→ 關鍵幀參數，給評測程式用（App 在 app.js 以 <video> 跳轉取得關鍵幀） */
export function keysFromFrames(frames, fps, p = {}) {
  return keyframeIndices(frames.length, fps, p.interval || 1)
    .map((i) => ({ t: i / fps, g: diverEstimate(frames[i], p.profile ? 'synthetic' : 'real') }));
}

export const INTERVALS = [[1, '高（每 1 秒）'], [0.5, '超高（每 0.5 秒）'], [2, '標準（每 2 秒）']];

export default {
  id: 'diverout',
  name: 'Diverout_sim（DIVEROUT 調色模擬）',
  short: 'Diverout_sim',
  cite: '反推模型，2026',
  kind: '逐通道自動色階＋紅色合成',
  wantsFull: true, // 百分位要在處理解析度上算（縮成 320 px 會改變分布的尾端）
  keyframes: true, // 影片：整支片的關鍵幀＋線性內插（由 App / 評測程式先算好，pipeline 收 opts.g）
  params: [
    { key: 'interval', label: '模式（關鍵幀間隔）', options: INTERVALS, def: 1 },
    { key: 'profile', label: '參數組', options: [[0, 'real（實拍擬合）'], [1, 'synthetic（測試圖規則）']], def: 0 },
  ],
  estimate(img, p) {
    return diverEstimate(img, p.profile ? 'synthetic' : 'real');
  },
  apply(img, g) {
    return diverApply(img, g);
  },
};
