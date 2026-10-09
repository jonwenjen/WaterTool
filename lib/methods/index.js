import ancuti from './ancuti.js';
import mlle from './mlle.js';
import ulap from './ulap.js';
import udcp from './udcp.js';
import rghs from './rghs.js';
import seathru from './seathru.js';
import ibla from './ibla.js';
import funie from './funie.js';
import { uwcnn, fiveaplus, uiec2net, nu2net } from './uieb-nets.js';
import { waternet, uvenet } from './waternet.js';
import diverout from './diverout.js';
import fgdpa from './fgdpa.js';

mlle.discrete = ['order'];

/**
 * 同一組影片（UVE-38K 5 段成對影片、240 格）上的 [PSNR, SSIM, LPIPS, FID]，見 docs/results-video.md。
 * App 的方法清單與「方法與出處」依 PSNR 由高到低排序（同分看 SSIM）。
 */
export const SCORES = {
  waternet: [20.05, 0.612, 0.252, 69.5], fiveaplus: [19.96, 0.618, 0.262, 77.5], uiec2net: [19.79, 0.616, 0.251, 71.3],
  nu2net: [19.69, 0.616, 0.255, 74.5], diverout: [19.65, 0.589, 0.223, 59.2], fgdpa: [19.39, 0.612, 0.281, 73.6], uvenet: [18.75, 0.591, 0.316, 77.9],
  rghs: [18.30, 0.547, 0.272, 62.6], funie: [17.93, 0.576, 0.355, 91.2], uwcnn: [17.80, 0.575, 0.391, 119.3],
  mlle: [17.56, 0.511, 0.447, 128.2], ancuti: [16.24, 0.578, 0.280, 98.7], seathru: [14.80, 0.469, 0.410, 139.3],
  ulap: [13.44, 0.500, 0.411, 107.8], ibla: [13.32, 0.426, 0.374, 86.1], udcp: [11.01, 0.367, 0.452, 93.7],
};
/** 未處理的原片在同一組影片上的分數（低於這個 = 比不處理還離參考遠） */
export const RAW_SCORE = [16.84, 0.575, 0.361, 78.5];

export const METHODS = [ancuti, mlle, ulap, udcp, rghs, seathru, ibla, funie, nu2net, uiec2net, uwcnn, fiveaplus, waternet, uvenet, diverout, fgdpa]
  .sort((a, b) => SCORES[b.id][0] - SCORES[a.id][0] || SCORES[b.id][1] - SCORES[a.id][1]);
export const byId = Object.fromEntries(METHODS.map((m) => [m.id, m]));
/** 評測用：把不在 App 清單裡的方法（例：mobile-nets.js 的候選模型）登記到 byId，讓 Processor 找得到 */
export function register(...ms) {
  for (const m of ms) byId[m.id] = m;
}

export function defaults(m) {
  return Object.fromEntries(m.params.map((p) => [p.key, p.def]));
}
