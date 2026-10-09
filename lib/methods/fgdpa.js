// 方法：FGDPA（Real-Time Underwater Image Enhancement via Frequency-Guided Dual-Path Attention，ICME 2026）
// 權重：github.com/LethyZhang/FGDPA（Apache-2.0，UIEB 訓練），由 scripts/export_mobile_onnx.py 轉成 ONNX（與原作 PyTorch 差 < 1e-6）。
// 只有 4,234 個參數（34 KB）：MobileIE 的重參數化小網路，加上頻域引導的雙路注意力（32×32 DFT 幅度 → 通道注意力，
// 最大／平均圖 → 空間注意力）。原作 32×32 的 FFT 在 ONNX 裡改成等價的 DFT 矩陣乘法（手機瀏覽器的 ONNX Runtime 不一定支援 FFT）。
// 原作以全解析度推論；這裡和其他深度模型一樣保持長寬比、長邊 256（邊長須為 32 的倍數），輸出 clip 到 [0,1]，
// 再由 net.js 擬合成局部色彩轉換套回原解析度。
import { netMethod } from './net.js';

export default netMethod({
  id: 'fgdpa',
  name: 'FGDPA 頻域引導雙路注意力',
  short: 'FGDPA',
  cite: 'Zhang et al., ICME 2026',
  kind: '深度學習（4 千參數，頻域注意力）',
  input: '01',
  output: 'clip',
  size: 'aspect',
  edge: 256,
  multiple: 32,
  model: { file: 'models/fgdpa.onnx', mb: 0.03 },
});
