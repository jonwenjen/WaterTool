# 🌊 WaterTool — 水下影片還原工作台

把網路上**有論文、有 GitHub 原始碼**的水下影像還原方法整理出 14 種，再加上 DIVEROUT App 調色的反推模型（Diverout_sim），重新實作成一個**純瀏覽器**的 App：
開啟水下影片或照片 → 選方法 → 分割畫面即時比較 → 匯出 MP4 / PNG。
影片另外加了**時間一致性**（防閃爍），因為逐幀方法直接套在影片上最常見的問題就是閃爍。

- **不上傳、不需伺服器**：所有運算在本機瀏覽器的背景執行緒完成。
- **可安裝成 App**（PWA）：手機「加到主畫面」、桌面 Chrome「安裝」，安裝後可離線使用。
- **15 種方法**：7 種傳統（物理模型 / 增強）+ 7 個深度學習模型（FUnIE-GAN、WaterNet、UVE-Net 與 4 個 UIEB 訓練模型，ONNX 在瀏覽器執行）+ **Diverout_sim**（重現 DIVEROUT「高／超高／標準」調色）。
- **每種方法都有客觀評測**：EUVP 真實照片與 UVE-38K 真實影片的 PSNR / SSIM、合成真值場景、閃爍量測（[`docs/results.md`](docs/results.md)、[`docs/results-video.md`](docs/results-video.md)）。

![分割比較（左原始、右 Ancuti 融合）](docs/screenshots/video-split.png)

![全部比較：同一幀、所有方法並列，附 UIQM / UCIQE 與耗時](docs/screenshots/photo-compare.png)

## 快速開始

```bash
npm install          # 只有開發 / 測試需要；網站本身是純靜態檔
npm run serve        # http://localhost:8080
npm test             # 單元測試（核心運算、15 種方法、時間穩定化）
npm run e2e -- <影片>  # 無頭 Chromium 端對端：播放、15 種方法、全部比較、7 個深度模型、Diverout_sim 關鍵幀、匯出 MP4/PNG
node scripts/bench.mjs [EUVP data/test 目錄] > docs/results.md   # 重新評測（照片、合成場景）
node scripts/bench-video.mjs <UVE-38K imgs 目錄> --out v.json && node scripts/video-report.mjs v.json > docs/results-video.md   # 影片
```

**發佈成網站**：推到 `main` 後由 `.github/workflows/pages.yml` 部署到 GitHub Pages
（第一次需在 *Settings → Pages → Source* 選 **GitHub Actions**），網址會是
`https://jonwenjen.github.io/WaterTool/`。

**安裝成 App**：用手機開上面網址 → Android Chrome「加到主畫面 / 安裝應用程式」、iOS Safari「分享 → 加入主畫面」；
桌面 Chrome / Edge 網址列右側的「安裝」按鈕（App 內也有「安裝 App」按鈕）。

## 使用方式

1. **開啟影片／照片**（或拖進畫面）。沒有素材可按 **合成示範**，會產生一段已知真值的合成水下影片。
2. 右側選 **還原方法**，調整參數；畫面上拖曳分割線比較原始 / 還原。
   每個滑桿下方的「ⓘ 說明」寫了從最小到最大的效果、適用情境與建議數值（內容在 [`lib/help.js`](lib/help.js)）。
3. **全部比較** 會把目前畫面用所有方法各算一次，並列顯示（含 UIQM / UCIQE 與耗時），點一下即切換。
4. **播放很順**：播放時由 GPU（WebGL2）把色彩即時套到每一格影片，速度跟原片一樣（測試中 30 fps 影片維持約 30 fps）；
   色彩本身由背景執行緒用完整演算法在小圖（長邊 320）上持續重算，再擬合成局部色彩轉換交給 GPU。
   暫停、照片與匯出則是逐像素完整計算。不支援 WebGL2 的瀏覽器自動改用逐幀處理。
   色彩更新比影片慢（手機上常要 0.3–2 秒），所以播放用較粗的局部色彩轉換、新舊轉換之間在 GPU 上平滑過渡，只有真的換鏡頭才直接切換；
   模擬手機延遲 0.8 秒時，預覽與該格精確結果的誤差起伏：RGHS 2.10 → 0.22、MLLE 2.06 → 0.32、NU²-Net 1.71 → 0.18
   （`FIT_DELAY=800 node scripts/preview-accuracy.mjs <影片> <方法>`）。
5. **第一次開啟會在背景下載全部 7 個深度模型與執行環境（約 51 MB）** 存到本機，頂端會顯示進度；之後選用免等待、可離線。
6. **影片時間一致性**：τ（參數平滑時間）、輸出去閃爍強度、每 N 幀重新估計（FUnIE-GAN 預設 4）。
7. **不會卡住**：背景運算一個一個排隊（同一個模型不會同時推論）；若超過 40 秒沒有回應（例如手機記憶體不足），
   會自動重新啟動並重算目前畫面；播放中重新啟動時，播放的色彩計算也會自己接回。手機收回 GPU 畫布時自動改用逐幀處理，影片不會停住。
   暫停瞬間先用這一格的 GPU 結果當暫時畫面，完整計算完成再取代（拖分隔線不會露出舊畫面）。
   ONNX 多執行緒只在桌機開；手機一律單執行緒（多執行緒在手機上曾讓背景卡死）。
   關鍵幀（Diverout_sim、快速匯出）用 Mediabunny 直接解碼取得，不依賴看不見的 `<video>`（手機瀏覽器常不替它載入資料，以前會停在「分析關鍵幀」）。
   測試：`node scripts/stress-ui.mjs <影片>`（播放／暫停／連續調參數）、`node scripts/recover-check.mjs <影片>`（模擬卡死與 GPU 畫布被收回）、
   `node scripts/mobile-keys-check.mjs <影片>`（模擬手機不載入隱藏影片）、
   `node scripts/export-identity-check.mjs <影片> <匯出目錄> <方法…>`（每支匯出都最接近自己所選方法的完整計算結果）。
8. **匯出**：照片 → PNG；影片 → MP4（WebCodecs 編碼，H.264 不可用時自動改 VP9/AV1，**保留原音軌**）。
9. **影片匯出很快**（「影片匯出方式」選單，預設「快速」）：每 0.5 秒（或 1 秒）的關鍵幀用完整演算法算一次，
   得到「原片 → 結果」的色彩轉換；匯出每一格時把前後兩個關鍵幀在 GPU 上線性內插、套到原解析度，每格只剩 GPU 繪製與編碼。
   - **深度模型**：直接用網路輸出的局部色彩轉換係數，和逐格版逐像素相差 ≤ 1；桌機上 ONNX 另外開多執行緒
     （Service Worker 補上跨來源隔離標頭，第一次開啟會自動重新整理一次）。
   - **Diverout_sim**：整支片的關鍵幀色階 → 全域色彩矩陣，和逐格版相同。
   - **其他方法**：關鍵幀在長邊 640 的圖上完整處理，再擬合成局部色彩轉換。細部的局部對比會比逐格版柔和
     （與逐格輸出相差 27–35 dB，MLLE、RGHS 差最多），但和 UVE-38K 參考影片比的 PSNR / SSIM 持平或更好
     （[`docs/results-video.md`](docs/results-video.md) 最後一節）。要完全相同的結果選「逐格完整計算」。

   5 秒 1080p 影片的匯出時間（無頭 Chromium、軟體 GPU 與 VP9 軟體編碼；手機的硬體 GPU 與 H.264 編碼器更快）：

   | 方法 | 逐格完整計算 | 快速（0.5 秒關鍵幀） |
   |---|---|---|
   | 色彩平衡＋融合 | 559 秒 | **34 秒**（16×） |
   | MLLE | 258 秒 | **31 秒**（8×） |
   | RGHS | 119 秒 | **29 秒**（4×） |
   | Five A⁺ | （1080p 未測，見 ※） | **28 秒** |
   | Diverout_sim | 26 秒 | **21 秒** |

   ※ 3 秒 640×360 影片：Five A⁺ 21.5 → 6.1 秒、NU²-Net 34.1 → 7.0 秒、WaterNet 96.8 → 14.5 秒、FUnIE-GAN 12.7 → 5.0 秒。
   同一支 1080p 片單純轉檔（不處理）要 4 秒，其餘是關鍵幀計算與軟體 GPU 的繪製、讀回。

---|---|---|
   | Five A⁺ | 21.5 秒 | **6.1 秒**（3.5×） |
   | NU²-Net | 34.1 秒 | **7.0 秒**（4.9×） |
   | WaterNet | 96.8 秒 | **14.5 秒**（6.7×） |
   | FUnIE-GAN | 12.7 秒 | **5.0 秒**（2.5×） |

   畫質沒有變差：UVE-38K 真實影片上 7 個深度模型的 PSNR、SSIM、時間誤差都持平或略好（[`docs/results-video.md`](docs/results-video.md) 最後一節）；
   GPU 套用與 CPU 計算逐像素相差 ≤ 1。要舊的逐幀方式可選「逐幀處理」。

---

## 一、研究整理：網路上的論文與 GitHub 實作

### 實作進 App 的 15 種方法

| # | 方法 | 類型 | 論文 | GitHub 參考實作 |
|---|---|---|---|---|
| 1 | 色彩平衡 + 多尺度融合 | 增強 | Ancuti et al., *Color Balance and Fusion for Underwater Image Enhancement*, IEEE TIP 2018 · [DOI](https://doi.org/10.1109/TIP.2017.2759252) | [fergaletto/…（MATLAB）](https://github.com/fergaletto/Color-Balance-and-fusion-for-underwater-image-enhancement.-.)、[fowles/underwater-color](https://github.com/fowles/underwater-color)、[arm-on/underwater-image-enhancement](https://github.com/arm-on/underwater-image-enhancement) |
| 2 | MLLE 最小色損 + 局部自適應對比 | 增強 | Zhang et al., *Underwater Image Enhancement via Minimal Color Loss and Locally Adaptive Contrast Enhancement*, IEEE TIP 2022 · [DOI](https://doi.org/10.1109/TIP.2022.3177129) | [Li-Chongyi/MMLE_code（官方）](https://github.com/Li-Chongyi/MMLE_code)、[nomi30701/…（Python 重現）](https://github.com/nomi30701/Underwater-image-color-correction-adaptive-contrast-enhancemention-and-yolo-detect-python) |
| 3 | ULAP 水下光衰減先驗 | 物理復原 | Song et al., *A Rapid Scene Depth Estimation Model Based on Underwater Light Attenuation Prior*, PCM 2018 · [連結](https://researchportal.scu.edu.au/esploro/outputs/bookChapter/A-Rapid-Scene-Depth-Estimation-Model/991012926976402368) | [wangyanckxx/Single-Underwater-Image-Enhancement-and-Color-Restoration](https://github.com/wangyanckxx/Single-Underwater-Image-Enhancement-and-Color-Restoration) |
| 4 | UDCP 水下暗通道先驗 | 物理復原 | Drews et al., *Transmission Estimation in Underwater Single Images*, ICCV Workshops 2013 · [CVF](https://openaccess.thecvf.com/content_iccv_workshops_2013/W24/html/Drews_Jr._Transmission_Estimation_in_2013_ICCV_paper.html) | 同上（UDCP 資料夾） |
| 5 | RGHS 相對全域直方圖拉伸 | 增強 | Huang et al., *Shallow-water Image Enhancement Using Relative Global Histogram Stretching*, MMM 2018 · [HAL](https://hal-amu.archives-ouvertes.fr/hal-01632263) | 同上（RGHS 資料夾） |
| 6 | Sea-thru（修正成像模型） | 物理復原 | Akkaynak & Treibitz, *Sea-thru: A Method for Removing Water From Underwater Images*, CVPR 2019 · [CVF](https://openaccess.thecvf.com/content_CVPR_2019/html/Akkaynak_Sea-Thru_A_Method_for_Removing_Water_From_Underwater_Images_CVPR_2019_paper.html) | [hainh/sea-thru](https://github.com/hainh/sea-thru)、[CV-Reimplementation/Sea-thru-implementation](https://github.com/CV-Reimplementation/Sea-thru-implementation) |
| 7 | IBLA 模糊度＋光吸收 | 物理復原 | Peng & Cosman, *Underwater Image Restoration Based on Image Blurriness and Light Absorption*, IEEE TIP 2017 · [DOI](https://doi.org/10.1109/TIP.2017.2663846) | [wangyanckxx/…（IBLA，Python）](https://github.com/wangyanckxx/Single-Underwater-Image-Enhancement-and-Color-Restoration) |
| 8 | FUnIE-GAN | 深度學習 | Islam, Xia, Sattar, *Fast Underwater Image Enhancement for Improved Visual Perception*, IEEE RA-L 2020 · [arXiv](https://arxiv.org/abs/1903.09766) | [xahidbuffon/FUnIE-GAN（官方，MIT）](https://github.com/xahidbuffon/FUnIE-GAN) |
| 9 | NU²-Net（Underwater Ranker） | 深度學習 | Guo et al., *Underwater Ranker: Learn Which Is Better and How to Be Better*, AAAI 2023 · [arXiv](https://arxiv.org/abs/2208.06857) | [RQ-Wu/UnderwaterRanker](https://github.com/RQ-Wu/UnderwaterRanker)；權重 [ddz16/UIE_Benckmark](https://github.com/ddz16/UIE_Benckmark) |
| 10 | UIEC²-Net | 深度學習 | Wang et al., *UIEC²-Net: CNN-based Underwater Image Enhancement Using Two Color Space*, SPIC 2021 · [arXiv](https://arxiv.org/abs/2103.07138) | [BIGWangYuDong/UWEnhancement](https://github.com/BIGWangYuDong/UWEnhancement)；權重同上 |
| 11 | UWCNN | 深度學習 | Li, Anwar, Porikli, *Underwater Scene Prior Inspired Deep Underwater Image and Video Enhancement*, Pattern Recognition 2020 · [arXiv](https://arxiv.org/abs/1807.03528) | [BIGWangYuDong/UWEnhancement](https://github.com/BIGWangYuDong/UWEnhancement)；權重同上 |
| 12 | Five A⁺ Network | 深度學習 | Jiang et al., *Five A⁺ Network: You Only Need 9K Parameters for Underwater Image Enhancement*, BMVC 2023 · [arXiv](https://arxiv.org/abs/2305.08824) | [Owen718/FiveAPlus-Network](https://github.com/Owen718/FiveAPlus-Network)；權重同上 |
| 13 | WaterNet | 深度學習 | Li et al., *An Underwater Image Enhancement Benchmark Dataset and Beyond*（UIEB），IEEE TIP 2020 · [arXiv](https://arxiv.org/abs/1901.05495) | [Li-Chongyi/Water-Net_Code](https://github.com/Li-Chongyi/Water-Net_Code)；PyTorch 權重 [tnwei/waternet](https://github.com/tnwei/waternet)（MIT） |
| 14 | UVE-Net（影片） | 深度學習 | Xie et al., *UVEB: A Large-scale Benchmark and Baseline Towards Real-World Underwater Video Enhancement*, CVPR 2024 · [arXiv](https://arxiv.org/abs/2404.14542) | [yzbouc/UVEB](https://github.com/yzbouc/UVEB)（MIT，含權重） |
| 15 | Diverout_sim | 調色模擬 | DIVEROUT App 影片「AI 調色」的黑箱反推模型 · [`docs/diverout-model.md`](docs/diverout-model.md) | 命令列工具 [`tools/diverout_cc.py`](tools/diverout_cc.py)；App 版 [`diverout.js`](lib/methods/diverout.js) |

### 第二輪：再加入的 5 種方法（依評分挑選）

搜尋 GitHub 與彙整清單後，挑選標準是「有公開程式 **且** 有公開的評分或可重現的權重」，並能在手機瀏覽器執行：

- **4 個深度模型** 來自 [ddz16/UIE_Benckmark](https://github.com/ddz16/UIE_Benckmark)（MIT）—— 同一份程式、同一個 UIEB 訓練/測試切分訓練出的權重，
  分數可以互相比較。該作者在 UIEDP 論文（[arXiv 2312.06240](https://arxiv.org/abs/2312.06240)，ESWA 2025）報告的 UIEB 測試集 T90 成績：

  | 模型 | 參數量 | UIEB T90 PSNR ↑ | SSIM ↑ | ONNX 大小 |
  |---|---|---|---|---|
  | UIEC²-Net | 53 萬 | 23.26 | 0.91 | 2.2 MB |
  | NU²-Net | 315 萬 | 22.93 | 0.90 | 12.6 MB |
  | Five A⁺ | 9 千 | 20.98 | 0.88 | 0.9 MB |
  | UWCNN | 4 萬 | 19.02 | 0.82 | 0.2 MB |

  （數字取自論文表格。）轉成 ONNX 的方式見 `scripts/export_uieb_onnx.py`：
  UIEC²-Net 的遮罩賦值改為 `torch.where`、Five A⁺ 的 FFT 改為等價的 DFT 矩陣乘法，兩者與原始 PyTorch 輸出逐像素比對誤差 0；
  在 onnxruntime-web 中與 PyTorch 的最大差異 UWCNN 3e-6、Five A⁺ 5e-6、NU²-Net 4e-6、UIEC²-Net 3e-3（< 1/255）。
- **IBLA**（TIP 2017）是傳統物理復原中被引用最多、各綜述常列為強基準的方法；第二輪原本也考慮 ACDC（JOE 2022），
  但它的官方程式核心是加密的 MATLAB p-code，無法照原作重現，因此改用有完整 Python 參考碼的 IBLA。
- **在本專案的 EUVP 真實照片上重新評分**（與參考圖比較），4 個 UIEB 模型的 PSNR / SSIM 都高於全部 7 種傳統方法（見第四節）。

### 第三輪：GitHub 熱門專案名單

常見的「GitHub 熱門水下還原專案」排名是 FUnIE-GAN、UWGAN、UWCNN、WaterNet、Sea-Thru。對照 App：

| 名次 | 專案 | 狀態 |
|---|---|---|
| 1 | FUnIE-GAN | ✅ 已有（官方權重） |
| 2 | UWGAN（[infrontofme/UWGAN_UIE](https://github.com/infrontofme/UWGAN_UIE)） | ❌ **無法加入**：倉庫與分支都沒有附訓練好的權重；作者的網盤連結在這個環境連不到，也沒有可用的訓練資料能自行重現 |
| 3 | UWCNN | ✅ 已有（UIEB 權重） |
| 4 | WaterNet | ✅ **新增**：原作 TensorFlow 權重轉成的 PyTorch 版（tnwei/waternet，sha256 `daa0ee…`；Dropbox 連不到，改從內含同一檔案的 GitHub 倉庫取得並比對雜湊）。前處理（白平衡、CLAHE、Gamma）照參考程式實作，JS 全流程與 Python 參考輸出相差 PSNR 69 dB（幾乎相同） |
| 5 | Sea-Thru | ✅ 已有（以 ULAP 單張深度代替 RGB-D，屬近似） |

另外加入 **UVE-Net**：真實水下影片資料集 UVEB（CVPR 2024）的官方基準模型，倉庫直接附權重；實測每格輸出只取決於該格，以單格模式執行，每格約 0.3 秒。

### 影片專用（時間一致性）的研究

| 論文 | 重點 | 程式 |
|---|---|---|
| Srinath et al., *UnDIVE: Generalized Underwater Video Enhancement Using Generative Priors*, WACV 2025 · [arXiv 2411.05886](https://arxiv.org/abs/2411.05886) | 物理成像式做空間增強 + 幀間一致性損失 | [suhas-srinath/undive](https://github.com/suhas-srinath/undive) |
| Xie et al., *UVEB: A Large-scale Benchmark and Baseline Towards Real-World Underwater Video Enhancement*, CVPR 2024 · [arXiv 2404.14542](https://arxiv.org/abs/2404.14542) | 1,308 對影片的資料集；UVE-Net 把當前幀轉成卷積核傳給相鄰幀 | [yzbouc/UVEB](https://github.com/yzbouc/UVEB) |
| *Enhancing Underwater Video from Consecutive Frames While Preserving Temporal Consistency*, JMSE 2025 · [DOI](https://doi.org/10.3390/jmse13010127) | 雙分支網路，以光流維持時間一致 | — |
| *WaterWave: … Wavelet-based Temporal Consistency Field*, [arXiv 2512.05492](https://arxiv.org/pdf/2512.05492) | 把單張增強器接上小波域的時間一致性場 | — |
| Bonneel et al., *Blind Video Temporal Consistency*, SIGGRAPH Asia 2015 · [專案頁](https://perso.liris.cnrs.fr/nicolas.bonneel/consistency/) | 任何逐幀處理都能事後去閃爍：梯度取自當前處理幀、其餘對齊前一幀 | 專案頁有程式 |
| Lai et al., *Learning Blind Video Temporal Consistency*, ECCV 2018 · [arXiv 1808.00449](https://arxiv.org/abs/1808.00449) | 遞迴網路學習去閃爍；提出扭曲誤差 E_warp 指標 | — |
| Lei et al., *Blind Video Temporal Consistency via Deep Video Prior*, NeurIPS 2020 | 以影片本身訓練的網路做一致性 | [ChenyangLEI/deep-video-prior](https://github.com/ChenyangLEI/deep-video-prior) |

### 彙整清單與資料集

- [fansuregrin/Awesome-UIE](https://github.com/fansuregrin/Awesome-UIE)、[CXH-Research/Underwater-Image-Enhancement](https://github.com/CXH-Research/Underwater-Image-Enhancement)：水下影像增強論文/程式清單。
- [ddz16/UIE_Benckmark](https://github.com/ddz16/UIE_Benckmark)：多種方法（含 MLLE）的統一實作。
- 資料集：EUVP（FUnIE-GAN 倉庫）、UIEB（Li et al., TIP 2019）、UVEB（影片）。
- 綜述：Wang et al., *An Experimental-based Review of Image Enhancement and Image Restoration Methods for Underwater Imaging*（[arXiv 1907.03246](https://arxiv.org/abs/1907.03246)，即上面 wangyanckxx 倉庫）。

**為什麼影片專用的深度模型（UnDIVE、UVE-Net）沒有直接放進 App**：它們需要 PyTorch + GPU 推論（數十 MB 以上權重、每幀數百 ms 到數秒），
在手機瀏覽器裡跑不動，也違背「檔案不離開裝置」。App 採用它們的核心觀察——逐幀方法的閃爍主要來自**每幀獨立估計的全域參數**
與**低頻亮度/色彩的跳動**——用可即時執行的方式處理（見第三節）。

---

## 二、15 種方法：原理與本實作

每個方法分成兩步：`estimate()` 在 320 px 小圖上估計**全域量**（背景光、白平衡增益、拉伸範圍、散射係數…），
`apply()` 在處理解析度上套用。這樣一來估計便宜、全域量也能做時間平滑。程式在 [`lib/methods/`](lib/methods)。

### 1. 色彩平衡 + 多尺度融合（Ancuti 2018）— [`ancuti.js`](lib/methods/ancuti.js)
紅色通道補償 `R += α(Ḡ − R̄)(1 − R)G`（綠水時自動同時補償藍色）→ 灰色世界白平衡 →
兩個輸入：Gamma（γ=2）版與「正規化反銳化遮罩」版 → 權重 = 拉普拉斯對比 + 顯著性（Achanta）+ 飽和度，
正規化 `(W+δ)/(ΣW+Kδ)` → 拉普拉斯 / 高斯金字塔融合。
**適用**：幾乎所有水色；評測中合成場景平均色差最低。**缺點**：最慢（金字塔），開放水域偏灰。

### 2. MLLE（Zhang 2022）— [`mlle.js`](lib/methods/mlle.js)
LACC：以平均最大的通道為參考，`medium += K·L`，補償量依「最大衰減圖」`1 − I_small^1.2` 混合並加回細節層。
參考碼以迭代求 K，本實作用其**收斂值的封閉解** `K = (L̄ − mean)/L̄`（結果相同、每幀時間固定）。
LACE：L 通道 `μ + min(σ²_global/σ²_local, β)(L − μ)`，局部統計用 O(n) 方框濾波**逐像素**計算（參考碼是 25 px 區塊、會有接縫），
再引導濾波，最後平衡 Lab 的 a/b。**適用**：綠/藍色偏重的近景。**缺點**：開放水域偏紫。

### 3. ULAP（Song 2018）— [`ulap.js`](lib/methods/ulap.js)
深度 `d = 0.5116 + 0.5052·max(G,B) − 0.9051·R`（參考碼係數）→ 引導濾波細化 → 背景光取最遠 0.1% 中最亮者 →
`d_f = 8(d + d0)`、`t = {0.83, 0.95, 0.97}^d_f` → `J = (I − B)/t + B`。**最快**之一，結果保守。

### 4. UDCP（Drews 2013）— [`udcp.js`](lib/methods/udcp.js)
G、B 兩通道的暗通道 → 背景光 → 透射率 `1 − ω·min_patch(min(G/A_G, B/A_B))`、限制 [0.1, 0.9]、引導濾波 → 反解。
原方法不處理色偏且偏暗，所以加了**可調的後置白平衡**（預設開；設 0 即原方法）。去霧最強，但容易過飽和。

### 5. RGHS（Huang 2018）— [`rghs.js`](lib/methods/rghs.js)
G/B 等化（`0.5/mean`）→ 每通道相對拉伸 `[I_min, I_max] → [I_min, 1]`（保留暗端，不硬拉紅）→
Lab：L 1%/99% 拉伸、a/b 以 `x·1.3^(1−|x|/128)` 提高彩度。**適用**：淺水、色偏不重的畫面，色彩自然。

### 6. Sea-thru（Akkaynak & Treibitz 2019）— [`seathru.js`](lib/methods/seathru.js)
在**線性光**上：深度分 10 段、每段取最暗 1%（最多 20 點）擬合 `B(z) = B∞(1−e^{−β_B z}) + J′e^{−β_D′ z}`（網格搜尋 + 有界最小平方）→
扣散射 → 以深度為引導的大半徑濾波近似 LSAC 估光源 `E = 2a` → `β_D = −ln(E)/z` 依深度分段取中位數 → `J = D·e^{β_D(z) z}` →
G/B 最亮 10% 白平衡（紅取兩者平均，同參考碼）→ 拉伸。
**與原論文的差異（重要）**：原論文需要 RGB-D 或 SfM 深度；影片沒有，這裡用 ULAP 的單張深度先驗（相對深度，對應到 [近, 遠] 公尺）。
因為深度不是真實距離，加了三個防護：只扣真正的散射項（`J′` 項是暗點本身殘留的直射光）、散射不超過該深度最暗像素、
增益上限（亮度 ≤ 4×、通道比 ≤ 5×）；最遠的開放水域（原論文中沒有深度的像素）保留原色。

### 7. IBLA（Peng & Cosman 2017）— [`ibla.js`](lib/methods/ibla.js)
深度由三張圖融合：紅通道局部最大值 d_R（紅光越少越遠）、紅減藍綠的 MIP 圖 d_D、多尺度模糊度圖 d_B；
權重 `d = Θb(Θa·d_D + (1−Θa)·d_R) + (1−Θb)·d_B`，Θa、Θb 是背景光亮度與平均紅色量的 sigmoid（斜率 32）。
背景光取三個候選（RGB 暗通道最亮 0.1%、亮度四分樹、模糊度四分樹），依該通道亮像素比例在最大與最小間內插。
`t_R = e^{−d_f/7}`，`t_G、t_B = t_R^k`（k 由背景光與波長換算），引導濾波細化後反解。
與參考碼的差異：sigmoid 用論文的 [0,1] 正規化值（參考碼誤用 0–255，等於階梯函數）、雙邊濾波改為自引導的引導濾波、視窗隨解析度縮放。

### 8. FUnIE-GAN（Islam 2020）— [`funie.js`](lib/methods/funie.js)
官方 PyTorch 權重轉 ONNX（float16，14 MB），以 onnxruntime-web（WASM）在背景執行緒推論。
網路只在長邊 256 px 的小圖上跑；它的效果擬合成**逐通道局部仿射轉換**（引導濾波係數 a、b），放大後套到原解析度——
顏色來自網路，細節保留原片；係數本身也能做時間平滑。第一次使用下載約 28 MB（模型 + WASM），存在獨立的本機快取（`watertool-models-v1`）：App 更新不會清掉、重開不用再下載、離線也能用；並向瀏覽器要求永久儲存，降低空間不足時被清除的機會。

### 9–12. NU²-Net、UIEC²-Net、UWCNN、Five A⁺ — [`uieb-nets.js`](lib/methods/uieb-nets.js)、[`net.js`](lib/methods/net.js)
推論流程與原倉庫的 `test_UIEB.py` 相同：影像壓成 256×256、輸入 [0,1]、輸出若超出 [0,1] 就逐通道 min-max 正規化（`normalize_img`）。
接著和 FUnIE-GAN 一樣擬合成局部色彩轉換，套回原解析度與原長寬比，細節不糊、影片可做時間平滑。
WASM 單執行緒每次推論：Five A⁺ 約 0.7 s、NU²-Net 約 1 s、UWCNN 約 1 s、UIEC²-Net 約 5 s（電腦；手機約 2–3 倍），
影片預設每 4 幀重算一次網路。模型檔各自只下載一次，存在本機快取。

### 13. WaterNet — [`waternet.js`](lib/methods/waternet.js)
輸入是原圖加上三個前處理版本：白平衡（SimplestColorBalance，飽和比例依通道總和比例調整）、Lab 亮度做 CLAHE（clip 0.1、8×8）、Gamma 0.7。
網路產生三張信心圖，各自細修後加權融合。前處理照 tnwei/waternet 的 `data.py` 實作（含 OpenCV 8-bit Lab 量化），單張約 4–5 秒（256 px）。

### 14. UVE-Net（UVEB）— [`waternet.js`](lib/methods/waternet.js)
UVEB 官方小模型（12 通道特徵、53 萬參數）：把中間格縮小 4 倍後產生動態卷積核，再套到各格的特徵上。
匯出時把逐批次迴圈與 5 維 PixelShuffle 改寫成等價運算（與原始 PyTorch 輸出差 0），輸入長寬為 16 的倍數。

### 15. Diverout_sim（DIVEROUT 調色模擬）— [`diverout.js`](lib/methods/diverout.js)
重現 DIVEROUT App「高／超高／標準」的黑箱反推模型（完整說明見 [`docs/diverout-model.md`](docs/diverout-model.md)）：逐通道自動色階。
每隔 T 秒（高 1 秒、超高 0.5 秒、標準 2 秒）取一個關鍵幀，算出 R、G、B 各自的黑點與白點；中間幀線性內插；
紅色平均太低時先合成紅色 `R′ = w·R + (1−w)·(G − k·B)` 再拉伸。整張畫面同一組參數，沒有局部處理。
- **影片要先看過整支片**：選這個方法時，App 會先用一個看不見的播放器跳到每個關鍵幀估計參數，之後的暫停預覽、
  播放、匯出都用同一組關鍵幀內插（和 DIVEROUT 一樣）。播放時參數是全域 3×4 色彩矩陣，直接在 GPU 每格套用。
- **參數**：模式（高／超高／標準）、參數組（real：實拍擬合，預設；synthetic：測試圖規則）；「還原強度」= 原工具的 `--strength`。
- **與原工具一致**：同一批影格上，App 版與 [`tools/diverout_cc.py`](tools/diverout_cc.py) 輸出相差 ≤ 1 碼值（PSNR 73 dB，
  關鍵幀位置相同）；照片 real 參數組逐像素相差 ≤ 1。
- **命令列版**：`pip install numpy opencv-python`（另需 ffmpeg），`python3 tools/diverout_cc.py dive.mp4` → `dive_cc.mp4`（保留音軌），
  也可處理照片與整個資料夾；4K 片建議加 `--max-height 1080`。

---

## 三、影片時間一致性 — [`lib/temporal.js`](lib/temporal.js)

1. **參數層**：每幀估出的全域量做指數移動平均（時間常數 τ 秒，以實際幀間隔計算 `α = 1 − e^{−dt/τ}`）；
   以 8×8 色度 + 8 階亮度直方圖距離偵測**換鏡頭**，換鏡頭時立即重設（不會拖泥帶水）。
   不可內插的量（例如 MLLE 的通道排序）一改變就整體重設。
2. **輸出層（盲去閃爍，免光流）**：輸入與輸出都縮成長邊 48 的粗網格；輸入幾乎沒變的格子（靜止區域）讓輸出低頻跟隨前一幀穩定值，
   移動的格子直接放行；修正量雙線性放大後加回——只動低頻，不糊細節。是 Bonneel 2015「梯度取自當前幀、低頻對齊前一輸出」的簡化版。
3. **每 N 幀重新估計**：其餘幀沿用（並平滑）上次的全域量，對 FUnIE-GAN 這類慢的估計特別有用。

---

## 四、評測結果（摘要，完整見 [`docs/results.md`](docs/results.md)、[`docs/results-video.md`](docs/results-video.md)）

**EUVP 真實水下照片**（23 張，與資料集附的參考增強圖比較；↑ 越高越好、↓ 越低越好）：

| 方法 | PSNR ↑ | SSIM ↑ | 色差 ΔE ↓ | UIQM ↑ |
|---|---|---|---|---|
| 未處理 | 17.19 | 0.680 | 23.6 | 2.73 |
| FUnIE-GAN ※ | **21.92** | **0.708** | **13.3** | 3.23 |
| NU²-Net | 19.81 | 0.705 | 16.9 | 3.24 |
| UIEC²-Net | 19.43 | 0.697 | 18.0 | 3.22 |
| Five A⁺ | 19.13 | 0.695 | 18.5 | 3.20 |
| **WaterNet** | 19.05 | 0.698 | 17.4 | 3.22 |
| **UVE-Net** | 18.94 | 0.677 | 17.7 | 3.13 |
| ULAP | 18.02 | 0.678 | 19.8 | 2.99 |
| Diverout_sim | 17.70 | 0.695 | 20.7 | 2.95 |
| IBLA | 17.61 | 0.645 | 20.8 | 2.65 |
| UWCNN | 17.44 | 0.653 | 21.6 | 3.09 |
| 色彩平衡＋融合 | 16.77 | 0.695 | 24.3 | **3.46** |
| RGHS | 15.15 | 0.627 | 25.3 | 2.67 |
| Sea-thru（ULAP 深度） | 15.13 | 0.617 | 25.8 | 3.10 |
| MLLE | 15.07 | 0.644 | 23.8 | 3.07 |
| UDCP | 11.73 | 0.453 | 37.8 | 2.81 |

粗體名稱 = 第三輪新加入的 2 種。※ FUnIE-GAN 就是用 EUVP 訓練的，在這組照片上有主場優勢；
其餘 6 個深度模型是在 UIEB / UVEB 訓練的，換到 EUVP 仍然 PSNR 全部高於未處理，除 UWCNN 外也都勝過 7 種傳統方法。
傳統方法中只有 ULAP、IBLA 的 PSNR 高於未處理——參考圖偏向「保留水色、溫和修正」，強力去色偏的方法反而扣分。

**UVE-38K 真實水下影片**（5 段、240 格，與逐格參考影片比較；App 預設影片模式：時間穩定化開）：

| 排名 | 方法 | PSNR ↑ | SSIM ↑ | 時間誤差 E_t ↓ | 每格 ms |
|---|---|---|---|---|---|
| 1 | **WaterNet** | **20.05** | 0.612 | 10.72 | 4872 |
| 2 | Five A⁺ | 19.96 | **0.618** | **10.69** | 628 |
| 3 | UIEC²-Net | 19.79 | 0.616 | 10.72 | 5555 |
| 4 | NU²-Net | 19.69 | 0.616 | 10.76 | 1277 |
| 5 | **Diverout_sim** | 19.65 | 0.589 | 11.22 | **5** |
| 6 | **UVE-Net** | 18.75 | 0.591 | 11.22 | 314 |
| 7 | RGHS | 18.30 | 0.547 | 12.25 | 44 |
| 8 | FUnIE-GAN | 17.93 | 0.576 | 11.60 | 419 |
| 9 | UWCNN | 17.80 | 0.575 | 11.50 | 879 |
| 10 | MLLE | 17.56 | 0.511 | 15.95 | 127 |
| — | 未處理 | 16.84 | 0.575 | 11.08 | — |
| 11 | 色彩平衡＋融合 | 16.24 | 0.578 | 11.59 | 104 |
| 12 | Sea-thru（ULAP 深度） | 14.80 | 0.469 | 14.40 | 246 |
| 13 | ULAP | 13.44 | 0.500 | 12.28 | 27 |
| 14 | IBLA | 13.32 | 0.426 | 12.95 | 249 |
| 15 | UDCP | 11.01 | 0.367 | 13.74 | 31 |

UVE-38K 的參考影片是從 12 種增強方法挑選、再做幀間一致化的結果；GIF 預覽為 256 色，分數適合方法間互相比較。
Diverout_sim 以每 1 秒的關鍵幀＋線性內插處理（同 DIVEROUT「高」），只是整張畫面的色階拉伸，卻排到第 5、與 NU²-Net 只差 0.04 dB，
而且每格只要 5 ms（深度模型的百分之一）。沒了 EUVP 的主場優勢，FUnIE-GAN 掉到第 8；前 4 名都是 UIEB 訓練的模型，差距在 0.4 dB 內。
每格 ms 是 Node 單執行緒 CPU、320 px 全方法處理；App 播放時改用 GPU 套用局部係數，不受這個速度限制。

**合成場景**（已知真值；水上場景經修正成像模型退化成藍水/綠水/混濁）——平均色差 ΔE（越低越好）：

| 方法 | 平均 ΔE | 每幀（640×360，Node 單執行緒） |
|---|---|---|
| 未處理 | 35.5 | — |
| **色彩平衡＋融合** | **21.1** | 661 ms |
| UWCNN | 21.4 | 1178 ms |
| MLLE | 21.8 | 297 ms |
| NU²-Net | 22.2 | 1592 ms |
| Five A⁺ | 23.3 | 774 ms |
| UVE-Net | 24.0 | 403 ms |
| UIEC²-Net | 25.9 | 6612 ms |
| FUnIE-GAN | 26.0 | 791 ms |
| WaterNet | 27.6 | 5014 ms |
| IBLA | 29.1 | 760 ms |
| Diverout_sim | 29.1 | 148 ms |
| Sea-thru（ULAP 深度） | 29.3 | 439 ms |
| RGHS | 33.7 | 171 ms |
| ULAP | 35.6 | 93 ms |
| UDCP | 49.7 | 106 ms |

**影片閃爍**（合成平移影片，亮度閃爍 0–255）：時間穩定化讓 14 種方法中的 13 種閃爍降低 **37–90%**
（例：WaterNet 3.70 → 0.46、UWCNN 3.32 → 0.49、FUnIE-GAN 1.46 → 0.14），扭曲誤差也全部下降。
例外是 RGHS（1.32 → 1.39）：它每幀的直方圖拉伸本來就會抵消輸入的曝光抖動，平滑參數反而保留了輸入本身的抖動。
UVE-Net 是影片模型，逐幀閃爍本來就最低（0.55），穩定後 0.15。
Diverout_sim 不用 App 的時間穩定化，而是 DIVEROUT 的關鍵幀內插：在這段「每幀 ±3% 曝光抖動」的合成片上，閃爍反而從逐幀的 0.62 變成 2.54——
關鍵幀之間參數固定，輸入本身的抖動被色階拉伸放大（逐幀處理時則被每幀的拉伸抵消）。真實影片（UVE-38K）上它的亮度閃爍 0.71，與 RGHS 相當。

**怎麼選**：
- **畫質優先、照片或短片**：**WaterNet**（真實影片第 1）、**NU²-Net**（照片整體最均衡）或 **UIEC²-Net**——這三個每幀都要 1–5 秒（CPU）。
- **手機上跑影片**：**Five A⁺**（0.9 MB、真實影片第 2、SSIM 與時間誤差最好）或 **UVE-Net**（最快的深度模型、閃爍最低）；傳統方法選 **1 融合**。
- **綠水、色偏重的近景**：**2 MLLE** 或 **8 FUnIE-GAN**；**淺水晴天、想保留水的氛圍**：**5 RGHS**。
- **想要 DIVEROUT 的樣子**：**15 Diverout_sim**（每格約 5 ms，手機也能即時播放，色彩只做全域拉伸、不動細節）。
- **混濁、霧感重**：**7 IBLA** 或 **4 UDCP**（白平衡開）；**6 Sea-thru** 對有遠近層次的場景最「物理」，但依賴深度先驗。

> 指標的限制：UIQM / UCIQE 會獎勵高對比、高飽和（UDCP 的 UCIQE 最高但色差最大），只能當參考；
> 合成場景的色差是「真值」意義下的比較，但退化模型是簡化的；EUVP、UVE-38K 的參考圖都是人工挑選的增強結果，不是真值。

---

## 五、檔案結構

```
index.html  style.css  app.js     介面（分割比較、播放、全部比較、匯出）
worker.js                         背景執行緒：所有運算、ONNX 模型載入與本機快取
sw.js  manifest.webmanifest       PWA（離線、安裝）
lib/core.js                       影像基礎：縮放、方框/高斯/最小值濾波、引導濾波、金字塔、Lab
lib/methods/*.js                  15 種方法（estimate / apply）；net.js = 深度模型共同外殼；diverout.js = Diverout_sim
lib/temporal.js                   時間一致性
lib/pipeline.js                   單幀管線：估計 → 平滑 → 套用 → 去閃爍 → 強度（或直接收關鍵幀內插好的參數）
lib/metrics.js                    UIQM、UCIQE、色差、PSNR、SSIM
lib/synth.js                      合成真值場景與影片（測試與「合成示範」）
models/  vendor/                  7 個 ONNX 模型、onnxruntime-web、mediabunny（npm run vendor 更新）
scripts/export_uieb_onnx.py       UIEB 權重 → ONNX 的轉檔腳本（需 torch）
scripts/export_extra_onnx.py      WaterNet、UVE-Net 權重 → ONNX
scripts/bench.mjs                 評測：合成場景、EUVP 照片、合成影片閃爍 → docs/results.md
scripts/bench-video.mjs           評測：UVE-38K 成對影片（video-report.mjs → docs/results-video.md）
tools/diverout_cc.py              Diverout_sim 命令列版（Python + numpy + OpenCV + ffmpeg）：影片、照片、資料夾
docs/diverout-model.md            DIVEROUT 調色反推模型說明（參數、來源測試、準確度、限制）
test/  scripts/                   單元測試、評測、端對端、靜態伺服器
```

## 授權

程式碼 MIT（[`LICENSE`](LICENSE)）。第三方：FUnIE-GAN 權重 MIT（[`models/FUnIE-GAN-LICENSE`](models/FUnIE-GAN-LICENSE)）、
UWCNN / UIEC²-Net / NU²-Net / Five A⁺ 的 UIEB 權重 MIT（[`models/UIEB-MODELS-LICENSE`](models/UIEB-MODELS-LICENSE)）、
WaterNet 權重 MIT（tnwei，[`models/WATERNET-LICENSE`](models/WATERNET-LICENSE)）、UVE-Net 權重 MIT（yzbouc，[`models/UVENET-LICENSE`](models/UVENET-LICENSE)）、
onnxruntime-web MIT、Mediabunny MPL-2.0（[`vendor/`](vendor)）。各方法的演算法版權屬原論文作者；本專案依論文與公開參考碼重新實作。
評測用的 EUVP 照片與 UVE-38K 影片不隨專案發佈（EUVP 由 `bench.mjs` 從 FUnIE-GAN 倉庫取得；UVE-38K 請 clone github.com/TrentQiQ/UVE-38K）。
