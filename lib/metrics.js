// 無參考水下影像品質指標（論文最常用的兩個），用於 App 內即時比較與測試。
// UIQM：Panetta, Gao, Agaian, "Human-Visual-System-Inspired Underwater Image Quality Measures",
//       IEEE JOE 2016。實作依 FUnIE-GAN 倉庫的 uqim_utils.py（視窗 10、α-trim 0.1）。
// UCIQE：Yang & Sowmya, "An Underwater Color Image Quality Evaluation Metric", IEEE TIP 2015。
// 另附有真值時的 CIEDE76 色差（合成測試用）。
import * as C from './core.js';

const EDGE = 512; // 在固定尺寸上計算，避免指標隨解析度變動

function prep(img) {
  const [w, h] = C.fitSize(img.w, img.h, EDGE);
  return w === img.w && h === img.h ? img : C.resize(img, w, h);
}

function trimmedStats(arr, a = 0.1) {
  const s = Float32Array.from(arr).sort();
  const lo = Math.ceil(a * s.length), hi = Math.floor((1 - a) * s.length);
  let m = 0;
  for (let i = lo; i < hi; i++) m += s[i];
  m /= Math.max(1, hi - lo);
  let v = 0;
  for (let i = 0; i < s.length; i++) v += (s[i] - m) ** 2;
  return [m, v / s.length];
}

function sobelMag(p, w, h) {
  const o = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const ym = Math.max(0, y - 1), yp = Math.min(h - 1, y + 1);
    for (let x = 0; x < w; x++) {
      const xm = Math.max(0, x - 1), xp = Math.min(w - 1, x + 1);
      const a = p[ym * w + xm], b = p[ym * w + x], c = p[ym * w + xp];
      const d = p[y * w + xm], f = p[y * w + xp];
      const g = p[yp * w + xm], hh = p[yp * w + x], i = p[yp * w + xp];
      const gx = c + 2 * f + i - (a + 2 * d + g), gy = g + 2 * hh + i - (a + 2 * b + c);
      o[y * w + x] = Math.hypot(gx, gy);
    }
  }
  return o;
}

function blocks(p, w, h, win, fn) {
  const k1 = Math.floor(h / win), k2 = Math.floor(w / win);
  let val = 0;
  for (let by = 0; by < k1; by++) for (let bx = 0; bx < k2; bx++) {
    let mx = -Infinity, mn = Infinity;
    for (let y = by * win; y < (by + 1) * win; y++) for (let x = bx * win; x < (bx + 1) * win; x++) {
      const v = p[y * w + x];
      if (v > mx) mx = v;
      if (v < mn) mn = v;
    }
    val += fn(mx, mn);
  }
  return { val, k: k1 * k2 };
}

export function uiqm(img) {
  img = prep(img);
  const { w, h } = img, n = w * h;
  const [r, g, b] = img.c.map((p) => p.map((v) => v * 255));
  // UICM
  const rg = new Float32Array(n), yb = new Float32Array(n);
  for (let i = 0; i < n; i++) { rg[i] = r[i] - g[i]; yb[i] = (r[i] + g[i]) / 2 - b[i]; }
  const [mrg, vrg] = trimmedStats(rg), [myb, vyb] = trimmedStats(yb);
  const uicm = -0.0268 * Math.hypot(mrg, myb) + 0.1586 * Math.sqrt(vrg + vyb);
  // UISM：各通道 Sobel 邊緣 × 通道值 的 EME
  const eme = (p) => {
    const { val, k } = blocks(p, w, h, 10, (mx, mn) => (mx > 0 && mn > 0 ? Math.log(mx / mn) : 0));
    return (2 / k) * val;
  };
  const edgeMap = (p) => {
    const s = sobelMag(p, w, h);
    const [, mx] = C.minMax(s);
    const k = mx > 0 ? 255 / mx : 0; // uqim_utils.sobel：幅值正規化到 0..255
    for (let i = 0; i < n; i++) s[i] = s[i] * k * p[i];
    return s;
  };
  const uism = 0.299 * eme(edgeMap(r)) + 0.587 * eme(edgeMap(g)) + 0.114 * eme(edgeMap(b));
  // UIConM：亮度的 logAMEE
  const I = new Float32Array(n);
  for (let i = 0; i < n; i++) I[i] = 0.299 * r[i] + 0.587 * g[i] + 0.114 * b[i];
  const { val, k } = blocks(I, w, h, 10, (mx, mn) => {
    const top = mx - mn, bot = mx + mn;
    if (bot === 0 || top === 0) return 0;
    const q = top / bot;
    return q * Math.log(q);
  });
  const uiconm = (-1 / k) * val;
  return { uiqm: 0.0282 * uicm + 0.2953 * uism + 3.5753 * uiconm, uicm, uism, uiconm };
}

export function uciqe(img) {
  img = prep(img);
  const lab = C.rgb2lab(img), n = lab.L.length;
  const chroma = new Float32Array(n), L = new Float32Array(n);
  let mc = 0, ms = 0;
  for (let i = 0; i < n; i++) {
    L[i] = lab.L[i] / 100;
    chroma[i] = Math.hypot(lab.A[i], lab.B[i]) / 100;
    mc += chroma[i];
    ms += L[i] > 1e-3 ? Math.min(1, chroma[i] / L[i]) : 0;
  }
  mc /= n;
  ms /= n;
  let vc = 0;
  for (let i = 0; i < n; i++) vc += (chroma[i] - mc) ** 2;
  const [l1, l99] = C.percentiles(L, [0.01, 0.99]);
  return 0.468 * Math.sqrt(vc / n) + 0.2745 * (l99 - l1) + 0.2576 * ms;
}

/** 平均 CIEDE76 色差（與真值比較；兩張需同尺寸） */
export function deltaE(a, b) {
  const A = C.rgb2lab(a), B = C.rgb2lab(b), n = A.L.length;
  let s = 0;
  for (let i = 0; i < n; i++) s += Math.sqrt((A.L[i] - B.L[i]) ** 2 + (A.A[i] - B.A[i]) ** 2 + (A.B[i] - B.B[i]) ** 2);
  return s / n;
}

/** PSNR（dB，RGB 0–255；與參考圖比較，越高越好） */
export function psnr(a, b) {
  let s = 0, n = 0;
  for (let c = 0; c < 3; c++) for (let i = 0; i < a.c[c].length; i++) { s += ((a.c[c][i] - b.c[c][i]) * 255) ** 2; n++; }
  const mse = s / n;
  return mse === 0 ? 99 : 10 * Math.log10((255 * 255) / mse);
}

/** SSIM（Wang et al. 2004：11×11 高斯 σ=1.5、K1=0.01、K2=0.03；三通道平均） */
export function ssim(a, b) {
  const { w, h } = a, C1 = (0.01 * 255) ** 2, C2 = (0.03 * 255) ** 2;
  const k = (() => {
    const t = new Float32Array(11);
    let s = 0;
    for (let i = -5; i <= 5; i++) s += t[i + 5] = Math.exp(-(i * i) / (2 * 1.5 * 1.5));
    return t.map((v) => v / s);
  })();
  let total = 0;
  for (let c = 0; c < 3; c++) {
    const x = a.c[c].map((v) => v * 255), y = b.c[c].map((v) => v * 255), n = x.length;
    const xx = new Float32Array(n), yy = new Float32Array(n), xy = new Float32Array(n);
    for (let i = 0; i < n; i++) { xx[i] = x[i] * x[i]; yy[i] = y[i] * y[i]; xy[i] = x[i] * y[i]; }
    const [mx, my, sxx, syy, sxy] = [x, y, xx, yy, xy].map((p) => C.convSep(p, w, h, k));
    let s = 0, cnt = 0;
    // 只算完整視窗（去掉 5 px 邊界），與 skimage 預設相同
    for (let yy0 = 5; yy0 < h - 5; yy0++) for (let xx0 = 5; xx0 < w - 5; xx0++) {
      const i = yy0 * w + xx0;
      const vx = sxx[i] - mx[i] * mx[i], vy = syy[i] - my[i] * my[i], cv = sxy[i] - mx[i] * my[i];
      s += ((2 * mx[i] * my[i] + C1) * (2 * cv + C2)) / ((mx[i] ** 2 + my[i] ** 2 + C1) * (vx + vy + C2));
      cnt++;
    }
    total += s / Math.max(cnt, 1);
  }
  return total / 3;
}
