import ancuti from './ancuti.js';
import mlle from './mlle.js';
import ulap from './ulap.js';
import udcp from './udcp.js';
import rghs from './rghs.js';
import seathru from './seathru.js';
import funie from './funie.js';

mlle.discrete = ['order'];

export const METHODS = [ancuti, mlle, ulap, udcp, rghs, seathru, funie];
export const byId = Object.fromEntries(METHODS.map((m) => [m.id, m]));

export function defaults(m) {
  return Object.fromEntries(m.params.map((p) => [p.key, p.def]));
}
