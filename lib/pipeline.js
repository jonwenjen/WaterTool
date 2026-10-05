// 單幀處理管線：估計（低解析度）→ 時間平滑 → 套用（處理解析度）→ 去閃爍 → 混合強度。
import * as C from './core.js';
import { byId, defaults } from './methods/index.js';
import { Stabilizer } from './temporal.js';

export const ESTIMATE_EDGE = 320;

export class Processor {
  constructor(ctx = {}) {
    this.ctx = ctx; // { runNet } 給 FUnIE-GAN
    this.stab = new Stabilizer();
    this.key = '';
    this.frame = 0;
    this.lastG = null;
  }

  reset() {
    this.stab.reset();
    this.frame = 0;
    this.lastG = null;
  }

  /**
   * opts: {
   *   method, params,
   *   video: { dt (秒), tau (秒, 0=關), deflicker (0..1), every (每 N 幀重新估計) } | null,
   *   mix (0..1, 與原片混合), post (0..1, 共用自動色階)
   * }
   */
  async run(img, opts) {
    const m = byId[opts.method];
    if (!m) throw new Error('未知方法 ' + opts.method);
    const params = { ...defaults(m), ...(opts.params || {}) };
    const key = m.id + JSON.stringify(params);
    if (key !== this.key) {
      this.key = key;
      this.reset();
    }
    const v = opts.video;
    const t0 = now();
    const sig = Stabilizer.signature(img);
    let g, cut = true, dist = 0, est = false;
    const every = v ? Math.max(1, v.every || 1) : 1;
    const quickCut = this.stab.sig ? Stabilizer.distance(sig, this.stab.sig) > 0.5 : true;
    if (!this.lastG || !v || this.frame % every === 0 || quickCut) {
      const low = m.wantsFull ? img : C.resize(img, ...C.fitSize(img.w, img.h, ESTIMATE_EDGE));
      g = await m.estimate(low, params, this.ctx);
      est = true;
      if (v) ({ g, cut, dist } = this.stab.smooth(g, sig, v.dt * (est ? every : 1), v.tau, m.discrete));
      this.lastG = g;
    } else {
      g = this.lastG;
      this.stab.sig = sig;
      cut = false;
    }
    const t1 = now();
    let out = m.apply(img, g, params);
    if (v && v.deflicker > 0) this.stab.deflicker(img, out, v.deflicker);
    if (opts.post > 0) C.autoLevels(out, 0.002, 0.998, opts.post);
    const mix = opts.mix ?? 1;
    if (mix < 1) {
      for (let c = 0; c < 3; c++) {
        const s = img.c[c], d = out.c[c];
        for (let i = 0; i < d.length; i++) d[i] = s[i] + (d[i] - s[i]) * mix;
      }
    }
    this.frame++;
    return { out, g, cut, dist, estimated: est, ms: { estimate: t1 - t0, apply: now() - t1 } };
  }
}

const now = () => (globalThis.performance ? performance.now() : Date.now());
