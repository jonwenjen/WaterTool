# 影片評測（UVE-38K 成對影片）

由 `node scripts/bench-video.mjs` 與 `scripts/video-report.mjs` 產生。資料：[UVE-38K](https://github.com/TrentQiQ/UVE-38K)（Multimedia Tools and Applications 2023）倉庫附的 5 段真實水下影片與逐格參考影片（coral、cuttlefish、dive、marine_ranching_4、shark），每段全部的格（coral 359、cuttlefish 159、dive 119、marine_ranching_4 119、shark 161），共 917 格，320 px。
參考影片是從 12 種增強方法中人工挑選、再做過幀間一致化的結果（不是真值）；GIF 為 256 色，原始與參考都經過同樣量化，分數適合方法間互相比較。

每個方法都以 App 預設的影片模式處理（時間穩定化開：τ 0.5 秒、去閃爍 0.7、每格重新估計）；Diverout_sim 用它自己的關鍵幀（每 1 秒）＋線性內插；組合方法（深度模型＋Diverout_sim 各半）的 Diverout_sim 部分同樣用關鍵幀，深度模型部分照常時間平滑。
E_t = 平均 |(O_t − O_{t−1}) − (R_t − R_{t−1})|（0–255）：輸出影片的格間變化和參考影片差多少，越低越好；亮度閃爍 = 相鄰格平均亮度差（參考影片本身為 0.10）。

LPIPS（Zhang et al., CVPR 2018，AlexNet v0.1）= 每格與參考格的深度特徵感知距離，越低越像；FID（Heusel et al., NeurIPS 2017）= 全部 917 格輸出與全部參考格的 InceptionV3 特徵分佈距離，越低整體觀感越接近參考。
FID 是「一組對一組」的分佈距離，917 格對 2048 維特徵屬於小樣本，數值會偏高、只適合方法間比較（不能和論文裡用上萬張圖算的 FID 直接比）。計算：`tools/perceptual_eval.py`。

每格 ms 是 Node 單執行緒 CPU、320 px 的整套處理時間，取自機器沒有其他工作時的另一次評測（這次 917 格的評測平行跑了很多工作，時間偏高）。

排名依**綜合評分**（0–100）：PSNR、SSIM、LPIPS、FID 各自在表中方法間做最小–最大正規化（最好 = 1、最差 = 0），四項平均 × 100。App 的方法清單用同樣的排序。

| 排名 | 方法 | 綜合 ↑ | PSNR ↑ | SSIM ↑ | LPIPS ↓ | FID ↓ | E_t ↓ | 亮度閃爍 | 每格 ms |
|---|---|---|---|---|---|---|---|---|---|
| 1 | NU²-Net ＋ Diverout_sim（各半） | 98.6 | 19.61 | 0.618 | 0.204 | 33.3 | 10.40 | 0.50 | 1796 |
| 2 | Five A⁺ ＋ Diverout_sim（各半） | 98.4 | 19.79 | 0.623 | 0.207 | 35.5 | 10.38 | 0.48 | 860 |
| 3 | FGDPA ＋ Diverout_sim（各半） | 94.5 | 19.36 | 0.618 | 0.219 | 37.8 | 10.37 | 0.50 | 110 |
| 4 | Five A⁺ 超輕量網路 | 90.5 | 19.36 | 0.627 | 0.232 | 47.5 | 10.45 | 0.41 | 628 |
| 5 | NU²-Net（Underwater Ranker） | 90.0 | 19.06 | 0.623 | 0.233 | 45.1 | 10.49 | 0.43 | 1277 |
| 6 | UIEC²-Net RGB＋HSV 雙色彩空間 | 89.5 | 19.07 | 0.622 | 0.235 | 45.5 | 10.46 | 0.43 | 5555 |
| 7 | Diverout_sim（DIVEROUT 調色模擬） | 89.5 | 18.63 | 0.590 | 0.226 | 35.7 | 10.84 | 0.60 | 5 |
| 8 | WaterNet（UIEB 基準網路） | 87.6 | 19.07 | 0.614 | 0.245 | 45.5 | 10.52 | 0.48 | 4872 |
| 9 | FGDPA 頻域引導雙路注意力 | 86.2 | 18.95 | 0.619 | 0.254 | 47.1 | 10.54 | 0.43 | 114 |
| 10 | UVE-Net（UVEB 影片增強） | 75.5 | 17.99 | 0.595 | 0.286 | 52.2 | 10.82 | 0.39 | 314 |
| 11 | RGHS 相對直方圖拉伸 | 74.0 | 17.37 | 0.558 | 0.281 | 42.3 | 11.78 | 0.56 | 44 |
| — | （未處理） | 69.0 | 16.88 | 0.585 | 0.319 | 48.2 | 10.70 | 0.37 | — |
| 12 | FUnIE-GAN 深度學習 | 64.0 | 17.29 | 0.581 | 0.325 | 62.2 | 11.12 | 0.35 | 419 |
| 13 | 色彩平衡＋多尺度融合 | 60.1 | 15.56 | 0.586 | 0.283 | 74.1 | 11.30 | 0.35 | 104 |
| 14 | UWCNN 水下場景先驗 CNN | 56.4 | 17.48 | 0.580 | 0.349 | 77.0 | 11.08 | 0.48 | 879 |
| 15 | ULAP 光衰減先驗復原 | 44.0 | 14.63 | 0.529 | 0.363 | 69.9 | 12.01 | 0.53 | 27 |
| 16 | MLLE 最小色損＋局部對比 | 33.0 | 17.20 | 0.532 | 0.424 | 102.4 | 15.59 | 0.47 | 127 |
| 17 | IBLA 模糊度＋光吸收 | 29.0 | 12.77 | 0.409 | 0.375 | 58.3 | 12.70 | 0.70 | 249 |
| 18 | Sea-thru（ULAP 深度） | 26.9 | 14.52 | 0.466 | 0.399 | 87.0 | 14.11 | 0.93 | 246 |
| 19 | UDCP 水下暗通道 | 13.0 | 10.99 | 0.387 | 0.426 | 66.4 | 13.14 | 0.42 | 31 |

### 各段 PSNR

| 方法 | coral | cuttlefish | dive | marine_ranching_4 | shark |
|---|---|---|---|---|---|
| NU²-Net ＋ Diverout_sim（各半） | 16.09 | 23.39 | 22.41 | 22.04 | 19.88 |
| Five A⁺ ＋ Diverout_sim（各半） | 16.42 | 23.47 | 23.54 | 21.17 | 19.87 |
| FGDPA ＋ Diverout_sim（各半） | 16.12 | 23.12 | 22.52 | 20.46 | 19.71 |
| Five A⁺ 超輕量網路 | 17.46 | 23.48 | 22.56 | 16.41 | 19.33 |
| NU²-Net（Underwater Ranker） | 16.93 | 23.41 | 22.24 | 16.03 | 19.39 |
| UIEC²-Net RGB＋HSV 雙色彩空間 | 17.17 | 22.76 | 23.00 | 15.54 | 19.37 |
| Diverout_sim（DIVEROUT 調色模擬） | 15.07 | 22.70 | 21.62 | 19.93 | 19.37 |
| WaterNet（UIEB 基準網路） | 16.37 | 22.96 | 20.84 | 20.30 | 19.03 |
| FGDPA 頻域引導雙路注意力 | 16.92 | 22.92 | 22.22 | 16.03 | 19.29 |
| UVE-Net（UVEB 影片增強） | 16.46 | 23.40 | 19.04 | 16.57 | 16.32 |
| RGHS 相對直方圖拉伸 | 14.73 | 22.39 | 16.36 | 20.11 | 17.01 |
| （未處理） | 16.84 | 21.00 | 18.24 | 15.62 | 12.83 |
| FUnIE-GAN 深度學習 | 15.71 | 19.97 | 19.81 | 16.03 | 17.23 |
| 色彩平衡＋多尺度融合 | 14.58 | 18.20 | 16.61 | 13.76 | 15.72 |
| UWCNN 水下場景先驗 CNN | 15.82 | 21.62 | 18.30 | 15.91 | 17.62 |
| ULAP 光衰減先驗復原 | 15.48 | 16.93 | 14.27 | 14.54 | 10.80 |
| MLLE 最小色損＋局部對比 | 15.77 | 17.96 | 19.24 | 17.46 | 17.96 |
| IBLA 模糊度＋光吸收 | 10.34 | 13.47 | 20.78 | 8.03 | 15.10 |
| Sea-thru（ULAP 深度） | 13.50 | 16.54 | 16.97 | 12.99 | 14.14 |
| UDCP 水下暗通道 | 11.09 | 15.33 | 10.76 | 7.22 | 9.45 |

### 各段 LPIPS ↓

| 方法 | coral | cuttlefish | dive | marine_ranching_4 | shark |
|---|---|---|---|---|---|
| NU²-Net ＋ Diverout_sim（各半） | 0.212 | 0.076 | 0.172 | 0.323 | 0.245 |
| Five A⁺ ＋ Diverout_sim（各半） | 0.204 | 0.074 | 0.169 | 0.371 | 0.253 |
| FGDPA ＋ Diverout_sim（各半） | 0.217 | 0.074 | 0.168 | 0.411 | 0.263 |
| Five A⁺ 超輕量網路 | 0.194 | 0.071 | 0.212 | 0.484 | 0.305 |
| NU²-Net（Underwater Ranker） | 0.204 | 0.087 | 0.206 | 0.441 | 0.305 |
| UIEC²-Net RGB＋HSV 雙色彩空間 | 0.202 | 0.069 | 0.209 | 0.458 | 0.325 |
| Diverout_sim（DIVEROUT 調色模擬） | 0.231 | 0.100 | 0.178 | 0.372 | 0.262 |
| WaterNet（UIEB 基準網路） | 0.227 | 0.083 | 0.217 | 0.428 | 0.330 |
| FGDPA 頻域引導雙路注意力 | 0.215 | 0.066 | 0.205 | 0.581 | 0.320 |
| UVE-Net（UVEB 影片增強） | 0.224 | 0.086 | 0.251 | 0.597 | 0.421 |
| RGHS 相對直方圖拉伸 | 0.290 | 0.092 | 0.312 | 0.406 | 0.333 |
| （未處理） | 0.228 | 0.150 | 0.259 | 0.604 | 0.522 |
| FUnIE-GAN 深度學習 | 0.261 | 0.145 | 0.284 | 0.715 | 0.388 |
| 色彩平衡＋多尺度融合 | 0.279 | 0.108 | 0.301 | 0.443 | 0.331 |
| UWCNN 水下場景先驗 CNN | 0.276 | 0.133 | 0.369 | 0.620 | 0.512 |
| ULAP 光衰減先驗復原 | 0.287 | 0.215 | 0.357 | 0.534 | 0.557 |
| MLLE 最小色損＋局部對比 | 0.391 | 0.298 | 0.454 | 0.536 | 0.515 |
| IBLA 模糊度＋光吸收 | 0.405 | 0.204 | 0.223 | 0.642 | 0.394 |
| Sea-thru（ULAP 深度） | 0.373 | 0.270 | 0.328 | 0.667 | 0.440 |
| UDCP 水下暗通道 | 0.371 | 0.201 | 0.464 | 0.675 | 0.558 |

## 組合方法：深度模型 ＋ Diverout_sim 各取一半

**想法**：Diverout_sim 是整支片關鍵幀的全域色階，整體顏色最接近參考（單一方法中 LPIPS 0.226、FID 35.7 最好），但局部對比與 PSNR、SSIM 較弱；
深度模型是局部色彩轉換，PSNR、SSIM 最好，整體顏色（LPIPS、FID）較弱。兩者的誤差方向不同，把結果各取一半平均，誤差會互相抵消一部分。

**做法**（`lib/methods/blend.js`、`lib/pipeline.js` 的 `runBlend`）：out = (1 − s)·深度模型 + s·Diverout_sim，s 預設 0.5（參數「Diverout_sim 比例」可調）。
深度模型部分照常處理（含時間平滑）；Diverout_sim 部分影片用整支片的關鍵幀（同單獨的 Diverout_sim），照片就在那一張估計。
播放與快速匯出時兩條路都在 GPU 上算：深度模型的關鍵幀係數內插 ＋ Diverout_sim 的 3×4 矩陣內插，在同一個著色器裡依比例混合（`player-gl.js` 的 `matW`）。

**評測**：與上表其他方法完全相同（UVE-38K 5 段 917 格、App 影片模式、`bench-video.mjs --blends`）。四個候選都評測，App 用綜合評分前三：

| 組合 | 綜合 | PSNR ↑ | SSIM ↑ | LPIPS ↓ | FID ↓ | E_t ↓ | 亮度閃爍 | EUVP PSNR／SSIM／LPIPS | 狀態 |
|---|---|---|---|---|---|---|---|---|---|
| NU²-Net ＋ Diverout_sim | 98.6 | 19.61 | 0.618 | **0.204** | **33.3** | 10.40 | 0.50 | 18.96／0.718／0.256 | App（第 1） |
| Five A⁺ ＋ Diverout_sim | 98.4 | **19.79** | **0.623** | 0.207 | 35.5 | 10.38 | 0.48 | 18.83／0.713／0.257 | App（第 2） |
| UIEC²-Net ＋ Diverout_sim | 98.3 | 19.68 | 0.620 | 0.204 | 35.2 | 10.39 | 0.50 | 18.90／0.712／0.254 | 只評測（分數略低，而且 UIEC²-Net 比 NU²-Net 慢約 4 倍） |
| FGDPA ＋ Diverout_sim | 94.5 | 19.36 | 0.618 | 0.219 | 37.8 | 10.37 | 0.50 | 18.83／**0.722**／**0.253** | App（第 3，最快：每格約 0.1 秒） |
| 對照：Five A⁺（單獨） | 90.5 | 19.36 | 0.627 | 0.232 | 47.5 | 10.45 | 0.41 | 19.13／0.695／0.274 | |
| 對照：NU²-Net（單獨） | 90.0 | 19.06 | 0.623 | 0.233 | 45.1 | 10.49 | 0.43 | 19.81／0.705／0.264 | |
| 對照：Diverout_sim（單獨） | 89.5 | 18.63 | 0.590 | 0.226 | 35.7 | 10.84 | 0.60 | 17.70／0.695／0.267 | |

（EUVP = 23 張真實水下照片，未處理 17.19／0.680／0.303，見 [results.md](results.md)。綜合評分只用 UVE-38K 影片的四項分數。）

**結論**：
- **UVE-38K 影片上，組合方法排前三**：Five A⁺ ＋ Diverout_sim PSNR 19.79（單一方法最好的 Five A⁺ 是 19.36），NU²-Net ＋ Diverout_sim LPIPS 0.204、FID 33.3 是全部最好。
  三個組合的 PSNR 都好過單獨的深度模型、LPIPS 都好過單獨的 Diverout_sim；FID 除了 FGDPA 組合（37.8，略差於 Diverout_sim 的 35.7）也都更好。
  SSIM 介於兩者之間（比單獨的深度模型低 0.001–0.005）。
  E_t（10.37–10.40）比兩個組成方法都低：兩者各自的格間變化部分抵消。亮度閃爍介於兩者之間。
- **EUVP 照片上結果不一樣**：組合方法 SSIM、LPIPS 比組成的深度模型好，但 PSNR 低 0.3–0.9 dB。EUVP 的參考圖是另一種風格的增強結果，
  Diverout_sim 單獨在 EUVP 上只有 17.70，平均進去後拉低了 PSNR。影片（UVE-38K）才是 App 的主要用途，排序依影片分數。
- **比例**：Five A⁺ ＋ Diverout_sim 的比例 0.3／0.4／0.5／0.6／0.7 的 PSNR 為 19.75／19.80／19.79／19.70／19.53（由兩者的輸出直接平均算得），0.4–0.5 最好；預設用 0.5。
- **速度**：組合方法的計算量 = 深度模型 ＋ Diverout_sim（每格多約 5 ms）。播放與快速匯出在 GPU 上混合，和單獨的深度模型一樣順。
- 這是在拿來排序的同一組影片上評測的結果（比例 0.5 是事先決定、不是在這組資料上挑的）；EUVP 的結果顯示換一種參考風格時，PSNR 不一定更好。

## 新模型評測：手機級（2024–2026）、大型對照模型與通用還原模型

**怎麼挑的**：搜尋 2024–2026 年的水下影像／影片增強研究。手機級的條件是參數少、全卷積、能轉 ONNX 在手機瀏覽器跑；
另外把常被引用、但模型較大的幾個（U-shape Transformer、UnDIVE、DM-UW、UVENet、Shallow-UWnet）也拿來當對照，看「大模型」在同一組影片上是否真的比較好。
權重都是原作公開的：前 6 個放在 GitHub 倉庫裡，後 5 個放在原作 README 連結的 Google Drive。

| 模型 | 出處 | 權重 | 授權 |
|---|---|---|---|
| MobileIE | Yan et al., ICCV 2025（手機即時影像增強，含水下任務的 UIEB 權重） | [AVC2-UESTC/MobileIE](https://github.com/AVC2-UESTC/MobileIE) | Apache-2.0 |
| FGDPA | Zhang et al., ICME 2026（以 MobileIE 為基礎、加頻域引導注意力，UIEB 訓練） | [LethyZhang/FGDPA](https://github.com/LethyZhang/FGDPA) | Apache-2.0 |
| LU2Net | Yang et al., arXiv 2406.14973（2024，LSUI 訓練） | [MrYangHaodong/LU2Net](https://github.com/MrYangHaodong/LU2Net) | 未聲明 |
| LiteEnhanceNet | Zhang et al., Expert Systems with Applications 2024 | [zhangsong1213/LiteEnhanceNet](https://github.com/zhangsong1213/LiteEnhanceNet) | 未聲明 |
| AquaFastNet | Hasib et al., 2026 修訂稿（UIEB／EUVP） | [ShahidHasib586/AquaFastNet](https://github.com/ShahidHasib586/AquaFastNet) | Apache-2.0 |
| PIC-UIE | arXiv 2609.33318（2026，YCbCr 空間預測轉換、深度只用於訓練監督，UIEB 微調） | [OceanZ9639/PIC-UIE](https://github.com/OceanZ9639/PIC-UIE) | 未聲明 |
| Shallow-UWnet | Naik et al., AAAI 2021（EUVP 訓練） | [mkartik/Shallow-UWnet](https://github.com/mkartik/Shallow-UWnet)（Google Drive） | MIT |
| U-shape Transformer | Peng et al., IEEE TIP 2023（LSUI 訓練） | [LintaoPeng/U-shape_Transformer…](https://github.com/LintaoPeng/U-shape_Transformer_for_Underwater_Image_Enhancement)（Google Drive） | MIT |
| UnDIVE | Srinath et al., WACV 2025（擴散 U-Net 編碼器當生成先驗＋HDRNet 雙邊網格；兩組權重，見下） | [suhas-srinath/undive](https://github.com/suhas-srinath/undive)（Google Drive） | 未聲明 |
| DM-UW | Tang et al., ACM MM 2023（Transformer 條件擴散模型，演化搜尋出的 10 步跳步取樣） | [piggy2009/DM_underwater](https://github.com/piggy2009/DM_underwater)（Google Drive） | 未聲明 |
| UVENet | Du et al., arXiv 2403.11506（2024，ConvNeXt-T 骨幹、一次吃 5 格的影片網路，SUVE 合成影片訓練） | [ddz16/UVENet](https://github.com/ddz16/UVENet)（Google Drive） | 未聲明 |

#### 沒有權重或程式的候選（PGMamba、USWformer、UCS-Net、Rep-UWnet、UIVE）

這幾個拿不到權重（或沒有程式），無法評測還原品質，只能用原作程式（隨機權重）量計算量與速度。計算量 = 256×256 輸入的乘加次數（`torch.utils.flop_counter`）；
速度 = 這台機器 CPU 單執行緒（PyTorch 或 ONNX Runtime；量的時候機器上還有其他評測在跑，只看數量級；手機瀏覽器的 WASM 通常更慢）。
對照（同樣條件、PyTorch）：FGDPA 4,234 參數、0.25 GMACs、68 ms；PIC-UIE 9,486 參數、0.05 GMACs、79 ms。

| 模型 | 出處 | 程式／權重 | 參數 | 計算量（256²） | 實測速度 | 結論 |
|---|---|---|---|---|---|---|
| PGMamba | AAAI 2026（物理模型引導的全域 Mamba） | 程式在 GitHub，**權重未公開** | 460 萬 | 14.7 GMACs | 128²：2.8 秒；256²：約 11 秒 | ✗ 不適合即時 |
| USWformer | Mishra et al., WACV 2025（稀疏小波自注意力） | **沒有官方程式與權重**；GitHub 上只有一個非官方重現（結構與論文不符：1,932 萬參數、23 GMACs） | 119 萬（論文） | — | — | 無法評估 |
| UCS-Net | — | 找不到論文程式或權重 | — | — | — | 無法評估 |
| Rep-UWnet | Liu et al., Sensors 2024（RepVGG 重參數化，以 Shallow-UWnet 為基礎） | **沒有公開程式與權重** | 45 萬（論文） | 估計約 30 GMACs（全解析度卷積、不降採樣：參數 × 像素數） | — | ✗ 計算量比 PGMamba 還大 |
| UIVE | Luo et al., Frontiers in Marine Science 2025（無 BN 殘差塊 U-Net＋自適應亮度後處理） | **沒有公開程式與權重** | — | — | 論文：640×480 36 FPS（論文自己的硬體） | 可能可行，但無法驗證 |

- **PGMamba**：Mamba 的選擇性掃描需要 CUDA 運算子（`mamba_ssm`）。這裡改寫成分塊 cumsum 掃描（與參考實作差 < 10⁻⁶），
  隨機 Gumbel 路由改成 argmax、`torch.sort` 改成 topk 後才能轉出 ONNX（固定尺寸、8–13 千個節點、約 20 MB）。即使轉得出來也是 FGDPA 的約 58 倍計算量；
  原作的 Gumbel 路由每格隨機，影片會閃爍。最多只能偶爾處理關鍵幀，而且沒有權重可用。
- **USWformer**：論文只有 119 萬參數，但官方沒有釋出程式；非官方重現的結構與論文不同，量出來的數字不能代表原作。
- **Rep-UWnet、UIVE**：論文有公開，但沒有程式和權重（MDPI、Frontiers 的頁面在這個環境也連不到）。Rep-UWnet 推論時是重參數化後的全解析度 CNN，
  結構類似 Shallow-UWnet（22 萬參數，上表實測 WASM 3.4 秒），參數多一倍，只會更慢。
- 若之後拿到 UCS-Net 的論文或程式連結，可以用同樣的方式再評估。

**轉換與驗證**（`scripts/export_mobile_onnx.py`）：直接用原作倉庫的網路定義與權重（以 weights_only 方式載入，不執行檔案裡的程式），
各模型原作測試流程的後處理一起放進 ONNX，再與原作 PyTorch 的輸出逐像素比對：

| 模型 | ONNX 與原作的最大差 | 需要的改寫 |
|---|---|---|
| MobileIE、LiteEnhanceNet、AquaFastNet、Shallow-UWnet | < 2×10⁻⁶ | 無 |
| FGDPA | < 2×10⁻⁶ | 32×32 FFT 改成等價的 DFT 矩陣乘法 |
| LU2Net | < 2×10⁻⁶ | same 填補改成明確填補（ONNX Runtime 不支援 same 加空洞卷積） |
| PIC-UIE | 2×10⁻⁶（34 張真實水下畫面上 Newton–Schulz 與原作 eigh 差 7.7×10⁻⁷） | 3×3 共變異數的 −1/2 次方：eigh 改成 Newton–Schulz 迭代 |
| U-shape Transformer | 4×10⁻⁶ | 無（取最大尺度輸出＋原作 save_image 的 min-max） |
| UnDIVE | 3.5×10⁻⁵（含整張 min-max 放大；遠小於 1/255） | 雙邊網格切片：原作 jit 版改成雙線性放大＋gather，權重相同 |
| DM-UW | 2.9×10⁻⁶（256×256） | 10 步 DDIM 展開在同一張圖；起始雜訊固定（CPU 產生器、原作種子 44444） |
| UVENet | 7×10⁻⁷ | 無（評測時直接用原作程式推論，見下） |

參數量與論文一致（MobileIE 4,075、FGDPA 4,234、PIC-UIE 9,486、Shallow-UWnet 219,456）。AquaFastNet 釋出的實作是 309,862 個參數（論文表格寫 107,670，作者 README 已註明這個落差）。

**評測方式**：與上面 16 種方法完全相同——同一組 UVE-38K 影片（5 段、全部 917 格）、App 預設的影片模式（時間穩定化開），
網路在長邊 256 跑（原作壓成 256×256 測試的 LU2Net、LiteEnhanceNet、Shallow-UWnet、U-shape Transformer、DM-UW 同樣壓成 256×256），再擬合成局部色彩轉換套回原解析度。例外：
- **DM-UW** 每格要 2 分鐘以上（WASM），逐格跑 917 格不實際，改用 App 的快速匯出方式：每 1 秒一個關鍵幀、中間內插（`bench-video.mjs --keys 1`）。
  下面「快速匯出」一節的比較顯示，關鍵幀內插的分數和逐格處理幾乎相同。
- **UVENet** 一次吃前後共 5 格，先用 `tools/uvenet_infer.py` 照原作方式（5 格滑動視窗、256×256、頭尾重複第一／最後一格）算出網路輸出，
  再由 `bench-video.mjs --pre` 走同樣的擬合與影片模式。
- **UnDIVE** 有兩組權重：官方的 `UnDIVE_100` 是在 UIEB 預訓練後、再用 UVE-38K 影片加時間一致性損失訓練（這 5 段可能在它的訓練資料裡）；
  `UIEB_pretrain_150` 只用 UIEB 訓練，當作沒看過 UVE-38K 的對照。兩組都評測。

LPIPS、FID 的算法同上一節（`tools/perceptual_eval.py`）。🆕 = 新模型（含下面「通用影像還原模型」一節的 8 個）；排名依 PSNR（同分看 SSIM）。

| 排名 | 方法 | PSNR ↑ | SSIM ↑ | LPIPS ↓ | FID ↓ | E_t ↓ | 亮度閃爍 |
|---|---|---|---|---|---|---|---|
| 1 | Five A⁺ 超輕量網路 | 19.36 | 0.627 | 0.232 | 47.5 | 10.45 | 0.41 |
| 2 | UIEC²-Net RGB＋HSV 雙色彩空間 | 19.07 | 0.622 | 0.235 | 45.5 | 10.46 | 0.43 |
| 3 | WaterNet（UIEB 基準網路） | 19.07 | 0.614 | 0.245 | 45.5 | 10.52 | 0.48 |
| 4 | NU²-Net（Underwater Ranker） | 19.06 | 0.623 | 0.233 | 45.1 | 10.49 | 0.43 |
| 5 | **PIC-UIE 預測影像自適應校正** 🆕 | 18.97 | 0.621 | 0.242 | 44.4 | 10.56 | 0.43 |
| 6 | **FGDPA 頻域引導雙路注意力** 🆕 | 18.95 | 0.619 | 0.254 | 47.1 | 10.54 | 0.43 |
| 7 | Diverout_sim（DIVEROUT 調色模擬） | 18.63 | 0.590 | 0.226 | 35.7 | 10.84 | 0.60 |
| 8 | **DM-UW Transformer 擴散模型** 🆕 | 18.56 | 0.614 | 0.254 | 47.3 | 10.53 | 0.54 |
| 9 | **LiteEnhanceNet 深度可分離卷積** 🆕 | 18.51 | 0.614 | 0.270 | 47.4 | 10.68 | 0.37 |
| 10 | **MobileIE（手機即時影像增強）** 🆕 | 18.38 | 0.612 | 0.258 | 47.1 | 10.57 | 0.41 |
| 11 | **UnDIVE（只用 UIEB 預訓練的權重）** 🆕 | 18.28 | 0.613 | 0.291 | 48.5 | 10.74 | 0.48 |
| 12 | **AquaFastNet 輕量 U-Net＋SE** 🆕 | 18.21 | 0.610 | 0.255 | 47.2 | 10.55 | 0.54 |
| 13 | **UVENet（SUVE，5 格輸入影片網路）** 🆕 | 18.01 | 0.610 | 0.268 | 56.4 | 10.67 | 0.50 |
| 14 | UVE-Net（UVEB 影片增強） | 17.99 | 0.595 | 0.286 | 52.2 | 10.82 | 0.39 |
| 15 | **U-shape Transformer** 🆕 | 17.77 | 0.588 | 0.293 | 52.9 | 10.95 | 0.43 |
| 16 | **Shallow-UWnet 淺層壓縮網路** 🆕 | 17.58 | 0.580 | 0.340 | 64.0 | 11.20 | 0.34 |
| 17 | UWCNN 水下場景先驗 CNN | 17.48 | 0.580 | 0.349 | 77.0 | 11.08 | 0.48 |
| 18 | RGHS 相對直方圖拉伸 | 17.37 | 0.558 | 0.281 | 42.3 | 11.78 | 0.56 |
| 19 | **LU2Net 輕量 U-Net** 🆕 | 17.29 | 0.593 | 0.260 | 48.6 | 10.73 | 0.46 |
| 20 | FUnIE-GAN 深度學習 | 17.29 | 0.581 | 0.325 | 62.2 | 11.12 | 0.35 |
| 21 | **UnDIVE 擴散先驗影片增強** 🆕 | 17.26 | 0.607 | 0.287 | 57.5 | 10.71 | 0.47 |
| 22 | MLLE 最小色損＋局部對比 | 17.20 | 0.532 | 0.424 | 102.4 | 15.59 | 0.47 |
| — | （未處理） | 16.88 | 0.585 | 0.319 | 48.2 | 10.70 | 0.37 |
| 23 | **AdaIR 頻率自適應一體還原** 🆕 | 16.29 | 0.564 | 0.379 | 62.6 | 11.19 | 0.37 |
| 24 | **DehazeFormer 去霧 Transformer** 🆕 | 15.84 | 0.557 | 0.379 | 74.4 | 11.16 | 0.36 |
| 25 | **MoCE-IR 專家混合一體還原** 🆕 | 15.83 | 0.559 | 0.379 | 61.5 | 11.12 | 0.35 |
| 26 | **MoCE-IR-S（小型版）** 🆕 | 15.71 | 0.553 | 0.382 | 61.5 | 11.11 | 0.36 |
| 27 | 色彩平衡＋多尺度融合 | 15.56 | 0.586 | 0.283 | 74.1 | 11.30 | 0.35 |
| 28 | **PromptIR 提示式一體還原** 🆕 | 15.30 | 0.549 | 0.383 | 61.7 | 11.09 | 0.39 |
| 29 | **InstructIR 文字指令還原（指令：修照片的顏色）** 🆕 | 15.09 | 0.547 | 0.395 | 72.6 | 11.01 | 0.42 |
| 30 | **ICELUT 查表式修圖** 🆕 | 14.67 | 0.529 | 0.418 | 76.1 | 11.13 | 0.43 |
| 31 | ULAP 光衰減先驗復原 | 14.63 | 0.529 | 0.363 | 69.9 | 12.01 | 0.53 |
| 32 | Sea-thru（ULAP 深度） | 14.52 | 0.466 | 0.399 | 87.0 | 14.11 | 0.93 |
| 33 | **OneRestore 複合退化還原** 🆕 | 14.14 | 0.558 | 0.392 | 68.2 | 11.07 | 0.62 |
| 34 | IBLA 模糊度＋光吸收 | 12.77 | 0.409 | 0.375 | 58.3 | 12.70 | 0.70 |
| 35 | UDCP 水下暗通道 | 10.99 | 0.387 | 0.426 | 66.4 | 13.14 | 0.42 |

#### 手機適用性（新模型與 App 現有的深度模型）

推論時間 = onnxruntime-web WASM 單執行緒、只算網路本身（`scripts/net-speed.mjs`，這台機器上量的；手機瀏覽器同樣用 WASM，實際速度依手機而定）。
「720p 原畫面」= 不縮小、直接把 1280×704（約 720p，FGDPA 要求邊長為 32 的倍數）整張丟進網路（只有可變尺寸的模型能這樣跑）。

| 方法 | 參數量 | 模型檔 | 推論（App 用的尺寸） | 推論（720p 原畫面） | EUVP PSNR | EUVP LPIPS |
|---|---|---|---|---|---|---|
| **FGDPA** 🆕 | 4,234 | 34 KB | 49.8 ms（256×160） | 991 ms | 19.24 | 0.259 |
| **MobileIE** 🆕 | 4,075 | 20 KB | 33.7 ms（256×160） | 1019 ms | 19.05 | 0.260 |
| **LU2Net** 🆕 | 175,571 | 712 KB | 581.5 ms（256×256） | — | 21.44 | 0.251 |
| **LiteEnhanceNet** 🆕 | 13,688 | 65 KB | 437.8 ms（256×256） | — | 19.21 | 0.263 |
| **AquaFastNet** 🆕 | 309,862 | 1.2 MB | 164.5 ms（256×160） | 3942 ms | 23.30 | 0.233 |
| **PIC-UIE** 🆕 | 9,486 | 109 KB | 18.6 ms（256×144） | 341 ms | 19.06 | 0.266 |
| **Shallow-UWnet** 🆕 | 219,456 | 862 KB | 3366.6 ms（256×256） | — | 20.80 | 0.269 |
| **U-shape** 🆕 | 3,159 萬 | 120.1 MB | 4991.9 ms（256×256） | — | 22.02 | 0.247 |
| **UnDIVE** 🆕 | 672 萬 | 25.7 MB | 2901.9 ms（256×144） | 3901 ms | 15.12 | 0.292 |
| **UnDIVE-UIEB** 🆕 | 672 萬 | 25.7 MB | 2974.0 ms（256×144） | 4256 ms | 16.75 | 0.293 |
| **DM-UW** 🆕 | 1,071 萬 | 45.4 MB | 127448.3 ms（256×256） | — | 20.58 | 0.264 |
| **PromptIR** 🆕 | 3,538 萬 | 137.8 MB | 25661.0 ms（256×160） | — | 16.87 | 0.333 |
| **AdaIR** 🆕 | 2,874 萬 | 111.0 MB | 37241.0 ms（256×256） | — | 16.95 | 0.333 |
| **MoCE-IR** 🆕 | 2,535 萬 | 103.3 MB | 18595.2 ms（256×160） | — | 16.95 | 0.332 |
| **MoCE-IR-S** 🆕 | 1,148 萬 | 50.4 MB | 10000.0 ms（256×160） | — | 16.88 | 0.333 |
| **InstructIR** 🆕 | 1,584 萬 | 61.1 MB | 2090.9 ms（256×160） | — | 15.23 | 0.352 |
| **DehazeFormer** 🆕 | 124 萬 | 5.8 MB | 4500.5 ms（256×256） | — | 16.27 | 0.342 |
| **OneRestore** 🆕 | 1,798 萬 | 69.2 MB | 3273.1 ms（256×256） | — | 16.78 | 0.334 |
| **ICELUT** 🆕 | 查表式 | 5.4 MB | 55.9 ms（256×256） | — | 14.98 | 0.369 |
| **UVENet** 🆕 | 3,320 萬 | 141.2 MB | 7833.1 ms（256×256×5 格） | — | — | — |
| Five A+ | 9 千 | 832 KB | 869.2 ms（256×256） | — | 19.13 | 0.274 |
| UIEC²-Net | 53 萬 | 2.1 MB | 8421.2 ms（256×256） | — | 19.43 | 0.265 |
| WaterNet | 109 萬 | 4.2 MB | 6452.9 ms（256×144） | — | 19.05 | 0.266 |
| NU²-Net | 315 萬 | 12.0 MB | 1957.3 ms（256×256） | — | 19.81 | 0.264 |
| UVE-Net | 53 萬 | 2.1 MB | 342.9 ms（320×176） | — | 18.94 | 0.280 |
| UWCNN | 4 萬 | 160 KB | 1409.0 ms（256×256） | — | 17.44 | 0.362 |
| FUnIE-GAN | 702 萬 | 13.4 MB | 371.3 ms（256×160） | — | 21.92 | 0.248 |

**注意**：EUVP 照片分數有主場優勢的：AquaFastNet（權重用 EUVP 測試集挑最佳回合）、Shallow-UWnet、FUnIE-GAN（EUVP 訓練）、
LU2Net 與 U-shape Transformer（LSUI 訓練，LSUI 收錄了部分 EUVP、UIEB 的圖）。UVENet 是多格輸入的影片網路，不評 EUVP 單張照片。
UVE-38K 影片對所有新模型都是沒看過的資料，只有官方 UnDIVE 可能看過（見上）。

**結論**：
- **PIC-UIE 是這次最好的新模型**：只有 9,486 個參數（109 KB），PSNR 18.97、SSIM 0.621 排第 5，只比第 1 名 Five A⁺ 低 0.39 dB；
  LPIPS 0.242 好過 WaterNet、FGDPA，FID 44.4 是所有深度模型最低。推論 18.6 ms（256×144）是所有模型最快，不縮小直接跑 720p 也只要 0.34 秒。
- **FGDPA**（已在 App 裡）緊接在後：PSNR 18.95、SSIM 0.619，推論 50 ms。PIC-UIE 和 FGDPA 都只比 App 的前 4 名（Five A⁺、UIEC²-Net、WaterNet、NU²-Net，19.06–19.36）
  低 0.1–0.4 dB，但快 17–450 倍。
- **大模型沒有比較好**：DM-UW（1,071 萬參數、擴散 10 步）PSNR 18.56 排第 8，比 PIC-UIE 低，每格卻要 127 秒；
  UVENet（3,320 萬、5 格輸入）18.01、U-shape Transformer（3,159 萬、120 MB）17.77、Shallow-UWnet 17.58，都輸給 4 千–1 萬參數的 FGDPA、PIC-UIE。
  這組真實影片上，訓練資料和處理流程比模型大小重要。
- **UnDIVE 的官方權重反而比較差**：用 UVE-38K 再訓練的 `UnDIVE_100` PSNR 17.26、FID 57.5，比只用 UIEB 預訓練的 18.28、48.5 都差，看不到主場優勢；
  EUVP 上兩組都低於未處理（15.12、16.75 vs 17.19）。它的輸出最後做整張 min-max 拉伸（原作推論流程），可能是分數偏低的原因之一。
- **時間一致性**：所有深度模型的 E_t 都在 10.45–11.20，都經過 App 的時間穩定化；UVENet 本身吃多格輸入，E_t 10.67，沒有比單格模型更好。
- **手機適用性**：PIC-UIE、FGDPA、MobileIE（19–50 ms）適合即時預覽；AquaFastNet、LiteEnhanceNet、LU2Net（160–580 ms）可用於匯出；
  UnDIVE、Shallow-UWnet、U-shape Transformer、UVENet（2.9–7.8 秒）只能用關鍵幀快速匯出，除了 Shallow-UWnet（0.8 MB）模型檔都要 26–141 MB；DM-UW 每格 127 秒，不可行。
- 授權：MobileIE、FGDPA、AquaFastNet 是 Apache-2.0，Shallow-UWnet、U-shape Transformer 是 MIT；**FGDPA 已加入 App**（`lib/methods/fgdpa.js`）。
  PIC-UIE、LU2Net、LiteEnhanceNet、UnDIVE、DM-UW、UVENet 的倉庫沒有授權聲明，暫不散布它們的權重（`models/eval/` 不進 git）。

### 通用影像還原模型（2023–2025）套用在水下影片

**怎麼挑的**：搜尋近 3 年（2023–2025）的通用影像還原論文，挑出退化種類和水下相近的模型。水下影片的問題是散射造成的霧化、偏色和低光，
對應到「一體式還原」（一個模型同時處理霧、低光等多種退化）、去霧與修圖。條件是原作公開權重，而且能轉成 ONNX 在瀏覽器跑。
這些模型都**沒有用水下資料訓練**，評測的目的是確認「拿現成的通用還原模型直接套在水下影片」是否可行。

| 模型 | 出處 | 用的權重（任務） | 權重來源 | 授權 |
|---|---|---|---|---|
| PromptIR | Potlapalli et al., NeurIPS 2023（[arXiv 2306.13090](https://arxiv.org/abs/2306.13090)） | 一體式三合一（雜訊／雨／霧） | [va1shn9v/PromptIR](https://github.com/va1shn9v/PromptIR)（Google Drive） | 學術用途授權（非商用） |
| AdaIR | Cui et al., ICLR 2025（[arXiv 2403.14614](https://arxiv.org/abs/2403.14614)） | 一體式五合一（雜訊／雨／霧／模糊／低光） | [c-yn/AdaIR](https://github.com/c-yn/AdaIR)（Google Drive） | MIT |
| MoCE-IR、MoCE-IR-S | Zamfir et al., CVPR 2025（[arXiv 2411.18466](https://arxiv.org/abs/2411.18466)） | 一體式五合一（大、小兩種） | [eduardzamfir/MoCE-IR](https://github.com/eduardzamfir/MoCE-IR)（Google Drive） | CC BY-NC-SA 4.0 |
| InstructIR | Conde et al., ECCV 2024（[arXiv 2401.16468](https://arxiv.org/abs/2401.16468)） | 七種任務、依文字指令（含 MIT-5K 修圖） | [mv-lab/InstructIR](https://github.com/mv-lab/InstructIR)（Hugging Face） | MIT |
| DehazeFormer | Song et al., IEEE TIP 2023（[arXiv 2204.03883](https://arxiv.org/abs/2204.03883)） | 作者 Hugging Face 展示版（預測逐像素色調曲線的 MCT 版） | [IDKiro/DehazeFormer](https://github.com/IDKiro/DehazeFormer)（[HF Space](https://huggingface.co/spaces/IDKiro/DehazeFormer_Demo)） | MIT |
| OneRestore | Guo et al., ECCV 2024（[arXiv 2407.04621](https://arxiv.org/abs/2407.04621)） | 複合退化（低光＋霧＋雨＋雪，CDD-11），自動判斷退化種類 | [gy65896/OneRestore](https://github.com/gy65896/OneRestore)（Hugging Face） | 未聲明 |
| ICELUT | Yang et al., ECCV 2024（[arXiv 2403.19238](https://arxiv.org/abs/2403.19238)） | 全域 3D 查表修圖（FiveK 專家修圖） | [Stephen0808/ICELUT](https://github.com/Stephen0808/ICELUT)（倉庫內） | 未聲明 |
| AnyIR | Ren et al., 2025（[arXiv 2504.14249](https://arxiv.org/abs/2504.14249)） | — | [Amazingren/AnyIR](https://github.com/Amazingren/AnyIR) | **權重未公開，無法評測** |

DehazeFormer 的戶外（RESIDE-outdoor）權重在 Google Drive 上超過下載配額，改用作者 Hugging Face 展示頁的權重。

**轉換與驗證**（`scripts/export_restoration_onnx.py`）：同樣直接用原作的網路定義與權重（weights_only 載入；ICELUT 的查表檔用只允許 numpy 陣列的受限 unpickler），
轉出 ONNX 後與原作 PyTorch 輸出逐像素比對，最大差都 ≤ 6×10⁻⁶（ICELUT 是和原作編譯的 C++ 三線性插值核心比）。需要的改寫：

| 模型 | 改寫 |
|---|---|
| AdaIR | `torch.fft` 頻域低通改成等價的 DFT 矩陣乘法（可分離遮罩） |
| MoCE-IR、MoCE-IR-S | `rfft2` 循環卷積改成 DFT 矩陣乘法；稀疏專家派送改成密集加權（數學上相同）；**去掉測試時路由加的隨機雜訊**（原作推論每次結果不同，影片會閃爍） |
| InstructIR | 文字編碼器（BGE）不放進 ONNX：指令固定為「please I want this underwater photo for my photo album, can you edit it as a photographer and fix the colors」，先算好嵌入向量，分類結果為「修圖」任務 |
| DehazeFormer、OneRestore、ICELUT | 抗鋸齒縮放／區域平均改成預先算好的可分離矩陣（輸入固定 256×256）；ICELUT 的三線性 3D 查表改成 8 角 gather |
| OneRestore | 退化種類由內建的 ResNet-18 分類器自動判斷（與原作相同，一起放進 ONNX） |

AdaIR 的頻率遮罩、DehazeFormer、OneRestore、ICELUT 只能用固定 256×256 輸入（和 LU2Net 等一樣壓成正方形再套回）；其他用長邊 256。
評測方式與上面完全相同（UVE-38K 5 段 917 格、App 影片模式、擬合局部色彩轉換套回原解析度）。大模型的 917 格用原生 ONNX Runtime 4 執行緒跑
（`node-net.mjs` 的 `ORT_NODE`，與 WASM 同一個 ONNX 檔、輸出相同），只為了縮短評測時間；下表的推論時間仍是 WASM 單執行緒。

**結果**（35 個方法中的排名；上面總表已含這 8 個模型，依 PSNR 排序）：

| 模型 | PSNR ↑ | SSIM ↑ | LPIPS ↓ | FID ↓ | PSNR 名次 | SSIM 名次 | LPIPS 名次 | FID 名次 | EUVP PSNR／LPIPS |
|---|---|---|---|---|---|---|---|---|---|
| （未處理） | 16.88 | 0.585 | 0.319 | 48.2 | — | — | — | — | 17.19／0.303 |
| AdaIR | 16.29 | 0.564 | 0.379 | 62.6 | 23 | 22 | 25 | 24 | 16.95／0.333 |
| DehazeFormer | 15.84 | 0.557 | 0.379 | 74.4 | 24 | 26 | 26 | 31 | 16.27／0.342 |
| MoCE-IR | 15.83 | 0.559 | 0.379 | 61.5 | 25 | 23 | 27 | 20 | 16.95／0.332 |
| MoCE-IR-S | 15.71 | 0.553 | 0.382 | 61.5 | 26 | 27 | 28 | 21 | 16.88／0.333 |
| PromptIR | 15.30 | 0.549 | 0.383 | 61.7 | 28 | 28 | 29 | 22 | 16.87／0.333 |
| InstructIR | 15.09 | 0.547 | 0.395 | 72.6 | 29 | 29 | 31 | 29 | 15.23／0.352 |
| ICELUT | 14.67 | 0.529 | 0.418 | 76.1 | 30 | 31 | 33 | 32 | 14.98／0.369 |
| OneRestore | 14.14 | 0.558 | 0.392 | 68.2 | 33 | 25 | 30 | 27 | 16.78／0.334 |

（LPIPS 名次依未四捨五入的值；AdaIR、DehazeFormer、MoCE-IR 顯示都是 0.379。）

**結論**：
- **8 個通用還原模型全部比未處理的原片差**：PSNR、SSIM、LPIPS 都輸給原片（PSNR 16.88、LPIPS 0.319），EUVP 照片上也一樣（全部低於原片 17.19、0.303）。
  最好的 AdaIR 排第 23／35，只贏過傳統的色彩平衡融合、ULAP、Sea-thru、IBLA、UDCP。
- **原因是它們不修正水下偏色**：通用還原學的是「去霧／去雨／提亮」，不學顏色衰減。實際看輸出，綠色偏色不但沒去掉，
  去霧造成的對比增強還把綠色加深（例如 marine_ranching_4 這段：原片平均 RGB 約 (132, 176, 123)，AdaIR 後 (116, 168, 106)，PromptIR 後 (93, 158, 80)；參考答案是 (170, 164, 152)）。
  水下專用模型（Five A⁺、PIC-UIE、FGDPA）會把綠色偏色壓下去（同一格 Five A⁺ 後約 (125, 129, 144)），所以排名在前。
- InstructIR 就算用文字指令要求「修正水下照片的顏色」，選到的也是一般修圖任務（MIT-5K），一樣不會去綠。ICELUT（FiveK 修圖查表）同理。
- 速度（WASM 單執行緒，見下面手機適用性表）：ICELUT 56 ms 最快（全域查表，但分數最差之一）；InstructIR 2.1 秒、OneRestore 3.3 秒、DehazeFormer 4.5 秒、MoCE-IR-S 10 秒、MoCE-IR 18.6 秒、PromptIR 25.7 秒、AdaIR 37.2 秒，
  除了 ICELUT、DehazeFormer（5–6 MB）模型檔都要 50–138 MB。就算畫質可用，也只能用關鍵幀快速匯出。
- **因此這 8 個都不加入 App**。要用這類架構做水下還原，需要用水下成對資料（UIEB、LSUI 等）重新訓練或微調——那已經等於另一個水下專用模型，
  而上表顯示 4 千–1 萬參數的水下專用模型（FGDPA、PIC-UIE）就已經接近最好的成績。
- 授權：PromptIR（學術非商用）、MoCE-IR（CC BY-NC-SA）不能商用；OneRestore、ICELUT 沒有授權聲明。轉好的 ONNX 只留在本機評測（`models/eval/` 不進 git）。

## 深度模型的快速匯出：關鍵幀＋內插 vs 逐幀

App 的「深度模型影片匯出：快速」只在每 0.5 秒（或 1 秒）的關鍵幀跑網路，中間格把前後關鍵幀的色彩轉換係數線性內插。
下表用同樣 5 段影片的前 48 格（共 240 格，較早的一次評測，數字不能和上面 917 格的主表直接比）比較（`node scripts/bench-video.mjs <imgs> --frames 48 --methods … --keys 0.5`）。逐幀 = 同一批 240 格的影片模式（每格估計＋時間平滑＋去閃爍）。
每格 ms 是 Node 單執行緒 CPU（含 CPU 套用）；App 的快速匯出由 GPU 套用，實際更快。

| 方法 | 逐幀 PSNR / SSIM / E_t / 閃爍 / ms | 關鍵幀 0.5 秒 | 關鍵幀 1 秒 |
|---|---|---|---|
| WaterNet（UIEB 基準網路） | 20.05 / 0.612 / 10.72 / 0.63 / 4872 | 20.31 / 0.617 / 10.52 / 0.76 / 738 | 20.24 / 0.616 / 10.59 / 0.66 / 440 |
| Five A⁺ 超輕量網路 | 19.96 / 0.618 / 10.69 / 0.44 / 628 | 20.14 / 0.623 / 10.53 / 0.59 / 98 | 19.92 / 0.620 / 10.58 / 0.36 / 60 |
| UIEC²-Net RGB＋HSV 雙色彩空間 | 19.79 / 0.616 / 10.72 / 0.47 / 5555 | 20.11 / 0.620 / 10.53 / 0.60 / 743 | 20.03 / 0.619 / 10.61 / 0.48 / 435 |
| NU²-Net（Underwater Ranker） | 19.69 / 0.616 / 10.76 / 0.49 / 1277 | 19.82 / 0.620 / 10.59 / 0.63 / 180 | 19.69 / 0.618 / 10.65 / 0.48 / 109 |
| UVE-Net（UVEB 影片增強） | 18.75 / 0.591 / 11.22 / 0.36 / 314 | 18.92 / 0.594 / 11.08 / 0.48 / 54 | 18.81 / 0.593 / 11.13 / 0.41 / 34 |
| FUnIE-GAN 深度學習 | 17.93 / 0.576 / 11.60 / 0.32 / 419 | 18.06 / 0.580 / 11.49 / 0.37 / 69 | 18.00 / 0.579 / 11.51 / 0.35 / 47 |
| UWCNN 水下場景先驗 CNN | 17.80 / 0.575 / 11.50 / 0.51 / 879 | 17.81 / 0.579 / 11.50 / 0.99 / 125 | 17.94 / 0.579 / 11.40 / 0.57 / 75 |

關鍵幀內插的 PSNR、SSIM、E_t 全部持平或略好（內插本身就是平滑的時間變化）。0.5 秒時亮度閃爍略增（UWCNN 0.51 → 0.99 最多，約等於 Sea-thru 的 1.02）；1 秒時閃爍回到逐幀的水準，網路次數再少一半。

## 其他方法的快速匯出：關鍵幀＋擬合的局部色彩轉換

傳統方法的「快速」匯出：每 0.5 秒的關鍵幀在長邊 640 的圖上完整處理，把「原片 → 結果」擬合成局部仿射色彩轉換（引導濾波係數），
中間格內插後由 GPU 套到原解析度。由 `node scripts/fast-export-check.mjs <影片> <UVE-38K imgs>` 產生。
「快速 vs 逐格」是同一支 640×360 影片上兩種輸出的差異（越高越像逐格版）；UVE-38K 兩欄都是前 240 格（較早的一次評測），彼此可以比，但不能和上面 917 格的主表直接比。

| 方法 | 快速 vs 逐格 PSNR（關鍵幀 640） | （關鍵幀 320） | UVE-38K 快速 PSNR / SSIM | UVE-38K 逐格 PSNR / SSIM |
|---|---|---|---|---|
| 色彩平衡＋多尺度融合 | 35.4 dB | 35.1 dB | 16.42 / 0.595 | 16.24 / 0.578 |
| MLLE 最小色損＋局部對比 | 26.6 dB | 26.6 dB | 18.62 / 0.592 | 17.56 / 0.511 |
| ULAP 光衰減先驗復原 | 33.6 dB | 33.7 dB | 13.84 / 0.518 | 13.44 / 0.500 |
| UDCP 水下暗通道 | 34.5 dB | 34.2 dB | 11.25 / 0.403 | 11.01 / 0.367 |
| RGHS 相對直方圖拉伸 | 29.1 dB | 29.3 dB | 18.55 / 0.566 | 18.30 / 0.547 |
| Sea-thru（ULAP 深度） | 31.0 dB | 30.8 dB | 14.71 / 0.515 | 14.80 / 0.469 |
| IBLA 模糊度＋光吸收 | 35.0 dB | 35.0 dB | 13.55 / 0.449 | 13.32 / 0.426 |

局部色彩轉換會把細部的局部對比變柔（MLLE、RGHS 與逐格版差最多），但和參考影片比的 PSNR / SSIM 幾乎全部持平或更好（Sea-thru 的 PSNR 低 0.09 dB，SSIM 較高）。
