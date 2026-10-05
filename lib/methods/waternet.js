// 方法：WaterNet（UIEB 論文的基準網路）與 UVE-Net（UVEB 影片增強基準，單格模式）
//
// WaterNet：Li, Guo, Ren, Cong, Hou, Kwong, Tao, "An Underwater Image Enhancement Benchmark Dataset and Beyond",
//   IEEE TIP 29, 2020（UIEB）。原始碼 github.com/Li-Chongyi/Water-Net_Code；
//   PyTorch 重現與權重 github.com/tnwei/waternet（MIT，權重 sha256 daa0ee…，由原作 TensorFlow 權重轉換）。
//   網路輸入 = 原圖 + 三個前處理版本（白平衡 WB、直方圖等化 HE、Gamma 0.7 GC），學習三者的信心圖並融合。
//   前處理依 tnwei/waternet 的 data.py（OpenCV 8-bit 行為）實作。
// UVE-Net：Xie et al., "UVEB: A Large-scale Benchmark and Baseline Towards Real-World Underwater Video
//   Enhancement", CVPR 2024。github.com/yzbouc/UVEB（MIT）附的小模型 samll_net_g.pth。
//   它把中間格的資訊轉成卷積核傳給各格；實測每一格的輸出只取決於該格，因此以單格模式匯出。
import * as C from '../core.js';
import { netMethod } from './net.js';

const u8 = (v) => Math.max(0, Math.min(255, Math.floor(v))); // numpy astype(np.uint8)（截斷）

/** tnwei white_balance_transform（SimplestColorBalance.m）：飽和比例依通道總和比例調整，clip 後拉伸到 0–255 */
function whiteBalance(R) {
  const n = R[0].length, sums = R.map((p) => p.reduce((s, v) => s + v, 0));
  const maxpix = Math.max(...sums), out = [];
  for (let c = 0; c < 3; c++) {
    const sat = 0.005 * (maxpix / Math.max(sums[c], 1));
    const sorted = Float64Array.from(R[c]).sort();
    const q = (p) => { // np.quantile（線性內插）
      const pos = p * (n - 1), i = Math.floor(pos), f = pos - i;
      return i + 1 < n ? sorted[i] + (sorted[i + 1] - sorted[i]) * f : sorted[n - 1];
    };
    const lo = q(sat), hi = q(1 - sat), k = hi > lo ? 255 / (hi - lo) : 0;
    const o = new Uint8Array(n);
    for (let i = 0; i < n; i++) o[i] = u8((Math.min(hi, Math.max(lo, R[c][i])) - lo) * k);
    out.push(o);
  }
  return out;
}

/** OpenCV CLAHE（8-bit，clipLimit、tiles×tiles；與 cv::createCLAHE 相同的裁切、重分配與雙線性內插） */
export function clahe(L, w, h, clipLimit = 0.1, tiles = 8) {
  const padW = w % tiles ? tiles - (w % tiles) : 0, padH = h % tiles ? tiles - (h % tiles) : 0;
  const W = w + padW, H = h + padH, tw = W / tiles, th = H / tiles;
  const at = (x, y) => { // BORDER_REFLECT_101 補邊
    if (x >= w) x = 2 * w - 2 - x;
    if (y >= h) y = 2 * h - 2 - y;
    return L[Math.max(0, y) * w + Math.max(0, x)];
  };
  const total = tw * th, clip = Math.max(Math.floor((clipLimit * total) / 256), 1), scale = 255 / total;
  const luts = [];
  for (let ty = 0; ty < tiles; ty++) for (let tx = 0; tx < tiles; tx++) {
    const hist = new Int32Array(256);
    for (let y = ty * th; y < (ty + 1) * th; y++) for (let x = tx * tw; x < (tx + 1) * tw; x++) hist[at(x, y)]++;
    let excess = 0;
    for (let i = 0; i < 256; i++) if (hist[i] > clip) { excess += hist[i] - clip; hist[i] = clip; }
    const batch = Math.floor(excess / 256);
    let residual = excess - batch * 256;
    for (let i = 0; i < 256; i++) hist[i] += batch;
    if (residual > 0) {
      const step = Math.max(Math.floor(256 / residual), 1);
      for (let i = 0; i < 256 && residual > 0; i += step, residual--) hist[i]++;
    }
    const lut = new Uint8Array(256);
    let sum = 0;
    for (let i = 0; i < 256; i++) { sum += hist[i]; lut[i] = Math.min(255, Math.round(sum * scale)); }
    luts.push(lut);
  }
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const tyf = y / th - 0.5;
    let ty1 = Math.floor(tyf), ty2 = ty1 + 1;
    const ya = tyf - ty1;
    ty1 = Math.max(ty1, 0); ty2 = Math.min(ty2, tiles - 1);
    for (let x = 0; x < w; x++) {
      const txf = x / tw - 0.5;
      let tx1 = Math.floor(txf), tx2 = tx1 + 1;
      const xa = txf - tx1;
      tx1 = Math.max(tx1, 0); tx2 = Math.min(tx2, tiles - 1);
      const v = L[y * w + x];
      const r = (luts[ty1 * tiles + tx1][v] * (1 - xa) + luts[ty1 * tiles + tx2][v] * xa) * (1 - ya)
        + (luts[ty2 * tiles + tx1][v] * (1 - xa) + luts[ty2 * tiles + tx2][v] * xa) * ya;
      out[y * w + x] = Math.min(255, Math.round(r));
    }
  }
  return out;
}

/** tnwei histeq：RGB → Lab（OpenCV 8-bit：L·255/100），L 做 CLAHE(0.1, 8×8)，再轉回 RGB */
function histEq(img) {
  const { w, h } = img, n = w * h, lab = C.rgb2lab(img);
  const L8 = new Uint8Array(n);
  for (let i = 0; i < n; i++) L8[i] = Math.min(255, Math.round((lab.L[i] * 255) / 100));
  const eq = clahe(L8, w, h, 0.1, 8);
  for (let i = 0; i < n; i++) {
    lab.L[i] = (eq[i] * 100) / 255;
    // OpenCV 8-bit Lab 把 a、b 存成 0–255 整數；照樣量化再轉回 RGB
    lab.A[i] = Math.min(255, Math.max(0, Math.round(lab.A[i] + 128))) - 128;
    lab.B[i] = Math.min(255, Math.max(0, Math.round(lab.B[i] + 128))) - 128;
  }
  return C.lab2rgb(lab);
}

/** WaterNet 輸入：[原圖, WB, HE, GC]，各 3 通道、[0,1]（與 tnwei inference.py 相同，先量化成 8-bit） */
function waternetInput(small) {
  const n = small.w * small.h;
  const R = small.c.map((p) => Uint8Array.from(p, (v) => Math.round(v * 255)));
  const rgb8 = { w: small.w, h: small.h, c: R.map((p) => Float32Array.from(p, (v) => v / 255)) };
  const wb = whiteBalance(R);
  const he = histEq(rgb8);
  const x = new Float32Array(12 * n);
  for (let c = 0; c < 3; c++) for (let i = 0; i < n; i++) {
    x[c * n + i] = R[c][i] / 255;
    x[(3 + c) * n + i] = wb[c][i] / 255;
    x[(6 + c) * n + i] = Math.round(he.c[c][i] * 255) / 255;
    x[(9 + c) * n + i] = u8(255 * Math.pow(R[c][i] / 255, 0.7)) / 255;
  }
  return x;
}

export const waternet = netMethod({
  id: 'waternet',
  name: 'WaterNet（UIEB 基準網路）',
  short: 'WaterNet',
  cite: 'Li et al., IEEE TIP 2020',
  kind: '深度學習（融合式 CNN，109 萬參數）',
  model: { file: 'models/waternet.onnx', mb: 4.4 },
  size: 'aspect', edge: 256, multiple: 8,
  buildInput: waternetInput,
  output: 'clip',
});

export const uvenet = netMethod({
  id: 'uvenet',
  name: 'UVE-Net（UVEB 影片增強）',
  short: 'UVE-Net',
  cite: 'Xie et al., CVPR 2024',
  kind: '深度學習（影片模型，53 萬參數）',
  model: { file: 'models/uvenet.onnx', mb: 2.2 },
  size: 'aspect', edge: 320, multiple: 16,
  input: '01',
  output: 'clip',
});
