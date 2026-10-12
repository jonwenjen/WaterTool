"""近三年的通用影像還原模型（不是專為水下訓練）→ ONNX，並與原作 PyTorch 輸出比對。看它們直接套到水下影片的效果。

  python scripts/export_restoration_onnx.py <候選倉庫目錄> <權重目錄> <輸出目錄 models/eval/> [測試圖]
  只轉其中幾個：環境變數 ONLY=promptir,adair

候選倉庫目錄底下（git clone）：va1shn9v_PromptIR、c-yn_AdaIR、eduardzamfir_MoCE-IR、mv-lab_InstructIR、gy65896_OneRestore
權重目錄底下（原作 README 的 Google Drive／Hugging Face 連結下載）：
  promptir/model.ckpt                         PromptIR（NeurIPS 2023）三種退化（雜訊、雨、霧）一體模型
  adair/adair5d.ckpt                          AdaIR（ICLR 2025）五種退化（＋模糊、低光）一體模型
  moceir/checkpoints/MoCE_IR_AIO5/last.ckpt   MoCE-IR（CVPR 2025）五種退化；MoCE_IR_S_AIO5 為小型版
  dehazeformer/space/dehazeformer.pth (+ dehazeformer_model.py)
                                              DehazeFormer（IEEE TIP 2023）作者 Hugging Face 展示用的版本（DehazeFormer 預測逐像素色調曲線）
  onerestore/onerestore_cdd-11.tar、embedder_model.tar
                                              OneRestore（ECCV 2024）複合退化（低光／霧／雨／雪）＋自動判斷退化種類
  instructir_prompts.json                     InstructIR（ECCV 2024）指令的文字向量（bge-micro-v2 → 原作 LM head，事先算好）
另外 Stephen0808_ICELUT：ICELUT（ECCV 2024，FiveK 修圖）的查表權重在倉庫的 ICELUT/ 裡（Basis_lut.npy 是 pickle，用只放行陣列的讀法）。

權重以 weights_only 方式載入（Lightning 檢查點裡的設定只放行 argparse.Namespace）。原作測試流程的後處理一起放進 ONNX，輸出在 [0,1]。
ONNX 不能直接轉的地方：
  MoCE-IR 的 FFT 注意力（q、k 循環摺積）→ DFT 矩陣乘法；選專家改成全部算再乘閘值（結果相同，路由不會被寫死）；
    原作推論時路由也加了隨機雜訊，這裡去掉（確定、可重現）。
  AdaIR 的頻率分離用複數 FFT＋資料決定的遮罩 → 等價的實數 DFT 矩陣乘法（遮罩可分離、只留直流附近幾個頻率）；固定 256×256 輸入。
  DehazeFormer（展示版）用 5 維 grid_sample 套曲線 → 空間方向雙線性放大＋亮度方向線性內插（與原作相同）；
    它先把輸入 area 縮成 256×256，動態尺寸時 ONNX 匯出不了，所以固定 256×256 輸入。
  OneRestore 的退化種類判斷（逐張 argmax 後用 Python 迴圈取向量）→ 用索引取向量；縮成 224×224 給判斷網路時用張量的雙線性縮放；
    交叉注意力裡的抗鋸齒縮放（transforms.Resize）→ 事先算好的縮放矩陣，固定 256×256 輸入。
  InstructIR 的文字指令固定成一句（見 PROMPT），文字向量當常數放進 ONNX。
  ICELUT 的三線性查表（原作 CUDA／C++ 擴充）→ 8 個角落 gather；縮成 32×32 的抗鋸齒雙線性縮放 → 事先算好的縮放矩陣；固定 256×256 輸入。
"""
import argparse
import importlib.util
import json
import math
import os
import sys
import types

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

C, W, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
TEST = sys.argv[4] if len(sys.argv) > 4 else None
torch.manual_seed(0)
# InstructIR 的指令：照原作展示的「當攝影師幫我修這張照片」改成水下，事先決定、沒有拿評測影片挑過
PROMPT = 'please I want this underwater photo for my photo album, can you edit it as a photographer and fix the colors'


def load_file(name, path, extra_path=None):
    if extra_path:
        sys.path.insert(0, extra_path)
    try:
        spec = importlib.util.spec_from_file_location(name, path)
        mod = importlib.util.module_from_spec(spec)
        sys.modules[name] = mod
        spec.loader.exec_module(mod)
    finally:
        if extra_path:
            sys.path.remove(extra_path)
    return mod


def ckpt(path, prefix=''):
    with torch.serialization.safe_globals([argparse.Namespace]):
        d = torch.load(path, map_location='cpu', weights_only=True)
    sd = d.get('state_dict', d)
    return {k[len(prefix):]: v for k, v in sd.items() if k.startswith(prefix)}


class Clip(nn.Module):
    def __init__(self, net):
        super().__init__()
        self.net = net

    def forward(self, x):
        return self.net(x).clamp(0, 1)


def aa_mats(h, w, n):
    """F.interpolate(…, (n, n), bilinear, antialias=True) 是可分離的線性運算：L = R_h · X · R_wᵀ。
    R 要用「真的二維」輸入求（PyTorch 的抗鋸齒核在另一維是 1 時權重不同）：第 i 列全 1 的影像縮小後的第 0 欄 = R_h 的第 i 欄"""
    with torch.no_grad():
        eh = torch.eye(h)[:, :, None].expand(h, h, w).reshape(h, 1, h, w)
        rh = F.interpolate(eh, (n, n), mode='bilinear', align_corners=False, antialias=True)[:, 0, :, 0].T.contiguous()
        ew = torch.eye(w)[:, None, :].expand(w, h, w).reshape(w, 1, h, w)
        rw = F.interpolate(ew, (n, n), mode='bilinear', align_corners=False, antialias=True)[:, 0, 0, :].T.contiguous()
    return rh, rw


# ---------- 1. PromptIR ----------
def promptir():
    m = load_file('promptir_model', os.path.join(C, 'va1shn9v_PromptIR', 'net', 'model.py'))
    net = m.PromptIR(decoder=True)
    net.load_state_dict(ckpt(os.path.join(W, 'promptir', 'model.ckpt'), 'net.'), strict=True)
    net = Clip(net).eval()
    return net, net


# ---------- 2. AdaIR（FFT → 實數 DFT 矩陣） ----------
def low_pass(x, k_h, k_w, n=128):
    """原作 FreModule.fft 的低頻部分 L = ifft2(fft2(x)·M)（norm='forward'）。M 在移到中心後的座標是
    [h/2−k_h, h/2+k_h) × [w/2−k_w, w/2+k_w) → 原座標的頻率 u ∈ [−k_h, k_h)、v ∈ [−k_w, k_w)，可分離：
    L = P_h · x · P_wᵀ，P[i, j] = (1/h) Σ_u e^{2πi·u(i−j)/h}（實部、虛部分開算）"""
    h, w = x.shape[-2:]

    def P(size, k, kmax):
        d = torch.arange(size, dtype=x.dtype)
        d = d[:, None] - d[None, :]
        re = torch.zeros(size, size, dtype=x.dtype)
        im = torch.zeros(size, size, dtype=x.dtype)
        for u in range(-kmax, kmax):  # kmax = size // n（固定尺寸時是常數）
            on = ((u >= -k) & (u < k)).to(x.dtype)
            a = 2 * math.pi * u * d / size
            re = re + on * torch.cos(a)
            im = im + on * torch.sin(a)
        return re / size, im / size

    ar, ai = P(h, k_h, h // n)
    br, bi = P(w, k_w, w // n)
    lr = ar @ x @ br.T - ai @ x @ bi.T
    li = ar @ x @ bi.T + ai @ x @ br.T
    return lr, li


def adair():
    m = load_file('adair_model', os.path.join(C, 'c-yn_AdaIR', 'net', 'model.py'))
    ref = m.AdaIR(decoder=True)
    ref.load_state_dict(ckpt(os.path.join(W, 'adair', 'adair5d.ckpt'), 'net.'), strict=True)

    def fft(self, x, n=128):
        x = self.conv1(x)
        h, w = x.shape[-2:]
        thr = self.rate_conv(F.adaptive_avg_pool2d(x, 1)).sigmoid()  # batch = 1
        k_h = (h // n * thr[0, 0, 0, 0]).int()
        k_w = (w // n * thr[0, 1, 0, 0]).int()
        lr, li = low_pass(x, k_h, k_w, n)
        high = torch.sqrt((x - lr) ** 2 + li ** 2)  # |ifft(F·(1−M))| = |x − L|
        low = torch.sqrt(lr ** 2 + li ** 2)
        return high, low

    import copy
    net = copy.deepcopy(ref)
    for mod in net.modules():
        if type(mod).__name__ == 'FreModule':
            mod.fft = types.MethodType(fft, mod)
    return Clip(net).eval(), Clip(ref).eval()


# ---------- 3. MoCE-IR ----------
def dft(p, dtype=torch.float32):
    k = torch.arange(p, dtype=torch.float64)
    a = 2 * math.pi * torch.outer(k, k) / p
    return torch.cos(a).to(dtype), (-torch.sin(a)).to(dtype)  # A = e^{−2πi·jk/p} 的實部、虛部


def circ_conv2(q, k, p):
    """irfft2(rfft2(q)·rfft2(k), s=(p,p))（最後兩維 p×p 的二維循環摺積），用 DFT 矩陣算"""
    ar, ai = dft(p, q.dtype)

    def fwd(x):
        return ar @ x @ ar.T - ai @ x @ ai.T, ar @ x @ ai.T + ai @ x @ ar.T

    qr, qi = fwd(q)
    kr, ki = fwd(k)
    pr, pi = qr * kr - qi * ki, qr * ki + qi * kr
    mr, mi = ar @ pr + ai @ pi, ar @ pi - ai @ pr  # conj(A)·P
    return (mr @ ar.T + mi @ ai.T) / (p * p)  # 取實部、除以 p²（逆轉換正規化）


def moceir(small=False):
    sys.modules.setdefault('fvcore', types.ModuleType('fvcore'))
    fv = types.ModuleType('fvcore.nn')
    fv.FlopCountAnalysis = fv.flop_count_table = None
    sys.modules['fvcore.nn'] = fv
    m = load_file('moce_model' + ('_s' if small else ''), os.path.join(C, 'eduardzamfir_MoCE-IR', 'src', 'net', 'moce_ir.py'))

    # 原作推論時的路由也加了隨機雜訊（noise_std = 1/專家數，沒有只限訓練）→ 每次結果不同。這裡去掉雜訊（取期望的確定路由）
    def routing(self, x, freq_emb):
        logits = self.gate(x) + self.freq_gate(freq_emb)
        scores = logits.softmax(dim=-1)
        v, i = torch.topk(scores, self.k, dim=-1)
        return torch.zeros_like(logits).scatter(1, i, v), i, v, 0
    m.RoutingFunction.forward = routing

    def build():
        net = m.MoCEIR(dim=32 if small else 48, num_blocks=[4, 6, 6, 8], num_dec_blocks=[2, 4, 4], levels=4, heads=[1, 2, 4, 8],
                       num_refinement_blocks=4, topk=1, num_experts=4, rank=2, with_complexity=False, depth_type='constant',
                       stage_depth=[1, 1, 1], rank_type='spread', complexity_scale='max')
        net.load_state_dict(ckpt(os.path.join(W, 'moceir', 'checkpoints', 'MoCE_IR_S_AIO5' if small else 'MoCE_IR_AIO5', 'last.ckpt'), 'net.'), strict=True)
        return net

    class Out(nn.Module):
        def __init__(self, n):
            super().__init__()
            self.n = n

        def forward(self, x):
            y = self.n(x)
            if isinstance(y, (list, tuple)):
                y = y[0]
            return y.clamp(0, 1)

    ref = Out(build()).eval()
    net = Out(build()).eval()

    # ONNX 版：(1) 選專家改成「全部專家都算、乘上閘值（沒選到的是 0）再相加」，結果與只算選到的相同，但路由不會在匯出時被寫死；
    # (2) FFT 注意力（q、k 的循環摺積）改成 DFT 矩陣乘法
    def adapter(self, x, freq_emb, shared):
        gates, _, _, _ = self.routing(x, freq_emb)
        self.loss = 0
        out = 0
        for i, e in enumerate(self.experts):
            out = out + gates[:, i].reshape(-1, 1, 1, 1) * e(x, shared)
        return self.proj_out(out)

    def fft_attn(self, x):
        b, c, h, w = x.shape
        q = self.q_dwconv(self.q(x))
        k, v = self.kv_dwconv(self.kv(x)).chunk(2, dim=1)
        out = circ_conv2(self.pad_and_rearrange(q).float(), self.pad_and_rearrange(k).float(), self.patch_size)
        out = self.rearrange_to_original(out, (h, w))
        return self.proj_out(self.norm(out) * v)

    for mod in net.modules():
        if isinstance(mod, m.AdapterLayer):
            mod.forward = types.MethodType(adapter, mod)
        if isinstance(mod, m.FFTAttention):
            mod.forward = types.MethodType(fft_attn, mod)
    return net, ref


# ---------- 4. InstructIR（文字向量固定） ----------
def instructir():
    root = os.path.join(C, 'mv-lab_InstructIR')
    sys.path.insert(0, root)
    try:
        from models import instructir as ii
    finally:
        sys.path.remove(root)
    net = ii.create_model(input_channels=3, width=32, enc_blks=[2, 2, 4, 8], middle_blk_num=4, dec_blks=[2, 2, 2, 2], txtdim=256)
    net.load_state_dict(torch.load(os.path.join(root, 'models', 'im_instructir-7d.pt'), map_location='cpu', weights_only=True), strict=True)
    emb = torch.tensor(json.load(open(os.path.join(W, 'instructir_prompts.json')))[PROMPT])[None]

    class Fixed(nn.Module):
        def __init__(self, n):
            super().__init__()
            self.n = n
            self.register_buffer('emb', emb)

        def forward(self, x):
            return self.n(x, self.emb).clamp(0, 1)

    net = Fixed(net).eval()
    return net, net


# ---------- 5. DehazeFormer（作者展示版：DehazeFormer 預測逐像素色調曲線） ----------
def dehazeformer():
    m = load_file('dehazeformer_space', os.path.join(W, 'dehazeformer', 'space', 'dehazeformer_model.py'))
    ref = m.MCT()
    ref.load_state_dict(ckpt(os.path.join(W, 'dehazeformer', 'space', 'dehazeformer.pth')), strict=True)

    def mapping(self, x, param):
        """原作：每個顏色通道在 (寬, 高, 自己的值) 三維網格上三線性取樣（align_corners=True、邊界夾住）"""
        B, _, H, Wd = x.shape
        curve = torch.stack(torch.chunk(param, 3, dim=1), dim=1)  # [B,3,3l,ts,ts]
        outs = 0
        for ci, (cv, xi) in enumerate(zip(torch.chunk(curve, 3, dim=2), torch.chunk(x, 3, dim=1))):
            D = cv.shape[2]
            v = F.interpolate(cv.reshape(B, 3 * D, cv.shape[3], cv.shape[4]), (H, Wd), mode='bilinear', align_corners=True).reshape(B, 3, D, H, Wd)
            z = ((xi.clamp(-1, 1) + 1) / 2 * (D - 1)).squeeze(1)  # [B,H,W]，邊界夾住
            z0 = torch.floor(z).clamp(0, D - 1)
            z1 = (z0 + 1).clamp(max=D - 1)
            t = (z - z0)[:, None]
            g0 = torch.gather(v, 2, z0.long()[:, None, None].expand(B, 3, 1, H, Wd)).squeeze(2)
            g1 = torch.gather(v, 2, z1.long()[:, None, None].expand(B, 3, 1, H, Wd)).squeeze(2)
            outs = outs + g0 * (1 - t) + g1 * t
        return outs

    import copy
    net = copy.deepcopy(ref)
    net.mapping = types.MethodType(mapping, net)

    class IO(nn.Module):  # 原作 app.py：輸入 [−1,1]、輸出 clamp(−1,1)·0.5+0.5
        def __init__(self, n):
            super().__init__()
            self.n = n

        def forward(self, x):
            return self.n(x * 2 - 1).clamp(-1, 1) * 0.5 + 0.5

    return IO(net).eval(), IO(ref).eval()


# ---------- 6. OneRestore（自動判斷退化種類 → 對應的場景向量 → 還原） ----------
def onerestore():
    root = os.path.join(C, 'gy65896_OneRestore')
    sys.modules.setdefault('thop', types.SimpleNamespace(profile=None))  # 只用來算 FLOPs
    import torchvision
    r18 = torchvision.models.resnet.resnet18
    torchvision.models.resnet.resnet18 = lambda *a, **k: r18(weights=None)  # 權重來自 embedder_model.tar，不必下載 ImageNet 權重
    we = types.ModuleType('utils.utils_word_embedding')
    we.initialize_wordembedding_matrix = lambda name, vocab: (torch.zeros(len(vocab), 300), 300)  # GloVe 向量也在檢查點裡
    sys.path.insert(0, root)
    saved = {k: sys.modules.pop(k) for k in list(sys.modules) if k == 'utils' or k.startswith('utils.') or k == 'model' or k.startswith('model.')}
    try:
        import utils  # noqa: F401
        sys.modules['utils.utils_word_embedding'] = we
        from model.Embedder import Embedder
        from model.OneRestore import OneRestore
    finally:
        sys.path.remove(root)
    types_ = ['clear', 'low', 'haze', 'rain', 'snow', 'low_haze', 'low_rain', 'low_snow', 'haze_rain', 'haze_snow', 'low_haze_rain', 'low_haze_snow']
    try:
        emb = Embedder(types_)
    finally:
        torchvision.models.resnet.resnet18 = r18
    emb.load_state_dict(ckpt(os.path.join(W, 'onerestore', 'embedder_model.tar')), strict=True)
    res = OneRestore()
    res.load_state_dict(ckpt(os.path.join(W, 'onerestore', 'onerestore_cdd-11.tar')), strict=True)
    for k, v in saved.items():
        sys.modules.setdefault(k, v)

    class Ref(nn.Module):  # 原作 test.py 的流程（判斷網路的輸入改用張量縮放，與 ONNX 版相同）
        def __init__(self):
            super().__init__()
            self.emb, self.res = emb, res

        def forward(self, x):
            e, _, _ = self.emb(F.interpolate(x, (224, 224), mode='bilinear', align_corners=False), 'image_encoder')
            return self.res(x, e).clamp(0, 1)

    class AAResize(nn.Module):
        """transforms.Resize([n, n])（張量預設抗鋸齒雙線性）：可分離的線性運算 → 依輸入尺寸事先算好縮放矩陣（固定尺寸匯出時是常數）"""
        def __init__(self, n):
            super().__init__()
            self.n, self.cache = n, {}

        def forward(self, k):
            hw = (int(k.shape[-2]), int(k.shape[-1]))  # 追蹤（匯出）時形狀是被追蹤的值，轉成 int 才找得到先算好的矩陣
            if hw not in self.cache:
                self.cache[hw] = aa_mats(*hw, self.n)
            rh, rw = self.cache[hw]
            return rh @ k @ rw.T

    class Onnx(Ref):
        def __init__(self):
            super().__init__()
            import copy
            self.res = copy.deepcopy(res)
            for mod in self.res.modules():
                if hasattr(mod, 'resize') and isinstance(mod.resize, nn.Module) and type(mod.resize).__name__ == 'Resize':
                    mod.resize = AAResize(mod.resize.size[0])

        def forward(self, x):
            e = self.emb
            sw = e.mlp(e.embedder(e.train_type))
            f = e.feat_extractor(e.transform(F.interpolate(x, (224, 224), mode='bilinear', align_corners=False)))[0]
            f = e.img_final(e.img_avg_pool(e.img_embedder(f)).flatten(1))
            pred = e.classifier(f, sw).argmax(dim=1)
            return self.res(x, sw[pred]).clamp(0, 1)

    return Onnx().eval(), Ref().eval()


# ---------- 7. ICELUT（全域 3D 查表修圖；FiveK 專家 C） ----------
def safe_npy_pickle(path):
    """Basis_lut.npy 存的是 pickle（dict of torch tensors）：只放行陣列、張量重建與 OrderedDict；
    torch.storage._load_from_bytes 改成 weights_only 的 torch.load"""
    import collections
    import io
    import pickle

    class U(pickle.Unpickler):
        def find_class(self, mod, name):
            if (mod, name) == ('torch.storage', '_load_from_bytes'):
                return lambda b: torch.load(io.BytesIO(b), map_location='cpu', weights_only=True)
            if (mod, name) == ('torch._utils', '_rebuild_tensor_v2'):
                return torch._utils._rebuild_tensor_v2
            if (mod, name) == ('collections', 'OrderedDict'):
                return collections.OrderedDict
            if (mod, name) in (('numpy.core.multiarray', '_reconstruct'), ('numpy._core.multiarray', '_reconstruct')):
                return np.core.multiarray._reconstruct
            if (mod, name) in (('numpy', 'ndarray'), ('numpy', 'dtype')):
                return getattr(np, name)
            raise pickle.UnpicklingError(f'不允許的物件：{mod}.{name}')

    return _npy_obj(open(path, 'rb').read(), U)


def _npy_obj(raw, U):
    import io
    f = io.BytesIO(raw)
    np.lib.format.read_magic(f)
    np.lib.format.read_array_header_1_0(f)
    return U(f).load().item()


def trilinear(lut, img):
    """原作 trilinear_cpp 的 TriLinearForwardCpu：lut [3, d, d, d]（索引 r + g·d + b·d²）、img [3, H, W] ∈ [0,1]"""
    d = lut.shape[-1]
    binsize = 1.000001 / (d - 1)
    flat = lut.reshape(3, -1)
    r, g, b = img[0], img[1], img[2]
    ri, gi, bi = torch.floor(r / binsize), torch.floor(g / binsize), torch.floor(b / binsize)
    rd, gd, bd = torch.fmod(r, binsize) / binsize, torch.fmod(g, binsize) / binsize, torch.fmod(b, binsize) / binsize
    out = 0
    for dr in (0, 1):
        for dg in (0, 1):
            for db in (0, 1):
                idx = ((ri + dr) + (gi + dg) * d + (bi + db) * d * d).long().reshape(-1)
                wgt = (rd if dr else 1 - rd) * (gd if dg else 1 - gd) * (bd if db else 1 - bd)
                out = out + wgt[None] * flat[:, idx].reshape(3, *r.shape)
    return out


def icelut():
    root = os.path.join(C, 'Stephen0808_ICELUT', 'ICELUT')
    cls = torch.from_numpy(np.load(os.path.join(root, 'classifier_int8.npy'))).float()  # [5·4096, 10]
    lut_cat = torch.stack(torch.split(cls, 64 ** 2, dim=0))  # [5, 4096, 10]
    msb_t = torch.from_numpy(np.load(os.path.join(root, 'Model_msb_fp32.npy'))).reshape(4096, 10)
    lsb_t = torch.from_numpy(np.load(os.path.join(root, 'Model_lsb_fp32.npy'))).reshape(4096, 10)
    basis = safe_npy_pickle(os.path.join(root, 'Basis_lut.npy'))
    num, dim = 10, 33  # 原作 nsw='10+05+10'、dim=33
    cubes = basis['s'].mm(basis['Basis_LUT'].mm(basis['w']).reshape(-1, num * 3 * dim * dim)).reshape(dim, num * 3, dim ** 2).permute(1, 0, 2).reshape(num, 3, dim, dim, dim)
    luts = torch.empty_like(cubes)  # 原作 utils/LUT.py 的 cube_to_lut
    luts[:, 0] = cubes[:, 0].permute(0, 2, 3, 1)
    luts[:, 1] = cubes[:, 1].permute(0, 2, 1, 3)
    luts[:, 2] = cubes[:, 2]
    luts = luts.reshape(num, -1)
    E = 256
    # TF.resize(…, (32, 32))（張量預設抗鋸齒雙線性）是可分離的線性運算 → 事先算成 32×256 的矩陣
    R, _ = aa_mats(E, E, 32)
    wts = torch.tensor([16 * 16 * 16, 16 * 16, 16], dtype=torch.float32).view(1, 3, 1, 1)

    def weights_from(msb32, lsb32):
        im = torch.sum(msb32 * wts, dim=1).long().reshape(-1)
        il = torch.sum(lsb32 * wts, dim=1).long().reshape(-1)
        f = (msb_t[im] + lsb_t[il]).mean(dim=0)  # 平均池化 [10]
        f = torch.clamp(torch.round(f * 2) / 2, -16, 15.5)
        mid = ((f * 2).long() + 32).reshape(5, 2)
        out = lut_cat[torch.arange(5), mid[:, 0] * 64 + mid[:, 1]]
        return ((out - 32) / 4.0).sum(0, keepdim=True)  # [1, 10]

    class Net(nn.Module):  # 輸入 [1,3,256,256] ∈ [0,1]（照原作先量化成 8 位元）
        def forward(self, x):
            img = torch.round(x.clamp(0, 1) * 255)
            hi = torch.floor(img / 16)
            msb, lsb = hi / 16, (img - hi * 16) / 16
            m32 = torch.round(R @ msb @ R.T * 16) / 16
            l32 = torch.round(R @ lsb @ R.T * 16) / 16
            lut = (weights_from(m32, l32) @ luts).reshape(3, dim, dim, dim)
            org = img / 255
            return (trilinear(lut, org[0]) + org[0])[None].clamp(0, 1)

    class Ref(nn.Module):  # 原作流程：TF.resize ＋ 編譯好的原作 C++ 三線性查表
        def forward(self, x):
            import torchvision.transforms.functional as TF
            ext = sys.modules.get('trilinear_cpu_ext')
            img = torch.round(x.clamp(0, 1) * 255)
            hi = torch.floor(img / 16)
            m32 = torch.round(TF.resize(hi / 16, (32, 32)) * 16) / 16
            l32 = torch.round(TF.resize((img - hi * 16) / 16, (32, 32)) * 16) / 16
            lut = (weights_from(m32, l32) @ luts).reshape(1, 3, dim, dim, dim).contiguous()
            org = (img / 255).contiguous()
            out = torch.zeros_like(org)
            if ext is None:
                return Net()(x)
            ext.forward(lut, org, out, dim, dim ** 3, 1.000001 / (dim - 1), org.shape[2], org.shape[3], 1)
            return (out + org).clamp(0, 1)

    return Net().eval(), Ref().eval()


SPECS = [  # (名稱, 建構, 測試尺寸 (h, w)；第一個是匯出尺寸；動態尺寸與否)
    ('promptir', promptir, [(192, 256), (160, 256)], True),
    ('adair', adair, [(256, 256)], False),
    ('moceir', moceir, [(192, 256), (160, 256)], True),
    ('moceir_s', lambda: moceir(True), [(192, 256)], True),
    ('instructir', instructir, [(192, 256), (160, 256)], True),
    ('dehazeformer', dehazeformer, [(256, 256)], False),  # 原作先 area 縮成 256×256（動態尺寸匯出不了）→ 固定 256×256 輸入
    ('onerestore', onerestore, [(256, 256)], False),  # 交叉注意力把特徵抗鋸齒縮成 18×18：縮放矩陣依尺寸而定 → 固定 256×256
    ('icelut', icelut, [(256, 256)], False),
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
    if os.environ.get('TRILINEAR_EXT'):  # ICELUT 的原作 C++ 三線性查表（torch.utils.cpp_extension 編好的 .so），當比對基準
        spec = importlib.util.spec_from_file_location('trilinear_cpu_ext', os.environ['TRILINEAR_EXT'])
        sys.modules['trilinear_cpu_ext'] = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(sys.modules['trilinear_cpu_ext'])
    only = os.environ.get('ONLY')
    for name, build, sizes, dyn in SPECS:
        if only and name not in only.split(','):
            continue
        net, ref = build()
        params = sum(p.numel() for p in net.parameters())
        path = os.path.join(OUT, f'{name}.onnx')
        h0, w0 = sizes[0]
        with torch.no_grad():
            net(test_image(h0, w0))  # 先跑一次：OneRestore 的縮放矩陣在這時算好（匯出時當常數）
            torch.onnx.export(net, (test_image(h0, w0),), path, input_names=['x'], output_names=['y'], opset_version=17, dynamo=False,
                              dynamic_axes={'x': {2: 'h', 3: 'w'}, 'y': {2: 'h', 3: 'w'}} if dyn else None)
        sess = ort.InferenceSession(path, providers=['CPUExecutionProvider'])
        for h, w in sizes:
            x = test_image(h, w)
            with torch.no_grad():
                r, t = ref(x), net(x)
            o = torch.from_numpy(sess.run(['y'], {'x': x.numpy()})[0])
            print(f'{name:13s} {h}×{w}  參數 {params:,}  ONNX {os.path.getsize(path) / 2**20:.1f} MB  原作 vs 本版 {float((t - r).abs().max()):.2e}  '
                  f'原作 vs ONNX {float((o - r).abs().max()):.2e}  輸出範圍 [{float(o.min()):.3f}, {float(o.max()):.3f}]', flush=True)
