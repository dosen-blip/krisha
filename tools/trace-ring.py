#!/usr/bin/env python3
"""
tools/trace-ring.py — traces the KRISHA logo (img/logo.png) into closed outlines for fx/ring.js.

Pipeline (same as the DOSEN EPK neon trace):
  1. coverage = alpha of the blue ink (the PNG is flat #000ca9 with anti-aliased alpha)
  2. marching squares at the half-coverage iso-line (sub-pixel, saddle cells resolved by the cell average)
  3. Ramer-Douglas-Peucker simplification per closed loop (split at the farthest point)
  4. outer / hole classification by even-odd nesting depth; each hole is attached to its tightest outer
  5. orientation normalised for three.js ExtrudeGeometry (outer clockwise, holes counter-clockwise, y up)

Output: fx/ring-shape.js, coordinates in "image-height units": origin at the image centre, y up,
the full image spans x in [-W/2H, W/2H], y in [-0.5, 0.5]. That keeps the flat <img> (object-fit: cover)
and the 3D mesh in exact registration.

usage: python3 tools/trace-ring.py [--tolerance=0.6] [--out=fx/ring-shape.js]
"""
import sys
import os
import math
from collections import defaultdict

import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'img', 'logo.png')

args = dict(a[2:].split('=', 1) for a in sys.argv[1:] if a.startswith('--') and '=' in a)
TOL = float(args.get('tolerance', 0.35))         # RDP tolerance in source pixels
SMOOTH = float(args.get('smooth', 2.0))          # contour smoothing (gaussian sigma, in source pixels of arc)
OUT = os.path.join(ROOT, args.get('out', 'fx/ring-shape.js'))
MIN_AREA = 40.0                                   # drop specks (px^2)


def coverage_of(path):
    im = Image.open(path).convert('RGBA')
    a = np.asarray(im).astype(np.float32)
    alpha = a[..., 3] / 255.0
    # Only blue ink counts (guards against stray non-ink pixels): blue clearly above red/green.
    rgb = a[..., :3]
    ink = (rgb[..., 2] - np.maximum(rgb[..., 0], rgb[..., 1])) > 40
    cov = np.where(ink | (alpha < 0.999), alpha, 0.0)
    return cov, im.size


def marching_squares(f, t=0.5):
    """Returns closed loops of (x, y) sample coordinates (sample (i, j) = column i, row j)."""
    h, w = f.shape
    b = f > t
    a_ = b[:-1, :-1]; b_ = b[:-1, 1:]; c_ = b[1:, 1:]; d_ = b[1:, :-1]
    idx = (a_ * 8) | (b_ * 4) | (c_ * 2) | (d_ * 1)
    ys, xs = np.nonzero((idx != 0) & (idx != 15))

    points = {}
    links = defaultdict(list)

    def lerp(p, q):
        d = q - p
        return (t - p) / d if abs(d) > 1e-9 else 0.5

    for y, x in zip(ys.tolist(), xs.tolist()):
        a = f[y, x]; bb = f[y, x + 1]; c = f[y + 1, x + 1]; d = f[y + 1, x]
        index = int(idx[y, x])
        top = ((y * w + x) * 2)
        bottom = (((y + 1) * w + x) * 2)
        left = ((y * w + x) * 2 + 1)
        right = ((y * w + x + 1) * 2 + 1)

        def put(eid):
            if eid in points:
                return
            if eid == top:
                points[eid] = (x + lerp(a, bb), y)
            elif eid == bottom:
                points[eid] = (x + lerp(d, c), y + 1)
            elif eid == left:
                points[eid] = (x, y + lerp(a, d))
            else:
                points[eid] = (x + 1, y + lerp(bb, c))

        def seg(p, q):
            put(p); put(q)
            links[p].append(q); links[q].append(p)

        centre = (a + bb + c + d) / 4 > t
        if index in (1, 14): seg(left, bottom)
        elif index in (2, 13): seg(bottom, right)
        elif index in (3, 12): seg(left, right)
        elif index in (4, 11): seg(top, right)
        elif index in (6, 9): seg(top, bottom)
        elif index in (7, 8): seg(left, top)
        elif index == 5:
            if centre: seg(left, top); seg(bottom, right)
            else: seg(top, right); seg(left, bottom)
        elif index == 10:
            if centre: seg(top, right); seg(left, bottom)
            else: seg(left, top); seg(bottom, right)

    loops = []
    seen = set()
    for start in list(links.keys()):
        if start in seen:
            continue
        loop = []
        prev = -1
        cur = start
        while cur not in seen:
            seen.add(cur)
            loop.append(points[cur])
            nxt = next((n for n in links[cur] if n != prev and n not in seen), None)
            if nxt is None:
                break
            prev, cur = cur, nxt
        if len(loop) > 8:
            loops.append(loop)
    return loops


def area(pts):
    s = 0.0
    n = len(pts)
    for i in range(n):
        x0, y0 = pts[i]; x1, y1 = pts[(i + 1) % n]
        s += x0 * y1 - x1 * y0
    return s / 2


def seg_dist(p, a, b):
    dx = b[0] - a[0]; dy = b[1] - a[1]
    l = dx * dx + dy * dy
    t = 0.0 if l == 0 else max(0.0, min(1.0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l))
    return math.hypot(p[0] - (a[0] + dx * t), p[1] - (a[1] + dy * t))


def rdp(pts, tol):
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        i0, i1 = stack.pop()
        worst, index = 0.0, -1
        for i in range(i0 + 1, i1):
            d = seg_dist(pts[i], pts[i0], pts[i1])
            if d > worst:
                worst, index = d, i
        if index >= 0 and worst > tol:
            keep[index] = True
            stack.append((i0, index)); stack.append((index, i1))
    return [p for p, k in zip(pts, keep) if k]


def simplify_loop(pts, tol):
    p0 = pts[0]
    far = max(range(len(pts)), key=lambda i: (pts[i][0] - p0[0]) ** 2 + (pts[i][1] - p0[1]) ** 2)
    first = rdp(pts[:far + 1], tol)
    second = rdp(pts[far:] + [pts[0]], tol)
    return first + second[1:-1]


def smooth_loop(pts, sigma):
    """Gaussian smoothing of a closed loop along its arc length: removes the marching-squares ripple that
    would otherwise streak a glossy side wall, while rounding sharp tips by well under a pixel on screen.
    Tips (sharp turns) are protected by blending back toward the raw point by local curvature."""
    if sigma <= 0:
        return pts
    a = np.asarray(pts, dtype=np.float64)
    n = len(a)
    seg = np.linalg.norm(np.roll(a, -1, axis=0) - a, axis=1)
    step = max(1e-6, float(np.median(seg)))
    r = max(1, int(round(3 * sigma / step)))
    k = np.exp(-0.5 * (np.arange(-r, r + 1) * step / sigma) ** 2)
    k /= k.sum()
    out = np.zeros_like(a)
    for i, w in enumerate(k):
        out += w * np.roll(a, i - r, axis=0)
    # protect tips: where the raw outline turns sharply, keep the raw point
    prev = a - np.roll(a, 3, axis=0); nxt = np.roll(a, -3, axis=0) - a
    cosang = (prev * nxt).sum(1) / (np.linalg.norm(prev, axis=1) * np.linalg.norm(nxt, axis=1) + 1e-9)
    keep = np.clip((-cosang - 0.2) / 0.5, 0, 1)[:, None]      # > ~100 deg turn -> raw
    out = out * (1 - keep) + a * keep
    return [tuple(p) for p in out.tolist()]


def inside(pt, poly):
    x, y = pt
    c = False
    n = len(poly)
    j = n - 1
    for i in range(n):
        xi, yi = poly[i]; xj, yj = poly[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            c = not c
        j = i
    return c


def main():
    cov, (W, H) = coverage_of(SRC)
    f = np.pad(cov, 1)                               # closes loops that touch the image edge
    raw = marching_squares(f, 0.5)

    loops = []
    for lp in raw:
        # sample (i, j) of the padded field is the centre of source pixel (i - 1, j - 1)
        pts = [(x - 1 + 0.5, y - 1 + 0.5) for x, y in lp]
        if abs(area(pts)) < MIN_AREA:
            continue
        s = simplify_loop(smooth_loop(pts, SMOOTH), TOL)
        if len(s) >= 3 and abs(area(s)) >= MIN_AREA:
            loops.append(s)

    # even-odd nesting: depth = number of other loops containing this one's first vertex
    depth = []
    for i, lp in enumerate(loops):
        d = sum(1 for j, other in enumerate(loops) if j != i and inside(lp[0], other))
        depth.append(d)

    # convert to image-height units, y up (flips orientation, so classify after conversion)
    def conv(p):
        return ((p[0] - W / 2) / H, (H / 2 - p[1]) / H)
    loops_u = [[conv(p) for p in lp] for lp in loops]

    shapes = []
    outer_index = {}
    for i, lp in enumerate(loops_u):
        if depth[i] % 2 == 0:
            pts = lp if area(lp) < 0 else lp[::-1]   # outer: clockwise (three's canonical form)
            outer_index[i] = len(shapes)
            shapes.append({'outer': pts, 'holes': []})
    for i, lp in enumerate(loops_u):
        if depth[i] % 2 == 1:
            # tightest containing outer = containing loop with depth[i] - 1
            parents = [j for j in outer_index if depth[j] == depth[i] - 1 and inside(loops[i][0], loops[j])]
            if not parents:
                continue
            parent = min(parents, key=lambda j: abs(area(loops[j])))
            pts = lp if area(lp) > 0 else lp[::-1]   # hole: counter-clockwise
            shapes[outer_index[parent]]['holes'].append(pts)

    allpts = [p for s in shapes for p in s['outer']]
    xs = [p[0] for p in allpts]; ys = [p[1] for p in allpts]
    bounds = (min(xs), max(xs), min(ys), max(ys))

    # ink centroid (area-weighted, in the same units) — the spin pivot
    yy, xx = np.nonzero(cov > 0)
    wts = cov[yy, xx]
    cx = float(((xx + 0.5) * wts).sum() / wts.sum()); cy = float(((yy + 0.5) * wts).sum() / wts.sum())
    centroid = conv((cx, cy))

    # principal axis of the ink (the ring's long axis), degrees from +x, y up
    dx = (xx + 0.5 - cx); dy = -(yy + 0.5 - cy)
    cxx = float((wts * dx * dx).sum()); cyy = float((wts * dy * dy).sum()); cxy = float((wts * dx * dy).sum())
    axis = 0.5 * math.degrees(math.atan2(2 * cxy, cxx - cyy))

    fmt = lambda v: ('%.5f' % v).rstrip('0').rstrip('.') if v != 0 else '0'
    flat = lambda pts: '[' + ','.join(fmt(c) for p in pts for c in p) + ']'

    total = sum(len(s['outer']) + sum(len(h) for h in s['holes']) for s in shapes)
    lines = []
    lines.append('// GENERATED by tools/trace-ring.py from img/logo.png — do not edit by hand.')
    lines.append('// Units: image-height units, origin at the image centre, y up. The source image spans')
    lines.append('// x in [-ASPECT/2, ASPECT/2], y in [-0.5, 0.5]. Outer loops clockwise, holes counter-clockwise.')
    lines.append('// %d shapes, %d holes, %d points (smoothing sigma %.1f px, RDP tolerance %.2f px).' % (
        len(shapes), sum(len(s['holes']) for s in shapes), total, SMOOTH, TOL))
    lines.append('export const IMAGE = { width: %d, height: %d };' % (W, H))
    lines.append('export const ASPECT = %s;' % fmt(W / H))
    lines.append('export const BOUNDS = { minX: %s, maxX: %s, minY: %s, maxY: %s };' % tuple(fmt(b) for b in bounds))
    lines.append('export const CENTROID = [%s, %s];' % (fmt(centroid[0]), fmt(centroid[1])))
    lines.append('export const AXIS_DEG = %s;' % fmt(axis))
    lines.append('export const SHAPES = [')
    for s in shapes:
        holes = ','.join(flat(h) for h in s['holes'])
        lines.append('  { outer: %s, holes: [%s] },' % (flat(s['outer']), holes))
    lines.append('];')
    with open(OUT, 'w') as fh:
        fh.write('\n'.join(lines) + '\n')

    print('loops', len(loops), 'depths', depth)
    for k, s in enumerate(shapes):
        print('shape', k, 'outer pts', len(s['outer']), 'area', round(abs(area(s['outer'])), 5),
              'holes', [len(h) for h in s['holes']])
    print('bounds', [round(b, 4) for b in bounds], 'centroid', [round(c, 4) for c in centroid], 'axis', round(axis, 2))
    print('total points', total, '->', OUT, os.path.getsize(OUT), 'bytes')


if __name__ == '__main__':
    main()
