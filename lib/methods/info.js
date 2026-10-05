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
};
