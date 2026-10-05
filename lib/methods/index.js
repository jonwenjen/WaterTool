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

mlle.discrete = ['order'];

export const METHODS = [ancuti, mlle, ulap, udcp, rghs, seathru, ibla, funie, nu2net, uiec2net, uwcnn, fiveaplus, waternet, uvenet];
export const byId = Object.fromEntries(METHODS.map((m) => [m.id, m]));

export function defaults(m) {
  return Object.fromEntries(m.params.map((p) => [p.key, p.def]));
}
