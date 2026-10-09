"""5 個適合手機的新一代水下增強模型（2024–2026）→ ONNX，並與原作 PyTorch 輸出比對。

  python scripts/export_mobile_onnx.py <候選倉庫目錄> <輸出目錄 models/> [測試圖]

候選倉庫目錄底下要有（git clone，權重都在 GitHub 倉庫內）：
  AVC2-UESTC_mobileie         MobileIE（ICCV 2025）            pretrain/uieb_best_slim.pkl
  LethyZhang_fgdpa            FGDPA（ICME 2026）               experiments/pretrain/models/model_best_slim.pkl
  mryanghaodong_lu2net        LU2Net（2024）                   LightUNet_170.pth
  zhangsong1213_liteenhancenet LiteEnhanceNet（ESWA 2024）     snapshots/model_epoch_99.ckpt
  ShahidHasib586_aquafastnet  AquaFastNet（2026 修訂稿）        runs/uie_fastunet_base32/best.pt
  OceanZ9639_pic-uie          PIC-UIE（2026）                   weights/pic_uie.pth
  mkartik_shallow-uwnet       Shallow-UWnet（AAAI 2021）        model.ckpt（倉庫 README 的 Google Drive 連結，另外下載放進倉庫目錄）
  LintaoPeng_U-shape_Transformer_for_Underwater_Image_Enhancement
                              U-shape Transformer（TIP 2023）   saved_models/G/generator_795.pth（Google Drive，同上）
  suhas-srinath_undive        UnDIVE（WACV 2025）               PretrainedModels/{UnDIVE_100,UIEB_pretrain_150,DDPM_100}.pth（Google Drive，同上）
  piggy2009_DM_underwater     DM-UW（ACM MM 2023）              experiments_supervised/I950000_E3369_gen.pth（Google Drive，同上）

網路結構直接用原作倉庫的程式（純 torch.nn 定義），權重以 weights_only 方式載入（不執行檔案裡的程式）。
各模型原作測試流程的後處理一起放進 ONNX（輸出都已在 [0,1]）：
  MobileIE / FGDPA / LiteEnhanceNet：clip 到 [0,1]；AquaFastNet：網路本身已 clamp；
  LU2Net：torchvision save_image(normalize=True) = 整張圖 min-max 正規化。
FGDPA 的注意力用到 32×32 的 2D FFT 幅度；ONNX Runtime Web 不一定支援 DFT 運算，這裡改成等價的 DFT 矩陣乘法（cos/sin），
並把「平均池化到 32×32」改成 reshape 後取平均（輸入邊長為 32 的倍數時兩者完全相同）。
PIC-UIE 的色彩共變異數匹配用 torch.linalg.eigh 算 3×3 矩陣的 −1/2 次方，ONNX 沒有特徵分解 →
改成 Newton–Schulz 迭代（只用矩陣乘法），並把逐項指定的下三角矩陣改成 stack。

只轉其中幾個：環境變數 ONLY=pic_uie,fgdpa
"""
import importlib.util
import os
import sys
import types

import numpy as np
import torch
import torch.nn as nn

C, OUT = sys.argv[1], sys.argv[2]
TEST = sys.argv[3] if len(sys.argv) > 3 else None
torch.manual_seed(0)


def load_pkg(alias, pkg_dir, sub):
    """把原作的 model/ 套件以別名載入（避免不同倉庫都叫 model 而互相覆蓋）"""
    pkg = types.ModuleType(alias)
    pkg.__path__ = [pkg_dir]
    sys.modules[alias] = pkg
    spec = importlib.util.spec_from_file_location(f'{alias}.{sub}', os.path.join(pkg_dir, f'{sub}.py'))
    mod = importlib.util.module_from_spec(spec)
    sys.modules[f'{alias}.{sub}'] = mod
    spec.loader.exec_module(mod)
    return mod


def load_file(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


def wload(path):
    sd = torch.load(path, map_location='cpu', weights_only=True)
    for k in ('model', 'state_dict', 'model_state', 'net', 'params'):
        if isinstance(sd, dict) and k in sd and isinstance(sd[k], dict):
            return sd[k]
    return sd


class Clip(nn.Module):
    def __init__(self, net):
        super().__init__()
        self.net = net

    def forward(self, x):
        return self.net(x).clamp(0, 1)


class MinMax(nn.Module):
    """torchvision.utils.save_image(normalize=True)：整張圖的最小、最大值線性拉到 [0,1]"""

    def __init__(self, net):
        super().__init__()
        self.net = net

    def forward(self, x):
        y = self.net(x)
        lo, hi = y.min(), y.max()
        return (y.clamp(lo, hi) - lo) / torch.clamp(hi - lo, min=1e-5)


# ---------- 1. MobileIE（重參數化後的推論網路，12 通道） ----------
def mobileie():
    lle = load_pkg('mobileie_model', os.path.join(C, 'AVC2-UESTC_mobileie', 'model'), 'lle')
    net = lle.MobileIELLENetS(12)
    net.load_state_dict(wload(os.path.join(C, 'AVC2-UESTC_mobileie', 'pretrain', 'uieb_best_slim.pkl')), strict=True)
    return net.eval(), net


# ---------- 2. FGDPA（同上框架＋頻域引導雙路注意力） ----------
def dft_cs(n):
    k = torch.arange(n, dtype=torch.float64)
    a = 2 * np.pi * torch.outer(k, k) / n
    return torch.cos(a).float(), torch.sin(a).float()


def fgdpa():
    uie = load_pkg('fgdpa_model', os.path.join(C, 'LethyZhang_fgdpa', 'model'), 'uie')
    ref = uie.FGDRAUIENetS(12)
    ref.load_state_dict(wload(os.path.join(C, 'LethyZhang_fgdpa', 'experiments', 'pretrain', 'models', 'model_best_slim.pkl')), strict=True)
    ref.eval()

    class FGDPAOnnx(uie.FGDRAUIENetS):
        def __init__(self, channels):
            super().__init__(channels)
            c, s = dft_cs(self.fft_size)
            self.register_buffer('dc', c)
            self.register_buffer('ds', s)

        def _fgdra_attention(self, Fm):
            B, Cc, H, W = Fm.shape
            t = self.fft_size
            Fd = Fm.reshape(B, Cc, t, H // t, t, W // t).mean(dim=(3, 5))  # = avg_pool2d(kernel H/t)（H、W 為 t 的倍數）
            # |DFT2(X)| = |(C − iS) X (C − iS)|：實部 CXC − SXS，虛部 −(SXC + CXS)
            cx, sx = self.dc @ Fd, self.ds @ Fd
            re = cx @ self.dc - sx @ self.ds
            im = sx @ self.dc + cx @ self.ds
            M = torch.log1p(torch.sqrt(re * re + im * im))
            max_map, _ = torch.max(Fm, dim=1, keepdim=True)
            avg_map = torch.mean(Fm, dim=1, keepdim=True)
            A_s = torch.sigmoid(self.fgdra_fgsa(torch.cat([max_map, avg_map], dim=1)))
            gap_F = torch.mean(Fm, dim=(2, 3), keepdim=True)
            gap_M = torch.mean(M, dim=(2, 3), keepdim=True)
            gap_M = gap_M / (gap_M.mean(dim=1, keepdim=True) + 1e-6)
            A_c = torch.sigmoid(self.fgdra_fca(torch.cat([gap_F, gap_M], dim=1)))
            lam = torch.clamp(self.lam, 0.0, 1.0)
            return (1.0 - lam) * (self.alpha * A_c + self.beta * A_s) + lam * (A_c * A_s)

    net = FGDPAOnnx(12)
    net.load_state_dict({**ref.state_dict(), 'dc': net.dc, 'ds': net.ds}, strict=True)
    return net.eval(), ref


# ---------- 3. LU2Net ----------
def lu2net():
    m = load_file('lu2net_src', os.path.join(C, 'mryanghaodong_lu2net', 'LU2Net.py'))
    ref = m.LU2Net()
    ref.load_state_dict(wload(os.path.join(C, 'mryanghaodong_lu2net', 'LightUNet_170.pth')), strict=True)
    # padding='same' 匯出成 ONNX 的 auto_pad=SAME，ONNX Runtime 不支援它與 dilation 併用 → 改成等價的明確填補（核大小皆為奇數）
    import copy
    net = copy.deepcopy(ref)
    for mod in net.modules():
        if isinstance(mod, nn.Conv2d) and mod.padding == 'same':
            assert all(k % 2 == 1 for k in mod.kernel_size)
            mod.padding = tuple(d * (k - 1) // 2 for d, k in zip(mod.dilation, mod.kernel_size))
    return net.eval(), ref.eval()


# ---------- 4. LiteEnhanceNet（檔案是整個 pickled 模型物件） ----------
def liteenhancenet():
    m = load_file('model', os.path.join(C, 'zhangsong1213_liteenhancenet', 'model.py'))  # pickle 裡的類別叫 model.Mynet 等
    allow = [m.Mynet, m.ConvBlock1, m.ConvBlock2, m.ConvBlock3, m.ConvBlock4, m.SELayer, m.HardSwish, m.HardSigmoid,
             nn.Conv2d, nn.ReLU, nn.BatchNorm2d, nn.AdaptiveAvgPool2d, nn.Sequential, set]
    with torch.serialization.safe_globals(allow):
        obj = torch.load(os.path.join(C, 'zhangsong1213_liteenhancenet', 'snapshots', 'model_epoch_99.ckpt'), map_location='cpu', weights_only=True)
    net = m.Mynet()
    net.load_state_dict(obj.state_dict(), strict=True)
    return net.eval(), obj.eval()


# ---------- 5. AquaFastNet ----------
def aquafastnet():
    m = load_file('aquafastnet_src', os.path.join(C, 'ShahidHasib586_aquafastnet', 'uie', 'models.py'))
    net = m.FastUNetEnhancer(base=32)
    net.load_state_dict(wload(os.path.join(C, 'ShahidHasib586_aquafastnet', 'runs', 'uie_fastunet_base32', 'best.pt')), strict=True)
    return net.eval(), net


# ---------- 6. PIC-UIE（YCbCr 分解：小編碼器預測轉換，再套回原解析度） ----------
def newton_schulz_isqrt(A, iters):
    """對稱正定 A（[B,n,n]）的 A^(−1/2)；以 Frobenius 範數縮放後保證收斂"""
    n = A.shape[-1]
    I = torch.eye(n, dtype=A.dtype).expand_as(A)
    s = torch.sqrt((A * A).sum(dim=(1, 2), keepdim=True))
    Y, Z = A / s, I
    for _ in range(iters):
        T = 0.5 * (3.0 * I - Z @ Y)
        Y, Z = Y @ T, T @ Z
    return Z / torch.sqrt(s)


def pic_uie():
    root = os.path.join(C, 'OceanZ9639_pic-uie')
    sys.path.insert(0, root)
    from pic_uie.model import PICUIE
    sys.path.pop(0)
    st = torch.load(os.path.join(root, 'weights', 'pic_uie.pth'), map_location='cpu', weights_only=True)
    a = st['args']
    kw = dict(c=a['c'], knots=a['knots'], chroma_ds=a['chroma_ds'], chroma=a['chroma'], clut_size=a['clut_size'],
              depth_cond_chroma=a['depth_cond_chroma'], tone=a['tone'], grid_d=a['grid_d'], refine_y=a['refine_y'],
              lum=a['lum'], y_histeq=a['y_histeq'], histeq_bins=a['histeq_bins'], ccm=a['ccm'],
              y_rangenorm=a['y_rangenorm'], rangenorm_grid=a['rangenorm_grid'], colormatch=a['colormatch'],
              in_norm=a['in_norm'], global_stats=a['global_stats'])
    ref = PICUIE(**kw)
    ref.load_state_dict(st['model'], strict=True)

    class Out(nn.Module):
        def __init__(self, net):
            super().__init__()
            self.net = net

        def forward(self, x):
            return self.net(x)['out']

    class PICUIEOnnx(PICUIE):
        @staticmethod
        def _cov_match(ycc, cmatch, eps=1e-4):
            B, Cc, H, W = ycc.shape
            mu_t = cmatch[:, 0:3].view(B, 3, 1)
            l = cmatch[:, 3:9]
            z = torch.zeros_like(l[:, 0])
            L_t = torch.stack([torch.stack([l[:, 0], z, z], 1),
                               torch.stack([l[:, 1], l[:, 2], z], 1),
                               torch.stack([l[:, 3], l[:, 4], l[:, 5]], 1)], 1)
            alpha = torch.sigmoid(cmatch[:, 9]).view(B, 1, 1)
            x = ycc.reshape(B, Cc, -1)
            mu = x.mean(dim=2, keepdim=True)
            xc = x - mu
            cov = (xc @ xc.transpose(1, 2)) / (x.shape[2] - 1) + eps * torch.eye(Cc)
            x_w = newton_schulz_isqrt(cov, 30) @ xc
            out = (1 - alpha) * x + alpha * (L_t @ x_w + mu_t)
            return out.reshape(B, Cc, H, W)

    net = PICUIEOnnx(**kw)
    net.load_state_dict(st['model'], strict=True)
    return Out(net).eval(), Out(ref).eval()


# ---------- 7. Shallow-UWnet（檔案是整個 pickled 模型物件，類別在 model.py） ----------
def shallowuwnet():
    m = load_file('model', os.path.join(C, 'mkartik_shallow-uwnet', 'model.py'))
    allow = [m.UWnet, m.ConvBlock, nn.Conv2d, nn.ReLU, nn.Dropout2d, nn.Sequential, set]
    with torch.serialization.safe_globals(allow):
        obj = torch.load(os.path.join(C, 'mkartik_shallow-uwnet', 'model.ckpt'), map_location='cpu', weights_only=True)
    net = m.UWnet()
    net.load_state_dict(obj.state_dict(), strict=True)
    return net.eval(), obj.eval()


# ---------- 8. U-shape Transformer（輸入固定 256×256；取最大尺度輸出 output[3]，原作 save_image(normalize=True)） ----------
def ushape():
    root = os.path.join(C, 'LintaoPeng_U-shape_Transformer_for_Underwater_Image_Enhancement')
    sys.path.insert(0, root)
    from net.Ushape_Trans import Generator
    sys.path.pop(0)
    net = Generator()
    net.load_state_dict(wload(os.path.join(root, 'saved_models', 'G', 'generator_795.pth')), strict=True)

    class Last(nn.Module):
        def __init__(self, g):
            super().__init__()
            self.g = g

        def forward(self, x):
            return self.g(x)[3]

    m = Last(net).eval()
    return m, m


# ---------- 9. UnDIVE（擴散 U-Net 編碼器當特徵＋HDRNet 雙邊網格；兩組權重：UnDIVE_100 有用 UVE-38K 訓練、UIEB_pretrain_150 沒有） ----------
def np_allow():
    """DDPM_100.pth 裡存了 numpy 陣列（loss 紀錄）：只放行 numpy 重建陣列用的函式"""
    import numpy.core.multiarray as ma
    return [(ma._reconstruct, 'numpy.core.multiarray._reconstruct'), (ma.scalar, 'numpy.core.multiarray.scalar'), np.ndarray, np.dtype,
            *[type(np.dtype(t)) for t in ('float64', 'float32', 'int64', 'int32', 'bool')]]


def undive_build(which):
    import functools
    import torch.nn.functional as F
    root = os.path.join(C, 'suhas-srinath_undive')
    # 原作模組匯入時有 GPU 測試碼（slice.py 在 import 時對 .cuda() 張量做 jit.trace）、建構時把擴散網路搬到 cuda 並載入 DDPM 權重：
    # 暫時把 .cuda()/.to('cuda') 變成不動作、torch.load 改成 CPU＋weights_only
    sys.modules.setdefault('turtle', types.SimpleNamespace(forward=None))  # model_depth.py 有一行用不到的 from turtle import forward
    cu, to, ld = torch.Tensor.cuda, nn.Module.to, torch.load
    torch.Tensor.cuda = lambda self, *a, **k: self
    nn.Module.to = lambda self, *a, **k: self if (a and str(a[0]).startswith('cuda')) else to(self, *a, **k)

    def safe_load(f, *a, **k):
        with torch.serialization.safe_globals(np_allow()):
            return ld(f, map_location='cpu', weights_only=True)
    torch.load = safe_load
    try:
        sys.path.insert(0, root)
        import model_depth
        prm = dict(luma_bins=8, channel_multiplier=1, spatial_bin=16, guide_complexity=16, batch_norm=False, net_input_size=256, net_output_size=512)
        ref = model_depth.HDRPointwiseNN_depth(params=prm, ckpt=os.path.join(root, 'PretrainedModels', 'DDPM_100.pth'))
        sd = safe_load(os.path.join(root, 'PretrainedModels', f'{which}.pth'))
    finally:
        torch.Tensor.cuda, nn.Module.to, torch.load = cu, to, ld
        sys.path.pop(0)
    r = ref.load_state_dict(sd, strict=False)  # 原作也是 strict=False；這裡確認權重真的全部對上
    assert not r.missing_keys and not r.unexpected_keys, r
    ref.eval()

    def post(full, res):  # 原作 inference_per_video.py：res 夾在 [full, 1]、img = full / (res + 0.001)，存檔前 rescale_intensity（整張 min-max）
        img = full / (torch.minimum(torch.maximum(res, full), torch.ones_like(full)) + 0.001)
        lo, hi = img.min(), img.max()
        return (img - lo) / torch.clamp(hi - lo, min=1e-8)

    class Ref(nn.Module):  # 原作流程：低解析度輸入 = 最近鄰縮成 256×256（cv2.INTER_NEAREST），雙邊切片用原作的 torch.jit.script 版
        def __init__(self, m):
            super().__init__()
            self.m = m

        def forward(self, x):
            res, _ = self.m(F.interpolate(x, (256, 256), mode='nearest'), x)
            return post(x, res)

    class Onnx(nn.Module):
        """雙邊網格切片改寫：空間方向 = 雙線性放大（align_corners=False，邊界夾住，與原作的索引夾住相同）；
        亮度方向照原作取最近的兩格（gather）、用同樣的平滑線性權重"""
        def __init__(self, m):
            super().__init__()
            self.coeffs, self.guide, self.apply_c = m.coeffs, m.guide, m.apply_coeffs

        def forward(self, x):
            B, _, H, W = x.shape
            grid, _ = self.coeffs(F.interpolate(x, (256, 256), mode='nearest'))  # [B,12,8,16,16]
            nc, gd = grid.shape[1], grid.shape[2]
            g = F.interpolate(grid.reshape(B, nc * gd, grid.shape[3], grid.shape[4]), (H, W), mode='bilinear', align_corners=False)
            g = g.reshape(B, nc, gd, H, W)
            gkf = self.guide(x) * gd  # [B,1,H,W]
            gk0 = torch.floor(gkf - 0.5)
            w0 = torch.clamp(1.0 - torch.sqrt((gk0 + 0.5 - gkf) ** 2 + 1e-8), min=0.0)
            w1 = torch.clamp(1.0 - torch.sqrt((gk0 + 1.5 - gkf) ** 2 + 1e-8), min=0.0)
            i0 = torch.clamp(gk0, 0, gd - 1).long().unsqueeze(1).expand(B, nc, 1, H, W)
            i1 = torch.clamp(gk0 + 1, 0, gd - 1).long().unsqueeze(1).expand(B, nc, 1, H, W)
            coeff = w0 * torch.gather(g, 2, i0).squeeze(2) + w1 * torch.gather(g, 2, i1).squeeze(2)
            return post(x, self.apply_c(coeff, x))

    return Onnx(ref).eval(), Ref(ref).eval()


def undive():
    return undive_build('UnDIVE_100')


def undive_uieb():
    return undive_build('UIEB_pretrain_150')


# ---------- 10. DM-UW（條件擴散模型：預設 10 步 DDIM、eta=0 → 給定起始雜訊後完全確定） ----------
# 原作起始雜訊用 CUDA 亂數產生器（種子 44444）；CPU 產生不出同一組，這裡用 CPU 產生器、同樣種子，把雜訊固定成常數放進 ONNX。
# 10 次 U-Net 展開在同一張圖裡（共用同一份權重），輸入 256×256（原作驗證集的尺寸）。展開 10 次的追蹤很吃記憶體，所以用 64×64 匯出（全卷積、尺寸可變），在 256×256 驗證。
def dmuw():
    root = os.path.join(C, 'piggy2009_DM_underwater')
    sys.path.insert(0, root)
    try:
        from model.ddpm_trans_modules import unet as U, diffusion as D
    finally:
        sys.path.pop(0)
    net = U.UNet(in_channel=6, out_channel=3, norm_groups=24, inner_channel=48, channel_mults=[1, 2, 4, 8, 8],
                 attn_res=[16], res_blocks=2, dropout=0.2, image_size=256)
    diff = D.GaussianDiffusion(net, image_size=256, channels=3, loss_type='l1', conditional=True, schedule_opt=None)
    diff.set_new_noise_schedule(dict(schedule='linear', n_timestep=2000, linear_start=1e-6, linear_end=1e-2), torch.device('cpu'))
    sd = wload(os.path.join(root, 'experiments_supervised', 'I950000_E3369_gen.pth'))
    sd = {k: v for k, v in sd.items() if not k.startswith('style_loss.')}  # 訓練用的 VGG 感知損失，推論用不到
    diff.load_state_dict(sd, strict=True)
    diff.eval()
    steps = [1898, 1640, 1539, 1491, 1370, 1136, 972, 858, 680, 340]  # 原作 p_sample_loop 的預設（演化搜尋出的跳步）
    noise = torch.randn((1, 3, 256, 256), generator=torch.Generator().manual_seed(44444))

    class Ref(nn.Module):  # 原作的取樣迴圈（p_sample_ddim2），只把起始雜訊換成上面那組
        def __init__(self, d):
            super().__init__()
            self.d = d

        def forward(self, x):
            g = torch.Generator().manual_seed(44444)
            randn = torch.randn
            torch.randn = lambda shape, device=None, generator=None, **k: randn(shape, generator=g)
            try:
                y = self.d.p_sample_loop({'SR': x * 2 - 1, 'style': None})
            finally:
                torch.randn = randn
            return (y.clamp(-1, 1) + 1) / 2

    class Onnx(nn.Module):
        def __init__(self, d):
            super().__init__()
            self.unet = d.denoise_fn
            ac = (1.0 - d.betas).cumprod(dim=0)  # 與原作 extract((1 - betas).cumprod(0), t) 相同的 float32 算法
            self.register_buffer('noise', noise)
            self.register_buffer('ts', torch.tensor(steps, dtype=torch.long))
            self.register_buffer('at', ac[steps])
            self.register_buffer('an', torch.cat([ac[steps[1:]], torch.ones(1)]))

        def forward(self, x):
            cond, img = x * 2 - 1, self.noise[:, :, :x.shape[2], :x.shape[3]]  # 256×256 時就是整組雜訊（只為了用小圖匯出、省記憶體）
            for j in range(len(steps)):
                at, an = self.at[j], self.an[j]
                et = self.unet(torch.cat([cond, img], dim=1), self.ts[j:j + 1])
                x0 = (img - et * (1 - at).sqrt()) / at.sqrt()
                img = an.sqrt() * x0 + (1 - an).sqrt() * et
            return (img.clamp(-1, 1) + 1) / 2

    return Onnx(diff).eval(), Ref(diff).eval()


SPECS = [  # (名稱, 建構, 後處理, ONNX 是否動態尺寸, 測試尺寸)
    ('mobileie', mobileie, Clip, True, [(256, 256), (192, 256)]),
    ('fgdpa', fgdpa, Clip, True, [(256, 256), (192, 256)]),
    ('lu2net', lu2net, MinMax, False, [(256, 256)]),
    ('liteenhancenet', liteenhancenet, Clip, False, [(256, 256)]),
    ('aquafastnet', aquafastnet, lambda n: n, True, [(256, 256), (192, 256)]),
    ('pic_uie', pic_uie, lambda n: n, True, [(256, 256), (144, 256), (360, 640)]),
    ('shallowuwnet', shallowuwnet, Clip, False, [(256, 256)]),  # 原作 test.py 壓成 256×256，save_image 會 clamp 到 [0,1]
    ('ushape', ushape, MinMax, False, [(256, 256)]),
    ('undive', undive, lambda n: n, True, [(256, 256), (144, 256), (360, 640)]),
    ('undive_uieb', undive_uieb, lambda n: n, True, [(256, 256), (144, 256)]),
    ('dmuw', dmuw, lambda n: n, True, [(256, 256)]),
]


def test_image(h, w):
    if TEST:
        from PIL import Image
        im = Image.open(TEST).convert('RGB').resize((w, h), Image.BILINEAR)
        return torch.from_numpy(np.asarray(im, dtype=np.float32) / 255).permute(2, 0, 1)[None]
    return torch.rand(1, 3, h, w)


if __name__ == '__main__':
    import onnxruntime as ort
    os.makedirs(OUT, exist_ok=True)
    only = os.environ.get('ONLY')
    for name, build, post, dyn, sizes in SPECS:
        if only and name not in only.split(','):
            continue
        net, ref = build()
        model = post(net).eval()
        params = sum(p.numel() for p in net.parameters())
        h0, w0 = (64, 64) if name == 'dmuw' else sizes[0]
        path = os.path.join(OUT, f'{name}.onnx')
        torch.onnx.export(model, (test_image(h0, w0),), path, input_names=['x'], output_names=['y'], opset_version=17, dynamo=False,
                          dynamic_axes={'x': {2: 'h', 3: 'w'}, 'y': {2: 'h', 3: 'w'}} if dyn else None)
        sess = ort.InferenceSession(path, providers=['CPUExecutionProvider'])
        for h, w in sizes:
            x = test_image(h, w)
            with torch.no_grad():
                r = ref(x) if name.startswith('undive') or name == 'dmuw' else post(ref)(x) if ref is not net else model(x)
                t = model(x)
            o = torch.from_numpy(sess.run(['y'], {'x': x.numpy()})[0])
            print(f'{name:15s} {h}×{w}  參數 {params:,}  ONNX {os.path.getsize(path) / 1024:.0f} KB  '
                  f'原作 vs 本版 {float((t - r).abs().max()):.2e}  原作 vs ONNX {float((o - r).abs().max()):.2e}  '
                  f'輸出範圍 [{float(o.min()):.3f}, {float(o.max()):.3f}]')
