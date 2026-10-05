// 影片時間一致性（逐幀方法用在影片上最常見的問題是「閃爍」）。
//
// 兩層，皆不需光流、可即時：
// 1. 參數層：每幀估出的全域量（背景光、白平衡增益、拉伸範圍、散射係數…）做指數移動平均，
//    時間常數 τ 秒；以色彩直方圖距離偵測「換鏡頭」，換鏡頭時立即重設。
//    概念同 UnDIVE（WACV 2025）、Bonneel et al.（SIGGRAPH Asia 2015）所指出的：逐幀增強
//    的閃爍主要來自每幀獨立估計的全域參數抖動。
// 2. 輸出層（盲去閃爍）：把輸出與輸入縮成粗網格（長邊 48）；輸入幾乎沒變的格子
//    （靜止區域）讓輸出低頻跟隨前一幀的穩定值，移動區域直接放行；
//    修正量以雙線性放大後加回全解析度，只動低頻、不糊細節。
//    這是 Bonneel 等人「梯度取自當前處理幀、低頻取自前一輸出」想法的免光流簡化版。
import * as C from './core.js';

const GRID_EDGE = 48;

export class Stabilizer {
  constructor() {
    this.reset();
  }

  reset() {
    this.g = null;
    this.sig = null;
    this.prevIn = null;
    this.stab = null;
    this.lastCut = 0;
  }

  /** 換鏡頭偵測：8×8 色度 + 8 階亮度直方圖的 L1 距離（0..1） */
  static signature(img) {
    const [w, h] = C.fitSize(img.w, img.h, 64);
    const t = C.resize(img, w, h), n = w * h;
    const hist = new Float32Array(72);
    const [r, g, b] = t.c;
    for (let i = 0; i < n; i++) {
      const s = r[i] + g[i] + b[i] + 1e-6;
      const cr = Math.min(7, ((r[i] / s) * 8) | 0), cg = Math.min(7, ((g[i] / s) * 8) | 0);
      hist[cr * 8 + cg] += 0.5 / n;
      hist[64 + Math.min(7, ((s / 3) * 8) | 0)] += 0.5 / n;
    }
    return hist;
  }

  static distance(a, b) {
    let d = 0;
    for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]);
    return d; // 兩個各總和 1 的直方圖：最大 2
  }

  /**
   * 平滑全域參數。discrete：不可內插的欄位（例如通道排序），一旦改變就整體重設。
   * 回傳 { g, cut, dist }
   */
  smooth(g, sig, dt, tau, discrete = [], cutThreshold = 0.5) {
    const dist = this.sig ? Stabilizer.distance(sig, this.sig) : 2;
    this.sig = sig;
    let cut = !this.g || dist > cutThreshold;
    if (!cut) for (const k of discrete) if (JSON.stringify(g[k]) !== JSON.stringify(this.g[k])) cut = true;
    if (cut || !(tau > 0) || !(dt > 0)) {
      this.g = g;
      if (cut) { this.stab = null; this.prevIn = null; }
      return { g, cut, dist };
    }
    const a = 1 - Math.exp(-dt / tau);
    this.g = blend(this.g, g, a);
    return { g: this.g, cut, dist };
  }

  /** 輸出層去閃爍（就地修改 out）。strength 0..1；回傳實際修正的平均量。 */
  deflicker(input, out, strength = 0.7, sigma = 0.03) {
    const [gw, gh] = C.fitSize(out.w, out.h, GRID_EDGE);
    const inL = C.resize(input, gw, gh), outL = C.resize(out, gw, gh), n = gw * gh;
    if (!this.stab || !this.prevIn || this.stab.w !== gw || this.stab.h !== gh) {
      this.stab = outL;
      this.prevIn = inL;
      return 0;
    }
    const corr = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
    let total = 0;
    for (let i = 0; i < n; i++) {
      let d = 0;
      for (let c = 0; c < 3; c++) d += Math.abs(inL.c[c][i] - this.prevIn.c[c][i]);
      d /= 3;
      const still = Math.exp(-((d / sigma) ** 2)) * strength; // 1 = 靜止
      for (let c = 0; c < 3; c++) {
        const target = outL.c[c][i] + (this.stab.c[c][i] - outL.c[c][i]) * still;
        corr[c][i] = target - outL.c[c][i];
        this.stab.c[c][i] = target;
        total += Math.abs(corr[c][i]);
      }
    }
    this.prevIn = inL;
    for (let c = 0; c < 3; c++) {
      const up = C.resizePlane(corr[c], gw, gh, out.w, out.h), p = out.c[c];
      for (let i = 0; i < p.length; i++) p[i] = C.clamp01(p[i] + up[i]);
    }
    return total / (3 * n);
  }
}

/** 遞迴內插數字、陣列、TypedArray；長度不同時取新值。 */
export function blend(a, b, t) {
  if (typeof b === 'number') return typeof a === 'number' && Number.isFinite(a) ? a + (b - a) * t : b;
  if (ArrayBuffer.isView(b)) {
    if (!ArrayBuffer.isView(a) || a.length !== b.length) return b;
    const o = new b.constructor(b.length);
    for (let i = 0; i < b.length; i++) o[i] = a[i] + (b[i] - a[i]) * t;
    return o;
  }
  if (Array.isArray(b)) {
    if (!Array.isArray(a) || a.length !== b.length) return b;
    return b.map((v, i) => blend(a[i], v, t));
  }
  if (b && typeof b === 'object') {
    const o = {};
    for (const k of Object.keys(b)) o[k] = a && k in a ? blend(a[k], b[k], t) : b[k];
    return o;
  }
  return b;
}
