// 把 bench-video.mjs 的 JSON（可多個，平行跑的分段結果）合併成 Markdown 表格。
//   node scripts/video-report.mjs a.json b.json … [--perc perceptual.json] > docs/results-video.md
// --perc：tools/perceptual_eval.py 的結果（LPIPS、FID），加進表格。
// --ms：另一份 bench-video 結果，只取它的每格 ms（例如機器沒有其他工作時量的；平行跑很多評測時 ms 會偏高）。
import { readFileSync } from 'node:fs';
import { METHODS } from '../lib/methods/index.js';

const argv = process.argv.slice(2), take = (k) => { const i = argv.indexOf(k); return i >= 0 ? JSON.parse(readFileSync(argv.splice(i, 2)[1], 'utf8')) : null; };
const perc = take('--perc') || {}, msFrom = take('--ms');
const all = {};
// 多個 JSON（平行分段、或 --clips 補跑的結果）逐方法、逐段合併
for (const f of argv) for (const [id, r] of Object.entries(JSON.parse(readFileSync(f, 'utf8')))) all[id] = { ...all[id], ...r };
const ref = all.reference;
const clips = Object.keys(ref).sort();
const name = (id) => (id === 'input' ? '（未處理）' : METHODS.find((m) => m.id === id)?.name || id);
const ids = ['input', ...METHODS.map((m) => m.id)].filter((id) => all[id]);
const avg = (id, k, src = all) => {
  let s = 0, n = 0;
  for (const c of Object.keys(src[id] || {})) { const r = src[id][c]; if (!clips.includes(c) || r[k] === undefined) continue; s += r[k] * r.frames; n += r.frames; }
  return s / n;
};
const rows = ids.map((id) => ({ id, psnr: avg(id, 'psnr'), ssim: avg(id, 'ssim'), lpips: perc[id]?.lpips, fid: perc[id]?.fid, et: avg(id, 'etemp'), fl: avg(id, 'flicker'), ms: avg(id, 'ms', msFrom || all) }));
const hasP = rows.some((r) => r.lpips !== undefined);
const opt = (v, d) => (v === undefined ? '—' : v.toFixed(d));
rows.sort((a, b) => b.psnr - a.psnr || b.ssim - a.ssim);
const f = (v, d = 2) => v.toFixed(d);
const frames = clips.reduce((s, c) => s + ref[c].frames, 0);
const counts = clips.map((c) => ref[c].frames);
const clipFrames = counts.every((n) => n === counts[0]) ? `每段取前 ${counts[0]} 格` : `每段全部的格（${clips.map((c, i) => `${c} ${counts[i]}`).join('、')}）`;
const out = [];
out.push('# 影片評測（UVE-38K 成對影片）\n');
out.push(`由 \`node scripts/bench-video.mjs\` 與 \`scripts/video-report.mjs\` 產生。資料：[UVE-38K](https://github.com/TrentQiQ/UVE-38K)（Multimedia Tools and Applications 2023）倉庫附的 ${clips.length} 段真實水下影片與逐格參考影片（${clips.join('、')}），${clipFrames}，共 ${frames} 格，320 px。`);
out.push('參考影片是從 12 種增強方法中人工挑選、再做過幀間一致化的結果（不是真值）；GIF 為 256 色，原始與參考都經過同樣量化，分數適合方法間互相比較。\n');
out.push('每個方法都以 App 預設的影片模式處理（時間穩定化開：τ 0.5 秒、去閃爍 0.7、每格重新估計）；Diverout_sim 用它自己的關鍵幀（每 1 秒）＋線性內插。');
out.push('E_t = 平均 |(O_t − O_{t−1}) − (R_t − R_{t−1})|（0–255）：輸出影片的格間變化和參考影片差多少，越低越好；亮度閃爍 = 相鄰格平均亮度差（參考影片本身為 ' + f(clips.reduce((s, c) => s + ref[c].flicker * ref[c].frames, 0) / frames) + '）。\n');
if (hasP) {
  out.push('LPIPS（Zhang et al., CVPR 2018，AlexNet v0.1）= 每格與參考格的深度特徵感知距離，越低越像；FID（Heusel et al., NeurIPS 2017）= 全部 ' + frames + ' 格輸出與全部參考格的 InceptionV3 特徵分佈距離，越低整體觀感越接近參考。');
  out.push('FID 是「一組對一組」的分佈距離，' + frames + ' 格對 2048 維特徵屬於小樣本，數值會偏高、只適合方法間比較（不能和論文裡用上萬張圖算的 FID 直接比）。計算：`tools/perceptual_eval.py`。\n');
}
if (msFrom) out.push('每格 ms 是 Node 單執行緒 CPU、320 px 的整套處理時間，取自機器沒有其他工作時的另一次評測（這次 917 格的評測平行跑了很多工作，時間偏高）。\n');
out.push('| 排名 | 方法 | PSNR ↑ | SSIM ↑ |' + (hasP ? ' LPIPS ↓ | FID ↓ |' : '') + ' E_t ↓ | 亮度閃爍 | 每格 ms |');
out.push('|---|---|---|---|' + (hasP ? '---|---|' : '') + '---|---|---|');
let rank = 0;
for (const r of rows) {
  const isIn = r.id === 'input';
  out.push(`| ${isIn ? '—' : ++rank} | ${name(r.id)} | ${f(r.psnr)} | ${f(r.ssim, 3)} |${hasP ? ` ${opt(r.lpips, 3)} | ${opt(r.fid, 1)} |` : ''} ${f(r.et)} | ${f(r.fl)} | ${isIn || Number.isNaN(r.ms) ? '—' : f(r.ms, 0)} |`);
}
out.push('\n### 各段 PSNR\n');
out.push('| 方法 | ' + clips.join(' | ') + ' |');
out.push('|---|' + clips.map(() => '---').join('|') + '|');
for (const r of rows) out.push(`| ${name(r.id)} | ${clips.map((c) => (all[r.id][c] ? f(all[r.id][c].psnr) : '—')).join(' | ')} |`);
if (hasP) {
  out.push('\n### 各段 LPIPS ↓\n');
  out.push('| 方法 | ' + clips.join(' | ') + ' |');
  out.push('|---|' + clips.map(() => '---').join('|') + '|');
  for (const r of rows) out.push(`| ${name(r.id)} | ${clips.map((c) => opt(perc[r.id]?.clips?.[c]?.lpips, 3)).join(' | ')} |`);
}
process.stdout.write(out.join('\n') + '\n');
