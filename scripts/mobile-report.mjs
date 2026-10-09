// 手機級新模型評測的 Markdown 段落：候選模型與 App 現有方法放在同一張表比較。
//   node scripts/mobile-report.mjs --video a.json b.json … --perc p1.json p2.json … --euvp-perc e.json --speed s.json
// （bench-video.mjs、tools/perceptual_eval.py、net-speed.mjs 的輸出；EUVP 的 PSNR/SSIM 由 --euvp 指定的 JSON 提供）
import { readFileSync } from 'node:fs';
import { METHODS, register } from '../lib/methods/index.js';
import { CANDIDATES } from '../lib/methods/mobile-nets.js';

register(...CANDIDATES);
const groups = {};
let key = null;
for (const a of process.argv.slice(2)) {
  if (a.startsWith('--')) { key = a.slice(2); groups[key] = []; } else groups[key].push(a);
}
const merge = (files = []) => Object.assign({}, ...files.map((f) => JSON.parse(readFileSync(f, 'utf8'))));
const video = merge(groups.video), perc = merge(groups.perc), eperc = merge(groups['euvp-perc']), speed = merge(groups.speed), euvp = merge(groups.euvp);
const ALL = [...METHODS, ...CANDIDATES], isNew = new Set(['fgdpa', ...CANDIDATES.map((m) => m.id)]); // FGDPA 已加入 App，仍標為這次評測的新模型
const name = (id) => (id === 'input' ? '（未處理）' : ALL.find((m) => m.id === id).name);
const clips = Object.keys(video.reference);
const avg = (id, k) => {
  let s = 0, n = 0;
  for (const c of clips) { const r = video[id]?.[c]; if (!r) continue; s += r[k] * r.frames; n += r.frames; }
  return s / n;
};
const f = (v, d = 2) => (v === undefined || Number.isNaN(v) ? '—' : v.toFixed(d));
const ids = ['input', ...ALL.map((m) => m.id)].filter((id) => video[id]);
const rows = ids.map((id) => ({ id, psnr: avg(id, 'psnr'), ssim: avg(id, 'ssim'), lpips: perc[id]?.lpips, fid: perc[id]?.fid, et: avg(id, 'etemp'), fl: avg(id, 'flicker') }))
  .sort((a, b) => b.psnr - a.psnr || b.ssim - a.ssim);
const out = [];
out.push('| 排名 | 方法 | PSNR ↑ | SSIM ↑ | LPIPS ↓ | FID ↓ | E_t ↓ | 亮度閃爍 |');
out.push('|---|---|---|---|---|---|---|---|');
let rank = 0;
for (const r of rows) {
  const nm = isNew.has(r.id) ? `**${name(r.id)}** 🆕` : name(r.id);
  out.push(`| ${r.id === 'input' ? '—' : ++rank} | ${nm} | ${f(r.psnr)} | ${f(r.ssim, 3)} | ${f(r.lpips, 3)} | ${f(r.fid, 1)} | ${f(r.et)} | ${f(r.fl)} |`);
}
out.push('\n#### 手機適用性（新模型與 App 現有的深度模型）\n');
out.push('推論時間 = onnxruntime-web WASM 單執行緒、只算網路本身（`scripts/net-speed.mjs`，這台機器上量的；手機瀏覽器同樣用 WASM，實際速度依手機而定）。');
out.push('「720p 原畫面」= 不縮小、直接把 1280×704（約 720p，FGDPA 要求邊長為 32 的倍數）整張丟進網路（只有可變尺寸的模型能這樣跑）。\n');
out.push('| 方法 | 參數量 | 模型檔 | 推論（App 用的尺寸） | 推論（720p 原畫面） | EUVP PSNR | EUVP LPIPS |');
out.push('|---|---|---|---|---|---|---|');
const params = { mobileie: '4,075', fgdpa: '4,234', liteenhancenet: '13,688', lu2net: '175,571', aquafastnet: '309,862', picuie: '9,486', fiveaplus: '9 千', uwcnn: '4 萬', uiec2net: '53 萬', nu2net: '315 萬', funie: '702 萬', waternet: '109 萬', uvenet: '53 萬' };
const NEW = ALL.filter((m) => isNew.has(m.id));
for (const m of [...NEW, ...METHODS.filter((x) => x.needsModel && !isNew.has(x.id))]) {
  const s = speed[m.id] || {};
  const nm = isNew.has(m.id) ? `**${m.short}** 🆕` : m.short;
  out.push(`| ${nm} | ${params[m.id] || '—'} | ${s.mb !== undefined ? (s.mb < 1 ? Math.round(s.mb * 1024) + ' KB' : s.mb.toFixed(1) + ' MB') : '—'} | ${s.ms !== undefined ? `${f(s.ms, 1)} ms（${s.size}）` : '—'} | ${s.ms720 !== undefined ? f(s.ms720, 0) + ' ms' : '—'} | ${euvp[m.id] ? f(euvp[m.id].psnr) : '—'} | ${eperc[m.id] ? f(eperc[m.id].lpips, 3) : '—'} |`);
}
process.stdout.write(out.join('\n') + '\n');
