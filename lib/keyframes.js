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
