// 影像基礎運算：所有方法共用。
// 影像格式 Img = { w, h, c: [R, G, B] }，每個通道是 Float32Array，值域 [0,1]（sRGB 編碼值，
// 與各論文的參考程式碼一致：它們都直接在 8-bit sRGB 值上運算）。

export function create(w, h) {
  return { w, h, c: [new Float32Array(w * h), new Float32Array(w * h), new Float32Array(w * h)] };
}

export function clone(img) {
  return { w: img.w, h: img.h, c: img.c.map((p) => new Float32Array(p)) };
}

export function fromRGBA(data, w, h) {
  const img = create(w, h);
  const [r, g, b] = img.c;
  const k = 1 / 255;
  for (let i = 0, j = 0; i < w * h; i++, j += 4) {
    r[i] = data[j] * k;
    g[i] = data[j + 1] * k;
    b[i] = data[j + 2] * k;
  }
  return img;
}

export function toRGBA(img, out) {
  const n = img.w * img.h;
  out = out || new Uint8ClampedArray(n * 4);
  const [r, g, b] = img.c;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    out[j] = r[i] * 255 + 0.5;
    out[j + 1] = g[i] * 255 + 0.5;
    out[j + 2] = b[i] * 255 + 0.5;
    out[j + 3] = 255;
  }
  return out;
}

export const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

export function clampImg(img) {
  for (const p of img.c) for (let i = 0; i < p.length; i++) p[i] = p[i] < 0 ? 0 : p[i] > 1 ? 1 : p[i];
  return img;
}

export function mean(p) {
  let s = 0;
  for (let i = 0; i < p.length; i++) s += p[i];
  return s / p.length;
}

export function minMax(p) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < p.length; i++) {
    const v = p[i];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return [lo, hi];
}

/** 亮度（Rec.601，與 OpenCV 灰階相同） */
export function gray(img) {
  const n = img.w * img.h, out = new Float32Array(n);
  const [r, g, b] = img.c;
  for (let i = 0; i < n; i++) out[i] = 0.299 * r[i] + 0.587 * g[i] + 0.114 * b[i];
  return out;
}

/**
 * 百分位數（多個一起算），以 4096 格直方圖近似；q 為 0..1。
 * lo/hi 為直方圖範圍（預設 0..1）。
 */
export function percentiles(p, qs, lo = 0, hi = 1) {
  const B = 4096, hist = new Uint32Array(B), s = (B - 1) / (hi - lo || 1);
  for (let i = 0; i < p.length; i++) {
    let k = ((p[i] - lo) * s) | 0;
    if (k < 0) k = 0; else if (k >= B) k = B - 1;
    hist[k]++;
  }
  const out = [];
  for (const q of qs) {
    const target = q * (p.length - 1);
    let acc = 0, k = 0;
    for (; k < B; k++) {
      acc += hist[k];
      if (acc > target) break;
    }
    out.push(lo + Math.min(k, B - 1) / s);
  }
  return out;
}

// ---------- 縮放 ----------

/** 平面縮放：縮小用區域平均（避免鋸齒），放大用雙線性。 */
export function resizePlane(p, w, h, nw, nh) {
  if (nw === w && nh === h) return new Float32Array(p);
  if (nw < w && nh < h) return areaDown(p, w, h, nw, nh);
  return bilinear(p, w, h, nw, nh);
}

function bilinear(p, w, h, nw, nh) {
  const out = new Float32Array(nw * nh);
  const sx = w / nw, sy = h / nh;
  const x0s = new Int32Array(nw), x1s = new Int32Array(nw), fxs = new Float32Array(nw);
  for (let x = 0; x < nw; x++) {
    let fx = (x + 0.5) * sx - 0.5;
    if (fx < 0) fx = 0;
    let x0 = fx | 0;
    if (x0 > w - 1) x0 = w - 1;
    x0s[x] = x0;
    x1s[x] = x0 + 1 < w ? x0 + 1 : w - 1;
    fxs[x] = fx - x0;
  }
  for (let y = 0; y < nh; y++) {
    let fy = (y + 0.5) * sy - 0.5;
    if (fy < 0) fy = 0;
    let y0 = fy | 0;
    if (y0 > h - 1) y0 = h - 1;
    const y1 = y0 + 1 < h ? y0 + 1 : h - 1, ty = fy - y0;
    const r0 = y0 * w, r1 = y1 * w, o = y * nw;
    for (let x = 0; x < nw; x++) {
      const a = p[r0 + x0s[x]], b = p[r0 + x1s[x]], c = p[r1 + x0s[x]], d = p[r1 + x1s[x]];
      const t = fxs[x];
      const top = a + (b - a) * t, bot = c + (d - c) * t;
      out[o + x] = top + (bot - top) * ty;
    }
  }
  return out;
}

function areaDown(p, w, h, nw, nh) {
  // 先水平再垂直，每個輸出格取其覆蓋的來源像素平均（含分數權重）
  const tmp = new Float32Array(nw * h);
  const sx = w / nw;
  for (let x = 0; x < nw; x++) {
    const a = x * sx, b = a + sx;
    const i0 = Math.floor(a), i1 = Math.min(w, Math.ceil(b));
    for (let y = 0; y < h; y++) {
      let s = 0;
      const r = y * w;
      for (let i = i0; i < i1; i++) {
        const wgt = Math.min(b, i + 1) - Math.max(a, i);
        s += p[r + i] * wgt;
      }
      tmp[y * nw + x] = s / sx;
    }
  }
  const out = new Float32Array(nw * nh);
  const sy = h / nh;
  for (let y = 0; y < nh; y++) {
    const a = y * sy, b = a + sy;
    const j0 = Math.floor(a), j1 = Math.min(h, Math.ceil(b));
    for (let x = 0; x < nw; x++) {
      let s = 0;
      for (let j = j0; j < j1; j++) s += tmp[j * nw + x] * (Math.min(b, j + 1) - Math.max(a, j));
      out[y * nw + x] = s / sy;
    }
  }
  return out;
}

export function resize(img, nw, nh) {
  return { w: nw, h: nh, c: img.c.map((p) => resizePlane(p, img.w, img.h, nw, nh)) };
}

/** 長邊縮到 edge（不放大） */
export function fitSize(w, h, edge) {
  const s = Math.min(1, edge / Math.max(w, h));
  return [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))];
}

// ---------- 濾波 ----------

/** 方框平均（邊界以實際覆蓋像素數正規化），O(n) 與半徑無關。 */
export function boxMean(p, w, h, r) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  r = Math.max(0, Math.round(r));
  for (let y = 0; y < h; y++) {
    const o = y * w;
    let s = 0, cnt = 0;
    for (let x = 0; x <= Math.min(r, w - 1); x++) { s += p[o + x]; cnt++; }
    for (let x = 0; x < w; x++) {
      tmp[o + x] = s / cnt;
      const add = x + r + 1, sub = x - r;
      if (add < w) { s += p[o + add]; cnt++; }
      if (sub >= 0) { s -= p[o + sub]; cnt--; }
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0, cnt = 0;
    for (let y = 0; y <= Math.min(r, h - 1); y++) { s += tmp[y * w + x]; cnt++; }
    for (let y = 0; y < h; y++) {
      out[y * w + x] = s / cnt;
      const add = y + r + 1, sub = y - r;
      if (add < h) { s += tmp[add * w + x]; cnt++; }
      if (sub >= 0) { s -= tmp[sub * w + x]; cnt--; }
    }
  }
  return out;
}

function gaussKernel(sigma) {
  const r = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float32Array(2 * r + 1);
  let s = 0;
  for (let i = -r; i <= r; i++) s += k[i + r] = Math.exp((-i * i) / (2 * sigma * sigma));
  for (let i = 0; i < k.length; i++) k[i] /= s;
  return k;
}

/** 可分離高斯模糊（邊界複製）。sigma 大時改用三次方框近似。 */
export function gaussBlur(p, w, h, sigma) {
  if (sigma <= 0) return new Float32Array(p);
  if (sigma > 6) {
    // 三次方框 ≈ 高斯（Wells 1986）
    const r = Math.max(1, Math.round(Math.sqrt((12 * sigma * sigma) / 3 + 1) / 2 - 0.5));
    return boxMean(boxMean(boxMean(p, w, h, r), w, h, r), w, h, r);
  }
  return convSep(p, w, h, gaussKernel(sigma));
}

export function convSep(p, w, h, k) {
  const r = (k.length - 1) >> 1;
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) {
        let xx = x + i;
        xx = xx < 0 ? 0 : xx >= w ? w - 1 : xx;
        s += p[o + xx] * k[i + r];
      }
      tmp[o + x] = s;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) {
        let yy = y + i;
        yy = yy < 0 ? 0 : yy >= h ? h - 1 : yy;
        s += tmp[yy * w + x] * k[i + r];
      }
      out[y * w + x] = s;
    }
  }
  return out;
}

/** 局部最小值濾波（方形窗 2r+1），可分離，van Herk/Gil-Werman O(n)。 */
export function minFilter(p, w, h, r) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  const line = new Float32Array(Math.max(w, h)), res = new Float32Array(Math.max(w, h));
  const run = (len) => minLine(line, res, len, r);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) line[x] = p[y * w + x];
    run(w);
    for (let x = 0; x < w; x++) tmp[y * w + x] = res[x];
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) line[y] = tmp[y * w + x];
    run(h);
    for (let y = 0; y < h; y++) out[y * w + x] = res[y];
  }
  return out;
}

function minLine(a, out, n, r) {
  // 單調佇列
  const q = new Int32Array(n);
  let head = 0, tail = 0, next = 0;
  for (let i = 0; i < n; i++) {
    const hiIdx = Math.min(n - 1, i + r);
    while (next <= hiIdx) {
      while (tail > head && a[q[tail - 1]] >= a[next]) tail--;
      q[tail++] = next++;
    }
    while (q[head] < i - r) head++;
    out[i] = a[q[head]];
  }
}

/** 引導濾波（He et al., TPAMI 2013），灰階引導影像 I、輸入 p。 */
export function guidedFilter(I, p, w, h, r, eps) {
  const n = w * h;
  const mI = boxMean(I, w, h, r), mp = boxMean(p, w, h, r);
  const Ip = new Float32Array(n), II = new Float32Array(n);
  for (let i = 0; i < n; i++) { Ip[i] = I[i] * p[i]; II[i] = I[i] * I[i]; }
  const mIp = boxMean(Ip, w, h, r), mII = boxMean(II, w, h, r);
  const a = new Float32Array(n), b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const cov = mIp[i] - mI[i] * mp[i], v = mII[i] - mI[i] * mI[i];
    a[i] = cov / (v + eps);
    b[i] = mp[i] - a[i] * mI[i];
  }
  const ma = boxMean(a, w, h, r), mb = boxMean(b, w, h, r);
  const q = new Float32Array(n);
  for (let i = 0; i < n; i++) q[i] = ma[i] * I[i] + mb[i];
  return q;
}

/** 快速引導濾波（He & Sun 2015）：在 1/s 尺寸計算係數再放大，大半徑時大幅加速。 */
export function fastGuidedFilter(I, p, w, h, r, eps, s = 4) {
  if (s <= 1 || w < 4 * s || h < 4 * s) return guidedFilter(I, p, w, h, r, eps);
  const sw = Math.max(1, Math.round(w / s)), sh = Math.max(1, Math.round(h / s));
  const Is = resizePlane(I, w, h, sw, sh), ps = resizePlane(p, w, h, sw, sh);
  const rs = Math.max(1, Math.round(r / s)), n = sw * sh;
  const mI = boxMean(Is, sw, sh, rs), mp = boxMean(ps, sw, sh, rs);
  const Ip = new Float32Array(n), II = new Float32Array(n);
  for (let i = 0; i < n; i++) { Ip[i] = Is[i] * ps[i]; II[i] = Is[i] * Is[i]; }
  const mIp = boxMean(Ip, sw, sh, rs), mII = boxMean(II, sw, sh, rs);
  const a = new Float32Array(n), b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    a[i] = (mIp[i] - mI[i] * mp[i]) / (mII[i] - mI[i] * mI[i] + eps);
    b[i] = mp[i] - a[i] * mI[i];
  }
  const ma = resizePlane(boxMean(a, sw, sh, rs), sw, sh, w, h);
  const mb = resizePlane(boxMean(b, sw, sh, rs), sw, sh, w, h);
  const q = new Float32Array(w * h);
  for (let i = 0; i < q.length; i++) q[i] = ma[i] * I[i] + mb[i];
  return q;
}

// ---------- 金字塔（Burt & Adelson） ----------

const K5 = new Float32Array([1 / 16, 4 / 16, 6 / 16, 4 / 16, 1 / 16]);

export function pyrDown(p, w, h) {
  const b = convSep(p, w, h, K5);
  const nw = Math.max(1, (w + 1) >> 1), nh = Math.max(1, (h + 1) >> 1);
  const out = new Float32Array(nw * nh);
  for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) out[y * nw + x] = b[Math.min(h - 1, 2 * y) * w + Math.min(w - 1, 2 * x)];
  return { p: out, w: nw, h: nh };
}

export function gaussPyramid(p, w, h, levels) {
  const pyr = [{ p, w, h }];
  for (let i = 1; i < levels; i++) {
    const last = pyr[i - 1];
    pyr.push(pyrDown(last.p, last.w, last.h));
  }
  return pyr;
}

export function laplacianPyramid(p, w, h, levels) {
  const g = gaussPyramid(p, w, h, levels);
  const L = [];
  for (let i = 0; i < levels - 1; i++) {
    const up = resizePlane(g[i + 1].p, g[i + 1].w, g[i + 1].h, g[i].w, g[i].h);
    const d = new Float32Array(g[i].p.length);
    for (let k = 0; k < d.length; k++) d[k] = g[i].p[k] - up[k];
    L.push({ p: d, w: g[i].w, h: g[i].h });
  }
  L.push(g[levels - 1]);
  return L;
}

export function collapse(L) {
  let cur = L[L.length - 1].p;
  for (let i = L.length - 2; i >= 0; i--) {
    const up = resizePlane(cur, L[i + 1].w, L[i + 1].h, L[i].w, L[i].h);
    const o = new Float32Array(up.length);
    for (let k = 0; k < o.length; k++) o[k] = up[k] + L[i].p[k];
    cur = o;
  }
  return cur;
}

/** 金字塔層數：最小邊至少約 8 像素 */
export function pyrLevels(w, h, max = 7) {
  return Math.max(1, Math.min(max, Math.floor(Math.log2(Math.min(w, h) / 8)) + 1));
}

// ---------- 色彩空間 ----------

const SRGB2LIN = new Float32Array(4097);
for (let i = 0; i <= 4096; i++) {
  const v = i / 4096;
  SRGB2LIN[i] = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}
export function toLinear(v) {
  const k = v * 4096;
  if (k <= 0) return 0;
  if (k >= 4096) return 1;
  const i = k | 0, t = k - i;
  return SRGB2LIN[i] + (SRGB2LIN[i + 1] - SRGB2LIN[i]) * t;
}
export function toSRGB(v) {
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

const fLab = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
const fLabInv = (t) => (t > 0.206893 ? t * t * t : (t - 16 / 116) / 7.787);

/** sRGB [0,1] → CIELAB（D65；L 0..100，a/b 約 −128..127），與 OpenCV/skimage 相同定義。 */
export function rgb2lab(img) {
  const n = img.w * img.h;
  const L = new Float32Array(n), A = new Float32Array(n), B = new Float32Array(n);
  const [r, g, b] = img.c;
  for (let i = 0; i < n; i++) {
    const R = toLinear(r[i]), G = toLinear(g[i]), Bl = toLinear(b[i]);
    const X = (0.412453 * R + 0.35758 * G + 0.180423 * Bl) / 0.950456;
    const Y = 0.212671 * R + 0.71516 * G + 0.072169 * Bl;
    const Z = (0.019334 * R + 0.119193 * G + 0.950227 * Bl) / 1.088754;
    const fx = fLab(X), fy = fLab(Y), fz = fLab(Z);
    L[i] = Y > 0.008856 ? 116 * fy - 16 : 903.3 * Y;
    A[i] = 500 * (fx - fy);
    B[i] = 200 * (fy - fz);
  }
  return { w: img.w, h: img.h, L, A, B };
}

export function lab2rgb(lab, out) {
  const n = lab.w * lab.h;
  out = out || create(lab.w, lab.h);
  const [r, g, b] = out.c;
  for (let i = 0; i < n; i++) {
    const fy = (lab.L[i] + 16) / 116, fx = fy + lab.A[i] / 500, fz = fy - lab.B[i] / 200;
    const X = fLabInv(fx) * 0.950456, Y = fLabInv(fy), Z = fLabInv(fz) * 1.088754;
    r[i] = toSRGB(3.240479 * X - 1.53715 * Y - 0.498535 * Z);
    g[i] = toSRGB(-0.969256 * X + 1.875992 * Y + 0.041556 * Z);
    b[i] = toSRGB(0.055648 * X - 0.204043 * Y + 1.057311 * Z);
  }
  return out;
}

/** 最後的穩健輸出拉伸：每通道共用同一組黑白點（保持色彩比例），只在動態範圍不足時作用。 */
export function autoLevels(img, lo = 0.002, hi = 0.998, strength = 1) {
  const g = gray(img);
  const [a, b] = percentiles(g, [lo, hi]);
  if (b - a < 1e-3 || strength <= 0) return img;
  const s = 1 / (b - a);
  for (const p of img.c) for (let i = 0; i < p.length; i++) {
    const v = (p[i] - a) * s;
    p[i] = clamp01(p[i] + (v - p[i]) * strength);
  }
  return img;
}
