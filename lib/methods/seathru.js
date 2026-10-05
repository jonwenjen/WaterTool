// 方法 6：Sea-thru（修正後的水下成像模型）＋ ULAP 單張深度
// Akkaynak & Treibitz, "Sea-thru: A Method for Removing Water From Underwater Images", CVPR 2019；
// 模型：Akkaynak & Treibitz, "A Revised Underwater Image Formation Model", CVPR 2018。
// 參考實作：github.com/hainh/sea-thru（Python，配合 monodepth2 深度）
//
// Sea-thru 需要深度圖。影片沒有 RGB-D，這裡改用 ULAP（方法 3）的單張深度先驗當相對深度，
// 再線性對應到 [近距, 遠距] 公尺 —— 這是本工具的近似，非原論文設定。
// 1. 背景散射：把深度分 10 段，每段取最暗 1% 像素，擬合
//      B_c(z) = B∞(1 − e^{−β_B z}) + J′·e^{−β_D′ z}
//    （β_B、β_D′ 以網格搜尋，B∞、J′ 以有界最小平方）
// 2. 直射訊號 D_c = I_c − B∞(1 − e^{−β_B z})。擬合式中的 J′ 項是「最暗點本身殘留的直射光」，
//    不是散射；沒有真正暗點的近景（常見於影片）若連它一起扣會把訊號扣光，故只扣散射項。
// 3. 光源：局部空間平均色（LSAC）—— 以深度為引導的大半徑引導濾波近似「只在深度相近處平均」，
//    E_c = 2·a_c；由 E 推出 β_D = −ln(E)/z，再依深度分段取中位數，使衰減只隨深度變化
// 4. J_c = D_c · e^{β_D(z)·z}，限制在 [0,1]；直射訊號幾乎為零的開放水域（原論文沒有深度的像素）
//    （ULAP 判為最遠的區域）保留原像素；再以 G、B 最亮 10% 白平衡（紅色取兩者平均，參考碼 wbalance_no_red_10p），最後拉伸。
import * as C from '../core.js';
import { depthRange, refinedDepth } from './ulap.js';

const NB = 16; // β_D(z) 的分段數
const GRID = Array.from({ length: 24 }, (_, i) => 0.01 * Math.pow(500, i / 23)); // 0.01 … 5

export default {
  id: 'seathru',
  name: 'Sea-thru（ULAP 深度）',
  short: 'Sea-thru',
  cite: 'Akkaynak & Treibitz, CVPR 2019',
  kind: '物理復原',
  params: [
    { key: 'far', label: '最遠距離（公尺）', min: 3, max: 25, step: 0.5, def: 10 },
    { key: 'near', label: '最近距離（公尺）', min: 0.2, max: 3, step: 0.1, def: 1 },
    { key: 'wb', label: '白平衡強度', min: 0, max: 1, step: 0.05, def: 1 },
  ],

  estimate(low, p) {
    const { w, h } = low, n = w * h;
    const [dLo, dHi] = depthRange(low);
    const D = refinedDepth(low, dLo, dHi);
    const z = new Float32Array(n);
    for (let i = 0; i < n; i++) z[i] = p.near + D[i] * (p.far - p.near);
    const lin = linearize(low); // 成像模型在線性光上成立（原論文用 RAW）；深度先驗仍用 sRGB

    // ---- 1. 背景散射點：每個深度段最暗 1% ----
    const bins = Array.from({ length: 10 }, () => []);
    for (let i = 0; i < n; i++) bins[Math.min(9, ((D[i] * 10) | 0))].push(i);
    const pts = [];
    for (const b of bins) {
      if (b.length < 5) continue;
      b.sort((i, j) => lin.c[0][i] + lin.c[1][i] + lin.c[2][i] - (lin.c[0][j] + lin.c[1][j] + lin.c[2][j]));
      const k = Math.min(20, Math.max(1, Math.ceil(b.length * 0.01))); // 參考碼：每段最多 20 點
      for (let t = 0; t < k; t++) pts.push(b[t]);
    }
    const bs = [0, 1, 2].map((c) => fitBackscatter(pts.map((i) => z[i]), pts.map((i) => lin.c[c][i])));
    // 散射不可能比該深度最暗的像素還亮：每段取各通道第 1 百分位當上限（防止深度先驗不準時扣過頭）
    const cap = [0, 1, 2].map((c) => {
      const t = bins.map((b) => (b.length < 5 ? NaN : C.percentiles(Float32Array.from(b, (i) => lin.c[c][i]), [0.01])[0]));
      return fillTable(t);
    });

    // ---- 2+3. 直射訊號與光源 → β_D(z) 分段表 ----
    const zg = D; // 引導：相對深度
    const r = Math.max(3, Math.round(Math.max(w, h) / 8));
    const bD = [];
    for (let c = 0; c < 3; c++) {
      const Dc = new Float32Array(n);
      for (let i = 0; i < n; i++) Dc[i] = Math.max(0, lin.c[c][i] - bsCapped(bs[c], cap[c], z[i], D[i]));
      const a = C.guidedFilter(zg, Dc, w, h, r, 1e-3);
      const per = Array.from({ length: NB }, () => []);
      for (let i = 0; i < n; i++) {
        const E = Math.max(2 * a[i], 1e-3);
        const beta = Math.min(5, Math.max(0, -Math.log(Math.min(E, 1)) / z[i]));
        per[Math.min(NB - 1, ((D[i] * NB) | 0))].push(beta);
      }
      bD.push(smoothTable(per));
    }
    const g = { dLo, dHi, bs, cap, bD, gain: [1, 1, 1], lo: 0, hi: 1 };
    // ---- 4. 白平衡增益與拉伸範圍（在低解析度上跑一次） ----
    const J = recover(lin, g, p, D);
    const top = [1, 2].map((c) => {
      const [q] = C.percentiles(J.c[c], [0.9], 0, 6);
      let s = 0, k = 0;
      for (const v of J.c[c]) if (v >= q) { s += v; k++; }
      return 1 / Math.max(s / Math.max(k, 1), 0.02);
    });
    const dg = (2 * top[0]) / (top[0] + top[1]), db = (2 * top[1]) / (top[0] + top[1]);
    g.gain = [(dg + db) / 2, dg, db].map((v) => Math.min(2, Math.max(0.5, v)));
    for (let c = 0; c < 3; c++) for (let i = 0; i < n; i++) J.c[c][i] *= 1 + (g.gain[c] - 1) * p.wb;
    const all = new Float32Array(3 * n);
    all.set(J.c[0]); all.set(J.c[1], n); all.set(J.c[2], 2 * n);
    [g.lo, g.hi] = C.percentiles(all, [0.002, 0.995], 0, 6);
    g.hi = Math.max(g.hi, g.lo + 0.1);
    return g;
  },

  apply(img, g, p) {
    const D = refinedDepth(img, g.dLo, g.dHi);
    const J = recover(linearize(img), g, p, D);
    const s = 1 / (g.hi - g.lo);
    for (let c = 0; c < 3; c++) {
      const k = 1 + (g.gain[c] - 1) * p.wb, q = J.c[c];
      for (let i = 0; i < q.length; i++) q[i] = C.toSRGB((q[i] * k - g.lo) * s);
    }
    return J;
  },
};

function recover(img, g, p, D) {
  const n = img.w * img.h, out = C.create(img.w, img.h);
  const G = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const z = p.near + D[i] * (p.far - p.near);
    const f = D[i] * (NB - 1), k = Math.min(NB - 2, f | 0), t = f - k;
    for (let c = 0; c < 3; c++) {
      const tab = g.bD[c];
      G[c] = Math.exp((tab[k] + (tab[k + 1] - tab[k]) * t) * z);
    }
    // 增益限制：整體亮度增益（以 G、B 較小者計）≤ MAX_GAIN，通道間比例 ≤ MAX_RATIO，
    // 以免暗部雜訊被放大成色塊（ULAP 深度不是真實距離，β 的絕對值不可靠，比例較可靠）
    const base = Math.min(G[1], G[2]), sc = base > MAX_GAIN ? MAX_GAIN / base : 1;
    // 有效度：最遠的一段（開放水域，原論文中沒有深度的像素）漸變回原像素
    const u = (D[i] - 0.8) / 0.2, v = u <= 0 ? 1 : u >= 1 ? 0 : 1 - u * u * (3 - 2 * u);
    for (let c = 0; c < 3; c++) {
      const gain = Math.min(G[c], base * MAX_RATIO) * sc;
      const s = img.c[c][i];
      const J = Math.max(0, s - bsCapped(g.bs[c], g.cap[c], z, D[i])) * gain;
      out.c[c][i] = s + (J - s) * v;
    }
  }
  return out;
}

const MAX_RATIO = 5;
const MAX_GAIN = 4;
const backscatter = (b, z) => b[0] * (1 - Math.exp(-b[1] * z));
function bsCapped(b, cap, z, d) {
  const f = d * 9, k = Math.min(8, f | 0), t = f - k;
  return Math.min(backscatter(b, z), cap[k] + (cap[k + 1] - cap[k]) * t);
}
function linearize(img) {
  return { w: img.w, h: img.h, c: img.c.map((p) => p.map(C.toLinear)) };
}

/** 擬合 B(z) = B∞(1 − e^{−βB z}) + J′e^{−βD′ z}；B∞、J′ ∈ [0,1]。回傳 [B∞, βB, J′, βD′]。 */
function fitBackscatter(zs, ys) {
  if (zs.length < 2) return [ys.length ? ys[0] : 0, 1, 0, 1];
  let best = [0, 1, 0, 1], bestErr = Infinity;
  const n = zs.length;
  const u = new Float64Array(n), v = new Float64Array(n);
  for (const bB of GRID) {
    for (let i = 0; i < n; i++) u[i] = 1 - Math.exp(-bB * zs[i]);
    for (const bD of GRID) {
      let uu = 0, vv = 0, uv = 0, uy = 0, vy = 0;
      for (let i = 0; i < n; i++) {
        v[i] = Math.exp(-bD * zs[i]);
        uu += u[i] * u[i]; vv += v[i] * v[i]; uv += u[i] * v[i]; uy += u[i] * ys[i]; vy += v[i] * ys[i];
      }
      const cands = [];
      const det = uu * vv - uv * uv;
      if (Math.abs(det) > 1e-12) cands.push([(uy * vv - vy * uv) / det, (vy * uu - uy * uv) / det]);
      cands.push([uy / Math.max(uu, 1e-12), 0], [0, vy / Math.max(vv, 1e-12)]);
      for (let [a, b] of cands) {
        a = Math.min(1, Math.max(0, a));
        b = Math.min(1, Math.max(0, b));
        let e = 0;
        for (let i = 0; i < n; i++) e += (a * u[i] + b * v[i] - ys[i]) ** 2;
        if (e < bestErr) { bestErr = e; best = [a, bB, b, bD]; }
      }
    }
  }
  return best;
}

/** 每段取中位數，空段內插，再做 [1 2 1] 平滑。 */
function smoothTable(per) {
  const t = per.map((a) => {
    if (a.length < 3) return NaN;
    a.sort((x, y) => x - y);
    return a[a.length >> 1];
  });
  fillTable(t);
  return t.map((v, i) => (t[Math.max(0, i - 1)] + 2 * v + t[Math.min(NB - 1, i + 1)]) / 4);
}

/** 空格（NaN）以相鄰有值的格線性內插 / 外推（就地修改並回傳） */
function fillTable(t) {
  const known = t.map((v, i) => (Number.isNaN(v) ? -1 : i)).filter((i) => i >= 0);
  if (!known.length) return t.fill(0);
  for (let i = 0; i < t.length; i++) {
    if (!Number.isNaN(t[i])) continue;
    const lo = known.filter((k) => k < i).pop(), hi = known.find((k) => k > i);
    t[i] = lo === undefined ? t[hi] : hi === undefined ? t[lo] : t[lo] + ((t[hi] - t[lo]) * (i - lo)) / (hi - lo);
  }
  return t;
}
