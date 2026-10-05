// 方法：4 個在 UIEB 資料集訓練的深度模型
// 權重：ddz16/UIE_Benckmark（MIT，Du et al., "UIEDP", Expert Systems with Applications 2025 的基準實驗）
//       github.com/ddz16/UIE_Benckmark/tree/main/checkpoints/UIEB
// 由 scripts/export_uieb_onnx.py 轉成 ONNX（固定 1×3×256×256、輸入 [0,1]；與 PyTorch 輸出差 ≤ 3e-3）。
// 推論流程與該倉庫的 test_UIEB.py 相同：壓成 256×256 → 網路 → normalize_img；
// 再由 net.js 擬合成局部色彩轉換，套回原解析度與長寬比。
import { netMethod } from './net.js';

const common = { input: '01', output: 'norm', size: 'square256' };

export const uwcnn = netMethod({
  ...common,
  id: 'uwcnn',
  name: 'UWCNN 水下場景先驗 CNN',
  short: 'UWCNN',
  cite: 'Li et al., Pattern Recognition 2020',
  kind: '深度學習（CNN，4 萬參數）',
  model: { file: 'models/uwcnn.onnx', mb: 0.2 },
});

export const fiveaplus = netMethod({
  ...common,
  id: 'fiveaplus',
  name: 'Five A⁺ 超輕量網路',
  short: 'Five A+',
  cite: 'Jiang et al., BMVC 2023',
  kind: '深度學習（9 千參數）',
  model: { file: 'models/fiveaplus.onnx', mb: 0.9 },
});

export const uiec2net = netMethod({
  ...common,
  id: 'uiec2net',
  name: 'UIEC²-Net RGB＋HSV 雙色彩空間',
  short: 'UIEC²-Net',
  cite: 'Wang et al., Signal Process. Image Commun. 2021',
  kind: '深度學習（CNN，53 萬參數）',
  model: { file: 'models/uiec2net.onnx', mb: 2.2 },
});

export const nu2net = netMethod({
  ...common,
  id: 'nu2net',
  name: 'NU²-Net（Underwater Ranker）',
  short: 'NU²-Net',
  cite: 'Guo et al., AAAI 2023',
  kind: '深度學習（U-Net，315 萬參數）',
  model: { file: 'models/nu2net.onnx', mb: 12.6 },
});
