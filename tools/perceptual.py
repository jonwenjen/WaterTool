"""LPIPS 與 FID（感知相似度與分佈距離），評測用。

LPIPS（Zhang et al., CVPR 2018）：AlexNet v0.1，與 github.com/richzhang/PerceptualSimilarity 的 lpips.LPIPS(net='alex')
相同的計算（輸入 [-1,1]、ScalingLayer、5 層 ReLU 特徵逐通道正規化、平方差、線性層、空間平均後相加）。越低越像參考。
權重：lpips_alex.npz（AlexNet 卷積層＋5 個線性層），由 scripts/get_perceptual_weights.sh 下載並轉換。

FID（Heusel et al., NeurIPS 2017）：InceptionV3 pool3 2048 維特徵的 Fréchet 距離，用 torch-fidelity 的 TF 相容 InceptionV3
（權重 weights-inception-2015-12-05-6726825d.pth，與原始 TF 版 FID 一致）。越低表示整體影像分佈越接近參考。
注意：FID 是「一組影像對一組影像」的分佈距離，樣本少時偏高、變動大；這裡只適合方法間互相比較。
"""
import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F


class LPIPSAlex(nn.Module):
    def __init__(self, npz_path):
        super().__init__()
        z = np.load(npz_path)
        spec = [(3, 64, 11, 4, 2), (64, 192, 5, 1, 2), (192, 384, 3, 1, 1), (384, 256, 3, 1, 1), (256, 256, 3, 1, 1)]
        self.convs = nn.ModuleList()
        for i, (ci, co, k, s, p) in enumerate(spec):
            c = nn.Conv2d(ci, co, k, s, p)
            c.weight.data = torch.from_numpy(z[f'AlexNet_0/Conv_{i}/kernel']).permute(3, 2, 0, 1).contiguous()  # HWIO → OIHW
            c.bias.data = torch.from_numpy(z[f'AlexNet_0/Conv_{i}/bias'])
            self.convs.append(c)
        self.lins = [torch.from_numpy(z[f'NetLinLayer_{i}/Conv_0/kernel']).reshape(1, -1, 1, 1) for i in range(5)]
        self.register_buffer('shift', torch.tensor([-.030, -.088, -.188]).view(1, 3, 1, 1))
        self.register_buffer('scale', torch.tensor([.458, .448, .450]).view(1, 3, 1, 1))
        self.eval()

    def feats(self, x):
        x = (x - self.shift) / self.scale
        out = []
        for i, c in enumerate(self.convs):
            if i in (1, 2):
                x = F.max_pool2d(x, 3, 2)
            x = F.relu(c(x))
            out.append(x)
        return out

    @torch.no_grad()
    def forward(self, a, b):
        """a、b：N×3×H×W，值域 [0,1]（內部轉成 LPIPS 要的 [-1,1]）→ 每對一個距離"""
        fa, fb = self.feats(a * 2 - 1), self.feats(b * 2 - 1)
        d = 0
        for x, y, w in zip(fa, fb, self.lins):
            x = x / (torch.sqrt((x ** 2).sum(1, keepdim=True)) + 1e-10)
            y = y / (torch.sqrt((y ** 2).sum(1, keepdim=True)) + 1e-10)
            d = d + ((x - y) ** 2 * w).sum(1, keepdim=True).mean([2, 3], keepdim=True)
        return d.view(-1)


class InceptionFeatures:
    """TF 相容 InceptionV3 的 pool3 2048 維特徵（torch-fidelity 實作，不需要 torchvision）"""

    def __init__(self, weights_path):
        # torch_fidelity 的套件入口會載入 CLIP 等用到 torchvision 的模組；InceptionV3 本身不需要，跳過入口直接載入
        import importlib.util, sys, types
        if 'torch_fidelity' not in sys.modules:
            spec = importlib.util.find_spec('torch_fidelity')
            pkg = types.ModuleType('torch_fidelity')
            pkg.__path__ = list(spec.submodule_search_locations)
            sys.modules['torch_fidelity'] = pkg
        from torch_fidelity.feature_extractor_inceptionv3 import FeatureExtractorInceptionV3
        self.net = FeatureExtractorInceptionV3('inception-v3-compat', ['2048'], feature_extractor_weights_path=weights_path)
        self.net.eval()

    @torch.no_grad()
    def __call__(self, imgs):
        """imgs：N×3×H×W，[0,1] → N×2048（float64）"""
        x = (imgs.clamp(0, 1) * 255).round().to(torch.uint8)
        return self.net(x)[0].double().cpu().numpy()


def fid_from_feats(f1, f2):
    from scipy import linalg
    mu1, mu2 = f1.mean(0), f2.mean(0)
    s1, s2 = np.cov(f1, rowvar=False), np.cov(f2, rowvar=False)
    covmean, _ = linalg.sqrtm(s1.dot(s2), disp=False)
    if not np.isfinite(covmean).all():
        off = np.eye(s1.shape[0]) * 1e-6
        covmean = linalg.sqrtm((s1 + off).dot(s2 + off))
    covmean = covmean.real
    return float(((mu1 - mu2) ** 2).sum() + np.trace(s1) + np.trace(s2) - 2 * np.trace(covmean))
