"""把 lpips-jax（PyPI，github.com/wilson1yan/lpips-jax）附的 AlexNet LPIPS 權重轉成 numpy .npz。

  python tools/lpips_weights.py <alexnet.ckpt> <lpips_alex.npz>

為什麼用它：LPIPS 原版（richzhang/PerceptualSimilarity）的 AlexNet 骨幹要從 download.pytorch.org 下載，有些網路環境連不到；
lpips-jax 的套件把骨幹（torchvision AlexNet）與 5 個線性層一起打包。線性層與官方 lpips 套件的 v0.1/alex.pth 逐位元相同，
用官方範例圖算出的距離也一樣（ex_ref vs ex_p0 / ex_p1：0.722 / 0.138）。
.ckpt 是 Python pickle；這裡用只允許 numpy 陣列的 Unpickler 讀取，不會執行檔案裡的任何程式。
"""
import pickle
import sys

import numpy as np

ALLOW = {('numpy.core.multiarray', '_reconstruct'), ('numpy._core.multiarray', '_reconstruct'), ('numpy', 'ndarray'), ('numpy', 'dtype')}


class SafeUnpickler(pickle.Unpickler):
    def find_class(self, mod, name):
        if (mod, name) not in ALLOW:
            raise pickle.UnpicklingError(f'不允許的物件：{mod}.{name}')
        if mod.endswith('multiarray'):
            try:
                import numpy._core.multiarray as m
            except ImportError:
                import numpy.core.multiarray as m
            return getattr(m, name)
        return getattr(np, name)


def main(src, dst):
    flat = {}

    def walk(t, path):
        if isinstance(t, dict):
            for k, v in t.items():
                walk(v, path + [str(k)])
        else:
            flat['/'.join(path)] = np.asarray(t)

    with open(src, 'rb') as f:
        walk(SafeUnpickler(f).load(), [])
    need = [f'AlexNet_0/Conv_{i}/{k}' for i in range(5) for k in ('kernel', 'bias')] + [f'NetLinLayer_{i}/Conv_0/kernel' for i in range(5)]
    missing = [k for k in need if k not in flat]
    if missing:
        raise SystemExit(f'權重缺少：{missing}')
    np.savez(dst, **{k: flat[k] for k in need})
    print(f'已寫入 {dst}（{len(need)} 個陣列）')


if __name__ == '__main__':
    main(*sys.argv[1:3])
