// 組合方法：深度模型 ＋ Diverout_sim 各取一半（out = (1 − s)·深度模型 + s·Diverout_sim，s 預設 0.5）。
// 兩者互補：Diverout_sim 是整支片關鍵幀的全域色階（整體顏色最接近參考、LPIPS/FID 最好），深度模型是局部色彩轉換
// （PSNR/SSIM 最好）。UVE-38K 上平均後四項分數都比任一單獨方法好，見 docs/results-video.md「組合方法」。
//
// 管線（lib/pipeline.js 的 runBlend）：深度模型照常處理（含時間平滑）；Diverout_sim 影片用整支片的關鍵幀
// （呼叫端給 opts.g，同單獨的 Diverout_sim），照片與全部比較就在這一格估計。
// 播放與快速匯出在 GPU 上兩條路一起算：深度模型的局部係數 ＋ Diverout_sim 的 3×4 矩陣，依比例 s 混合。
import diverout from './diverout.js';
import { fiveaplus, uiec2net, nu2net } from './uieb-nets.js';
import fgdpa from './fgdpa.js';

/** a：深度模型（netMethod），短名 short 用在畫面標籤 */
export function blendMethod(a, { id, name, short }) {
  return {
    id,
    name,
    short,
    cite: `${a.cite} ＋ Diverout_sim`,
    kind: `組合：${a.short} 與 Diverout_sim 各一半`,
    blend: { a, b: diverout },
    needsModel: true,
    model: a.model,
    wantsFull: true,
    keyframes: true, // Diverout_sim 的部分用整支片的關鍵幀（App 的關鍵幀分析只估 Diverout_sim 的參數）
    params: [
      { key: 'share', label: 'Diverout_sim 比例', min: 0, max: 1, step: 0.05, def: 0.5 },
      diverout.params.find((p) => p.key === 'interval'),
    ],
    /** 關鍵幀分析用：只估 Diverout_sim 的參數 */
    estimate(img, p) {
      return diverout.estimate(img, { profile: 0, interval: p.interval });
    },
  };
}

export const mixFiveaplus = blendMethod(fiveaplus, { id: 'mix_fiveaplus', name: 'Five A⁺ ＋ Diverout_sim（各半）', short: 'Five A⁺＋Diverout' });
export const mixUiec2net = blendMethod(uiec2net, { id: 'mix_uiec2net', name: 'UIEC²-Net ＋ Diverout_sim（各半）', short: 'UIEC²＋Diverout' });
export const mixNu2net = blendMethod(nu2net, { id: 'mix_nu2net', name: 'NU²-Net ＋ Diverout_sim（各半）', short: 'NU²＋Diverout' });
export const mixFgdpa = blendMethod(fgdpa, { id: 'mix_fgdpa', name: 'FGDPA ＋ Diverout_sim（各半）', short: 'FGDPA＋Diverout' });
/** 評測過的候選（App 清單用其中三個，見 index.js） */
export const BLEND_CANDIDATES = [mixFiveaplus, mixUiec2net, mixNu2net, mixFgdpa];
