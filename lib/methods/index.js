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

mlle.discrete = ['order'];

/**
 * 同一組影片（UVE-38K 5 段成對影片、240 格）上的 PSNR / SSIM，見 docs/results-video.md。
 * App 的方法清單與「方法與出處」依 PSNR 由高到低排序（同分看 SSIM）。
 */
export const SCORES = {
  waternet: [20.05, 0.612], fiveaplus: [19.96, 0.618], uiec2net: [19.79, 0.616], nu2net: [19.69, 0.616],
  diverout: [19.65, 0.589], uvenet: [18.75, 0.591], rghs: [18.30, 0.547], funie: [17.93, 0.576],
  uwcnn: [17.80, 0.575], mlle: [17.56, 0.511], ancuti: [16.24, 0.578], seathru: [14.80, 0.469],
  ulap: [13.44, 0.500], ibla: [13.32, 0.426], udcp: [11.01, 0.367],
};
/** 未處理的原片在同一組影片上的分數（低於這個 = 比不處理還離參考遠） */
export const RAW_SCORE = [16.84, 0.575];

export const METHODS = [ancuti, mlle, ulap, udcp, rghs, seathru, ibla, funie, nu2net, uiec2net, uwcnn, fiveaplus, waternet, uvenet, diverout]
  .sort((a, b) => SCORES[b.id][0] - SCORES[a.id][0] || SCORES[b.id][1] - SCORES[a.id][1]);
export const byId = Object.fromEntries(METHODS.map((m) => [m.id, m]));

export function defaults(m) {
  return Object.fromEntries(m.params.map((p) => [p.key, p.def]));
}
