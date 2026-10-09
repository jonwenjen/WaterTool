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
 * 同一組影片（UVE-38K 5 段成對影片、全部 917 格）上的 [PSNR, SSIM, LPIPS, FID]，見 docs/results-video.md。
 * App 的方法清單與「方法與出處」依 PSNR 由高到低排序（同分看 SSIM）。
 */
export const SCORES = {
  fiveaplus: [19.36, 0.627, 0.232, 47.5], uiec2net: [19.07, 0.622, 0.235, 45.5], waternet: [19.07, 0.614, 0.245, 45.5],
  nu2net: [19.06, 0.623, 0.233, 45.1], fgdpa: [18.95, 0.619, 0.254, 47.1], diverout: [18.63, 0.590, 0.226, 35.7],
  uvenet: [17.99, 0.595, 0.286, 52.2], uwcnn: [17.48, 0.580, 0.349, 77.0], rghs: [17.37, 0.558, 0.281, 42.3],
  funie: [17.29, 0.581, 0.325, 62.2], mlle: [17.20, 0.532, 0.424, 102.4], ancuti: [15.56, 0.586, 0.283, 74.1],
  ulap: [14.63, 0.529, 0.363, 69.9], seathru: [14.52, 0.466, 0.399, 87.0], ibla: [12.77, 0.409, 0.375, 58.3],
  udcp: [10.99, 0.387, 0.426, 66.4],
};
/** 未處理的原片在同一組影片上的分數（低於這個 = 比不處理還離參考遠） */
export const RAW_SCORE = [16.88, 0.585, 0.319, 48.2];

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
