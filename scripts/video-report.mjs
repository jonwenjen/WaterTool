// 把 bench-video.mjs 的 JSON（可多個，平行跑的分段結果）合併成 Markdown 表格。
//   node scripts/video-report.mjs a.json b.json … > docs/results-video.md
import { readFileSync } from 'node:fs';
import { METHODS } from '../lib/methods/index.js';

const all = {};
for (const f of process.argv.slice(2)) Object.assign(all, JSON.parse(readFileSync(f, 'utf8')));
const ref = all.reference;
const clips = Object.keys(ref);
const name = (id) => (id === 'input' ? '（未處理）' : METHODS.find((m) => m.id === id)?.name || id);
const ids = ['input', ...METHODS.map((m) => m.id)].filter((id) => all[id]);
const avg = (id, k) => {
  let s = 0, n = 0;
  for (const c of clips) { const r = all[id][c]; if (!r) continue; s += r[k] * r.frames; n += r.frames; }
  return s / n;
};
const rows = ids.map((id) => ({ id, psnr: avg(id, 'psnr'), ssim: avg(id, 'ssim'), et: avg(id, 'etemp'), fl: avg(id, 'flicker'), ms: avg(id, 'ms') }));
rows.sort((a, b) => b.psnr - a.psnr);
const f = (v, d = 2) => v.toFixed(d);
const frames = clips.reduce((s, c) => s + ref[c].frames, 0);
const out = [];
out.push('# 影片評測（UVE-38K 成對影片）\n');
out.push(`由 \`node scripts/bench-video.mjs\` 與 \`scripts/video-report.mjs\` 產生。資料：[UVE-38K](https://github.com/TrentQiQ/UVE-38K)（Multimedia Tools and Applications 2023）倉庫附的 ${clips.length} 段真實水下影片與逐格參考影片（${clips.join('、')}），每段取前 ${frames / clips.length} 格，共 ${frames} 格，320 px。`);
out.push('參考影片是從 12 種增強方法中人工挑選、再做過幀間一致化的結果（不是真值）；GIF 為 256 色，原始與參考都經過同樣量化，分數適合方法間互相比較。\n');
out.push('每個方法都以 App 預設的影片模式處理（時間穩定化開：τ 0.5 秒、去閃爍 0.7、每格重新估計）；Diverout_sim 用它自己的關鍵幀（每 1 秒）＋線性內插。');
out.push('E_t = 平均 |(O_t − O_{t−1}) − (R_t − R_{t−1})|（0–255）：輸出影片的格間變化和參考影片差多少，越低越好；亮度閃爍 = 相鄰格平均亮度差（參考影片本身為 ' + f(clips.reduce((s, c) => s + ref[c].flicker * ref[c].frames, 0) / frames) + '）。\n');
out.push('| 排名 | 方法 | PSNR ↑ | SSIM ↑ | E_t ↓ | 亮度閃爍 | 每格 ms |');
out.push('|---|---|---|---|---|---|---|');
let rank = 0;
for (const r of rows) {
  const isIn = r.id === 'input';
  out.push(`| ${isIn ? '—' : ++rank} | ${name(r.id)} | ${f(r.psnr)} | ${f(r.ssim, 3)} | ${f(r.et)} | ${f(r.fl)} | ${isIn ? '—' : f(r.ms, 0)} |`);
}
out.push('\n### 各段 PSNR\n');
out.push('| 方法 | ' + clips.join(' | ') + ' |');
out.push('|---|' + clips.map(() => '---').join('|') + '|');
for (const r of rows) out.push(`| ${name(r.id)} | ${clips.map((c) => (all[r.id][c] ? f(all[r.id][c].psnr) : '—')).join(' | ')} |`);
process.stdout.write(out.join('\n') + '\n');
