// 評測用：5 個適合手機即時執行的新一代水下增強模型（2024–2026），尚未加入 App 的方法清單。
// ONNX 由 scripts/export_mobile_onnx.py 從原作倉庫的權重轉出，放在 models/eval/（不進 git：LU2Net、LiteEnhanceNet 的倉庫沒有授權聲明）。
// 推論尺寸照各模型原作的測試方式：全解析度的模型（MobileIE、FGDPA、AquaFastNet）這裡保持長寬比、長邊 256；
// 原作壓成 256×256 測試的（LU2Net、LiteEnhanceNet）同樣壓成 256×256。後處理已包含在 ONNX 裡，輸出在 [0,1]。
// 之後與其他深度模型一樣，由 net.js 擬合成局部色彩轉換套回原解析度。
import { netMethod } from './net.js';

const aspect = { input: '01', output: 'clip', size: 'aspect', edge: 256, multiple: 32 };
const square = { input: '01', output: 'clip', size: 'square256' };

export const mobileie = netMethod({
  ...aspect, id: 'mobileie', name: 'MobileIE（手機即時影像增強）', short: 'MobileIE',
  cite: 'Yan et al., ICCV 2025', kind: '深度學習（4 千參數，重參數化 CNN）',
  model: { file: 'models/eval/mobileie.onnx', mb: 0.02 },
});
export const fgdpa = netMethod({
  ...aspect, id: 'fgdpa', name: 'FGDPA 頻域引導雙路注意力', short: 'FGDPA',
  cite: 'Zhang et al., ICME 2026', kind: '深度學習（4 千參數，頻域注意力）',
  model: { file: 'models/eval/fgdpa.onnx', mb: 0.03 },
});
export const lu2net = netMethod({
  ...square, id: 'lu2net', name: 'LU2Net 輕量 U-Net', short: 'LU2Net',
  cite: 'Yang et al., arXiv 2024', kind: '深度學習（18 萬參數，軸向深度卷積 U-Net）',
  model: { file: 'models/eval/lu2net.onnx', mb: 0.7 },
});
export const liteenhancenet = netMethod({
  ...square, id: 'liteenhancenet', name: 'LiteEnhanceNet 深度可分離卷積', short: 'LiteEnhanceNet',
  cite: 'Zhang et al., Expert Syst. Appl. 2024', kind: '深度學習（1.4 萬參數）',
  model: { file: 'models/eval/liteenhancenet.onnx', mb: 0.07 },
});
export const aquafastnet = netMethod({
  ...aspect, id: 'aquafastnet', name: 'AquaFastNet 輕量 U-Net＋SE', short: 'AquaFastNet',
  cite: 'Hasib et al., 2026（修訂稿）', kind: '深度學習（31 萬參數）',
  model: { file: 'models/eval/aquafastnet.onnx', mb: 1.2 },
});

export const CANDIDATES = [mobileie, fgdpa, lu2net, liteenhancenet, aquafastnet];
