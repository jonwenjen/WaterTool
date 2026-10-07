// 關鍵幀：整支片每隔 T 秒估計一次全域參數，中間幀線性內插（Diverout_sim 與深度模型的快速匯出共用）。
// 參數 g 可以是數字、陣列、Float32Array 或物件（逐欄位內插）；形狀不同或非數值時取較近的一端。

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

/** 只在保留的區段 [[a, b], …] 內排關鍵幀（每段頭尾都有一個）：時間裁切後不必替刪掉的部分跑模型 */
export function keyframeTimesIn(segs, interval) {
  const out = [];
  for (const [a, b] of segs) for (const t of keyframeTimes(b - a, interval)) out.push(+(a + t).toFixed(6));
  return [...new Set(out)].sort((x, y) => x - y);
}

/** x + a·(y − x)，遞迴處理陣列與物件 */
export function lerpG(x, y, a) {
  if (typeof x === 'number' && typeof y === 'number') return x + a * (y - x);
  if (ArrayBuffer.isView(x) && ArrayBuffer.isView(y) && x.length === y.length) {
    const o = new x.constructor(x.length);
    for (let i = 0; i < x.length; i++) o[i] = x[i] + a * (y[i] - x[i]);
    return o;
  }
  if (Array.isArray(x) && Array.isArray(y) && x.length === y.length) return x.map((v, i) => lerpG(v, y[i], a));
  if (x && y && typeof x === 'object' && typeof y === 'object' && !Array.isArray(x)) {
    const o = {};
    for (const k of Object.keys(x)) o[k] = k in y ? lerpG(x[k], y[k], a) : x[k];
    return o;
  }
  return a < 0.5 ? x : y;
}

/** 依時間在關鍵幀之間線性內插（keys：[{ t, g }]，依 t 排序） */
export function interpKeys(keys, t) {
  if (!keys.length) return null;
  if (t <= keys[0].t) return keys[0].g;
  const last = keys[keys.length - 1];
  if (t >= last.t) return last.g;
  let j = 1;
  while (keys[j].t < t) j++;
  const A = keys[j - 1], B = keys[j];
  return lerpG(A.g, B.g, (t - A.t) / (B.t - A.t || 1));
}

/**
 * 兩組局部仿射係數 g = { nw, nh, a[3], b[3] } 的差異：輸入 0.4 時輸出相差多少（[0,1]，取最大的通道的平均值）。
 * 形狀不同時回傳 Infinity。
 */
export function gDist(x, y) {
  if (!x || !y || !x.a || !y.a || x.nw !== y.nw || x.nh !== y.nh) return Infinity;
  let worst = 0;
  for (let c = 0; c < 3; c++) {
    const A = x.a[c], B = x.b[c], A2 = y.a[c], B2 = y.b[c], n = A.length;
    let s = 0;
    for (let i = 0; i < n; i++) s += Math.abs((A[i] - A2[i]) * 0.4 + (B[i] - B2[i]));
    worst = Math.max(worst, s / n);
  }
  return worst;
}

/**
 * 關鍵幀自動加密：相鄰兩個關鍵幀的轉換差很多（gDist > thr）時，在中間再算一個；
 * 中間那個 ≈ 兩端的線性內插就停（漸變），否則繼續往差異大的一半細分，直到相鄰兩格。
 * thr 是最低門檻，實際門檻 = max(thr, 相鄰關鍵幀差異中位數 × 3)。
 * 用途：相機剛開錄時自動白平衡／曝光還沒穩定的幾格、場景切換 —— 不加密的話，那一格的強烈校正
 * 會被內插帶到後面 0.5 秒的正常畫面（例：開頭閃紅光）。
 * estimate(times) → 與 times 對應的 [{ t: 實際幀時間, g } | null]（批次，方便依序解碼）。
 * segs：時間裁切保留的區段，不跨區段細分。budget：最多加幾個關鍵幀。
 */
export async function refineKeys(keys, estimate, { thr: thrMin = 0.02, budget = 16, segs = null, minGap = 0.01, stale = () => false } = {}) {
  const out = [...keys].sort((p, q) => p.t - q.t);
  // 門檻隨方法調整：有些方法相鄰關鍵幀本來就會小幅波動，只細分明顯大於平常波動（中位數的 3 倍）的地方
  const ds = out.slice(1).map((k, i) => gDist(out[i].g, k.g)).filter(Number.isFinite).sort((p, q) => p - q);
  const thr = Math.max(thrMin, 3 * (ds[Math.floor(ds.length / 2)] || 0));
  const seg = (t) => (segs ? segs.findIndex(([a, b]) => t >= a - 0.06 && t <= b + 0.06) : 0); // 關鍵幀用實際幀時間，可能比區段頭早不到一格
  const need = (A, B) => B.t - A.t > minGap && seg(A.t) === seg(B.t) && gDist(A.g, B.g) > thr;
  let todo = [];
  for (let i = 1; i < out.length; i++) if (need(out[i - 1], out[i])) todo.push([out[i - 1], out[i]]);
  let added = 0;
  while (todo.length && added < budget && !stale()) {
    // 差異最大的先細分（預算不夠時優先處理明顯的閃爍）
    todo.sort((p, q) => gDist(q[0].g, q[1].g) - gDist(p[0].g, p[1].g));
    todo = todo.slice(0, Math.max(1, Math.ceil((budget - added) / 2))); // 留預算給下一輪往更細處追
    const got = await estimate(todo.map(([A, B]) => (A.t + B.t) / 2));
    if (stale()) break;
    const next = [];
    todo.forEach(([A, B], k) => {
      const m = got[k];
      if (!m || m.t <= A.t + 1e-6 || m.t >= B.t - 1e-6) return; // 已經是相鄰兩格
      out.push(m);
      added++;
      if (gDist(m.g, lerpG(A.g, B.g, (m.t - A.t) / (B.t - A.t))) < thr / 2) return; // 線性漸變：內插就夠
      if (need(A, m)) next.push([A, m]);
      if (need(m, B)) next.push([m, B]);
    });
    todo = next;
  }
  return out.sort((p, q) => p.t - q.t);
}
