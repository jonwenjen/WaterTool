"""UVENet（Du et al., arXiv 2403.11506，SUVE 訓練）在 UVE-38K 影片上的原生推論：5 格滑動視窗、256×256，
輸出存成原始 RGB（N × 256 × 256 × 3，uint8），給 scripts/bench-video.mjs --pre uvenet=<目錄> 當作網路輸出，
再和其他深度模型一樣擬合成局部色彩轉換套回原解析度（App 的影片模式）。

  python tools/uvenet_infer.py <ddz16/UVENet 倉庫> <net_g_latest.pth> <UVE-38K imgs 目錄> <輸出目錄>

前後補格的方式照原作 inference/inference_uvenet_allvideos.py（開頭重複第 1 格、結尾重複最後一格）。
原作的 basicsr 套件 import 時會編譯 CUDA 運算子（DCN），這裡只載入 UVENet 用到的 arch_util，其餘以空模組代替。
"""
import importlib.util
import os
import subprocess
import sys
import types

import numpy as np
import torch
import torch.nn.functional as F

repo, ckpt, src, out = sys.argv[1:5]
torch.set_num_threads(int(os.environ.get('THREADS', '1')))


def stub(name, **attrs):
    m = types.ModuleType(name)
    m.__path__ = []
    m.__dict__.update(attrs)
    sys.modules[name] = m
    return m


class _Reg:
    def register(self, *a, **k):
        return lambda c: c


for n in ('basicsr', 'basicsr.archs', 'basicsr.ops', 'basicsr.utils'):
    stub(n)
stub('basicsr.ops.dcn', ModulatedDeformConvPack=object, modulated_deform_conv=None)
sys.modules['basicsr.utils'].get_root_logger = lambda *a, **k: None
stub('basicsr.utils.registry', ARCH_REGISTRY=_Reg())


def load(name, rel):
    spec = importlib.util.spec_from_file_location(name, os.path.join(repo, rel))
    m = importlib.util.module_from_spec(spec)
    sys.modules[name] = m
    spec.loader.exec_module(m)
    return m


load('basicsr.archs.arch_util', 'basicsr/archs/arch_util.py')
arch = load('basicsr.archs.uvenet_arch', 'basicsr/archs/uvenet_arch.py')
net = arch.UVENet(arch_type='tiny', num_frame=5, drop_path_rate=0, layer_scale_init_value=1e-6, out_indices=[0, 1, 2, 3])
net.load_state_dict(torch.load(ckpt, map_location='cpu', weights_only=True)['params'], strict=True)
net.eval()


def decode(path):
    w, h = map(int, subprocess.check_output(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height',
                                             '-of', 'csv=p=0', path]).decode().strip().split(','))
    raw = subprocess.check_output(['ffmpeg', '-v', 'error', '-i', path, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])
    return np.frombuffer(raw, np.uint8).reshape(-1, h, w, 3)


os.makedirs(out, exist_ok=True)
for f in sorted(os.listdir(src)):
    if not f.endswith('-raw.gif'):
        continue
    clip = f[:-8]
    raw = decode(os.path.join(src, f))
    n = min(len(raw), len(decode(os.path.join(src, clip + '-ref.gif'))))
    x = torch.from_numpy(raw[:n].astype(np.float32) / 255).permute(0, 3, 1, 2)
    x = F.interpolate(x, (256, 256), mode='bilinear', align_corners=False, antialias=True)  # 原作影片輸入：ffmpeg scale=256:256
    T, half, res = x.shape[0], 2, []
    with torch.no_grad():
        for i in range(T):
            idx = [min(max(j, 0), T - 1) for j in range(i - half, i + half + 1)]  # 視窗超出頭尾時重複第一格／最後一格
            res.append(net(x[idx][None]).clamp(0, 1)[0])
            print(f'\r{clip} {i + 1}/{T}', end='', file=sys.stderr)
    y = (torch.stack(res).permute(0, 2, 3, 1).numpy() * 255).round().astype(np.uint8)
    y.tofile(os.path.join(out, f'{clip}.u8'))
    print(f'\r{clip} {T} 格', file=sys.stderr)
