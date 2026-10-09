"""5 個適合手機的新一代水下增強模型（2024–2026）→ ONNX，並與原作 PyTorch 輸出比對。

  python scripts/export_mobile_onnx.py <候選倉庫目錄> <輸出目錄 models/> [測試圖]

候選倉庫目錄底下要有（git clone，權重都在 GitHub 倉庫內）：
  AVC2-UESTC_mobileie         MobileIE（ICCV 2025）            pretrain/uieb_best_slim.pkl
  LethyZhang_fgdpa            FGDPA（ICME 2026）               experiments/pretrain/models/model_best_slim.pkl
  mryanghaodong_lu2net        LU2Net（2024）                   LightUNet_170.pth
  zhangsong1213_liteenhancenet LiteEnhanceNet（ESWA 2024）     snapshots/model_epoch_99.ckpt
  ShahidHasib586_aquafastnet  AquaFastNet（2026 修訂稿）        runs/uie_fastunet_base32/best.pt

網路結構直接用原作倉庫的程式（純 torch.nn 定義），權重以 weights_only 方式載入（不執行檔案裡的程式）。
各模型原作測試流程的後處理一起放進 ONNX（輸出都已在 [0,1]）：
  MobileIE / FGDPA / LiteEnhanceNet：clip 到 [0,1]；AquaFastNet：網路本身已 clamp；
  LU2Net：torchvision save_image(normalize=True) = 整張圖 min-max 正規化。
FGDPA 的注意力用到 32×32 的 2D FFT 幅度；ONNX Runtime Web 不一定支援 DFT 運算，這裡改成等價的 DFT 矩陣乘法（cos/sin），
並把「平均池化到 32×32」改成 reshape 後取平均（輸入邊長為 32 的倍數時兩者完全相同）。
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


SPECS = [  # (名稱, 建構, 後處理, ONNX 是否動態尺寸, 測試尺寸)
    ('mobileie', mobileie, Clip, True, [(256, 256), (192, 256)]),
    ('fgdpa', fgdpa, Clip, True, [(256, 256), (192, 256)]),
    ('lu2net', lu2net, MinMax, False, [(256, 256)]),
    ('liteenhancenet', liteenhancenet, Clip, False, [(256, 256)]),
    ('aquafastnet', aquafastnet, lambda n: n, True, [(256, 256), (192, 256)]),
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
    for name, build, post, dyn, sizes in SPECS:
        net, ref = build()
        model = post(net).eval()
        params = sum(p.numel() for p in net.parameters())
        h0, w0 = sizes[0]
        path = os.path.join(OUT, f'{name}.onnx')
        torch.onnx.export(model, (test_image(h0, w0),), path, input_names=['x'], output_names=['y'], opset_version=17, dynamo=False,
                          dynamic_axes={'x': {2: 'h', 3: 'w'}, 'y': {2: 'h', 3: 'w'}} if dyn else None)
        sess = ort.InferenceSession(path, providers=['CPUExecutionProvider'])
        for h, w in sizes:
            x = test_image(h, w)
            with torch.no_grad():
                r = post(ref)(x) if ref is not net else model(x)
                t = model(x)
            o = torch.from_numpy(sess.run(['y'], {'x': x.numpy()})[0])
            print(f'{name:15s} {h}×{w}  參數 {params:,}  ONNX {os.path.getsize(path) / 1024:.0f} KB  '
                  f'原作 vs 本版 {float((t - r).abs().max()):.2e}  原作 vs ONNX {float((o - r).abs().max()):.2e}  '
                  f'輸出範圍 [{float(o.min()):.3f}, {float(o.max()):.3f}]')
