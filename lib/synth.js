// 合成測試場景：已知真值的「水上」場景 + 物理水下退化，用於客觀評分與 App 內的示範影片。
// 退化模型（Akkaynak & Treibitz 2018 修正模型的簡化，線性光）：
//   I_c = J_c · E_c · e^{−β_c z} + B∞_c · (1 − e^{−β_c z}) + 雜訊
// E_c = e^{−K_c·d_surface} 為自水面下照光的衰減。
import * as C from './core.js';

export const WATERS = {
  blue: { name: '藍水 / 外海', beta: [0.42, 0.075, 0.05], Binf: [0.02, 0.22, 0.42], K: [0.35, 0.06, 0.04], surf: 6 },
  green: { name: '綠水 / 沿岸', beta: [0.45, 0.11, 0.28], Binf: [0.04, 0.32, 0.22], K: [0.4, 0.09, 0.2], surf: 4 },
  turbid: { name: '混濁', beta: [0.75, 0.38, 0.45], Binf: [0.12, 0.3, 0.26], K: [0.5, 0.2, 0.25], surf: 3 },
};

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

/** 合成真值場景（sRGB）與深度（公尺）。W×H 為完整畫布，影片會在上面平移裁切。 */
export function makeScene(W, H, seed = 7) {
  const R = rng(seed);
  const img = C.create(W, H), z = new Float32Array(W * H);
  const [r, g, b] = img.c;
  // 低頻雜訊紋理
  const tex = (() => {
    const gw = 24, gh = Math.ceil((24 * H) / W) + 1, grid = new Float32Array(gw * gh);
    for (let i = 0; i < grid.length; i++) grid[i] = R();
    return C.resizePlane(grid, gw, gh, W, H);
  })();
  const fine = new Float32Array(W * H);
  for (let i = 0; i < fine.length; i++) fine[i] = R();
  const fineB = C.gaussBlur(fine, W, H, 1.2);
  const horizon = 0.38 * H;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (y < horizon) {
      // 開放水域：遠處（真值為淺灰藍的「空」，退化後幾乎全是背景光）
      r[i] = 0.55; g[i] = 0.62; b[i] = 0.68;
      z[i] = 25;
    } else {
      // 海床：沙 + 岩石紋理，越下面越近
      const t = (y - horizon) / (H - horizon);
      const k = 0.65 + 0.35 * tex[i] + 0.25 * (fineB[i] - 0.5);
      r[i] = 0.78 * k; g[i] = 0.70 * k; b[i] = 0.55 * k;
      z[i] = 12 - 10 * Math.pow(t, 0.8);
    }
  }
  // 彩色物體（珊瑚、魚、色卡）
  const colors = [
    [0.85, 0.2, 0.18], [0.95, 0.55, 0.12], [0.95, 0.85, 0.2], [0.55, 0.25, 0.65],
    [0.2, 0.65, 0.35], [0.9, 0.45, 0.6], [0.95, 0.95, 0.92], [0.3, 0.3, 0.32], [0.2, 0.45, 0.8],
  ];
  const nObj = Math.round((W * H) / 9000);
  for (let o = 0; o < nObj; o++) {
    const cx = R() * W, cy = horizon + R() * (H - horizon), rad = (0.02 + 0.05 * R()) * Math.min(W, H);
    const col = colors[(R() * colors.length) | 0];
    const tt = (cy - horizon) / (H - horizon), zz = 12 - 10 * Math.pow(tt, 0.8) - 0.3;
    const sq = R() < 0.3;
    for (let y = Math.max(0, (cy - rad) | 0); y < Math.min(H, cy + rad); y++)
      for (let x = Math.max(0, (cx - rad) | 0); x < Math.min(W, cx + rad); x++) {
        const dx = x - cx, dy = y - cy;
        if (!sq && dx * dx + dy * dy > rad * rad) continue;
        const i = y * W + x, sh = 0.8 + 0.2 * fineB[i] + (sq ? 0 : -0.25 * (dy / rad));
        r[i] = col[0] * sh; g[i] = col[1] * sh; b[i] = col[2] * sh;
        z[i] = zz;
      }
  }
  // 色卡（近處，6 格）
  const cw = Math.round(W * 0.05), cy0 = Math.round(H * 0.82), cx0 = Math.round(W * 0.06);
  for (let k = 0; k < 6; k++) {
    const col = [[0.95, 0.95, 0.95], [0.5, 0.5, 0.5], [0.85, 0.15, 0.15], [0.15, 0.7, 0.2], [0.15, 0.25, 0.85], [0.95, 0.8, 0.1]][k];
    for (let y = cy0; y < Math.min(H, cy0 + cw); y++)
      for (let x = cx0 + k * cw; x < Math.min(W, cx0 + (k + 1) * cw - 2); x++) {
        const i = y * W + x;
        r[i] = col[0]; g[i] = col[1]; b[i] = col[2]; z[i] = 1.8;
      }
  }
  C.clampImg(img);
  return { img, z };
}

/** 依水質退化（輸入 sRGB 真值，輸出 sRGB 水下影像）。 */
export function degrade(scene, waterKey = 'blue', opts = {}) {
  const wt = WATERS[waterKey];
  const { img, z } = scene, n = img.w * img.h;
  const out = C.create(img.w, img.h);
  const R = rng(opts.seed || 3);
  const noise = opts.noise ?? 0.01, gain = opts.gain ?? 1;
  for (let c = 0; c < 3; c++) {
    const E = Math.exp(-wt.K[c] * wt.surf);
    for (let i = 0; i < n; i++) {
      const tr = Math.exp(-wt.beta[c] * z[i]);
      let v = C.toLinear(img.c[c][i]) * E * tr + wt.Binf[c] * (1 - tr);
      v = v * gain * 1.6 + (R() - 0.5) * 2 * noise * 0.3;
      out.c[c][i] = C.toSRGB(v);
    }
  }
  return out;
}

/** 從大畫布裁一幀（整數平移） */
export function crop(img, x0, y0, w, h) {
  const out = C.create(w, h);
  for (let c = 0; c < 3; c++)
    for (let y = 0; y < h; y++) out.c[c].set(img.c[c].subarray((y0 + y) * img.w + x0, (y0 + y) * img.w + x0 + w), y * w);
  return out;
}

/** 合成影片幀產生器：平移 + 每幀感光雜訊 + 輕微曝光抖動 */
export function* syntheticClip({ w = 320, h = 180, frames = 30, pan = 2, water = 'blue', jitter = 0.03, seed = 11 } = {}) {
  const W = w + pan * frames + 4, H = h;
  const scene = makeScene(W, H, seed);
  const R = rng(seed * 7);
  for (let f = 0; f < frames; f++) {
    const deg = degrade(scene, water, { seed: seed * 100 + f, noise: 0.012, gain: 1 + (R() - 0.5) * 2 * jitter });
    yield { frame: crop(deg, f * pan, 0, w, h), truth: crop(scene.img, f * pan, 0, w, h), shift: pan };
  }
}
