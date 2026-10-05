// 方法：FUnIE-GAN（深度學習）
// Islam, Xia, Sattar, "Fast Underwater Image Enhancement for Improved Visual Perception",
// IEEE RA-L 5(2):3227–3234, 2020。官方程式與權重：github.com/xahidbuffon/FUnIE-GAN（MIT）
// 模型：PyTorch 權重 → ONNX（float16），在瀏覽器以 onnxruntime-web（WASM）執行；外殼見 net.js。
import { netMethod } from './net.js';

export default netMethod({
  id: 'funie',
  name: 'FUnIE-GAN 深度學習',
  short: 'FUnIE-GAN',
  cite: 'Islam et al., IEEE RA-L 2020',
  kind: '深度學習（GAN）',
  model: { file: 'models/funie-gan.fp16.onnx', mb: 14 },
  input: 'pm1',
  output: 'pm1',
  size: 'aspect32',
});
