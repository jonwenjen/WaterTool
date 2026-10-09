"""對 bench-video.mjs --dump 的輸出算 LPIPS 與 FID。

  python tools/perceptual_eval.py <dump 目錄> <權重目錄> <輸出.json> [方法,方法…（只算這些）]

權重目錄要有 lpips_alex.npz 與 weights-inception-2015-12-05-6726825d.pth（scripts/get_perceptual_weights.sh 下載）。
每個方法：LPIPS = 每格與參考格的 LPIPS 平均（逐格、各段、全部）；FID = 全部輸出格 vs 全部參考格的 InceptionV3 特徵分佈距離。
"""
import json, os, sys
import numpy as np
import torch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from perceptual import LPIPSAlex, InceptionFeatures, fid_from_feats

dump, wdir, out = sys.argv[1:4]
only = set(sys.argv[4].split(',')) if len(sys.argv) > 4 else None
torch.set_num_threads(max(1, os.cpu_count() or 1))
meta = json.load(open(os.path.join(dump, 'meta.json')))
lp = LPIPSAlex(os.path.join(wdir, 'lpips_alex.npz'))
inc = InceptionFeatures(os.path.join(wdir, 'weights-inception-2015-12-05-6726825d.pth'))


def load(mid, clip):
    m = meta[clip]
    a = np.fromfile(os.path.join(dump, mid, f'{clip}.u8'), dtype=np.uint8).reshape(-1, m['h'], m['w'], 3)
    return torch.from_numpy(a.astype(np.float32) / 255).permute(0, 3, 1, 2).contiguous()


def batched(fn, x, bs=16):
    return [fn(x[i:i + bs]) for i in range(0, len(x), bs)]


ref = {c: load('reference', c) for c in meta}
ref_feat = np.concatenate([np.concatenate(batched(inc, ref[c])) for c in meta])
res = {}
ids = sorted(d for d in os.listdir(dump) if os.path.isdir(os.path.join(dump, d)) and d != 'reference' and (not only or d in only))
for mid in ids:
    clips, feats, tot, n = {}, [], 0.0, 0
    for c in meta:
        p = os.path.join(dump, mid, f'{c}.u8')
        if not os.path.exists(p):
            continue
        o = load(mid, c)
        dist = torch.cat([lp(o[i:i + 16], ref[c][i:i + 16]) for i in range(0, len(o), 16)])
        clips[c] = {'lpips': float(dist.mean()), 'frames': len(o)}
        tot += float(dist.sum())
        n += len(o)
        feats.append(np.concatenate(batched(inc, o)))
    if not n:
        continue
    res[mid] = {'lpips': tot / n, 'fid': fid_from_feats(np.concatenate(feats), ref_feat), 'frames': n, 'clips': clips}
    print(f"{mid:10s} LPIPS {res[mid]['lpips']:.4f}  FID {res[mid]['fid']:.2f}  ({n} 格)", flush=True)
json.dump(res, open(out, 'w'), indent=1)
