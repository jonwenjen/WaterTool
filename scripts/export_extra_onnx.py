# 用法：python scripts/export_extra_onnx.py <tnwei/waternet 目錄> <edinmilenko 倉庫的 models/weights.pt> <UVEB/UVE-Net 目錄> <輸出目錄>
# WaterNet：tnwei/waternet（MIT）的 PyTorch 架構 + 官方權重（sha256 daa0ee…，與 tnwei 發布的 waternet_exported_state_dict-daa0ee.pt 相同）
#           匯出成單一 12 通道輸入（原圖、白平衡、直方圖等化、Gamma 依序串接），任意尺寸。
# UVE-Net：yzbouc/UVEB（MIT）的小模型 samll_net_g.pth（num_feat=12），單格模式（每一格輸出只取決於該格），
#           輸入 1×3×H×W（H、W 為 16 的倍數，≥ 64），輸出取主輸出。
import sys, types, hashlib, importlib.util, torch, torch.nn as nn, numpy as np
WN, WN_W, UV, OUT = sys.argv[1:5]

spec = importlib.util.spec_from_file_location('wnet', f'{WN}/waternet/net.py'); wnet = importlib.util.module_from_spec(spec); spec.loader.exec_module(wnet)
print('waternet weights sha256', hashlib.sha256(open(WN_W, 'rb').read()).hexdigest()[:16])
class WaterNet12(nn.Module):
    def __init__(self):
        super().__init__(); self.net = wnet.WaterNet()
    def forward(self, x):
        rgb, wb, he, gc = torch.split(x, 3, dim=1)
        return self.net(rgb, wb, he, gc)  # forward(x, wb, ce, gc)
wn = WaterNet12(); wn.net.load_state_dict(torch.load(WN_W, map_location='cpu', weights_only=False)); wn.eval()

class ResidualBlockNoBN(nn.Module):
    def __init__(self, num_feat=64, pytorch_init=False):
        super().__init__()
        self.conv1 = nn.Conv2d(num_feat, num_feat, 3, 1, 1, bias=True); self.conv2 = nn.Conv2d(num_feat, num_feat, 3, 1, 1, bias=True)
        self.lrelu = nn.LeakyReLU(negative_slope=0.1, inplace=True)
    def forward(self, x): return x + self.conv2(self.lrelu(self.conv1(x)))
def make_layer(block, n, **kw): return nn.Sequential(*[block(**kw) for _ in range(n)])
dyd_src = open(f'{UV}/basicsr/archs/newDyD.py').read().replace('import basicsr.archs.blocks as blocks', '')
# 批次 1：卷積核形狀寫成常數（channels, 1, k, k），匯出器才知道動態卷積核的大小
dyd_src = dyd_src.replace('weight = weight.view(b * self.channels, 1, self.kernel_size, self.kernel_size)', 'weight = weight.view(self.channels, 1, self.kernel_size, self.kernel_size)')
dyd = types.ModuleType('newDyD'); exec(dyd_src, dyd.__dict__)
src = open(f'{UV}/basicsr/archs/deblur_arch_small.py').read()
src = src.replace('from basicsr.utils.registry import ARCH_REGISTRY', 'ARCH_REGISTRY = types.SimpleNamespace(register=lambda: (lambda c: c))')
src = src.replace('from .arch_util import ResidualBlockNoBN, flow_warp, make_layer,ResidualBlockNoBN2D', '').replace('from .newDyD import DynamicDWConv as DynamicDWConv', '')
# 批次大小固定為 1：把逐批次迴圈改成等價的單次運算（舊版 ONNX 匯出器無法處理迴圈內的動態 unsqueeze）
loop = '''         mid=[]
         for i in range(b):
             S_d_weight=self.dyd(S_d[i].unsqueeze(0))
             m=F.conv2d(L_d[i].unsqueeze(0), S_d_weight, self.bias.repeat(1), stride=1, padding=1, groups=self.num_feat*16)
             mid.append(m)
         mid=torch.stack(mid)'''
assert src.count(loop) == 2
src = src.replace(loop, '''         S_d_weight=self.dyd(S_d)
         mid=F.conv2d(L_d, S_d_weight, self.bias, stride=1, padding=1, groups=self.num_feat*16)''')
# PixelShuffle 對 4 維做，再補回時間維（與原本對 5 維做完全等價）
assert src.count('         out=pixup(mid)\n         return out') == 2
src = src.replace('         out=pixup(mid)\n         return out', '         out=pixup(mid).unsqueeze(1)\n         return out')
mod = types.ModuleType('deblur_small'); mod.__dict__.update(types=types, ResidualBlockNoBN=ResidualBlockNoBN, make_layer=make_layer, DynamicDWConv=dyd.DynamicDWConv)
exec(src, mod.__dict__)
class UVENetSingle(nn.Module):
    def __init__(self):
        super().__init__(); self.net = mod.Deblur_samll(num_feat=12)
    def forward(self, x):
        y, _ = self.net(x.unsqueeze(1))
        return y[:, 0]
uv = UVENetSingle(); uv.net.load_state_dict(torch.load(f'{UV}/pretrained/samll_net_g.pth', map_location='cpu', weights_only=False)['params'], strict=True); uv.eval()

for name, model, x, dyn in [('waternet', wn, torch.rand(1, 12, 192, 256), True), ('uvenet', uv, torch.rand(1, 3, 192, 256), True)]:
    path = f'{OUT}/{name}.onnx'
    with torch.no_grad(): ref = model(x)
    torch.onnx.export(model, (x,), path, input_names=['x'], output_names=['y'], opset_version=17, dynamo=False,
                      dynamic_axes={'x': {2: 'h', 3: 'w'}, 'y': {2: 'h', 3: 'w'}} if dyn else None)
    np.save(f'{OUT}/{name}_ref_in.npy', x.numpy()); np.save(f'{OUT}/{name}_ref_out.npy', ref.numpy())
    # 另一個尺寸也存一組，確認動態尺寸正確
    x2 = torch.rand(1, x.shape[1], 320, 176)
    with torch.no_grad(): np.save(f'{OUT}/{name}_ref2_out.npy', model(x2).numpy())
    np.save(f'{OUT}/{name}_ref2_in.npy', x2.numpy())
    print(name, 'params', sum(p.numel() for p in model.parameters()), '->', path)
