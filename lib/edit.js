// 影片編輯（匯出用）：旋轉、裁切成社群常用比例、變速 0.25–4×、時間裁切（只保留區間 / 刪除區間）。
// 這裡只有純計算（可在 Node 測試）；畫布繪製在 drawEdited（瀏覽器）。

/** 裁切比例（寬:高）。null = 原始比例 */
export const ASPECTS = [
  ['orig', '原始比例', null],
  ['1:1', '1:1 正方形（IG 貼文）', 1],
  ['4:5', '4:5 直式（IG 貼文、FB）', 4 / 5],
  ['9:16', '9:16 直式（Reels、限動、TikTok、Shorts）', 9 / 16],
  ['16:9', '16:9 橫式（YouTube）', 16 / 9],
  ['1.91:1', '1.91:1 橫式（IG 橫式貼文）', 1.91],
  ['4:3', '4:3 橫式', 4 / 3],
  ['3:4', '3:4 直式', 3 / 4],
];
export const aspectValue = (key) => (ASPECTS.find((a) => a[0] === key) || ASPECTS[0])[2];

export const DEFAULT_EDIT = Object.freeze({ rot: 0, aspect: 'orig', panX: 0.5, panY: 0.5, speed: 1, audio: 'keep', trim: { mode: 'none', start: 0, end: 0 } });

/** 有沒有任何編輯（沒有就走原本的匯出流程） */
export function editActive(e) {
  return !!e && (e.rot % 360 !== 0 || e.aspect !== 'orig' || e.speed !== 1 || e.audio === 'drop' || (e.trim && e.trim.mode !== 'none'));
}

/**
 * 旋轉後的畫面（rw×rh）裡，指定比例的最大裁切框，依 panX / panY（0–1）決定位置。
 * w、h：來源畫面（顯示方向）的寬高；rot：0 / 90 / 180 / 270（順時針）。
 */
export function cropRect(w, h, rot = 0, aspect = 'orig', panX = 0.5, panY = 0.5) {
  const r = ((rot % 360) + 360) % 360, rw = r % 180 ? h : w, rh = r % 180 ? w : h;
  const a = aspectValue(aspect);
  let cw = rw, ch = rh;
  if (a) {
    if (rw / rh > a) cw = rh * a; // 太寬：裁左右
    else ch = rw / a; // 太高：裁上下
  }
  cw = Math.max(2, Math.round(cw));
  ch = Math.max(2, Math.round(ch));
  const x = Math.round((rw - cw) * Math.min(1, Math.max(0, panX)));
  const y = Math.round((rh - ch) * Math.min(1, Math.max(0, panY)));
  return { rot: r, rw, rh, x, y, cw, ch };
}

/** 時間裁切 → 要保留的區段 [[開始, 結束], …]（秒，來源時間） */
export function keepSegments(duration, trim) {
  const D = Math.max(0, duration);
  if (!trim || trim.mode === 'none') return [[0, D]];
  const a = Math.min(Math.max(0, Math.min(trim.start, trim.end)), D), b = Math.min(Math.max(0, Math.max(trim.start, trim.end)), D);
  if (trim.mode === 'keep') return b - a > 1e-3 ? [[a, b]] : [[0, D]];
  // cut：刪除 [a, b]，保留前後
  const segs = [];
  if (a > 1e-3) segs.push([0, a]);
  if (D - b > 1e-3) segs.push([b, D]);
  return segs.length ? segs : [[0, D]];
}

/** 輸出片長（秒） */
export const outDuration = (segs, speed = 1) => segs.reduce((s, [a, b]) => s + (b - a), 0) / speed;

/** 來源時間 → 輸出時間；被刪掉的時間回傳 null */
export function mapTime(segs, speed, t) {
  let base = 0;
  for (const [a, b] of segs) {
    if (t >= a && t < b) return (base + (t - a)) / speed;
    base += b - a;
  }
  return null;
}

/** 某個來源時間之後（含）第一個保留的時間；之後都沒有則回傳 null（預覽播放用） */
export function nextKept(segs, t) {
  for (const [a, b] of segs) {
    if (t < b - 1e-3) return Math.max(t, a);
  }
  return null;
}

/**
 * 串流式線性重取樣（聲音變速）：每輸出 1 個樣本前進 step 個輸入樣本（step = 速度）。
 * 音調會跟著變（2× 變高、0.5× 變低），與多數相機 App 的快轉／慢動作相同。分段呼叫 push 也連續無斷點。
 */
export class Resampler {
  constructor(channels, step) {
    this.ch = channels;
    this.step = step;
    this.pos = 0; // 下一個輸出樣本在「上一塊最後一個樣本 + 這一塊」裡的位置
    this.last = null; // 上一塊的最後一個樣本（每聲道）
  }

  /** planes：每聲道一個 Float32Array（長度相同）→ 輸出 planes */
  push(planes) {
    const n = planes[0].length;
    if (!n) return planes.map(() => new Float32Array(0));
    const prev = this.last, off = prev ? 1 : 0, total = n + off; // 輸入序列 = [prev?, ...planes]
    const at = (c, i) => (i < off ? prev[c] : planes[c][i - off]);
    const count = Math.max(0, Math.ceil((total - 1 - this.pos) / this.step));
    const out = planes.map(() => new Float32Array(count));
    let p = this.pos;
    for (let k = 0; k < count; k++, p += this.step) {
      const i = Math.floor(p), f = p - i;
      for (let c = 0; c < this.ch; c++) {
        const v0 = at(c, i), v1 = i + 1 < total ? at(c, i + 1) : v0;
        out[c][k] = v0 + (v1 - v0) * f;
      }
    }
    this.pos = p - (total - 1); // 以這一塊最後一個樣本為新的起點
    this.last = planes.map((pl) => pl[n - 1]);
    return out;
  }
}

/** 偶數尺寸（影片編碼器要求） */
export const even = (v) => Math.max(2, Math.round(v / 2) * 2);

/**
 * 把來源畫面（srcW×srcH，顯示方向）旋轉、裁切後畫到 ctx（outW×outH）。瀏覽器用。
 */
export function drawEdited(ctx, src, srcW, srcH, crop, outW, outH) {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, outW, outH);
  ctx.scale(outW / crop.cw, outH / crop.ch);
  ctx.translate(-crop.x, -crop.y);
  ctx.translate(crop.rw / 2, crop.rh / 2);
  ctx.rotate((crop.rot * Math.PI) / 180);
  ctx.drawImage(src, -srcW / 2, -srcH / 2, srcW, srcH);
  ctx.restore();
}
