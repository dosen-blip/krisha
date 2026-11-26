# Match each photographed spread (img-webp/security-II-NN.webp) to a PDF spread by downsampled correlation.
import glob, os, sys, json
import numpy as np
from PIL import Image, ImageOps
RAW, REPO = sys.argv[1], sys.argv[2]
TH = 40  # comparison height

def prep(im, size, eq=False):
    im = im.convert('RGB').resize(size, Image.BILINEAR)
    if eq: im = ImageOps.equalize(im)
    return np.asarray(im, dtype=np.float32) / 255.0

def ncc(a, b):
    a = a - a.mean(); b = b - b.mean()
    d = np.sqrt((a * a).sum() * (b * b).sum()) + 1e-6
    return float((a * b).sum() / d)

def grad(a):
    g = a.mean(axis=2)
    gx = np.zeros_like(g); gy = np.zeros_like(g)
    gx[:, 1:-1] = g[:, 2:] - g[:, :-2]; gy[1:-1, :] = g[2:, :] - g[:-2, :]
    return np.abs(gx) + np.abs(gy)

out = {}
for iss in ['00', '01']:
    pages = sorted(glob.glob(f'{RAW}/{iss}/*.png'))
    N = len(pages)
    pim = [Image.open(p).convert('RGB').resize((200, int(200 * 1200 / Image.open(p).size[0]))) for p in pages]
    pw, ph = pim[0].size
    spreads = []
    k = 1
    while 2 * k <= N:
        L = pim[2 * k - 1]; R = pim[2 * k] if 2 * k + 1 <= N else Image.new('RGB', (pw, ph), 'black')
        s = Image.new('RGB', (pw * 2, ph)); s.paste(L, (0, 0)); s.paste(R, (pw, 0))
        spreads.append((k, s)); k += 1
    scans = sorted(f for f in glob.glob(f'{REPO}/img-webp/security-{iss}-*.webp') if 'cover' not in f)
    res = {}
    for f in scans:
        sc = Image.open(f).convert('RGB')
        asp = sc.width / sc.height
        tw = round(TH * asp)
        scores = []
        for k, s in spreads:
          tot = 0
          for eq in (False, True):
            T = prep(sc, (tw, TH), eq); Tg = grad(T)
            best = -1; bestp = None
            # the scan shows a window of the spread: try scales (window height relative to spread) and offsets
            for scale in (0.86, 0.92, 1.0, 1.06, 1.12):
                H2 = round(TH * scale); W2 = round(H2 * s.width / s.height)
                S = prep(s, (W2, H2), eq)
                pad = np.zeros((max(H2, TH) + 2 * 6, max(W2, tw) + 2 * 8, 3), np.float32)
                oy = (pad.shape[0] - H2) // 2; ox = (pad.shape[1] - W2) // 2
                pad[oy:oy + H2, ox:ox + W2] = S
                cy = (pad.shape[0] - TH) // 2; cx = (pad.shape[1] - tw) // 2
                for dy in range(-4, 5, 2):
                    for dx in range(-6, 7, 2):
                        y0, x0 = cy + dy, cx + dx
                        if y0 < 0 or x0 < 0 or y0 + TH > pad.shape[0] or x0 + tw > pad.shape[1]: continue
                        W = pad[y0:y0 + TH, x0:x0 + tw]
                        v = 0.5 * ncc(T, W) + 0.5 * ncc(Tg, grad(W))
                        if v > best: best = v; bestp = (scale, dx, dy)
            tot += best
          scores.append((tot / 2, k, bestp))
        scores.sort(reverse=True)
        (b1, k1, p1), (b2, k2, _) = scores[0], scores[1]
        ok = b1 >= 0.4 and b1 - b2 >= 0.08
        res[os.path.basename(f)] = dict(ok=ok, spread=k1, score=round(b1, 3), second=k2, score2=round(b2, 3), margin=round(b1 - b2, 3))
        print(iss, 'OK ' if ok else 'LOW', os.path.basename(f), 'spread', k1, f'pages {2*k1}-{2*k1+1}', round(b1, 3), 'next', k2, round(b2, 3), flush=True)
    out[iss] = res
json.dump(out, open('match-final.json', 'w'), indent=1)
