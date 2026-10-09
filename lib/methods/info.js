// 介面用的方法說明與出處（論文與 GitHub 參考實作）。
export const INFO = {
  ancuti: {
    summary: '先用綠色通道補回被水吃掉的紅色，再灰色世界白平衡；從同一張圖做出「Gamma 校正」與「銳化」兩個版本，依對比、顯著性、飽和度權重做拉普拉斯金字塔融合。不需深度、不需訓練，對各種水色都穩定，是最常被拿來比較的基準方法。',
    paper: ['IEEE TIP 27(1), 2018', 'https://doi.org/10.1109/TIP.2017.2759252'],
    code: [['fergaletto/Color-Balance-and-fusion…（MATLAB）', 'https://github.com/fergaletto/Color-Balance-and-fusion-for-underwater-image-enhancement.-.'], ['fowles/underwater-color（Python）', 'https://github.com/fowles/underwater-color']],
  },
  mlle: {
    summary: '以平均值最大的通道為參考，依「最大衰減圖」逐像素補償另兩個通道（色損最小），再在 Lab 的 L 通道用「全域/局部變異數比」做局部自適應對比增強，最後平衡 a、b 兩軸。速度快、去色偏強，常見結果偏亮、開放水域略帶紫。',
    paper: ['IEEE TIP 31, 2022', 'https://doi.org/10.1109/TIP.2022.3177129'],
    code: [['Li-Chongyi/MMLE_code（官方 MATLAB）', 'https://github.com/Li-Chongyi/MMLE_code'], ['nomi30701/…（Python 重現）', 'https://github.com/nomi30701/Underwater-image-color-correction-adaptive-contrast-enhancemention-and-yolo-detect-python']],
  },
  ulap: {
    summary: '水下紅光衰減最快，所以 max(G,B) − R 越大代表越遠；以線性回歸係數由單張圖估深度，再估背景光與 R/G/B 透射率，代入成像模型反解。物理意義清楚、速度快，結果保守（偏藍綠時色偏去除有限）。',
    paper: ['PCM 2018, LNCS 11164', 'https://researchportal.scu.edu.au/esploro/outputs/bookChapter/A-Rapid-Scene-Depth-Estimation-Model/991012926976402368'],
    code: [['wangyanckxx/Single-Underwater-Image-Enhancement-and-Color-Restoration（ULAP）', 'https://github.com/wangyanckxx/Single-Underwater-Image-Enhancement-and-Color-Restoration']],
  },
  udcp: {
    summary: '暗通道先驗的水下版：只用 G、B 通道估透射率（紅光幾乎被吸收、不可靠），再以引導濾波細化並反解霧化模型。去霧與對比提升明顯，但原方法不處理色偏且容易偏暗，因此加了可調的後置白平衡。',
    paper: ['ICCV Workshops 2013', 'https://openaccess.thecvf.com/content_iccv_workshops_2013/W24/html/Drews_Jr._Transmission_Estimation_in_2013_ICCV_paper.html'],
    code: [['wangyanckxx/…（UDCP）', 'https://github.com/wangyanckxx/Single-Underwater-Image-Enhancement-and-Color-Restoration']],
  },
  rghs: {
    summary: '針對淺水：先等化 G、B 通道，再依各通道分布做「相對」直方圖拉伸（保留暗端、不硬拉紅色），最後在 Lab 線性拉伸亮度並用 S 型曲線提高彩度。簡單、穩定、色彩自然；對深藍水的色偏修正較弱。',
    paper: ['MMM 2018, LNCS 10704', 'https://hal-amu.archives-ouvertes.fr/hal-01632263'],
    code: [['wangyanckxx/…（RGHS）', 'https://github.com/wangyanckxx/Single-Underwater-Image-Enhancement-and-Color-Restoration']],
  },
  seathru: {
    summary: '修正後的水下成像模型：散射與直射光的衰減係數不同、且隨距離變化。依深度分段取最暗像素擬合散射曲線並扣除，再以局部平均色估光源、反推隨深度變化的衰減並補償。原論文需要 RGB-D；這裡以 ULAP 單張深度代替，屬近似。',
    paper: ['CVPR 2019', 'https://openaccess.thecvf.com/content_CVPR_2019/html/Akkaynak_Sea-Thru_A_Method_for_Removing_Water_From_Underwater_Images_CVPR_2019_paper.html'],
    code: [['hainh/sea-thru（Python）', 'https://github.com/hainh/sea-thru']],
  },
  funie: {
    summary: '條件式 GAN（U-Net 生成器，約 7M 參數），以 EUVP 成對資料訓練，嵌入式裝置可即時執行。這裡把官方權重轉成 ONNX（float16，14 MB），在瀏覽器以 WASM 執行；網路在小圖上推論，再擬合成局部色彩轉換套到原解析度，細節不失真。第一次使用需下載約 28 MB。',
    paper: ['IEEE RA-L 5(2), 2020', 'https://arxiv.org/abs/1903.09766'],
    code: [['xahidbuffon/FUnIE-GAN（官方，MIT）', 'https://github.com/xahidbuffon/FUnIE-GAN']],
  },
  ibla: {
    summary: '用三種線索估深度：紅光最大值（紅光越少越遠）、紅與藍綠差（MIP）、影像模糊度（越遠越糊），並依背景光亮度與紅色量自動決定三者權重；背景光由三個候選融合。對混濁、偏暗、紅光幾乎全失的場景比單一先驗穩定，常被當作物理復原的強基準。',
    paper: ['IEEE TIP 26(4), 2017', 'https://doi.org/10.1109/TIP.2017.2663846'],
    code: [['wangyanckxx/…（IBLA，Python）', 'https://github.com/wangyanckxx/Single-Underwater-Image-Enhancement-and-Color-Restoration']],
  },
  nu2net: {
    summary: 'Underwater Ranker 論文的增強網路：U-Net 架構，訓練時加入「水下影像品質排序器」當損失，讓輸出往人眼覺得較好的方向走。四個 UIEB 模型中最大（12.6 MB），色彩自然、細節保留好。',
    paper: ['AAAI 2023', 'https://arxiv.org/abs/2208.06857'],
    code: [['RQ-Wu/UnderwaterRanker（官方）', 'https://github.com/RQ-Wu/UnderwaterRanker'], ['ddz16/UIE_Benckmark（UIEB 權重，MIT）', 'https://github.com/ddz16/UIE_Benckmark']],
  },
  uiec2net: {
    summary: '同時在 RGB 與 HSV 兩個色彩空間處理：RGB 分支去雜訊與色偏，HSV 分支用可學習的分段曲線調整色相、飽和度、亮度，最後由信心圖融合兩者。在 UIEB 測試集上是這四個模型中分數最高的（PSNR 23.26，UIEDP 論文 T90）。模型 2.2 MB，但運算較重。',
    paper: ['Signal Processing: Image Communication 96, 2021', 'https://arxiv.org/abs/2103.07138'],
    code: [['BIGWangYuDong/UWEnhancement（作者）', 'https://github.com/BIGWangYuDong/UWEnhancement'], ['ddz16/UIE_Benckmark（UIEB 權重，MIT）', 'https://github.com/ddz16/UIE_Benckmark']],
  },
  uwcnn: {
    summary: '最早期、最常被引用的水下 CNN 之一：只有 10 層卷積、約 4 萬參數（0.2 MB），以水下成像模型合成的資料訓練，直接輸出清晰影像（殘差學習）。輕、快，適合低階裝置與影片。',
    paper: ['Pattern Recognition 98, 2020', 'https://arxiv.org/abs/1807.03528'],
    code: [['BIGWangYuDong/UWEnhancement（PyTorch 版）', 'https://github.com/BIGWangYuDong/UWEnhancement'], ['ddz16/UIE_Benckmark（UIEB 權重，MIT）', 'https://github.com/ddz16/UIE_Benckmark']],
  },
  fiveaplus: {
    summary: '只有約 9 千個參數（0.9 MB）的超輕量網路：多分支色彩增強模組 + 多尺度金字塔細節增強，並在頻率域融合兩者。為即時、嵌入式設計，參數量比其他方法少兩到三個數量級。',
    paper: ['BMVC 2023', 'https://arxiv.org/abs/2305.08824'],
    code: [['Owen718/FiveAPlus-Network（官方）', 'https://github.com/Owen718/FiveAPlus-Network'], ['ddz16/UIE_Benckmark（UIEB 權重，MIT）', 'https://github.com/ddz16/UIE_Benckmark']],
  },
  waternet: {
    summary: 'UIEB 資料集論文提出的基準網路：先把原圖做白平衡、直方圖等化、Gamma 校正三個版本，網路學習三者各自的信心圖（哪裡該用哪一種），再融合並細修。是「GitHub 熱門水下還原專案」常見名單中的第 4 名。權重為原作 TensorFlow 權重轉成 PyTorch 的版本（tnwei/waternet）。運算較重（每張約 4–5 秒）。',
    paper: ['IEEE TIP 29, 2020（UIEB）', 'https://arxiv.org/abs/1901.05495'],
    code: [['Li-Chongyi/Water-Net_Code（官方）', 'https://github.com/Li-Chongyi/Water-Net_Code'], ['tnwei/waternet（PyTorch 與權重，MIT）', 'https://github.com/tnwei/waternet']],
  },
  uvenet: {
    summary: '第一個大型真實水下影片資料集 UVEB 的基準模型（CVPR 2024），專為影片設計：把中間格的資訊轉成卷積核傳給相鄰格，小模型可即時處理 2K 影片。這裡使用官方附的小模型（53 萬參數、2.2 MB），以單格模式執行（實測每格輸出只取決於該格），速度約 0.2 秒/格。',
    paper: ['CVPR 2024', 'https://arxiv.org/abs/2404.14542'],
    code: [['yzbouc/UVEB（官方，MIT，含權重）', 'https://github.com/yzbouc/UVEB']],
  },
  fgdpa: {
    summary: '2026 年的手機級即時水下增強網路，只有 4,234 個參數（34 KB）：以 MobileIE（ICCV 2025）的重參數化小網路為骨幹，訓練時用多分支卷積與固定 DCT 頻率先驗，推論時合併成單一卷積（不增加計算）；再加上「頻域引導雙路注意力」——特徵縮到 32×32 取 2D 頻譜幅度，配合全域平均做通道注意力，最大／平均圖做空間注意力，兩者融合後調整特徵。UIEB 訓練。在 UVE-38K 影片上 PSNR 19.39、SSIM 0.612（與 WaterNet 相同），每格推論約 0.04 秒，是 App 裡最快的深度模型。',
    paper: ['ICME 2026（arXiv 2606.30314）', 'https://arxiv.org/abs/2606.30314'],
    code: [['LethyZhang/FGDPA（官方，Apache-2.0，含權重）', 'https://github.com/LethyZhang/FGDPA'], ['AVC2-UESTC/MobileIE（骨幹，ICCV 2025）', 'https://github.com/AVC2-UESTC/MobileIE']],
  },
  diverout: {
    summary: '重現 DIVEROUT App「高／超高／標準」影片調色的反推模型（黑箱測試推得，不是官方實作）。本質是逐通道自動色階：每隔 1 秒（高）、0.5 秒（超高）或 2 秒（標準）取一個關鍵幀，估出 R、G、B 各自的黑點與白點，中間幀線性內插；紅色幾乎消失時，用綠、藍合成紅色（R′ = w·R + (1−w)·(G − k·B)）。整張畫面同一組參數，沒有銳化、降噪或局部處理。影片會先看過整支片算出所有關鍵幀，播放、匯出都用同一組；參數組 real 用實拍擬合（預設），synthetic 用測試圖規則。與 DIVEROUT 實際輸出相比：兩段實拍 PSNR 25.6 dB、SSIM 0.92（未處理 15.3 / 0.73）。',
    paper: ['反推模型說明（docs/diverout-model.md）', 'https://github.com/jonwenjen/WaterTool/blob/main/docs/diverout-model.md'],
    code: [['tools/diverout_cc.py（命令列工具：影片、照片、資料夾）', 'https://github.com/jonwenjen/WaterTool/blob/main/tools/diverout_cc.py'], ['lib/methods/diverout.js（App 版）', 'https://github.com/jonwenjen/WaterTool/blob/main/lib/methods/diverout.js']],
  },
};
