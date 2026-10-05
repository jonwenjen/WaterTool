# 用法：python scripts/export_uieb_onnx.py <UIE_Benckmark 目錄> <輸出目錄>（需要 torch、onnx）
# 把 ddz16/UIE_Benckmark 的 UIEB 權重轉成 ONNX（固定 1×3×256×256，與其測試流程相同的輸入尺寸）。
# 為了能匯出：UIEC2Net 去掉 .cuda() 與遮罩賦值、FiveA+ 的 FFT 改成等價的 DFT 矩陣乘法、NU2Net 的條件正規化移到 App 端。
import sys, math, types, importlib.util, torch, torch.nn as nn, numpy as np
REPO = sys.argv[1]; OUT = sys.argv[2]
torch.manual_seed(0)

def load_module(name, path, patch=None):
    src = open(path).read()
    if patch: src = patch(src)
    mod = types.ModuleType(name)
    exec(compile(src, path, 'exec'), mod.__dict__)
    return mod

def patch_uiec2(src):
    src = src.replace('torch.zeros(S_out.shape).cuda()', 'torch.zeros_like(S_out)').replace('torch.ones(S_out.shape).cuda()', 'torch.ones_like(S_out)')
    src = src.replace('torch.zeros(V_out.shape).cuda()', 'torch.zeros_like(V_out)').replace('torch.ones(V_out.shape).cuda()', 'torch.ones_like(V_out)')
    src = src.replace('torch.ones(x_m.shape).cuda()', 'torch.ones_like(x_m)')
    src = src.replace('torch.zeros(x.shape).cuda()', 'torch.zeros_like(x)').replace('torch.ones(x.shape).cuda()', 'torch.ones_like(x)')
    # 等價改寫，避免匯出成大型常數張量：sgn_m = clamp(x, 0, 1)；M·x − i·ones = M·x − i；S/V 的 where 夾值 = clamp
    src = src.replace("sgn_m(M * x_m - i * torch.ones_like(x_m))", "torch.clamp(M * x_m - i, 0, 1)")
    for v in ('S_out', 'V_out'):
        src = src.replace(f'''        zero_lab = torch.zeros_like({v})
        s_t = torch.where({v} < 0, zero_lab, {v})
        one_lab = torch.ones_like({v})
        {v} = torch.where(s_t > 1, one_lab, s_t)''', f'''        {v} = torch.clamp({v}, 0, 1)''')
    return src

class RGB2HSVExport(nn.Module):
    """與原 RGB2HSV 數學等價，用 torch.where 取代遮罩賦值。"""
    def forward(self, rgb):
        b, c, w, h = rgb.size()
        r, g, bl = rgb[:, 0], rgb[:, 1], rgb[:, 2]
        V, idx = torch.max(rgb, dim=1)
        mn = torch.min(rgb, dim=1)[0]
        d = V - mn
        S = d / (V + 0.0001)
        H0 = 60 * (g - bl) / (d + 0.0001)
        H1 = 120 + 60 * (bl - r) / (d + 0.0001)
        H2 = 240 + 60 * (r - g) / (d + 0.0001)
        H = torch.where(idx == 0, H0, torch.where(idx == 1, H1, H2))
        H = torch.where(H < 0, H + 360, H)
        H = torch.remainder(H, 360) / 360
        return torch.cat([H.view(b, 1, w, h), S.view(b, 1, w, h), V.view(b, 1, w, h)], 1)

def dft_mats(H, W):
    m = torch.arange(H).float(); k = torch.arange(H).float()
    ang = 2 * math.pi * torch.outer(m, k) / H          # [m,k]
    CH, SH = torch.cos(ang), torch.sin(ang)
    Wf = W // 2 + 1
    n = torch.arange(W).float(); kk = torch.arange(Wf).float()
    angw = 2 * math.pi * torch.outer(kk, n) / W         # [k,n]
    coef = torch.full((Wf,), 2.0); coef[0] = 1.0
    if W % 2 == 0: coef[-1] = 1.0
    CW = torch.cos(angw) * coef[:, None]; SW = torch.sin(angw) * coef[:, None]
    return CH, SH, CW, SW, Wf

class IRFFT2(nn.Module):
    """torch.abs(torch.fft.irfft2(complex(re, im), s=(H, W), norm='backward')) 的實數矩陣版本。"""
    def __init__(self, H, W):
        super().__init__()
        CH, SH, CW, SW, self.Wf = dft_mats(H, W)
        for k, v in dict(CH=CH, SH=SH, CW=CW, SW=SW).items(): self.register_buffer(k, v)
        self.norm = 1.0 / (H * W)
    def forward(self, re, im):
        re = re[..., : self.Wf]; im = im[..., : self.Wf]
        # 沿 H 做逆 DFT：A[m] = Σ_k Z[k] e^{+i2πkm/H}
        Are = torch.matmul(self.CH, re) - torch.matmul(self.SH, im)
        Aim = torch.matmul(self.SH, re) + torch.matmul(self.CH, im)
        # 沿 W 做實數逆 DFT（Hermitian；DC 與 Nyquist 的虛部忽略）
        out = torch.matmul(Are, self.CW) - torch.matmul(Aim, self.SW)
        return out * self.norm

def make_sfdim_forward(irfft):
    def forward(self, x, y):
        a = 0.1
        mix = x + y
        z = mix + 1e-8
        mag = torch.abs(z)
        pha = (z < 0).to(z.dtype) * math.pi  # angle() of a real tensor: π where negative, else 0
        mix_mag = self.Conv1(mag)
        mix_pha = self.Conv1_1(pha)
        real = mix_mag * torch.cos(mix_pha)
        imag = mix_mag * torch.sin(mix_pha)
        x_out = torch.abs(irfft(real, imag)) + 1e-8
        return self.Conv2(a * x_out + (1 - a) * mix)
    return forward

def load_ckpt(model, path):
    ck = torch.load(path, map_location='cpu', weights_only=False)['state_dict']
    sd = {k[6:]: v for k, v in ck.items()}
    missing, unexpected = model.load_state_dict(sd, strict=False)
    print('  missing', missing, 'unexpected', unexpected)
    return model.eval()

SIZE = 256
x = torch.rand(1, 3, SIZE, SIZE)
models = {}
m = load_module('UWCNN', f'{REPO}/model/UWCNN.py'); models['uwcnn'] = load_ckpt(m.UWCNN(), f'{REPO}/checkpoints/UIEB/UWCNN.ckpt')
m = load_module('NU2Net', f'{REPO}/model/NU2Net.py'); models['nu2net'] = load_ckpt(m.NU2Net(tail='none'), f'{REPO}/checkpoints/UIEB/NU2Net.ckpt')
m = load_module('UIEC2Net', f'{REPO}/model/UIEC2Net.py', patch_uiec2)
net = load_ckpt(m.UIEC2Net(), f'{REPO}/checkpoints/UIEB/UIEC2Net.ckpt'); net.rgb2hsv = RGB2HSVExport(); models['uiec2net'] = net
m5 = load_module('FIVE', f'{REPO}/model/FIVE_APLUS.py')
five = load_ckpt(m5.FIVE_APLUSNet(), f'{REPO}/checkpoints/UIEB/FIVE_APLUS.ckpt')
models['fiveaplus'] = five

# 參考輸出（原始實作，CPU）
with torch.no_grad():
    ref = {}
    ref['uwcnn'] = models['uwcnn'](x)
    ref['nu2net'] = models['nu2net'](x)
    ref['fiveaplus'] = five(x)
    # UIEC2Net 原 RGB2HSV（遮罩版）作為參考
    orig = m.UIEC2Net(); orig.load_state_dict(net.state_dict(), strict=False); orig.eval()
    ref['uiec2net'] = orig(x)
    # FiveA+ 換成 DFT 矩陣版後應與原 FFT 版一致
    irfft = IRFFT2(SIZE, SIZE)
    five.fusion_mixer.irfft = irfft
    five.fusion_mixer.forward = types.MethodType(make_sfdim_forward(irfft), five.fusion_mixer)
    alt = five(x)
    print('FiveA+ DFT vs FFT max diff', (alt - ref['fiveaplus']).abs().max().item())
    print('UIEC2Net where-HSV vs mask-HSV max diff', (net(x) - ref['uiec2net']).abs().max().item())

for name, model in models.items():
    path = f'{OUT}/{name}.onnx'
    torch.onnx.export(model, (x,), path, input_names=['x'], output_names=['y'], opset_version=17, dynamo=False)
    np.save(f'{OUT}/{name}_ref_in.npy', x.numpy()); np.save(f'{OUT}/{name}_ref_out.npy', ref[name].numpy())
    n = sum(p.numel() for p in model.parameters())
    print(name, 'params', n, 'exported', path)
