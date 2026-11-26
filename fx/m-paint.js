/*
 * fx/m-paint.js — Paint page on phones (<= 700px), WebGL. "The phone is the lamp."
 *
 *  Gallery  One canvas, absolutely positioned inside .mobile-paint-gallery as a sliding window (about two screens
 *           tall, re-centred on the viewport as you scroll), so it scrolls with the compositor and never drifts
 *           against the DOM. Each painting is a thin box at its static framing (same crop as the <img>), relief from
 *           neighbouring-texel luminance, lit by a raking lamp:
 *             - no sensor permission (or before it): the lamp sits off the left edge at mid-screen, so a painting
 *               crossing the screen is lit from below-left, then side-on, then from above-left. It fades in while
 *               you scroll and out ~1s after you stop (rest = the static image, loop idle).
 *             - motion live (fx/m-motion.js): the lamp follows the tilt and the boxes turn a degree or two.
 *           At rest the canvas is cleared and the <img>s show (rest = the static page, exactly); while lit or
 *           turned, DOM imgs are hidden only once GL drew them and only while they sit fully inside the window.
 *  Focus    Tap a painting: Win98 zoom rectangles from its box to the screen, white, the work arrives interlaced
 *           (32 -> 12 -> 4px blocks -> sharp) turning in to show its edge, the caption types in. The first focus tap
 *           calls enableMotion({ ask: true }). In focus: tilt turns the canvas a few degrees and moves the lamp;
 *           tap / pinch = MS-Paint magnifier (hard steps 1x 2x 4x 8x, "400%" readout, nearest texels at 8x);
 *           drag pans when magnified; swipe left / right = next / previous through a Bayer dither dissolve ("3/9");
 *           CLOSE / swipe down / Esc flies it back into its slot while the white dithers away.
 *  Layers   Viewer z 92 (above the sticky phone nav, z 80; below transitions, 100). See fx/m-paint.css.
 *
 *  The viewer controller (gestures, zoom steps, timeline, chrome) is exported and shared with fx/paint-lite.js,
 *  which renders the same viewer with plain DOM on phones without WebGL.
 *
 *  Physical data (cm, wood, diptych seams) is read from the desktop .figure that shows the same image file.
 */

import { motion, enableMotion } from './m-motion.js';

const DEG = Math.PI / 180;
export const LEVELS = [1, 2, 4, 8];
const RECT_STEPS = 7, RECT_MS = 40, RECT_TRAIL = 3;   // same zoom rectangles as fx/transitions.js
const ARRIVE = [[32, 0], [12, 110], [4, 210]];        // [block px, ms after the white lands]; sharp at SHARP_MS
const SHARP_MS = 310;
const HI_WAIT_MS = 1600;                              // hold the 4px pass this long for the full-size texture
const TURN_MS = 680;
const DISSOLVE_MS = 70;                               // dither dissolve: 4 hard steps
const CLOSE_MS = 560;
const PAIR_GAP_CM = 5, SEAM_GAP_CM = 1.2;
const HI_SIDE = 2048, LO_SIDE = 512;
// gallery textures: oversampled and read with a negative LOD bias so a lit painting keeps the grain the <img> has
const OVERSAMPLE = 1.5;
const GRAD_SCALE = Math.pow(2, -0.6);

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const easeIO = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const damp = (rate, dt) => 1 - Math.exp(-rate * dt);
const strip = (h) => { const d = document.createElement('div'); d.innerHTML = h; return d.textContent.replace(/\s+/g, ' ').trim(); };
const navH = () => Math.round((62 * document.documentElement.clientWidth) / 402);

/* ================================================================== shared: data */

export function coverCrop(rw, rh, iw, ih) {
  if (!iw || !ih || !rw || !rh) return [0, 0, 1, 1];
  const ra = rw / rh, ia = iw / ih;
  if (ia > ra) { const sx = ra / ia; return [(1 - sx) / 2, 0, sx, 1]; }
  const sy = ia / ra; return [0, (1 - sy) / 2, 1, sy];
}

/** The phone gallery's works in order: { i, fig, imgs, lines, panels: [{ img, u0, u1, cmW0, cmH0, wood, gap }] }. */
export function readWorks(page) {
  const gallery = page && page.querySelector('.mobile-paint-gallery');
  if (!gallery) return [];
  const desk = [...page.querySelectorAll(':scope > .figure')];
  const metaOf = (img) => {
    const src = img.getAttribute('src');
    const f = desk.find((d) => { const i = d.querySelector('img'); return i && i.getAttribute('src') === src; });
    return f ? f.dataset : {};
  };
  return [...gallery.querySelectorAll('figure')].filter((f) => f.querySelector('img')).map((fig, i) => {
    const cap = fig.querySelector('figcaption');
    const lines = cap ? cap.innerHTML.split(/<br\s*\/?>/i).map(strip).filter(Boolean) : [];
    const imgs = [...fig.querySelectorAll('img')];
    const panels = [];
    imgs.forEach((img) => {
      const d = metaOf(img);
      const [cw, ch] = String(d.cm || '').split(/x/i).map(Number);
      const seams = imgs.length > 1 ? [] : String(d.seams || '').split(/[\s,]+/).filter(Boolean).map(Number).filter((v) => v > 0 && v < 1);
      const cuts = [0, ...seams, 1];
      for (let s = 0; s < cuts.length - 1; s++) {
        panels.push({
          img, u0: cuts[s], u1: cuts[s + 1], cmW0: cw || 0, cmH0: ch || cw || 0, wood: d.support === 'wood',
          gap: panels.length ? (s === 0 ? PAIR_GAP_CM : SEAM_GAP_CM) : 0,
        });
      }
    });
    return { i, fig, imgs, lines, panels: panels.slice(0, 4), geom: null };
  });
}

/** Panels in cm (area from the data, proportions from the photo), total extent and box depth. */
export function workGeometry(w) {
  if (w.geom) return w.geom;
  let ready = true;
  const panels = w.panels.map((pn) => {
    const iw = pn.img.naturalWidth, ih = pn.img.naturalHeight;
    if (!iw || !ih) ready = false;
    const a = iw && ih ? iw / ih : 1;
    const area = pn.cmW0 && pn.cmH0 ? pn.cmW0 * pn.cmH0 : 6400;
    const W = Math.sqrt(area * a), H = Math.sqrt(area / a);
    return { cmW: W * (pn.u1 - pn.u0), cmH: H, gap: pn.gap };
  });
  const cmW = panels.reduce((s, p) => s + p.cmW + p.gap, 0);
  const cmH = Math.max(...panels.map((p) => p.cmH));
  const longCm = Math.max(...panels.map((p) => Math.max(p.cmW, p.cmH)));
  const wood = w.panels.some((p) => p.wood);
  const g = { panels, cmW, cmH, longCm, depthCm: wood ? 1.8 : clamp(1.6 + 0.02 * longCm, 2.2, 4.2), wood };
  if (ready) w.geom = g;
  return g;
}

/** Screen rect of a panel's part of its gallery <img> (object-fit: cover) and the image crop it shows. */
export function slotOf(pn) {
  const br = pn.img.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const sn = (v) => Math.round(v * dpr) / dpr;
  const r = { left: sn(br.left), top: sn(br.top), width: sn(br.width), height: sn(br.height) };
  const crop = coverCrop(r.width, r.height, pn.img.naturalWidth, pn.img.naturalHeight);
  const a = clamp((pn.u0 - crop[0]) / crop[2], 0, 1), b = clamp((pn.u1 - crop[0]) / crop[2], 0, 1);
  const x0 = r.left + r.width * a, x1 = r.left + r.width * b;
  return {
    cx: (x0 + x1) / 2, cy: r.top + r.height / 2, w: x1 - x0, h: r.height,
    crop: [crop[0] + a * crop[2], crop[1], (b - a) * crop[2], crop[3]],
  };
}

const unionOf = (rs) => {
  const x0 = Math.min(...rs.map((r) => r.cx - r.w / 2)), x1 = Math.max(...rs.map((r) => r.cx + r.w / 2));
  const y0 = Math.min(...rs.map((r) => r.cy - r.h / 2)), y1 = Math.max(...rs.map((r) => r.cy + r.h / 2));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
};

/* ================================================================== shared: Bayer dither */

export const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
export const DITHER_CELL = 3;           // CSS px per dither cell
const maskCache = new Map();
/** CSS mask (data URL, tile = 4 cells) that keeps cells whose Bayer threshold is below k (or not, inverted). */
export function bayerMask(k, inv = false) {
  const key = `${k.toFixed(3)}|${inv}`;
  if (maskCache.has(key)) return maskCache.get(key);
  const dpr = Math.max(1, Math.round(window.devicePixelRatio || 1));
  const cell = DITHER_CELL * dpr, c = document.createElement('canvas');
  c.width = c.height = cell * 4;
  const g = c.getContext('2d');
  g.fillStyle = '#000';
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
    const b = (BAYER4[x + y * 4] + 0.5) / 16;
    if (inv ? b >= k : b < k) g.fillRect(x * cell, y * cell, cell, cell);
  }
  const url = `url(${c.toDataURL()})`;
  maskCache.set(key, url);
  return url;
}

/* ================================================================== shared: viewer chrome */

/**
 * The viewer's DOM: a fixed root (z 92) with a renderer slot, a zoom-rectangle layer, a Win98-ish title bar
 * (< 3/9 >, the magnifier readout, CLOSE) and the typed caption.
 */
export function buildShell(total) {
  const root = document.createElement('div');
  root.className = 'fx-mpaint';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-labelledby', 'fx-mpaint-title');
  root.setAttribute('aria-describedby', 'fx-mpaint-desc');
  root.hidden = true;
  root.innerHTML = `
    <div class="fx-mpaint__view"></div>
    <div class="fx-mpaint__rects" aria-hidden="true"></div>
    <div class="fx-mpaint__bar">
      <div class="fx-mpaint__nav">
        <button type="button" class="fx-mpaint__prev" aria-label="Previous painting">&lt;</button>
        <span class="fx-mpaint__count" aria-hidden="true">1/${total}</span>
        <button type="button" class="fx-mpaint__next" aria-label="Next painting">&gt;</button>
      </div>
      <span class="fx-mpaint__zoom" aria-hidden="true">100%</span>
      <button type="button" class="fx-mpaint__close" aria-label="Close painting">CLOSE</button>
    </div>
    <div class="fx-mpaint__cap">
      <div class="fx-mpaint__lines" aria-hidden="true"></div>
      <p class="fx-mpaint__hint" aria-hidden="true">TAP OR PINCH TO MAGNIFY &middot; SWIPE FOR NEXT</p>
    </div>
    <p class="fx-mpaint__sr" id="fx-mpaint-title" aria-live="polite"></p>
    <p class="fx-mpaint__sr" id="fx-mpaint-desc"></p>`;
  document.body.append(root);
  const $ = (s) => root.querySelector(s);
  const S = {
    root, view: $('.fx-mpaint__view'), rects: $('.fx-mpaint__rects'), bar: $('.fx-mpaint__bar'),
    count: $('.fx-mpaint__count'), zoom: $('.fx-mpaint__zoom'), close: $('.fx-mpaint__close'),
    prev: $('.fx-mpaint__prev'), next: $('.fx-mpaint__next'), cap: $('.fx-mpaint__cap'),
    lines: $('.fx-mpaint__lines'), hint: $('.fx-mpaint__hint'), title: $('#fx-mpaint-title'), desc: $('#fx-mpaint-desc'),
    typing: 0,
  };
  S.setCount = (i) => { S.count.textContent = `${i + 1}/${total}`; };
  S.setZoom = (z) => {
    S.zoom.textContent = `${z * 100}%`;
    S.zoom.classList.toggle('is-mag', z > 1);
  };
  S.chrome = (on) => root.classList.toggle('is-chrome', !!on);
  S.clearType = () => { clearTimeout(S.typing); S.lines.innerHTML = ''; };
  S.type = (lines, delay = 0) => {
    S.clearType();
    const els = lines.map((txt, k) => {
      const d = document.createElement('div');
      d.className = k === 0 ? 'fx-mpaint__title' : 'fx-mpaint__line';
      d.innerHTML = '&nbsp;';
      S.lines.append(d);
      return d;
    });
    const caret = document.createElement('span');
    caret.className = 'fx-mpaint__caret';
    let li = 0, ci = 0;
    const step = () => {
      if (li >= lines.length) { caret.remove(); return; }
      ci++;
      els[li].textContent = lines[li].slice(0, ci);
      els[li].append(caret);
      if (ci >= lines[li].length) { li++; ci = 0; S.typing = setTimeout(step, 80); return; }
      S.typing = setTimeout(step, lines[li][ci - 1] === ' ' ? 10 : 20);
    };
    S.typing = setTimeout(step, delay);
  };
  return S;
}

/** Win98 zoom rectangles between two boxes (viewport px) on a hard step grid; resolves when done. */
export function zoomRects(layer, from, to, { steps = RECT_STEPS, ms = RECT_MS, trail = RECT_TRAIL, curve = 1.3 } = {}) {
  const els = [];
  for (let j = 0; j < trail; j++) {
    const r = document.createElement('div');
    r.className = 'fx-mpaint__rect';
    layer.append(r);
    els.push(r);
  }
  const at = (s) => {
    const t = Math.pow(s / (steps - 1), curve);
    const x = Math.round(lerp(from.x, to.x, t)), y = Math.round(lerp(from.y, to.y, t));
    const r = Math.round(lerp(from.x + from.w, to.x + to.w, t)), b = Math.round(lerp(from.y + from.h, to.y + to.h, t));
    return { x, y, w: Math.max(2, r - x), h: Math.max(2, b - y) };
  };
  let raf = 0, shown = -1, done = false, resolve;
  const finished = new Promise((res) => { resolve = res; });
  const t0 = performance.now();
  const end = () => {
    if (done) return;
    done = true;
    cancelAnimationFrame(raf);
    clearTimeout(backstop);
    els.forEach((e) => e.remove());
    resolve();
  };
  const tick = () => {
    raf = 0;
    const k = Math.floor((performance.now() - t0) / ms);
    if (k >= steps) { end(); return; }
    if (k !== shown) {
      shown = k;
      for (let j = 0; j < trail; j++) {
        const s = k - j, e = els[j];
        if (s < 0) { e.style.display = 'none'; continue; }
        const q = at(s);
        e.style.cssText = `display:block;left:${q.x}px;top:${q.y}px;width:${q.w}px;height:${q.h}px`;
      }
    }
    raf = requestAnimationFrame(tick);
  };
  const backstop = setTimeout(end, steps * ms + 250);
  tick();
  return { finished, cancel: end };
}

/* ================================================================== shared: viewer controller */

/**
 * createViewer({ works, shell, renderer, page, onOpen(wi), onLift(wi, on), onClosing(wi), onClosed(wi) })
 *   renderer: { request(), texState(wi) -> 0|1|2 (none / preview / full), load(wi, prio), show(on) }
 *   The renderer owns the frame loop: each frame it calls viewer.frame(now) -> { pose, busy } and draws pose:
 *   pose = { veil: 0..1 (dither coverage), lamp: {x,y,z,amt} (screen px), items: [{ wi, gx, gy, yaw, pitch, pix,
 *            nearest, mask, maskInv, panels: [{ pn, cx, cy, w, h, crop, depth, ex, ey }] }] }
 */
export function createViewer(o) {
  const { works, shell: S, renderer } = o;
  const html = document.documentElement;
  const N = works.length;
  const root = S.root;
  const V = {
    state: 'closed', wi: 0, zi: 0, pan: { x: 0, y: 0 }, drag: { x: 0, y: 0 },
    g: null, ptrs: new Map(), act: 0, actUntil: 0, tA: 0, dirA: 1, dis: null, cl: null, L: null,
    rects: null, last: 0, landed: 0, opener: null, hiUntil: 0,
  };
  const cleanups = [];
  const on = (el, type, fn, opts) => { el.addEventListener(type, fn, opts); cleanups.push(() => el.removeEventListener(type, fn, opts)); };
  const poke = () => renderer.request();
  const now = () => performance.now();
  const W = () => root.clientWidth || innerWidth;
  const H = () => root.clientHeight || innerHeight;

  const CAP_GAP = 12;
  function area() {
    const top = S.bar.offsetHeight + 14;
    const end = H() - 12;
    const capH = S.cap.offsetHeight;
    return { left: 16, top, right: W() - 16, bottom: Math.max(top + 120, end - capH - CAP_GAP), end, capH };
  }
  function layoutOf(wi) {
    const g = workGeometry(works[wi]);
    const A = area();
    const aw = A.right - A.left, ah = A.bottom - A.top;
    let k = Math.min(aw / g.cmW, ah / g.cmH);
    k *= 0.74 + 0.26 * clamp((g.longCm - 50) / 70, 0, 1);   // real size, gently: a 50cm work sits smaller
    const Wd = g.cmW * k, Hd = g.cmH * k, cx = (A.left + A.right) / 2;
    // painting + caption as one block, a little above the middle of the free space
    const free = Math.max(0, A.end - A.top - (Hd + CAP_GAP + A.capH));
    const y0 = A.top + free * 0.42;
    const cy = y0 + Hd / 2;
    A.capTop = Math.round(y0 + Hd + CAP_GAP - 10);
    let x = cx - Wd / 2;
    const panels = g.panels.map((p) => { x += p.gap * k; const w = p.cmW * k, h = p.cmH * k; const r = { cx: x + w / 2, cy, w, h, cmW: p.cmW }; x += w; return r; });
    return { k, W: Wd, H: Hd, cx, cy, panels, A, g };
  }
  function setLayout(wi) {
    V.L = layoutOf(wi);
    S.cap.style.top = `${V.L.A.capTop}px`;
    S.cap.style.bottom = 'auto';
    return V.L;
  }
  function clampPan(z, p, L) {
    const aw = L.A.right - L.A.left + 32, ah = L.A.bottom - L.A.top;
    const mx = Math.max(0, (L.W * z - aw) / 2), my = Math.max(0, (L.H * z - ah) / 2 + 24);
    return { x: clamp(p.x, -mx, mx), y: clamp(p.y, -my, my) };
  }

  /* ---------------- poses */
  function itemPose(wi, L, { ox = 0, oy = 0, s = 1, z = 1, pan = { x: 0, y: 0 }, yaw = 0, pitch = 0, pix = 0 } = {}) {
    const w = works[wi];
    const gx = L.cx + pan.x + ox, gy = L.cy + pan.y + oy, k = z * s;
    return {
      wi, gx, gy, yaw, pitch, pix, nearest: z >= 8 ? 1 : 0, mask: 1, maskInv: 0,
      panels: L.panels.map((r, j) => {
        const pn = w.panels[j];
        const pw = r.w * k;
        return {
          pn, cx: gx + (r.cx - L.cx) * k, cy: gy + (r.cy - L.cy) * k, w: pw, h: r.h * k,
          crop: [pn.u0, 0, pn.u1 - pn.u0, 1], depth: L.g.depthCm * (pw / r.cmW), ex: gx, ey: gy,
        };
      }),
    };
  }

  function lampOf(t, dt) {
    const live = motion.live;
    const mx = live ? motion.x : 0, my = live ? motion.y : 0;
    const tiltAmt = live ? clamp(Math.hypot(mx, my) * 2.4, 0, 1) : 0;
    const target = t < V.actUntil ? 1 : 0;
    V.act += (target - V.act) * damp(target > V.act ? 7 : 1.6, dt);
    if (Math.abs(target - V.act) < 0.003) V.act = target;
    const w = W(), h = H();
    const sx = -0.18 * w, sy = 0.22 * h;                 // resting raking lamp: upper left, off-screen
    const tx = w * (0.5 + 1.15 * mx), ty = h * (0.45 + 0.9 * my);
    const wS = V.act, wT = tiltAmt, sum = wS + wT + 1e-6;
    return {
      x: (sx * wS + tx * wT) / sum || sx, y: (sy * wS + ty * wT) / sum || sy, z: 150,
      amt: Math.max(wS, wT), busy: V.act !== target,
    };
  }
  const touchAct = (ms = 1200) => { V.actUntil = Math.max(V.actUntil, now() + ms); };

  /* ---------------- open / swipe / close */
  function open(wi) {
    if (V.state !== 'closed' || !works[wi]) return;
    V.wi = wi; V.zi = 0; V.pan = { x: 0, y: 0 }; V.drag = { x: 0, y: 0 }; V.dis = null; V.cl = null; V.g = null;
    V.ptrs.clear();
    V.opener = works[wi].fig;
    html.dataset.fxModal = 'm-paint';
    if (o.page) o.page.inert = true;
    root.hidden = false;
    root.classList.remove('is-mag', 'is-dragging');
    S.chrome(false);
    S.setCount(wi);
    S.setZoom(1);
    S.clearType();
    setAria(wi);
    renderer.show(true);
    renderer.load(wi, 2);
    try { o.onOpen && o.onOpen(wi); } catch (e) { /* the viewer still opens */ }
    const slots = works[wi].panels.map(slotOf);
    const from = unionOf(slots);
    V.dirA = from.x + from.w / 2 < W() / 2 ? 1 : -1;
    V.state = 'rects';
    V.rects = zoomRects(S.rects, from, { x: 0, y: 0, w: W(), h: H() });
    V.rects.finished.then(() => {
      V.rects = null;
      if (V.state !== 'rects') return;
      V.state = 'arrive';
      V.tA = now();
      setLayout(wi);
      S.chrome(true);
      S.type(works[wi].lines, 260);
      try { S.close.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
      o.onLift && o.onLift(wi, true);
      touchAct(TURN_MS + 900);
      poke();
    });
    poke();
  }

  function setAria(wi) {
    const ln = works[wi].lines;
    S.title.textContent = ln[0] || 'Painting';
    S.desc.textContent = `${ln.slice(1).join('. ')}. ${wi + 1} of ${N}. Tap or pinch to magnify, swipe for the next painting, swipe down to close.`;
  }

  function go(dir) {
    if (V.state !== 'open' && V.state !== 'arrive') return;
    if (V.dis) return;
    const t = now();
    const from = V.wi, fromL = V.L, fromPose = { ox: V.drag.x, z: LEVELS[V.zi], pan: { ...V.pan } };
    const wi = (V.wi + dir + N) % N;
    V.dis = { from, fromL, fromPose, t0: t, dir };
    V.hiUntil = t + HI_WAIT_MS;
    V.wi = wi; V.zi = 0; V.pan = { x: 0, y: 0 }; V.drag = { x: 0, y: 0 };
    setLayout(wi);
    root.classList.remove('is-mag');
    V.state = 'open';
    o.onLift && o.onLift(from, false, true);
    o.onLift && o.onLift(wi, true);
    S.setCount(wi); S.setZoom(1); setAria(wi);
    S.type(works[wi].lines, 120);
    renderer.load(wi, 2);
    renderer.load((wi + dir + N) % N, 1);
    touchAct(900);
    poke();
  }

  function scrollSlotIntoView(wi) {
    const r = unionOf(works[wi].panels.map(slotOf));
    const top = navH() + 8, bottom = innerHeight - 8;
    if (r.y >= top && r.y + r.h <= bottom) return;
    const y = window.scrollY + r.y + r.h / 2 - (top + (bottom - top) / 2);
    try { window.scrollTo({ top: Math.max(0, y), behavior: 'instant' }); } catch (e) { window.scrollTo(0, Math.max(0, y)); }
  }

  function close() {
    if (V.state === 'closing' || V.state === 'closed') return;
    if (V.state === 'rects') { if (V.rects) V.rects.cancel(); finishClose(); return; }
    const t = now();
    const cur = currentPose(t, 0);
    if (V.dis) { o.onLift && o.onLift(V.dis.from, false, true); V.dis = null; }
    scrollSlotIntoView(V.wi);
    const slots = works[V.wi].panels.map(slotOf);
    const sc = unionOf(slots);
    V.cl = { t0: t, from: cur, slots, sc, dir: sc.x + sc.w / 2 < W() / 2 ? 1 : -1 };
    V.state = 'closing';
    V.g = null; V.ptrs.clear();
    S.chrome(false);
    S.clearType();
    o.onClosing && o.onClosing(V.wi);
    zoomRects(S.rects, { x: 0, y: 0, w: W(), h: H() }, sc, { curve: 0.75 });
    poke();
  }

  function finishClose() {
    const wi = V.wi;
    V.state = 'closed';
    V.cl = null; V.dis = null; V.g = null; V.ptrs.clear();
    root.hidden = true;
    S.clearType();
    renderer.show(false);
    delete html.dataset.fxModal;
    if (o.page) o.page.inert = false;
    o.onClosed && o.onClosed(wi);
    const op = V.opener;
    if (op && op.isConnected) { try { op.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
  }

  /* ---------------- per-frame pose */
  function currentPose(t, dt) {
    const L = V.L || setLayout(V.wi);
    const live = motion.live;
    const z = LEVELS[V.zi];
    let yaw = 0, pitch = 0, pix = 0;
    if (V.state === 'arrive' || V.state === 'open') {
      const ka = clamp((t - V.tA) / TURN_MS, 0, 1);
      const left = 1 - easeOut(ka);
      yaw = V.dirA * 17 * DEG * left; pitch = -4 * DEG * left;
      if (live && z === 1) { yaw += motion.x * 7 * DEG; pitch += -motion.y * 5 * DEG; }
    }
    if (V.state === 'arrive') pix = arrivePix(t);
    const dy = Math.max(0, V.drag.y);
    const s = 1 - 0.24 * clamp(dy / (H() * 0.6), 0, 1);
    return itemPose(V.wi, L, { ox: V.drag.x, oy: V.drag.y, s, z, pan: V.pan, yaw, pitch, pix });
  }
  function arrivePix(t) {
    const e = t - V.tA;
    if (e >= SHARP_MS) {
      const st = renderer.texState(V.wi);
      if (st >= 2 || e > HI_WAIT_MS) return 0;
      return st >= 1 ? 4 : 32;
    }
    let pix = ARRIVE[0][0];
    ARRIVE.forEach(([p, at]) => { if (e >= at) pix = p; });
    return pix;
  }

  function frame(t) {
    const dt = V.last ? clamp((t - V.last) / 1000, 0, 0.1) : 1 / 60;
    V.last = t;
    if (V.state === 'closed') { V.last = 0; return { pose: null, busy: false }; }
    if (V.state === 'rects') return { pose: { veil: 0, items: [], lamp: { x: 0, y: 0, z: 1, amt: 0 } }, busy: true };
    let busy = false;
    const lamp = lampOf(t, dt);
    if (lamp.busy) busy = true;
    const items = [];
    let veil = 1;

    if (V.state === 'closing') {
      const C = V.cl;
      const p = clamp((t - C.t0) / CLOSE_MS, 0, 1), e = easeIO(p), sw = Math.sin(Math.PI * p);
      const f = C.from;
      items.push({
        wi: V.wi, gx: lerp(f.gx, C.sc.x + C.sc.w / 2, e), gy: lerp(f.gy, C.sc.y + C.sc.h / 2, e),
        yaw: lerp(f.yaw, 0, e) + C.dir * 9 * DEG * sw, pitch: lerp(f.pitch, 0, e) - 2.5 * DEG * sw,
        pix: 0, nearest: 0, mask: 1, maskInv: 0,
        panels: f.panels.map((fp, j) => {
          const sl = C.slots[j];
          const w = lerp(fp.w, sl.w, e);
          return {
            pn: fp.pn, cx: lerp(fp.cx, sl.cx, e), cy: lerp(fp.cy, sl.cy, e), w, h: lerp(fp.h, sl.h, e),
            crop: fp.crop.map((c, q) => lerp(c, sl.crop[q], e)), depth: fp.depth * (w / Math.max(1, fp.w)),
            ex: lerp(fp.ex, sl.cx, e), ey: lerp(fp.ey, sl.cy, e),
          };
        }),
      });
      const step = Math.floor((t - C.t0) / DISSOLVE_MS);
      veil = step < 1 ? 1 : Math.max(0, 1 - (step) * 0.25);
      lamp.amt *= 1 - p;
      busy = true;
      if (p >= 1) {
        if (!V.landed) { V.landed = t; o.onLanded && o.onLanded(V.wi); }
        else if (t - V.landed > 60) { V.landed = 0; finishClose(); return { pose: null, busy: false }; }
      }
      return { pose: { veil, items, lamp }, busy };
    }

    // springs back when the finger is gone
    const g = V.g;
    if (!(g && g.mode === 'swipe')) { V.drag.x += (0 - V.drag.x) * damp(16, dt); if (Math.abs(V.drag.x) < 0.3) V.drag.x = 0; else busy = true; }
    if (!(g && g.mode === 'down')) { V.drag.y += (0 - V.drag.y) * damp(16, dt); if (Math.abs(V.drag.y) < 0.3) V.drag.y = 0; else busy = true; }

    const cur = currentPose(t, dt);
    if (V.state === 'arrive') {
      busy = true;
      if (t - V.tA >= TURN_MS && cur.pix === 0) V.state = 'open';
    }
    if (V.dis) {
      const D = V.dis;
      const step = Math.floor((t - D.t0) / DISSOLVE_MS);
      if (step >= 4) {
        V.dis = null;
        o.onLift && o.onLift(D.from, false, true);
      } else {
        const k = (step + 1) * 0.2;
        const pe = easeOut(clamp((t - D.t0) / (DISSOLVE_MS * 4), 0, 1));
        const out = itemPose(D.from, D.fromL, { ox: D.fromPose.ox - D.dir * W() * 0.32 * pe, z: D.fromPose.z, pan: D.fromPose.pan });
        out.mask = k; out.maskInv = 1;
        items.push(out);
        cur.mask = k;
        cur.pix = step < 2 ? 12 : 4;
        cur.panels.forEach((pp) => { pp.cx += D.dir * W() * 0.1 * (1 - pe); });
        busy = true;
      }
    }
    // swiped to a work whose full-size texture is still decoding: hold the 4px pass (interlaced loading)
    if (!V.dis && V.state === 'open' && t < V.hiUntil && renderer.texState(V.wi) < 2) { cur.pix = 4; busy = true; }
    items.push(cur);
    if (V.drag.y > 0) {
      // the white dithers away in hard quarter steps as you pull down (the page shows through)
      veil = 1 - 0.25 * Math.min(3, Math.floor(V.drag.y / (H() * 0.09)));
    }
    root.classList.toggle('is-dragging', V.drag.y > 10);
    return { pose: { veil, items, lamp, drag: V.drag.y, g: V.g && V.g.mode }, busy };
  }

  /* ---------------- gestures */
  const inPainting = (x, y) => {
    const p = currentPose(now(), 0);
    return p.panels.some((r) => Math.abs(x - r.cx) <= r.w / 2 + 6 && Math.abs(y - r.cy) <= r.h / 2 + 6);
  };
  function zoomTo(zi, sx, sy, rel) {
    const L = V.L;
    if (!L) return;
    const z0 = LEVELS[V.zi], z1 = LEVELS[zi];
    const C0 = { x: L.cx + V.pan.x, y: L.cy + V.pan.y };
    const r = rel || { x: (sx - C0.x) / z0, y: (sy - C0.y) / z0 };
    const prev = V.zi;
    V.zi = zi;
    V.pan = zi === 0 ? { x: 0, y: 0 } : clampPan(z1, { x: sx - L.cx - r.x * z1, y: sy - L.cy - r.y * z1 }, L);
    if (prev !== zi) {
      S.setZoom(z1);
      root.classList.toggle('is-mag', zi > 0);
      // the magnifier's rectangle: the region that now fills the view, zooming out to it (or back in)
      const A = L.A, aw = A.right - A.left, ah = A.bottom - A.top, ratio = z1 / z0;
      const full = { x: A.left, y: A.top, w: aw, h: ah };
      const rw = aw / Math.max(ratio, 1 / ratio), rh = ah / Math.max(ratio, 1 / ratio);
      const box = { x: clamp(sx - rw / 2, A.left, A.right - rw), y: clamp(sy - rh / 2, A.top, A.bottom - rh), w: rw, h: rh };
      zoomRects(S.rects, ratio > 1 ? box : full, ratio > 1 ? full : box, { steps: 4, ms: 40, trail: 2, curve: 1 });
    }
    touchAct();
    poke();
  }

  const ptrList = () => [...V.ptrs.values()];
  function startGesture() {
    const ps = ptrList();
    const t = now();
    if (ps.length >= 2) {
      const [a, b] = ps;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const L = V.L, z = LEVELS[V.zi];
      V.g = {
        mode: 'pinch', d0: Math.max(20, Math.hypot(a.x - b.x, a.y - b.y)), z0: z,
        rel: { x: (mid.x - (L.cx + V.pan.x)) / z, y: (mid.y - (L.cy + V.pan.y)) / z },
      };
    } else if (ps.length === 1) {
      const p = ps[0];
      V.g = { mode: 'pending', id: p.id, x0: p.x, y0: p.y, t0: t, pan0: { ...V.pan }, fresh: true };
    } else V.g = null;
  }
  const accepting = () => V.state === 'open' || V.state === 'arrive';
  on(root, 'pointerdown', (e) => {
    if (!accepting() || V.dis) return;
    if (e.target.closest('button')) return;
    e.preventDefault();
    try { root.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    V.ptrs.set(e.pointerId, { id: e.pointerId, x: e.clientX, y: e.clientY, hist: [[now(), e.clientX, e.clientY]] });
    if (V.ptrs.size <= 2) startGesture();
    poke();
  });
  on(root, 'pointermove', (e) => {
    const p = V.ptrs.get(e.pointerId);
    if (!p || !accepting()) return;
    p.x = e.clientX; p.y = e.clientY;
    const t = now();
    p.hist.push([t, p.x, p.y]);
    while (p.hist.length > 2 && t - p.hist[0][0] > 100) p.hist.shift();
    const g = V.g;
    if (!g) return;
    const L = V.L;
    if (g.mode === 'pinch') {
      const [a, b] = ptrList();
      if (!b) return;
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const zc = g.z0 * (d / g.d0);
      const zi = clamp(Math.round(Math.log2(Math.max(1, zc))), 0, LEVELS.length - 1);
      if (zi !== V.zi) zoomTo(zi, mid.x, mid.y, g.rel);
      else if (zi > 0) V.pan = clampPan(LEVELS[zi], { x: mid.x - L.cx - g.rel.x * LEVELS[zi], y: mid.y - L.cy - g.rel.y * LEVELS[zi] }, L);
      touchAct();
      poke();
      return;
    }
    if (p.id !== g.id) return;
    const dx = p.x - g.x0, dy = p.y - g.y0;
    if (g.mode === 'pending') {
      if (Math.hypot(dx, dy) < 9) return;
      if (V.zi > 0) g.mode = 'pan';
      else if (Math.abs(dx) > Math.abs(dy)) g.mode = 'swipe';
      else if (dy > 0) g.mode = 'down';
      else g.mode = 'none';
      g.x0 = p.x; g.y0 = p.y;
      return;
    }
    if (g.mode === 'pan') V.pan = clampPan(LEVELS[V.zi], { x: g.pan0.x + dx, y: g.pan0.y + dy }, L);
    else if (g.mode === 'swipe') V.drag.x = dx;
    else if (g.mode === 'down') V.drag.y = Math.max(0, dy);
    touchAct();
    poke();
  });
  const velocity = (p) => {
    const h = p.hist;
    if (h.length < 2) return { x: 0, y: 0 };
    const a = h[0], b = h[h.length - 1], dt = Math.max(1, b[0] - a[0]);
    return { x: (b[1] - a[1]) / dt, y: (b[2] - a[2]) / dt };
  };
  const endPtr = (e, cancelled) => {
    const p = V.ptrs.get(e.pointerId);
    if (!p) return;
    V.ptrs.delete(e.pointerId);
    const g = V.g;
    if (!g || !accepting()) { V.g = null; return; }
    if (g.mode === 'pinch') {
      // one finger stays: keep panning from here when magnified
      const rest = ptrList()[0];
      V.g = rest && V.zi > 0 ? { mode: 'pan', id: rest.id, x0: rest.x, y0: rest.y, pan0: { ...V.pan } } : (rest ? { mode: 'none', id: rest.id } : null);
      poke();
      return;
    }
    if (p.id !== g.id) return;
    const v = velocity(p);
    const dx = p.x - g.x0, dy = p.y - g.y0;
    V.g = null;
    if (cancelled) { poke(); return; }
    if (g.mode === 'pending' && now() - g.t0 < 350) {
      if (inPainting(p.x, p.y)) zoomTo((V.zi + 1) % LEVELS.length, p.x, p.y);
      else if (V.zi > 0) zoomTo(0, p.x, p.y);
    } else if (g.mode === 'swipe') {
      if (Math.abs(dx) > 64 || Math.abs(v.x) > 0.5) go(dx < 0 ? 1 : -1);
    } else if (g.mode === 'down') {
      if (dy > 110 || v.y > 0.55) close();
    }
    poke();
  };
  on(root, 'pointerup', (e) => endPtr(e, false));
  on(root, 'pointercancel', (e) => endPtr(e, true));
  // never let the page scroll or the browser zoom under the viewer
  on(root, 'touchmove', (e) => { if (e.cancelable) e.preventDefault(); }, { passive: false });
  on(root, 'wheel', (e) => e.preventDefault(), { passive: false });
  on(root, 'gesturestart', (e) => e.preventDefault());

  on(S.close, 'click', () => close());
  on(S.prev, 'click', () => go(-1));
  on(S.next, 'click', () => go(1));
  on(document, 'keydown', (e) => {
    if (V.state === 'closed') return;
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
    else if ((e.key === '+' || e.key === '=') && V.L) { e.preventDefault(); zoomTo(Math.min(3, V.zi + 1), V.L.cx + V.pan.x, V.L.cy + V.pan.y); }
    else if (e.key === '-' && V.L) { e.preventDefault(); zoomTo(Math.max(0, V.zi - 1), V.L.cx + V.pan.x, V.L.cy + V.pan.y); }
    else if (e.key === 'Tab') {
      const f = [S.prev, S.next, S.close];
      const i = f.indexOf(document.activeElement);
      e.preventDefault();
      f[(i + (e.shiftKey ? f.length - 1 : 1) + f.length) % f.length].focus({ preventScroll: true });
    }
  }, true);
  cleanups.push(motion.subscribe(() => { if (V.state !== 'closed') poke(); }));
  on(window, 'resize', () => {
    if (V.state === 'closed' || V.state === 'closing') return;
    setLayout(V.wi);
    V.pan = clampPan(LEVELS[V.zi], V.pan, V.L);
    poke();
  });

  return {
    open, close, go, frame,
    get state() { return V.state; },
    get index() { return V.wi; },
    get zoom() { return LEVELS[V.zi]; },
    zoomTo: (zi, x, y) => zoomTo(zi, x, y),
    destroy() {
      if (V.state !== 'closed') { V.state = 'closing'; finishClose(); }
      cleanups.forEach((fn) => { try { fn(); } catch (e) { /* ignore */ } });
      root.remove();
    },
  };
}

/* ================================================================== GL */

const VERT = /* glsl */ `
varying vec3 vLocal;
varying vec3 vNormalL;
varying vec3 vWorld;
void main() {
  vLocal = position;
  vNormalL = normal;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const BAYER_GLSL = /* glsl */ `
const float B4[16] = float[16](0.,8.,2.,10.,12.,4.,14.,6.,3.,11.,1.,9.,15.,7.,13.,5.);
float bayer(vec2 fc, float cell) {
  ivec2 c = ivec2(mod(floor(fc / cell), 4.0));
  return (B4[c.x + c.y * 4] + 0.5) / 16.0;
}`;

const FRAG = /* glsl */ `
uniform sampler2D map;
uniform vec4 uCrop;      // image uv = crop.xy + faceUv * crop.zw (faceUv: u right, v down)
uniform vec2 uSize;      // face size, px
uniform vec2 uTexSize;
uniform float uDepth;
uniform mat3 uRot;
uniform vec3 uLight;     // lamp, world px
uniform float uLightAmt;
uniform float uLightR;
uniform vec3 uEye;
uniform float uWood;
uniform float uRelief;
uniform float uShadeK;
uniform float uSeed;
uniform float uGrad;
uniform float uPix;      // interlaced block, face px (0 = sharp)
uniform float uNearest;  // magnifier: nearest texel
uniform float uMask;     // dither coverage (1 = solid)
uniform float uMaskInv;
uniform float uCell;     // dither cell, device px
varying vec3 vLocal;
varying vec3 vNormalL;
varying vec3 vWorld;
${BAYER_GLSL}
float lum(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}

void main() {
  if (uMask < 0.999) {
    float b = bayer(gl_FragCoord.xy, uCell);
    if (uMaskInv > 0.5 ? (b < uMask) : (b >= uMask)) discard;
  }
  vec3 nl = vNormalL;
  vec3 key = normalize(vec3(-0.38, 0.52, 0.76));
  vec3 Nf = normalize(uRot * nl);
  vec2 fuv = vec2(vLocal.x + 0.5, 0.5 - vLocal.y);
  vec2 uv = uCrop.xy + fuv * uCrop.zw;
  vec2 dx = dFdx(uv), dy = dFdy(uv);
  vec3 col;

  if (nl.z > 0.5) {
    // ---- front: the painting. Rest = the texel, untouched.
    dx *= uGrad; dy *= uGrad;
    float shade = 1.0 + 0.2 * (dot(Nf, key) - key.z);
    vec3 add = vec3(0.0);
    if (uPix > 0.5) {
      vec2 nb = max(vec2(1.0), uSize / uPix);
      vec2 q = (floor(fuv * nb) + 0.5) / nb;
      float lod = log2(max(1.0, uPix / max(1.0, uSize.x) * uTexSize.x * uCrop.z));
      col = textureLod(map, uCrop.xy + q * uCrop.zw, lod).rgb;
    } else {
      if (uNearest > 0.5) col = textureLod(map, (floor(uv * uTexSize) + 0.5) / uTexSize, 0.0).rgb;
      else col = textureGrad(map, uv, dx, dy).rgb;
      if (uLightAmt > 0.001) {
        vec3 Lv = uLight - vWorld;
        float q = length(Lv.xy) / uLightR;
        float amt = uLightAmt / (1.0 + q * q);
        if (amt > 0.003) {
          vec2 px = max(abs(dx) + abs(dy), 1.0 / uTexSize);
          vec2 ox = vec2(px.x, 0.0), oy = vec2(0.0, px.y);
          vec2 g1 = vec2(lum(textureGrad(map, uv + ox, dx, dy).rgb) - lum(textureGrad(map, uv - ox, dx, dy).rgb),
                         lum(textureGrad(map, uv + oy, dx, dy).rgb) - lum(textureGrad(map, uv - oy, dx, dy).rgb));
          vec2 dx3 = dx * 3.0, dy3 = dy * 3.0;
          vec2 g3 = vec2(lum(textureGrad(map, uv + ox * 3.0, dx3, dy3).rgb) - lum(textureGrad(map, uv - ox * 3.0, dx3, dy3).rgb),
                         lum(textureGrad(map, uv + oy * 3.0, dx3, dy3).rgb) - lum(textureGrad(map, uv - oy * 3.0, dx3, dy3).rgb));
          vec2 g = g1 * 0.6 + g3 * 0.5;
          vec3 nT = normalize(vec3(-g.x * uRelief, g.y * uRelief, 1.0));
          vec3 N = normalize(uRot * nT);
          vec3 L = normalize(Lv);
          shade += clamp(amt * uShadeK * (dot(N, L) - dot(Nf, L)), -0.13, 0.09);   // relief only: flat stays 1.0
          vec3 V = normalize(uEye - vWorld);
          vec3 H = normalize(L + V);
          float sp = pow(max(dot(N, H), 0.0), 60.0) - pow(max(dot(Nf, H), 0.0), 60.0);
          add = vec3(max(sp, 0.0) * 0.04 * amt * smoothstep(0.03, 0.16, length(g)));
        }
      }
    }
    col = col * shade + add;
  } else if (nl.z < -0.5) {
    col = vec3(0.86, 0.84, 0.80) * (0.62 + 0.3 * max(dot(Nf, key), 0.0));
  } else {
    // ---- sides: paint wrapped round a stretched canvas (or a plywood panel edge)
    bool xs = abs(nl.x) > 0.5;
    float s = xs ? (0.5 - vLocal.y) : (vLocal.x + 0.5);
    float t = clamp(-vLocal.z, 0.0, 1.0);
    float sPx = s * (xs ? uSize.y : uSize.x);
    float tPx = t * uDepth;
    vec2 euv = xs ? vec2(nl.x > 0.0 ? 1.0 : 0.0, s) : vec2(s, nl.y > 0.0 ? 0.0 : 1.0);
    vec2 inward = xs ? vec2(nl.x > 0.0 ? -1.0 : 1.0, 0.0) : vec2(0.0, nl.y > 0.0 ? 1.0 : -1.0);
    euv += inward * (0.003 + 0.016 * t);
    vec3 paint = textureLod(map, uCrop.xy + euv * uCrop.zw, 2.5).rgb;
    float weave = sin(sPx * 2.6) * sin(tPx * 2.6) * 0.5 + 0.5;
    vec3 linen = vec3(0.93, 0.91, 0.865) * (0.95 + 0.05 * weave) * (0.96 + 0.07 * vnoise(vec2(sPx, tPx) * 0.4));
    float stop = 0.68 + 0.3 * vnoise(vec2(sPx * 0.05 + uSeed, 1.7));
    float painted = 1.0 - smoothstep(stop - 0.06, stop + 0.04, t);
    vec3 canvasSide = mix(linen, paint * (0.94 + 0.06 * weave), painted);
    float grain = 0.5 + 0.5 * sin(tPx * 1.9 + vnoise(vec2(sPx * 0.035 + uSeed, tPx * 0.25)) * 5.0);
    vec3 wood = mix(vec3(0.72, 0.56, 0.39), vec3(0.84, 0.70, 0.52), grain);
    vec3 woodSide = mix(wood, paint, 1.0 - smoothstep(0.07, 0.14, t));
    col = mix(canvasSide, woodSide, uWood);
    float shade = 0.6 + 0.32 * max(dot(Nf, key), 0.0);
    if (uLightAmt > 0.001) shade += 0.16 * uLightAmt * max(dot(Nf, normalize(uLight - vWorld)), 0.0);
    col *= shade * (1.0 - 0.1 * t);
  }
  gl_FragColor = vec4(col, 1.0);
}`;

const VEIL_VERT = /* glsl */ `void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const VEIL_FRAG = /* glsl */ `
uniform float uCover;
uniform float uCell;
${BAYER_GLSL}
void main() {
  if (uCover < 0.999 && bayer(gl_FragCoord.xy, uCell) >= uCover) discard;
  gl_FragColor = vec4(1.0);
}`;

function whenLoaded(img) {
  if (img.complete && img.naturalWidth) return Promise.resolve();
  return new Promise((res, rej) => {
    img.addEventListener('load', res, { once: true });
    img.addEventListener('error', rej, { once: true });
  });
}

/** Decoded, downscaled copy of an <img> (off the main thread where the browser allows). */
async function makeBitmap(img, maxSide, viaFetch = true) {
  await whenLoaded(img);
  const nw = img.naturalWidth, nh = img.naturalHeight;
  const s = Math.min(1, maxSide / Math.max(nw, nh));
  const w = Math.max(1, Math.round(nw * s)), h = Math.max(1, Math.round(nh * s));
  const opts = s < 1 ? { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' } : undefined;
  if ('createImageBitmap' in window) {
    if (viaFetch) {
      try {
        const blob = await (await fetch(img.currentSrc || img.src, { cache: 'force-cache' })).blob();
        return await createImageBitmap(blob, opts);
      } catch (e) { /* fall through */ }
    }
    try {
      if (img.decode) await img.decode();
      return await createImageBitmap(img, opts);
    } catch (e) { /* fall through */ }
  }
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(img, 0, 0, w, h);
  return c;
}

function makeTexture(THREE, renderer, source) {
  const tex = new THREE.Texture(source);
  tex.flipY = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
  tex.needsUpdate = true;
  tex.userData.size = [source.width, source.height];
  const close = source.close ? () => setTimeout(() => source.close(), 0) : null;
  if (close) tex.onUpdate = close;
  return tex;
}

/** Camera at (ex, ey, D) looking down -z whose frustum maps the z=0 plane exactly onto the W x H surface. */
function aimCamera(cam, ex, ey, D, W, H) {
  const near = 2, far = D * 4, k = near / D;
  cam.projectionMatrix.makePerspective(-ex * k, (W - ex) * k, -ey * k, (-H - ey) * k, near, far);
  cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
  cam.position.set(ex, ey, D);
  cam.updateMatrixWorld(true);
}

function makeUnit(THREE, geo, seed) {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      map: { value: null },
      uCrop: { value: new THREE.Vector4(0, 0, 1, 1) },
      uSize: { value: new THREE.Vector2(1, 1) },
      uTexSize: { value: new THREE.Vector2(1, 1) },
      uDepth: { value: 10 },
      uRot: { value: new THREE.Matrix3() },
      uLight: { value: new THREE.Vector3(0, 0, 100) },
      uLightAmt: { value: 0 },
      uLightR: { value: 600 },
      uEye: { value: new THREE.Vector3() },
      uWood: { value: 0 },
      uRelief: { value: 2.4 },
      uShadeK: { value: 0.8 },
      uSeed: { value: seed },
      uGrad: { value: GRAD_SCALE },
      uPix: { value: 0 },
      uNearest: { value: 0 },
      uMask: { value: 1 },
      uMaskInv: { value: 0 },
      uCell: { value: 6 },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(mesh);
  const cam = new THREE.PerspectiveCamera();
  return { mesh, mat, u: mat.uniforms, scene, cam };
}

const tmp = {};
function setRot(THREE, unit, q) {
  if (!tmp.m) tmp.m = new THREE.Matrix4();
  tmp.m.makeRotationFromQuaternion(q);
  unit.u.uRot.value.setFromMatrix4(tmp.m);
}

/* ------------------------------------------------------------------ mount */
export async function mount(ctx) {
  let api = null;
  try {
    api = await setup(ctx);
    return api;
  } catch (err) {
    console.warn('[fx] m-paint failed', err);
    try { api && api.destroy(); } catch (e) { /* ignore */ }
    return mountLite(ctx);
  }
}

async function mountLite(ctx) {
  try {
    const lite = await import('./paint-lite.js?v=2');
    return await lite.mount({ ...ctx, gl: false, THREE: null });
  } catch (e) { return null; }
}

async function setup(ctx) {
  const { THREE, core } = ctx;
  const html = document.documentElement;
  const page = document.querySelector('.paint-page');
  const gallery = page && page.querySelector('.mobile-paint-gallery');
  if (!gallery || !core.motionOK) return null;
  const works = readWorks(page);
  if (!works.length) return null;

  const cleanups = [];
  const on = (el, type, fn, opts) => { el.addEventListener(type, fn, opts); cleanups.push(() => el.removeEventListener(type, fn, opts)); };
  let destroyed = false;

  const geo = new THREE.BoxGeometry(1, 1, 1);
  geo.translate(0, 0, -0.5);                 // front face on z = 0, the box goes back into the wall

  /* ================= gallery */
  const IM = [];                             // one per <img>
  works.forEach((w) => w.imgs.forEach((img) => IM.push({ img, w, tex: null, unit: null, rect: null, drawn: false, hidden: false, seed: (IM.length * 7.31) % 10, turn: { x: 0, y: 0 } })));
  const imOf = (img) => IM.find((m) => m.img === img);

  const host = document.createElement('div');
  host.className = 'fx-mpaint-layer';
  host.setAttribute('aria-hidden', 'true');
  gallery.append(host);
  gallery.classList.add('fx-mpaint-gallery');

  let layoutDirty = true, winTop = -1, winH = 0;
  const pending = [];
  const lifted = new Set();                  // works the viewer has taken out of their slots
  const gv = core.createView({
    THREE, host, className: 'fx-canvas fx-canvas--passive',
    antialias: false, dprMax: 2, pixelBudget: 4.2e6,
    onResize: () => { layoutDirty = true; },
    onFrame: galleryFrame,
    onFail: (reason) => giveUp(reason),
  });
  gv.renderer.autoClear = false;
  IM.forEach((m) => { m.unit = makeUnit(THREE, geo, m.seed); m.unit.u.uWood.value = m.w.panels.some((p) => p.img === m.img && p.wood) ? 1 : 0; });

  // the window: about two screens of canvas, re-centred on the viewport when it gets near an edge
  const sizeWindow = () => {
    const h = Math.ceil(Math.max(innerHeight, (screen && screen.height) || 0) * 2);
    const gh = gallery.offsetHeight;
    const nh = Math.max(1, Math.min(h, gh));
    if (nh !== winH) { winH = nh; host.style.height = `${winH}px`; layoutDirty = true; }
  };
  const placeWindow = () => {
    const gr = gallery.getBoundingClientRect();
    const gh = gallery.offsetHeight;
    const vy0 = -gr.top, vy1 = vy0 + innerHeight;
    const margin = Math.max(0, (winH - innerHeight) / 4);
    const okTop = winTop <= 0 || vy0 >= winTop + margin;
    const okBottom = winTop + winH >= gh || vy1 <= winTop + winH - margin;
    if (winTop >= 0 && okTop && okBottom && vy1 > winTop && vy0 < winTop + winH) return false;
    const top = Math.round(clamp(vy0 - (winH - innerHeight) / 2, 0, Math.max(0, gh - winH)));
    if (top === winTop) return false;
    winTop = top;
    // keep the canvas on a whole device pixel (the gallery may start at a fractional y)
    const dpr = window.devicePixelRatio || 1;
    const docTop = (gr.top + window.scrollY) * dpr;
    host.style.top = `${top - (docTop - Math.floor(docTop)) / dpr}px`;
    layoutDirty = true;
    return true;
  };
  sizeWindow();
  placeWindow();

  const revealed = (fig) => !fig.classList.contains('reveal-media') || fig.classList.contains('is-visible');
  const mo = new MutationObserver(() => { layoutDirty = true; gv.invalidate(); });
  works.forEach((w) => mo.observe(w.fig, { attributes: true, attributeFilter: ['class', 'style'] }));
  cleanups.push(() => mo.disconnect());

  // gallery textures: viewport-first, sequential decodes, one upload per frame
  (async () => {
    const order = [...IM].sort((a, b) => Math.abs(a.img.getBoundingClientRect().top - innerHeight / 3) - Math.abs(b.img.getBoundingClientRect().top - innerHeight / 3));
    const scale = Math.min(2, window.devicePixelRatio || 1);
    for (const m of order) {
      if (destroyed) return;
      try {
        const r = m.img.getBoundingClientRect();
        const side = clamp(Math.ceil(Math.max(r.width, r.height) * scale * OVERSAMPLE), 256, 1280);
        const bmp = await makeBitmap(m.img, side);
        if (destroyed) { bmp.close && bmp.close(); return; }
        pending.push({ m, bmp });
        gv.invalidate();
      } catch (e) { /* this one stays DOM */ }
    }
  })();

  // scroll: the lamp sweeps while you scroll; the window follows
  let lastScroll = 0;
  const unsubScroll = core.scroll.subscribe(() => { lastScroll = performance.now(); if (!html.dataset.fxModal) gv.invalidate(); });
  const unsubMotion = motion.subscribe(() => { if (!html.dataset.fxModal) gv.invalidate(); });
  cleanups.push(unsubScroll, unsubMotion);
  on(window, 'resize', () => { sizeWindow(); layoutDirty = true; gv.invalidate(); });

  const GL = { act: 0, on: false };
  function measure(m, hr) {
    const a = m.img.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const sn = (v) => Math.round(v * dpr) / dpr;
    // Chrome snaps each image's edges to device px; the host sits on a whole device px (placeWindow)
    const x0 = sn(a.left), y0 = sn(a.top), w = sn(a.right) - x0, h = sn(a.bottom) - y0;
    m.rect = { x: x0 - sn(hr.left), y: y0 - sn(hr.top), w, h };
    m.crop = coverCrop(w, h, m.img.naturalWidth, m.img.naturalHeight);
    m.ok = revealed(m.w.fig) && w > 1 && h > 1;
  }

  function galleryFrame(dt) {
    if (destroyed) return false;
    const R = gv.renderer;
    const t = performance.now();
    let busy = false;
    if (placeWindow()) busy = true;

    const next = pending.shift();
    if (next) {
      next.m.tex = makeTexture(THREE, R, next.bmp);
      next.m.unit.u.map.value = next.m.tex;
      next.m.unit.u.uTexSize.value.set(next.bmp.width, next.bmp.height);
      layoutDirty = true;
    }
    if (pending.length) busy = true;

    const hr = host.getBoundingClientRect();
    if (layoutDirty) { IM.forEach((m) => measure(m, hr)); layoutDirty = false; }

    // lamp: scroll sweep (no permission needed) blended with tilt (once motion is live)
    const scrolling = t - lastScroll < 160;
    GL.act += ((scrolling ? 1 : 0) - GL.act) * damp(scrolling ? 6 : 2.6, dt);
    if (!scrolling && GL.act < 0.01) GL.act = 0;
    const live = motion.live;
    const mx = live ? motion.x : 0, my = live ? motion.y : 0;
    const tiltAmt = live ? clamp(Math.hypot(mx, my) * 2.4, 0, 1) : 0;
    const amt = Math.max(GL.act, tiltAmt);
    if (GL.act > 0) busy = true;
    const vw = hr.width, vh = innerHeight;
    // screen space -> canvas space (host top-left)
    const sLx = -0.25 * vw, sLy = 0.5 * vh;            // sweep lamp: off the left edge, mid-screen, low
    const tLx = vw * (0.5 + 1.2 * mx), tLy = vh * (0.5 + 0.9 * my);
    const wsum = GL.act + tiltAmt + 1e-6;
    const lx = (sLx * GL.act + tLx * tiltAmt) / wsum - hr.left;
    const ly = (sLy * GL.act + tLy * tiltAmt) / wsum - hr.top;

    const W = gv.size.width, H = gv.size.height;
    const D = Math.max(900, innerHeight * 1.5);
    const cell = DITHER_CELL * gv.size.dpr;
    R.setRenderTarget(null);
    R.clear(true, true, false);
    const kT = damp(8, dt);
    // At rest (no lamp, no turn) the canvas stands down and the <img>s show: rest is the static page, exactly.
    // (hysteresis, so sensor jitter around "held still" never flickers between canvas and <img>)
    if (!GL.on && (amt > 0.04 || GL.act > 0)) GL.on = true;
    else if (GL.on && amt < 0.004 && GL.act === 0) GL.on = false;
    const glOn = GL.on;
    if (!glOn) IM.forEach((m) => { m.turn.x = 0; m.turn.y = 0; });
    for (const m of IM) {
      const r = m.rect;
      const show = !!(glOn && m.tex && r && m.ok && !lifted.has(m.w));
      const inWin = r && r.y + r.h > 0 && r.y < H && r.x + r.w > 0 && r.x < W;
      const fully = r && r.y >= 0 && r.y + r.h <= H;
      if (show && inWin) {
        const tx = live ? -my * 1.6 * DEG : 0, ty = live ? mx * 2.2 * DEG : 0;
        m.turn.x += (tx - m.turn.x) * kT; m.turn.y += (ty - m.turn.y) * kT;
        if (Math.abs(tx - m.turn.x) + Math.abs(ty - m.turn.y) > 1e-4) busy = true;
        else { m.turn.x = tx; m.turn.y = ty; }
        const { mesh, u, cam } = m.unit;
        const g = workGeometry(m.w);
        // px per cm: the whole photo's displayed width over its width in cm
        let cmW = 0, du = 0;
        m.w.panels.forEach((p, j) => { if (p.img === m.img) { cmW += g.panels[j].cmW; du += p.u1 - p.u0; } });
        const depth = g.depthCm * ((r.w / m.crop[2]) / Math.max(1, cmW / Math.max(du, 1e-3)));
        const cx = r.x + r.w / 2, cy = -(r.y + r.h / 2);
        mesh.position.set(cx, cy, 0);
        mesh.rotation.set(m.turn.x, m.turn.y, 0);
        mesh.scale.set(r.w, r.h, Math.max(1, depth));
        mesh.updateMatrixWorld();
        setRot(THREE, m.unit, mesh.quaternion);
        u.uCrop.value.set(m.crop[0], m.crop[1], m.crop[2], m.crop[3]);
        u.uSize.value.set(r.w, r.h);
        u.uDepth.value = depth;
        u.uLight.value.set(lx, -ly, vh * 0.42);
        u.uLightAmt.value = amt;
        u.uLightR.value = Math.max(vw, vh) * 0.9;
        u.uCell.value = cell;
        aimCamera(cam, cx, cy, D, W, H);
        u.uEye.value.copy(cam.position);
        R.clearDepth();
        R.render(m.unit.scene, cam);
        m.drawn = true;
      }
      // the DOM image steps aside only where the canvas fully covers it
      const hide = !!(show && inWin && fully && m.drawn);
      if (hide !== m.hidden) {
        m.hidden = hide;
        if (hide) m.img.dataset.fxGl = 'drawn'; else delete m.img.dataset.fxGl;
      }
    }
    return busy;
  }
  gv.wake(1200);

  /* ================= focus viewer */
  let FV = null;                             // { view, units, veil, cam, texs }
  const texs = new Map();                    // img -> { lo, hi, loP, hiP, used }
  const S = buildShell(works.length);
  cleanups.push(() => S.root.remove());

  function ensureFocusView() {
    if (FV || destroyed) return FV;
    let view;
    try {
      view = core.createView({
        THREE, host: S.view, className: 'fx-canvas fx-canvas--passive fx-mpaint__canvas',
        antialias: true, dprMax: 2, pixelBudget: 4.2e6, observe: null,
        onFrame: (dt) => focusFrame(dt),
        onFail: () => giveUp('focus'),
      });
    } catch (e) { return null; }
    view.renderer.autoClear = false;
    const veilMat = new THREE.ShaderMaterial({
      uniforms: { uCover: { value: 1 }, uCell: { value: 6 } },
      vertexShader: VEIL_VERT, fragmentShader: VEIL_FRAG, depthTest: false, depthWrite: false,
    });
    const veilMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), veilMat);
    veilMesh.frustumCulled = false;
    const veilScene = new THREE.Scene();
    veilScene.add(veilMesh);
    FV = { view, units: [], veilMat, veilScene, veilCam: new THREE.Camera(), q: new THREE.Quaternion(), e: new THREE.Euler(), v: new THREE.Vector3() };
    // compile both programs now so the first arrival does not stall
    try {
      const u0 = unitAt(0);
      const dummy = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
      dummy.needsUpdate = true;
      u0.u.map.value = dummy;
      aimCamera(u0.cam, 0, 0, 1000, 10, 10);
      view.renderer.compile(u0.scene, u0.cam);
      view.renderer.compile(veilScene, FV.veilCam);
      u0.u.map.value = null;
      dummy.dispose();
    } catch (e) { /* compiles on first draw instead */ }
    return FV;
  }
  const unitAt = (k) => {
    while (FV.units.length <= k) FV.units.push(makeUnit(THREE, geo, 3 + FV.units.length * 4.1));
    return FV.units[k];
  };

  function texEntry(img) {
    let t = texs.get(img);
    if (!t) { t = { lo: null, hi: null, loP: null, hiP: null, used: 0 }; texs.set(img, t); }
    return t;
  }
  function loadTex(wi, prio) {
    const fv = ensureFocusView();
    if (!fv) return;
    const R = fv.view.renderer;
    works[wi].imgs.forEach((img) => {
      const t = texEntry(img);
      t.used = performance.now() + (prio >= 2 ? 1e6 : 0);
      if (!t.loP) {
        t.loP = makeBitmap(img, LO_SIDE, false).then((b) => {
          if (destroyed || !FV) { b.close && b.close(); return; }
          t.lo = makeTexture(THREE, R, b);
          try { R.initTexture(t.lo); } catch (e) { /* uploads on first draw */ }
          fv.view.invalidate();
        }).catch(() => {});
      }
      if (!t.hiP) {
        t.hiP = makeBitmap(img, Math.min(HI_SIDE, R.capabilities.maxTextureSize || HI_SIDE)).then((b) => {
          if (destroyed || !FV) { b.close && b.close(); return; }
          t.hi = makeTexture(THREE, R, b);
          try { R.initTexture(t.hi); } catch (e) { /* uploads on first draw */ }
          trimHi();
          fv.view.invalidate();
        }).catch(() => {});
      }
    });
  }
  // keep at most 4 full-size textures (the current work, its neighbours)
  function trimHi() {
    const his = [...texs.entries()].filter(([, t]) => t.hi).sort((a, b) => b[1].used - a[1].used);
    his.slice(4).forEach(([, t]) => { t.hi.dispose(); t.hi = null; t.hiP = null; });
  }
  const texState = (wi) => {
    const ts = works[wi].imgs.map((img) => texs.get(img));
    if (ts.every((t) => t && t.hi)) return 2;
    if (ts.every((t) => t && (t.lo || t.hi))) return 1;
    return 0;
  };

  let viewer = null;
  const renderer = {
    request: () => { if (FV) FV.view.invalidate(); },
    texState,
    load: (wi, prio) => loadTex(wi, prio),
    show: (onOff) => {
      if (!FV) return;
      if (onOff) FV.view.invalidate();
      else { FV.view.renderer.clear(); }
    },
  };

  function focusFrame() {
    if (!FV || destroyed || !viewer) return false;
    const R = FV.view.renderer;
    const { pose, busy } = viewer.frame(performance.now());
    lastPose = pose;
    R.setRenderTarget(null);
    R.clear(true, true, false);
    if (!pose) return false;
    const W = FV.view.size.width, H = FV.view.size.height, dpr = FV.view.size.dpr;
    const cell = DITHER_CELL * dpr;
    if (pose.veil > 0) {
      FV.veilMat.uniforms.uCover.value = pose.veil;
      FV.veilMat.uniforms.uCell.value = cell;
      R.render(FV.veilScene, FV.veilCam);
    }
    const D = Math.max(900, H * 1.45);
    let k = 0;
    const L = pose.lamp;
    pose.items.forEach((it) => {
      FV.e.set(it.pitch, it.yaw, 0);
      FV.q.setFromEuler(FV.e);
      it.panels.forEach((pp) => {
        const t = texs.get(pp.pn.img);
        const tex = t && (it.pix >= 12 && t.lo ? t.lo : (t.hi || t.lo));
        if (!tex) return;
        const unit = unitAt(k++);
        const { mesh, u, cam } = unit;
        u.map.value = tex;
        u.uTexSize.value.set(tex.userData.size[0], tex.userData.size[1]);
        FV.v.set(pp.cx - it.gx, -(pp.cy - it.gy), 0).applyQuaternion(FV.q);
        mesh.position.set(it.gx + FV.v.x, -it.gy + FV.v.y, FV.v.z);
        mesh.quaternion.copy(FV.q);
        mesh.scale.set(pp.w, pp.h, Math.max(1, pp.depth));
        mesh.updateMatrixWorld();
        setRot(THREE, unit, FV.q);
        u.uCrop.value.set(pp.crop[0], pp.crop[1], pp.crop[2], pp.crop[3]);
        u.uSize.value.set(pp.w, pp.h);
        u.uDepth.value = pp.depth;
        u.uWood.value = pp.pn.wood ? 1 : 0;
        u.uLight.value.set(L.x, -L.y, L.z);
        u.uLightAmt.value = L.amt;
        u.uLightR.value = Math.max(W, H) * 0.9;
        u.uPix.value = it.pix;
        u.uNearest.value = it.nearest;
        u.uMask.value = it.mask;
        u.uMaskInv.value = it.maskInv;
        u.uCell.value = cell;
        u.uGrad.value = 1;                     // focus: plain trilinear (no need to match an <img>)
        aimCamera(cam, pp.ex, -pp.ey, D, W, H);
        u.uEye.value.copy(cam.position);
        R.clearDepth();
        R.render(unit.scene, cam);
      });
    });
    return busy;
  }

  let asked = false, lastPose = null;
  function liftWork(wi, onOff) {
    const w = works[wi];
    if (onOff) lifted.add(w); else lifted.delete(w);
    w.fig.classList.toggle('fx-mpaint-lifted', !!onOff);
    gv.invalidate();
  }
  viewer = createViewer({
    works, shell: S, renderer, page,
    onOpen: (wi) => {
      ensureFocusView();
      // neighbours next, at idle
      setTimeout(() => { if (viewer.state !== 'closed') { loadTex((wi + 1) % works.length, 1); loadTex((wi - 1 + works.length) % works.length, 1); } }, 1400);
    },
    onLift: (wi, onOff, quiet) => {
      liftWork(wi, onOff);
      // once the white is up the page canvas has nothing to show: pause it
      if (onOff && !quiet) gv.setPaused(true);
    },
    onClosing: () => { gv.setPaused(false); layoutDirty = true; gv.invalidate(); },
    onLanded: (wi) => { liftWork(wi, false); gv.invalidate(); },
    onClosed: (wi) => { works.forEach((w, i) => { if (i !== wi) liftWork(i, false); }); gv.setPaused(false); gv.invalidate(); },
  });

  /* ---------------- input on the gallery */
  const label = (lines) => lines.join('. ').toLowerCase().replace(/ x /g, ' by ');
  works.forEach((w, wi) => {
    const el = w.fig;
    w.prevAttrs = ['tabindex', 'role', 'aria-label', 'aria-haspopup'].map((a) => [a, el.getAttribute(a)]);
    el.setAttribute('tabindex', '0');
    el.setAttribute('role', 'button');
    el.setAttribute('aria-label', `${label(w.lines)}. Open painting`);
    el.setAttribute('aria-haspopup', 'dialog');
    const openIt = () => {
      if (!FV && !ensureFocusView()) return;
      if (!asked) { asked = true; enableMotion({ ask: true }).then((live) => { if (live) { gv.invalidate(); renderer.request(); } }); }
      viewer.open(wi);
    };
    on(el, 'click', (e) => { if (!e.defaultPrevented) openIt(); });
    on(el, 'keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openIt(); } });
    on(el, 'touchstart', () => { if (!FV) (window.requestIdleCallback || setTimeout)(() => ensureFocusView()); }, { passive: true });
  });

  /* ---------------- failure / teardown */
  function restoreDom() {
    IM.forEach((m) => { delete m.img.dataset.fxGl; });
    works.forEach((w) => {
      w.fig.classList.remove('fx-mpaint-lifted');
      (w.prevAttrs || []).forEach(([a, v]) => (v == null ? w.fig.removeAttribute(a) : w.fig.setAttribute(a, v)));
    });
    gallery.classList.remove('fx-mpaint-gallery');
  }
  function teardown() {
    if (destroyed) return;
    destroyed = true;
    try { viewer && viewer.destroy(); } catch (e) { /* ignore */ }
    cleanups.forEach((fn) => { try { fn(); } catch (e) { /* ignore */ } });
    pending.forEach(({ bmp }) => bmp.close && bmp.close());
    pending.length = 0;
    if (FV) { try { FV.view.destroy(); } catch (e) { /* ignore */ } FV.units.forEach((u) => u.mat.dispose()); FV = null; }
    texs.forEach((t) => { t.lo && t.lo.dispose(); t.hi && t.hi.dispose(); });
    texs.clear();
    try { gv.destroy(); } catch (e) { /* ignore */ }
    IM.forEach((m) => { m.tex && m.tex.dispose(); m.unit && m.unit.mat.dispose(); });
    geo.dispose();
    host.remove();
    restoreDom();
    delete html.dataset.fxModal;
    if (page) page.inert = false;
  }
  function giveUp(reason) {
    if (destroyed) return;
    console.warn('[fx] m-paint: falling back to the lite viewer', reason);
    teardown();
    mountLite(ctx);
  }

  return {
    destroy: teardown,
    open: (i) => viewer.open(i),
    close: () => viewer.close(),
    go: (d) => viewer.go(d),
    zoomTo: (zi, x, y) => viewer.zoomTo(zi, x, y),
    get state() { return viewer.state; },
    get index() { return viewer.index; },
    get zoom() { return viewer.zoom; },
    get drawn() { return IM.filter((m) => m.drawn).length; },
    get hidden() { return IM.filter((m) => m.hidden).length; },
    get pose() { return lastPose && { drag: lastPose.drag, g: lastPose.g, veil: lastPose.veil, lamp: lastPose.lamp.amt, items: lastPose.items.map((i) => ({ wi: i.wi, pix: i.pix, mask: i.mask, inv: i.maskInv, yaw: i.yaw })) }; },
  };
}
