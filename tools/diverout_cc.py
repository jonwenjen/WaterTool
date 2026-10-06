#!/usr/bin/env python3
"""diverout_cc — underwater colour correction that reproduces DIVEROUT's "High / Standard / Ultra" look.

Reverse-engineered from black-box tests (see MODEL.md). Pure colour correction: per-channel auto-levels on
keyframes, linear interpolation between keyframes, and red-channel synthesis when red is (almost) gone.

Usage
  python3 diverout_cc.py IN.mp4  [OUT.mp4]           video  (audio is copied)
  python3 diverout_cc.py IN.jpg  [OUT.jpg]           single photo
  python3 diverout_cc.py FOLDER  [OUT_FOLDER]        every video / photo in a folder
Options
  --mode     high (default) | ultra | standard      keyframe interval 1 s | 0.5 s | 2 s
  --profile  real (default) | synthetic             level rule fitted on real dive footage | on test charts
  --strength 0..1.5 (default 1.0)                   blend with the original (1 = full correction)
  --max-height N                                    downscale before processing (e.g. 1080 for 4K input)
  --crf N (default 18)                              H.264 quality of the output video
Requires: python3, numpy, opencv-python, ffmpeg/ffprobe on PATH.
"""
import os, sys, json, math, argparse, subprocess, tempfile, shutil
import numpy as np
import cv2

VIDEO_EXT = ('.mp4', '.mov', '.m4v', '.mkv', '.avi')
IMAGE_EXT = ('.jpg', '.jpeg', '.png', '.tif', '.tiff', '.bmp', '.webp')
INTERVAL = {'high': 1.0, 'ultra': 0.5, 'standard': 2.0}

# ---------------------------------------------------------------- model parameters
# 'real'      : black = 0.1th pct of pixels in [32,232], white = 99th pct of all pixels   (+ offsets)
# 'synthetic' : non-flat pixels only, black = 2nd pct of >=32, white = 98th pct of <=232 (+ offsets)
REAL_OFF = np.array([[-7.6, -3.0], [-7.6, 4.3], [-4.5, -3.3]])          # (black, white) for R, G, B
SYN_OFF = np.array([[-10.4, -3.9], [-13.1, -0.4], [-14.1, -1.0]])
# red synthesis  R' = w*R + (1-w)*(G - k*B);  w from the frame's mean red, k from mean(G)/mean(B)
W_TAB = [(0.0, 0.0), (0.4, 0.0), (0.6, 0.10), (3.5, 0.28), (7.0, 0.34), (14.5, 0.37), (30.0, 0.50),
         (42.0, 0.58), (50.0, 0.64), (58.0, 0.70), (60.0, 1.0)]
SYN_RED_OFF = (-1.8, 16.2)                                               # black: 1st pct, white: 98th pct of R'


def red_weight(rmean):
    return float(np.interp(rmean, [x for x, _ in W_TAB], [y for _, y in W_TAB]))


def k_blue(t):
    return float(np.clip(1.18 * t[..., 1].mean() / max(t[..., 2].mean(), 1.0) - 0.40, 0.1, 1.5))


def estimate(img, profile='real'):
    """img: HxWx3 float32 RGB (0..255). Returns (levels[3,2], (w, k))."""
    t = img
    small = cv2.resize(t, (max(1, t.shape[1] // 2), max(1, t.shape[0] // 2)), interpolation=cv2.INTER_AREA) \
        if t.shape[0] > 1200 else t                                       # stats on <= ~1080p for speed
    raw = []
    if profile == 'real':
        for c in range(3):
            v = small[..., c].ravel()
            mid = v[(v >= 32) & (v <= 232)]
            raw.append((np.percentile(mid, 0.1) if mid.size else 0.0, np.percentile(v, 99)))
        lh = np.array(raw) + REAL_OFF
    else:
        y = small @ np.array([0.299, 0.587, 0.114], np.float32)
        g = np.maximum(np.abs(np.diff(y, axis=1, append=y[:, -1:])), np.abs(np.diff(y, axis=0, append=y[-1:, :])))
        m = g >= 1
        if m.sum() < 1000:
            m = np.ones_like(m)
        for c in range(3):
            v = small[..., c][m]
            lo, hi = v[v >= 32], v[v <= 232]
            raw.append((np.percentile(lo, 2) if lo.size else 0.0, np.percentile(hi, 98) if hi.size else 255.0))
        lh = np.array(raw) + SYN_OFF
    w = red_weight(float(small[..., 0].mean()))
    k = k_blue(small)
    if w < 1.0:
        rp = (w * small[..., 0] + (1 - w) * (small[..., 1] - k * small[..., 2])).ravel()
        lh[0] = (np.percentile(rp, 1) + SYN_RED_OFF[0], np.percentile(rp, 98) + SYN_RED_OFF[1])
    return lh, (w, k)


def apply(img, lh, wk, strength=1.0):
    w, k = wk
    out = (img - lh[:, 0]) / np.maximum(lh[:, 1] - lh[:, 0], 1e-3) * 255.0
    if w < 1.0:
        rp = w * img[..., 0] + (1 - w) * (img[..., 1] - k * img[..., 2])
        out[..., 0] = (rp - lh[0, 0]) / max(lh[0, 1] - lh[0, 0], 1e-3) * 255.0
    out = np.clip(out, 0, 255)
    if strength != 1.0:
        out = np.clip(img + strength * (out - img), 0, 255)
    return out


# ---------------------------------------------------------------- video IO (ffmpeg)
def probe(path):
    r = subprocess.run(['ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', path],
                       capture_output=True, text=True)
    return json.loads(r.stdout or '{}')


def video_info(path, max_height):
    info = probe(path)
    vs = [s for s in info.get('streams', []) if s.get('codec_type') == 'video'][0]
    w, h = int(vs['width']), int(vs['height'])
    rot = 0
    for sd in vs.get('side_data_list', []) or []:
        if 'rotation' in sd:
            rot = int(float(sd['rotation']))
    if abs(rot) in (90, 270):
        w, h = h, w
    if max_height and h > max_height:
        w, h = int(round(w * max_height / h / 2) * 2), max_height
    num, den = (vs.get('avg_frame_rate') or vs.get('r_frame_rate') or '30/1').split('/')
    fps = float(num) / float(den) if float(den) else 30.0
    dur = float(vs.get('duration') or info.get('format', {}).get('duration') or 0)
    n = int(vs.get('nb_frames') or 0) or int(round(dur * fps))
    has_audio = any(s.get('codec_type') == 'audio' for s in info.get('streams', []))
    return w, h, fps, n, has_audio


def frames(path, w, h):
    cmd = ['ffmpeg', '-loglevel', 'error', '-i', path, '-map', '0:v:0', '-fps_mode', 'passthrough',
           '-vf', f'scale={w}:{h}:flags=area,format=rgb24', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE)
    size = w * h * 3
    try:
        while True:
            buf = p.stdout.read(size)
            if len(buf) < size:
                break
            yield np.frombuffer(buf, np.uint8).reshape(h, w, 3)
    finally:
        if p.poll() is None:
            p.kill()
        p.wait()


def process_video(src, dst, mode, profile, strength, max_height, crf):
    w, h, fps, n, has_audio = video_info(src, max_height)
    # pass 1: keyframe estimates (keyframes evenly spaced, N = ceil(duration / interval))
    N = max(1, math.ceil(n / fps / INTERVAL[mode] - 1e-9))
    want = sorted(set(min(max(n - 1, 0), int(round(i * n / N))) for i in range(N + 1)))
    est, last, count = {}, None, 0
    for i, f in enumerate(frames(src, w, h)):
        if i in want:
            est[i] = estimate(f.astype(np.float32), profile)
        last, count = (i, f), i + 1
    if count == 0:
        raise SystemExit(f'could not decode {src}')
    if last[0] not in est:
        est[last[0]] = estimate(last[1].astype(np.float32), profile)
    keys = sorted(est)
    # pass 2: render
    tmp = tempfile.mkdtemp()
    vtmp = os.path.join(tmp, 'video.mp4')
    enc = subprocess.Popen(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24',
                            '-s', f'{w}x{h}', '-r', f'{fps:.6f}', '-i', '-',
                            '-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p',
                            '-c:v', 'libx264', '-preset', 'medium', '-crf', str(crf),
                            '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
                            '-color_range', 'tv', vtmp], stdin=subprocess.PIPE)
    for i, f in enumerate(frames(src, w, h)):
        k0 = max(k for k in keys if k <= i) if i >= keys[0] else keys[0]
        k1 = min((k for k in keys if k >= i), default=keys[-1])
        a = 0.0 if k1 == k0 else (i - k0) / (k1 - k0)
        lh = (1 - a) * est[k0][0] + a * est[k1][0]
        wk = tuple((1 - a) * np.array(est[k0][1]) + a * np.array(est[k1][1]))
        out = apply(f.astype(np.float32), lh, wk, strength)
        enc.stdin.write(np.rint(out).astype(np.uint8).tobytes())
        if i % 100 == 0:
            print(f'\r  {i + 1}/{count} frames', end='', flush=True)
    enc.stdin.close(); enc.wait()
    print(f'\r  {count}/{count} frames')
    if has_audio:
        subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', vtmp, '-i', src, '-map', '0:v:0', '-map', '1:a?',
                        '-c', 'copy', '-movflags', '+faststart', dst], check=True)
    else:
        shutil.move(vtmp, dst)
    shutil.rmtree(tmp, ignore_errors=True)


def process_image(src, dst, profile, strength, max_height):
    img = cv2.imread(src, cv2.IMREAD_COLOR)
    if img is None:
        raise SystemExit(f'could not read {src}')
    img = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    if max_height and img.shape[0] > max_height:
        img = cv2.resize(img, (int(img.shape[1] * max_height / img.shape[0]), max_height), interpolation=cv2.INTER_AREA)
    f = img.astype(np.float32)
    lh, wk = estimate(f, profile)
    out = np.rint(apply(f, lh, wk, strength)).astype(np.uint8)
    params = [cv2.IMWRITE_JPEG_QUALITY, 95] if dst.lower().endswith(('.jpg', '.jpeg')) else []
    cv2.imwrite(dst, cv2.cvtColor(out, cv2.COLOR_RGB2BGR), params)


def default_out(src):
    base, ext = os.path.splitext(src)
    return base + '_cc' + ('.mp4' if ext.lower() in VIDEO_EXT else ext)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('input'); ap.add_argument('output', nargs='?')
    ap.add_argument('--mode', default='high', choices=list(INTERVAL))
    ap.add_argument('--profile', default='real', choices=['real', 'synthetic'])
    ap.add_argument('--strength', type=float, default=1.0)
    ap.add_argument('--max-height', type=int, default=0)
    ap.add_argument('--crf', type=int, default=18)
    a = ap.parse_args()
    if os.path.isdir(a.input):
        outdir = a.output or os.path.join(a.input, 'corrected')
        os.makedirs(outdir, exist_ok=True)
        jobs = [(os.path.join(a.input, f), os.path.join(outdir, os.path.splitext(f)[0] + '_cc' +
                 ('.mp4' if f.lower().endswith(VIDEO_EXT) else os.path.splitext(f)[1])))
                for f in sorted(os.listdir(a.input)) if f.lower().endswith(VIDEO_EXT + IMAGE_EXT)]
    else:
        jobs = [(a.input, a.output or default_out(a.input))]
    for src, dst in jobs:
        print(f'{os.path.basename(src)} -> {dst}')
        if src.lower().endswith(VIDEO_EXT):
            process_video(src, dst, a.mode, a.profile, a.strength, a.max_height, a.crf)
        else:
            process_image(src, dst, a.profile, a.strength, a.max_height)
    print('done')


if __name__ == '__main__':
    main()
