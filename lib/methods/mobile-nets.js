// 評測用：適合手機即時執行的新一代水下增強模型（2024–2026）中，尚未加入 App 方法清單的 6 個
// （FGDPA 已加入 App，見 fgdpa.js；評測時一起比較）。
// ONNX 由 scripts/export_mobile_onnx.py 從原作倉庫的權重轉出，放在 models/eval/（不進 git：LU2Net、LiteEnhanceNet 的倉庫沒有授權聲明）。
// 推論尺寸照各模型原作的測試方式：全解析度的模型（MobileIE、FGDPA、AquaFastNet、PIC-UIE）這裡保持長寬比、長邊 256；
// 原作壓成 256×256 測試的（LU2Net、LiteEnhanceNet、Shallow-UWnet）同樣壓成 256×256。後處理已包含在 ONNX 裡，輸出在 [0,1]。
// 之後與其他深度模型一樣，由 net.js 擬合成局部色彩轉換套回原解析度。
import { netMethod } from './net.js';

const aspect = { input: '01', output: 'clip', size: 'aspect', edge: 256, multiple: 32 };
const square = { input: '01', output: 'clip', size: 'square256' };

export const mobileie = netMethod({
  ...aspect, id: 'mobileie', name: 'MobileIE（手機即時影像增強）', short: 'MobileIE',
  cite: 'Yan et al., ICCV 2025', kind: '深度學習（4 千參數，重參數化 CNN）',
  model: { file: 'models/eval/mobileie.onnx', mb: 0.02 },
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

// PIC-UIE 內部固定把輸入縮成 256×256 給編碼器，再把預測的轉換（透射率、色調曲線、色度 LUT、色彩矩陣）套回輸入解析度；不需要 32 的倍數
export const picuie = netMethod({
  ...aspect, multiple: 8, id: 'picuie', name: 'PIC-UIE 預測影像自適應校正', short: 'PIC-UIE',
  cite: 'arXiv 2609.33318, 2026', kind: '深度學習（9.5 千參數，YCbCr 轉換預測）',
  model: { file: 'models/eval/pic_uie.onnx', mb: 0.11 },
});

export const shallowuwnet = netMethod({
  ...square, id: 'shallowuwnet', name: 'Shallow-UWnet 淺層壓縮網路', short: 'Shallow-UWnet',
  cite: 'Naik et al., AAAI 2021', kind: '深度學習（22 萬參數，全解析度 CNN）',
  model: { file: 'models/eval/shallowuwnet.onnx', mb: 0.84 },
});

// 以下為「大模型」對照組（權重在 Google Drive）：不適合手機即時，只為了比較品質
export const ushape = netMethod({
  ...square, id: 'ushape', name: 'U-shape Transformer', short: 'U-shape',
  cite: 'Peng et al., IEEE TIP 2023', kind: '深度學習（3,159 萬參數，Transformer）',
  model: { file: 'models/eval/ushape.onnx', mb: 120 },
});

// UnDIVE：網路內部把輸入最近鄰縮成 256×256 預測雙邊網格，再依輸入解析度切片套用（後處理含整張 min-max，與原作相同）。
// 官方權重 UnDIVE_100 有用 UVE-38K 影片做時間一致性訓練（評測影片可能看過）；UIEB_pretrain_150 只用 UIEB 訓練，當公平對照。
const undiveBase = { ...aspect, multiple: 8, kind: '深度學習（672 萬參數，擴散先驗＋雙邊網格）' };
export const undive = netMethod({
  ...undiveBase, id: 'undive', name: 'UnDIVE 擴散先驗影片增強', short: 'UnDIVE',
  cite: 'Srinath et al., WACV 2025', model: { file: 'models/eval/undive.onnx', mb: 25.6 },
});
export const undiveUieb = netMethod({
  ...undiveBase, id: 'undive_uieb', name: 'UnDIVE（只用 UIEB 預訓練的權重）', short: 'UnDIVE-UIEB',
  cite: 'Srinath et al., WACV 2025', model: { file: 'models/eval/undive_uieb.onnx', mb: 25.6 },
});

// DM-UW：條件擴散模型，10 步 DDIM 全部展開在 ONNX 裡（起始雜訊固定 → 輸出確定），輸入 256×256。
// 每格約 40 秒（CPU 單執行緒），評測時只能用 App 的「快速匯出」方式：每 1 秒一個關鍵幀，中間內插（bench-video --keys 1）。
export const dmuw = netMethod({
  ...square, id: 'dmuw', name: 'DM-UW Transformer 擴散模型', short: 'DM-UW',
  cite: 'Tang et al., ACM MM 2023', kind: '深度學習（1,071 萬參數，條件擴散 10 步）',
  model: { file: 'models/eval/dmuw.onnx', mb: 45.4 },
});

export const CANDIDATES = [mobileie, lu2net, liteenhancenet, aquafastnet, picuie, shallowuwnet, ushape, undive, undiveUieb, dmuw];

// UVENet（Du et al.，SUVE 訓練）：一次吃 5 格（前後各 2 格）的影片網路，不能像上面那樣逐格呼叫。
// 評測時先用 tools/uvenet_infer.py 照原作方式（5 格滑動視窗、256×256）跑出網路輸出，
// 再由 bench-video.mjs --pre uvenet5=<目錄> 當作網路輸出，走同樣的擬合與影片模式。
export const uvenet5 = netMethod({
  ...square, id: 'uvenet5', name: 'UVENet（SUVE，5 格輸入影片網路）', short: 'UVENet',
  cite: 'Du et al., arXiv 2403.11506（2024）', kind: '深度學習（ConvNeXt-T 骨幹，多格輸入）',
  model: { file: 'pre:uvenet5', mb: 127 },
});
export const PRECOMPUTED = [uvenet5];
