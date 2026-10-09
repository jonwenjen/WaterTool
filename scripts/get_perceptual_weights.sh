#!/usr/bin/env bash
# 下載 LPIPS 與 FID 用的權重到指定目錄（預設 .cache/perceptual，不放進 git）
#   bash scripts/get_perceptual_weights.sh [目錄]          （PYTHON=… 指定有 numpy 的 Python，預設 python3）
# 需要：Python（numpy、pip）。之後評測用 tools/perceptual_eval.py（另需 torch、scipy、torch-fidelity）。
set -euo pipefail
PY="${PYTHON:-python3}"
DIR="${1:-.cache/perceptual}"
mkdir -p "$DIR"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
# FID：TF 相容 InceptionV3（torch-fidelity 重新上傳的原始 TF 權重）
[ -f "$DIR/weights-inception-2015-12-05-6726825d.pth" ] || curl -fsSL -o "$DIR/weights-inception-2015-12-05-6726825d.pth" \
  https://github.com/toshas/torch-fidelity/releases/download/v0.2.0/weights-inception-2015-12-05-6726825d.pth
# LPIPS：lpips-jax 的原始碼套件內附 AlexNet 骨幹＋線性層，轉成 npz
if [ ! -f "$DIR/lpips_alex.npz" ]; then
  "$PY" -m pip download --no-deps --no-binary :all: -d "$TMP" lpips-jax==0.1.0 >/dev/null
  tar xzf "$TMP"/lpips_jax-0.1.0.tar.gz -C "$TMP" lpips_jax-0.1.0/lpips_jax/weights/alexnet.ckpt
  "$PY" "$(dirname "$0")/../tools/lpips_weights.py" "$TMP/lpips_jax-0.1.0/lpips_jax/weights/alexnet.ckpt" "$DIR/lpips_alex.npz"
fi
ls -la "$DIR"
