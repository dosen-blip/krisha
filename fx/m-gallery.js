/*
 * fx/m-gallery.js — phone (≤700px) layer for photography, the project pages and contact. See fx/README.md.
 *
 * VIEWER.EXE  Tap any image/video → Win98 zoom rectangles (hard steps) from its slot out to a full-screen white viewer
 *             above the nav. Swipe left/right through every image on the page (4-step Bayer dither dissolve), counter
 *             "03 / 12" + the set/project label; pinch zooms in hard steps (1× 2× 3× 4×) with one-finger pan; double tap
 *             toggles 2×; swipe down / CLOSE / back button / Esc returns the image into its slot (rectangles back).
 * Magnifier   Long-press (≥420ms, still) on an image → an MS-Paint magnifier: square loupe above the finger showing
 *             that spot at 3× (nearest-neighbour), follows the finger while held, "3X" tag. Release dismisses it.
 *             The OS image callout / selection is suppressed on these images only.
 * Readout     Project pages: the title docks at the bottom of the screen (a status bar) and reads "IMG 2/6" as each
 *             image crosses the viewport centre, counting through in hard steps; it lands in its place at the end.
 * Contact     First tap on the e-mail copies it: Win tooltip "COPIED TO CLIPBOARD" + chime, with a "SEND >" control;
 *             a second tap while the tooltip is up follows the mailto. The first tap on the portrait turns on tilt
 *             (enableMotion → KRISHA.EXE dialog on iOS): a slight 3D card tilt with a hard #000ca9 offset shadow that
 *             shifts with it. Later taps open the viewer.
 * Reduced motion: no rectangles, dissolves or tilt; everything else works statically. No idle loops.
 */
import { INK } from './gl.js';
import { play, preload } from './sound.js';
import { motion, enableMotion, motionState } from './m-motion.js';

const html = document.documentElement;
const reducedMQ = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
const still = () => !!(reducedMQ && reducedMQ.matches);

const SLOT_SEL = '.photo-frame, .figure, .contact-portrait';
const TITLE_SEL = '.pralaya-title, .wardi-title, .ahlan-title, .talisman-title, .wwyfm-title';
const LEVELS = [1, 2, 3, 4];          // pinch zoom levels (hard steps)
const DISSOLVE_MS = 65;               // per dither step (4 steps)
const PRESS_MS = 420;                 // long-press for the magnifier
const LOUPE = 132, LOUPE_ZOOM = 3;    // loupe size (css px) and magnification

/* ------------------------------------------------------------------ small helpers */
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const pad = (n, w) => String(n).padStart(w, '0');
const vw = () => html.clientWidth || innerWidth;
const vh = () => innerHeight;
const navBottom = () => {
  const n = document.querySelector('.nav');
  const r = n && n.getBoundingClientRect();
  return r && r.bottom > 0 ? r.bottom : 0;
};

/** Run frame(k) for k = 0..steps-1 on a hard `ms` grid; resolves when done. */
function stepper(steps, ms, frame) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    let shown = -1, raf = 0, fin = false;
    const end = () => { if (fin) return; fin = true; cancelAnimationFrame(raf); clearTimeout(bk); resolve(); };
    const tick = () => {
      const k = Math.floor((performance.now() - t0) / ms);
      if (k >= steps) { end(); return; }
      if (k !== shown) { shown = k; try { frame(k); } catch (e) { end(); return; } }
      raf = requestAnimationFrame(tick);
    };
    const bk = setTimeout(end, steps * ms + 300);
    tick();
  });
}

/** Win98 zoom rectangles from box a to box b (viewport px), `trail` outlines at once. */
function zoomRects(a, b, { steps = 6, ms = 40, trail = 3 } = {}) {
  if (still() || !a || !b) return Promise.resolve();
  const layer = el('div', 'fxg-rects');
  layer.setAttribute('aria-hidden', 'true');
  const rs = [];
  for (let j = 0; j < trail; j++) { const r = el('div', 'fxg-rects__r'); layer.appendChild(r); rs.push(r); }
  document.body.appendChild(layer);
  const at = (s) => {
    const t = Math.pow(s / (steps - 1), 1.25);
    const x = Math.round(a.x + (b.x - a.x) * t), y = Math.round(a.y + (b.y - a.y) * t);
    const w = Math.round(a.w + (b.w - a.w) * t), h = Math.round(a.h + (b.h - a.h) * t);
    return { x, y, w: Math.max(2, w), h: Math.max(2, h) };
  };
  return stepper(steps, ms, (k) => {
    for (let j = 0; j < trail; j++) {
      const s = k - j, r = rs[j];
      if (s < 0) { r.style.display = 'none'; continue; }
      const q = at(s);
      r.style.cssText = `display:block;left:${q.x}px;top:${q.y}px;width:${q.w}px;height:${q.h}px`;
    }
  }).then(() => layer.remove());
}

const boxOf = (r) => ({ x: r.left, y: r.top, w: r.width, h: r.height });
/** A rect clipped to the visible viewport (below the sticky nav); null if nothing shows. */
function visibleBox(r) {
  const top = navBottom();
  const x0 = clamp(r.left, 0, vw()), x1 = clamp(r.right, 0, vw());
  const y0 = clamp(r.top, top, vh()), y1 = clamp(r.bottom, top, vh());
  if (x1 - x0 < 2 || y1 - y0 < 2) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/* ------------------------------------------------------------------ Win tooltip */
let tipEl = null, tipTimer = 0;
function hideTip() {
  clearTimeout(tipTimer);
  if (tipEl) { tipEl.remove(); tipEl = null; }
}
/** Show a Win-style tooltip at document position below/above anchor rect. `extra` = node appended inside. */
function showTip(text, rect, { ms = 3200, extra = null, above = false } = {}) {
  hideTip();
  const t = el('div', 'fxg-tip');
  t.setAttribute('role', 'status');
  t.appendChild(el('span', 'fxg-tip__txt', text));
  if (extra) t.appendChild(extra);
  document.body.appendChild(t);
  const w = t.offsetWidth, h = t.offsetHeight;
  const x = clamp(rect.left, 8, vw() - w - 10);
  const y = above ? rect.top - h - 8 : rect.bottom + 8;
  t.style.left = `${Math.round(x + scrollX)}px`;
  t.style.top = `${Math.round(clamp(y, navBottom() + 4, vh() - h - 8) + scrollY)}px`;
  tipEl = t;
  tipTimer = setTimeout(hideTip, ms);
  return t;
}

/* ------------------------------------------------------------------ media on the page */
function slotOf(m) { return m.closest(SLOT_SEL) || m; }
function isShown(slot) {
  const r = slot.getBoundingClientRect();
  return r.width >= 40 && r.height >= 40;
}
function collectMedia() {
  return Array.from(document.querySelectorAll('.page img, .page video')).filter((m) =>
    !m.closest('.nav, .mobile-menu, .fxg-viewer, .fxg-loupe') && isShown(slotOf(m)));
}

/** Set / project label for a medium. */
function labelFinder(page) {
  const title = document.querySelector(TITLE_SEL);
  const titleText = title ? (title.dataset.fxgTitle || title.textContent).trim() : '';
  const labels = Array.from(document.querySelectorAll('.page > .label'));
  const norm = (s) => s.replace(/\s+/g, ' ').replace(/\s*\/\s*/g, ' / ').trim().toUpperCase();
  return (m) => {
    if (labels.length) {
      let found = null;
      for (const l of labels) if (l.compareDocumentPosition(m) & Node.DOCUMENT_POSITION_FOLLOWING) found = l;
      return norm((found || labels[0]).textContent);
    }
    if (titleText) return norm(titleText);
    if (page === 'contact') return 'KRISHA DAVE';
    return norm(document.title.split('|')[0] || 'KRISHA DAVE');
  };
}

/** How the medium is drawn inside its box: { left, top, scale, natW, natH } in viewport px. */
function contentMap(m) {
  const r = m.getBoundingClientRect();
  const natW = m.naturalWidth || m.videoWidth || r.width, natH = m.naturalHeight || m.videoHeight || r.height;
  const cs = getComputedStyle(m);
  const fit = cs.objectFit || 'fill';
  let sx = r.width / natW, sy = r.height / natH;
  if (fit === 'cover') sx = sy = Math.max(sx, sy);
  else if (fit === 'contain') sx = sy = Math.min(sx, sy);
  const pos = (cs.objectPosition || '50% 50%').split(' ');
  const px = /%$/.test(pos[0]) ? parseFloat(pos[0]) / 100 : 0.5, py = /%$/.test(pos[1] || '') ? parseFloat(pos[1]) / 100 : 0.5;
  return { left: r.left + (r.width - natW * sx) * px, top: r.top + (r.height - natH * sy) * py, sx, sy, natW, natH };
}

/* ------------------------------------------------------------------ Bayer dither masks (4 steps) */
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
let masks = null;
function ditherMasks() {
  if (masks) return masks;
  masks = [];
  const cell = 3, dpr = Math.max(1, Math.round(window.devicePixelRatio || 1));
  const px = cell * dpr, tile = px * 4;
  for (let k = 1; k <= 3; k++) {
    const c = el('canvas');
    c.width = c.height = tile;
    const g = c.getContext('2d');
    g.fillStyle = '#000';
    for (let i = 0; i < 16; i++) if (BAYER[i] < k * 4) g.fillRect((i % 4) * px, Math.floor(i / 4) * px, px, px);
    masks.push(`url(${c.toDataURL()})`);
  }
  return masks;
}
function setMask(node, k) {      // k = 1..3 partial, else none
  const m = k >= 1 && k <= 3 ? ditherMasks()[k - 1] : '';
  const s = node.style;
  s.webkitMaskImage = s.maskImage = m || '';
  s.webkitMaskSize = s.maskSize = m ? '12px 12px' : '';
  s.webkitMaskRepeat = s.maskRepeat = m ? 'repeat' : '';
}

/* ================================================================== VIEWER.EXE */
function createViewer(page) {
  const label = labelFinder(page);
  const V = {
    open: false, busy: false, items: [], idx: 0,
    node: null, stage: null, pic: null, picBox: null,
    scale: 1, panX: 0, panY: 0,
    pushed: false, ignorePop: false, lastFocus: null,
  };

  function build() {
    const n = el('div', 'fxg-viewer');
    n.setAttribute('role', 'dialog');
    n.setAttribute('aria-modal', 'true');
    n.setAttribute('aria-label', 'VIEWER.EXE');
    n.innerHTML = `
      <div class="fxg-bar fxg-bar--top"><span class="fxg-label"></span><span class="fxg-count" aria-live="polite"></span></div>
      <div class="fxg-stage"><span class="fxg-zoom" hidden>1X</span></div>
      <div class="fxg-bar fxg-bar--bottom">
        <button type="button" class="fxg-btn fxg-prev" aria-label="Previous image">&lt;</button>
        <button type="button" class="fxg-btn fxg-close">CLOSE</button>
        <button type="button" class="fxg-btn fxg-next" aria-label="Next image">&gt;</button>
      </div>`;
    V.stage = n.querySelector('.fxg-stage');
    V.labelEl = n.querySelector('.fxg-label');
    V.countEl = n.querySelector('.fxg-count');
    V.zoomEl = n.querySelector('.fxg-zoom');
    n.querySelector('.fxg-close').addEventListener('click', () => close());
    n.querySelector('.fxg-prev').addEventListener('click', () => go(V.idx - 1));
    n.querySelector('.fxg-next').addEventListener('click', () => go(V.idx + 1));
    wireGestures();
    V.node = n;
  }

  /* -------- items + pictures */
  function itemFor(m) {
    const slot = slotOf(m);
    const sr = slot.getBoundingClientRect();
    let crop = null, aspect;
    if (slot !== m && slot.classList.contains('photo-frame')) {
      // zoom-cropped frame (hides polaroid borders): show exactly the framed crop, scaled up
      const ir = m.getBoundingClientRect();
      crop = {
        l: ((ir.left - sr.left) / sr.width) * 100, t: ((ir.top - sr.top) / sr.height) * 100,
        w: (ir.width / sr.width) * 100, h: (ir.height / sr.height) * 100,
      };
      aspect = sr.width / sr.height;
    } else {
      const w = m.naturalWidth || m.videoWidth, h = m.naturalHeight || m.videoHeight;
      aspect = w && h ? w / h : sr.width / sr.height;
    }
    return { m, slot, crop, aspect, label: label(m), video: m.tagName === 'VIDEO' };
  }

  function buildPic(item) {
    const pic = el('div', 'fxg-pic');
    let media;
    if (item.video) {
      media = el('video');
      media.muted = true; media.defaultMuted = true; media.playsInline = true; media.loop = true; media.autoplay = true;
      ['muted', 'playsinline', 'loop', 'autoplay'].forEach((a) => media.setAttribute(a, ''));
      if (item.m.poster) media.poster = item.m.poster;
      media.src = item.m.currentSrc || item.m.src;
    } else {
      media = new Image();
      media.decoding = 'async';
      media.alt = item.m.alt || '';
      media.src = item.m.currentSrc || item.m.src;
    }
    media.draggable = false;
    media.className = 'fxg-media';
    if (item.crop) {
      const c = item.crop;
      media.style.cssText = `left:${c.l}%;top:${c.t}%;width:${c.w}%;height:${c.h}%;object-fit:cover`;
    } else {
      media.style.cssText = 'left:0;top:0;width:100%;height:100%;object-fit:contain';
    }
    pic.appendChild(media);
    return { pic, media, item };
  }

  /** Fit box (stage px) for an aspect, contain, small margin. */
  function fitBox(aspect) {
    const sw = V.stage.clientWidth, sh = V.stage.clientHeight;
    const mw = sw, mh = sh - 8;
    let w = mw, h = w / aspect;
    if (h > mh) { h = mh; w = h * aspect; }
    w = Math.round(w); h = Math.round(h);
    return { x: Math.round((sw - w) / 2), y: Math.round((sh - h) / 2), w, h };
  }
  function place(p, box) {
    p.box = box;
    Object.assign(p.pic.style, { left: `${box.x}px`, top: `${box.y}px`, width: `${box.w}px`, height: `${box.h}px` });
  }
  /** Screen rect of the current picture (incl. zoom/pan), clipped to the stage. */
  function picScreenBox() {
    if (!V.pic) return null;
    return visibleBox(V.pic.pic.getBoundingClientRect());
  }

  function setChrome() {
    const it = V.items[V.idx], n = V.items.length, w = n >= 100 ? 3 : 2;
    V.labelEl.textContent = it.label;
    V.countEl.textContent = `${pad(V.idx + 1, w)} / ${pad(n, w)}`;
    const many = n > 1;
    V.node.querySelector('.fxg-prev').hidden = !many;
    V.node.querySelector('.fxg-next').hidden = !many;
  }

  /* -------- zoom / pan (hard steps) */
  function applyXform() {
    if (!V.pic) return;
    V.pic.pic.style.transform = V.scale === 1 && !V.panX && !V.panY ? ''
      : `translate(${Math.round(V.panX)}px, ${Math.round(V.panY)}px) scale(${V.scale})`;
    V.zoomEl.hidden = V.scale === 1;
    V.zoomEl.textContent = `${V.scale}X`;
    V.node.classList.toggle('is-zoomed', V.scale > 1);
  }
  function clampPan() {
    const b = V.pic.box, sw = V.stage.clientWidth, sh = V.stage.clientHeight;
    const cx = b.x + b.w / 2 - sw / 2, cy = b.y + b.h / 2 - sh / 2;   // pic centre offset from stage centre
    const ex = Math.max(0, (b.w * V.scale - sw) / 2), ey = Math.max(0, (b.h * V.scale - sh) / 2);
    V.panX = clamp(V.panX, -ex - cx, ex - cx);
    V.panY = clamp(V.panY, -ey - cy, ey - cy);
    if (V.scale === 1) { V.panX = 0; V.panY = 0; }
  }
  /** Set zoom level keeping stage point (px, py) anchored. */
  function zoomTo(level, px, py, fromScale = V.scale, fromPanX = V.panX, fromPanY = V.panY) {
    const b = V.pic.box;
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    const ux = (px - cx - fromPanX) / fromScale, uy = (py - cy - fromPanY) / fromScale;  // content point (unscaled)
    V.scale = level;
    V.panX = px - cx - ux * level;
    V.panY = py - cy - uy * level;
    clampPan();
    applyXform();
  }
  const nearestLevel = (s) => LEVELS.reduce((best, L) => (Math.abs(Math.log(s / L)) < Math.abs(Math.log(s / best)) ? L : best), 1);

  /* -------- navigation with the dither dissolve */
  let dissolveTok = 0;
  async function go(i) {
    if (!V.open || V.items.length < 2) return;
    const n = V.items.length;
    V.idx = ((i % n) + n) % n;
    const old = V.pic;
    const nu = buildPic(V.items[V.idx]);
    place(nu, fitBox(V.items[V.idx].aspect));
    V.scale = 1; V.panX = 0; V.panY = 0;
    if (old) old.pic.style.transform = '';
    V.pic = nu;
    setChrome();
    applyXform();
    const tok = ++dissolveTok;
    if (still() || !old) {
      V.stage.appendChild(nu.pic);
      if (old) old.pic.remove();
      return;
    }
    setMask(nu.pic, 1);
    nu.pic.style.visibility = 'hidden';
    V.stage.appendChild(nu.pic);
    try { if (!nu.item.video) await Promise.race([nu.media.decode(), new Promise((r) => setTimeout(r, 350))]); } catch (e) { /* show anyway */ }
    if (tok !== dissolveTok) { nu.pic.style.visibility = ''; setMask(nu.pic, 0); old.pic.remove(); return; }
    nu.pic.style.visibility = '';
    await stepper(4, DISSOLVE_MS, (k) => { if (tok === dissolveTok) setMask(nu.pic, k + 1); });
    setMask(nu.pic, 0);
    old.pic.remove();
  }

  /* -------- open / close */
  function onKey(e) {
    if (!V.open) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowRight') go(V.idx + 1);
    else if (e.key === 'ArrowLeft') go(V.idx - 1);
  }
  function onPop() {
    if (V.ignorePop) { V.ignorePop = false; return; }
    if (V.open) { V.pushed = false; close(); }
  }

  async function open(m) {
    if (V.open || V.busy) return;
    V.busy = true;
    try {
      if (!V.node) build();
      const media = collectMedia();
      V.items = media.map(itemFor);
      V.idx = Math.max(0, media.indexOf(m));
      if (!V.items.length) return;
      const from = visibleBox(V.items[V.idx].slot.getBoundingClientRect());
      V.lastFocus = document.activeElement;

      // lay the viewer out invisibly so the target box is known
      V.node.classList.add('is-measuring');
      document.body.appendChild(V.node);
      html.dataset.fxModal = 'viewer';
      html.classList.add('fxg-lock');
      Array.from(V.stage.querySelectorAll('.fxg-pic')).forEach((p) => p.remove());
      V.scale = 1; V.panX = 0; V.panY = 0;
      V.pic = buildPic(V.items[V.idx]);
      place(V.pic, fitBox(V.items[V.idx].aspect));
      V.stage.appendChild(V.pic.pic);
      setChrome();
      applyXform();
      const sr = V.stage.getBoundingClientRect(), b = V.pic.box;
      const to = { x: sr.left + b.x, y: sr.top + b.y, w: b.w, h: b.h };
      V.open = true;
      await zoomRects(from, to);
      V.node.classList.remove('is-measuring');
      if (V.pic.item.video) { const p = V.pic.media.play(); if (p && p.catch) p.catch(() => {}); }
      try { V.node.querySelector('.fxg-close').focus({ preventScroll: true }); } catch (e) { /* ignore */ }
      document.addEventListener('keydown', onKey);
      try { history.pushState({ fxg: 1 }, ''); V.pushed = true; } catch (e) { V.pushed = false; }
      addEventListener('popstate', onPop);
    } finally {
      V.busy = false;
    }
  }

  async function close() {
    if (!V.open || V.busy) return;
    V.busy = true;
    try {
      dissolveTok++;
      const it = V.items[V.idx];
      const from = picScreenBox();
      document.removeEventListener('keydown', onKey);
      removeEventListener('popstate', onPop);
      if (V.pushed && history.state && history.state.fxg) { V.ignorePop = true; try { history.back(); } catch (e) { V.ignorePop = false; } }
      V.pushed = false;
      V.node.remove();
      Array.from(V.stage.querySelectorAll('.fxg-pic')).forEach((p) => p.remove());
      V.pic = null;
      html.classList.remove('fxg-lock');
      delete html.dataset.fxModal;
      V.open = false;
      // bring the slot into view (it may have been a different image) and zoom back into it
      let r = it.slot.getBoundingClientRect();
      if (r.bottom < navBottom() + 20 || r.top > vh() - 20) {
        const top = scrollY + r.top - Math.max(navBottom(), (vh() - r.height) / 2);
        window.scrollTo({ top: Math.max(0, top), behavior: 'instant' });
        r = it.slot.getBoundingClientRect();
      }
      await zoomRects(from, visibleBox(r));
      try { if (V.lastFocus && V.lastFocus.focus) V.lastFocus.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    } finally {
      V.busy = false;
    }
  }

  /* -------- gestures inside the viewer (the only place this layer claims touch-action) */
  function wireGestures() {
    const st = V.stage;
    const pts = new Map();
    let g = null;              // current gesture
    let lastTap = { t: 0, x: 0, y: 0 };
    const local = (e) => { const r = st.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    const snap = (v, s) => Math.round(v / s) * s;

    st.addEventListener('pointerdown', (e) => {
      if (!V.open || V.busy || !V.pic) return;
      try { st.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      pts.set(e.pointerId, local(e));
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        g = { type: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, s0: V.scale, px0: V.panX, py0: V.panY,
          mx0: (a.x + b.x) / 2, my0: (a.y + b.y) / 2 };
        if (V.pic) V.pic.pic.style.translate = '';
      } else if (pts.size === 1) {
        const p = local(e);
        g = { type: 'pending', x0: p.x, y0: p.y, t0: performance.now(), px0: V.panX, py0: V.panY, dx: 0, dy: 0 };
      }
    });
    st.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId) || !g || !V.pic) return;
      pts.set(e.pointerId, local(e));
      if (g.type === 'pinch' && pts.size >= 2) {
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        const L = nearestLevel(g.s0 * (d / g.d0));
        // anchor the content point under the starting midpoint to the current midpoint
        const bx = V.pic.box, cx = bx.x + bx.w / 2, cy = bx.y + bx.h / 2;
        const ux = (g.mx0 - cx - g.px0) / g.s0, uy = (g.my0 - cy - g.py0) / g.s0;
        V.scale = L;
        V.panX = mx - cx - ux * L;
        V.panY = my - cy - uy * L;
        clampPan();
        applyXform();
        return;
      }
      if (pts.size !== 1) return;
      const p = local(e);
      g.dx = p.x - g.x0; g.dy = p.y - g.y0;
      if (g.type === 'pending' && Math.hypot(g.dx, g.dy) > 10) {
        if (V.scale > 1) g.type = 'pan';
        else if (Math.abs(g.dx) > Math.abs(g.dy)) g.type = 'swipe';
        else if (g.dy > 0) g.type = 'down';
        else g.type = 'none';
      }
      if (g.type === 'pan') {
        V.panX = g.px0 + g.dx; V.panY = g.py0 + g.dy;
        clampPan(); applyXform();
      } else if (g.type === 'swipe') {
        V.pic.pic.style.translate = `${snap(g.dx * 0.8, 6)}px 0`;
      } else if (g.type === 'down') {
        V.pic.pic.style.translate = `0 ${snap(Math.max(0, g.dy), 6)}px`;
        V.node.classList.toggle('is-leaving', g.dy > 90);
      }
    });
    const up = (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.delete(e.pointerId);
      if (!g) return;
      if (g.type === 'pinch') {
        if (pts.size === 1) {     // continue as a pan with the remaining finger
          const p = [...pts.values()][0];
          g = { type: V.scale > 1 ? 'pan' : 'none', x0: p.x, y0: p.y, t0: performance.now(), px0: V.panX, py0: V.panY, dx: 0, dy: 0 };
        } else g = null;
        return;
      }
      if (pts.size) return;
      const dt = Math.max(1, performance.now() - g.t0);
      const cur = g; g = null;
      if (V.pic) V.pic.pic.style.translate = '';
      V.node.classList.remove('is-leaving');
      if (e.type === 'pointercancel') return;
      if (cur.type === 'swipe') {
        const v = Math.abs(cur.dx) / dt;
        if (Math.abs(cur.dx) > 56 || (Math.abs(cur.dx) > 22 && v > 0.45)) go(V.idx + (cur.dx < 0 ? 1 : -1));
      } else if (cur.type === 'down') {
        const v = cur.dy / dt;
        if (cur.dy > 90 || (cur.dy > 30 && v > 0.5)) close();
      } else if (cur.type === 'pending' && dt < 300) {
        // tap: a second one soon after toggles 2× at that point
        const now = performance.now();
        if (now - lastTap.t < 320 && Math.hypot(cur.x0 - lastTap.x, cur.y0 - lastTap.y) < 30) {
          zoomTo(V.scale > 1 ? 1 : 2, cur.x0, cur.y0);
          lastTap.t = 0;
        } else lastTap = { t: now, x: cur.x0, y: cur.y0 };
      }
    };
    st.addEventListener('pointerup', up);
    st.addEventListener('pointercancel', up);
    // iOS Safari: keep its own page pinch out of the viewer
    V.stage.addEventListener('gesturestart', (e) => e.preventDefault());
  }

  return { open, close, get isOpen() { return V.open; }, state: V };
}

/* ================================================================== magnifier loupe */
function createLoupe(onShown) {
  const L = { node: null, canvas: null, ctx: null, target: null, timer: 0, start: null, active: false, suppressUntil: 0 };
  const dpr = Math.min(3, window.devicePixelRatio || 1);

  function build() {
    const n = el('div', 'fxg-loupe');
    n.setAttribute('aria-hidden', 'true');
    const c = el('canvas', 'fxg-loupe__c');
    c.width = c.height = Math.round(LOUPE * dpr);
    n.appendChild(c);
    n.appendChild(el('span', 'fxg-loupe__tag', `${LOUPE_ZOOM}X`));
    L.node = n; L.canvas = c; L.ctx = c.getContext('2d');
  }

  function position(x, y) {
    const W = vw(), H = vh();
    let left = Math.round(x - LOUPE / 2), top = Math.round(y - LOUPE - 44);
    if (top < navBottom() + 6) top = Math.round(y + 52);              // no room above: below the finger
    left = clamp(left, 6, W - LOUPE - 10);
    top = clamp(top, 6, H - LOUPE - 10);
    L.node.style.left = `${left}px`;
    L.node.style.top = `${top}px`;
    return { x: left, y: top, w: LOUPE, h: LOUPE };
  }

  function draw(x, y) {
    const g = L.ctx, D = L.canvas.width;
    const S = LOUPE / LOUPE_ZOOM;                         // css px of page shown
    const x0 = x - S / 2, y0 = y - S / 2;
    g.imageSmoothingEnabled = false;
    g.fillStyle = '#fff';
    g.fillRect(0, 0, D, D);
    // every image under the loupe, in paint order (DOM order; the collage doesn't overlap much)
    (L.media || []).forEach((m) => drawOne(m, x0, y0, S, D));
  }
  function drawOne(m, x0, y0, S, D) {
    const g = L.ctx, k = D / S;                          // screen → canvas
    const vis = slotOf(m).getBoundingClientRect();        // only what the slot shows on screen
    const cx0 = Math.max(x0, vis.left), cy0 = Math.max(y0, vis.top);
    const cx1 = Math.min(x0 + S, vis.right), cy1 = Math.min(y0 + S, vis.bottom);
    if (cx1 <= cx0 || cy1 <= cy0) return;
    const map = contentMap(m);
    // screen rect → source rect, clipped to the image
    let sx0 = (cx0 - map.left) / map.sx, sy0 = (cy0 - map.top) / map.sy;
    let sx1 = (cx1 - map.left) / map.sx, sy1 = (cy1 - map.top) / map.sy;
    const csx0 = clamp(sx0, 0, map.natW), csy0 = clamp(sy0, 0, map.natH);
    const csx1 = clamp(sx1, 0, map.natW), csy1 = clamp(sy1, 0, map.natH);
    if (csx1 - csx0 <= 0 || csy1 - csy0 <= 0) return;
    const dx = (map.left + csx0 * map.sx - x0) * k, dy = (map.top + csy0 * map.sy - y0) * k;
    const dw = (csx1 - csx0) * map.sx * k, dh = (csy1 - csy0) * map.sy * k;
    try { g.drawImage(m, csx0, csy0, csx1 - csx0, csy1 - csy0, dx, dy, dw, dh); } catch (e) { /* not decoded */ }
  }

  async function show(x, y) {
    if (!L.node) build();
    L.active = true;
    L.media = collectMedia();
    document.body.appendChild(L.node);
    L.node.style.visibility = 'hidden';
    const to = position(x, y);
    draw(x, y);
    try { if (navigator.vibrate) navigator.vibrate(8); } catch (e) { /* ignore */ }
    const S = LOUPE / LOUPE_ZOOM;
    await zoomRects({ x: x - S / 2, y: y - S / 2, w: S, h: S }, to, { steps: 3, ms: 30, trail: 2 });
    if (L.active) L.node.style.visibility = '';
    if (onShown) onShown();
  }
  function move(x, y) {
    if (!L.active) return;
    position(x, y);
    draw(x, y);
  }
  function hide() {
    L.active = false;
    if (L.node) L.node.remove();
  }

  /* touch wiring (per image; touchmove is non-passive only so the loupe can hold the page still) */
  const cancelPending = () => { clearTimeout(L.timer); L.timer = 0; L.start = null; };
  function onStart(e) {
    if (e.touches.length !== 1 || html.dataset.fxModal) { cancelPending(); if (L.active) hide(); return; }
    const t = e.touches[0];
    const m = mediaFrom(e.currentTarget);
    if (!m) return;
    L.target = m;
    L.start = { x: t.clientX, y: t.clientY, sy: scrollY };
    clearTimeout(L.timer);
    L.timer = setTimeout(() => {
      L.timer = 0;
      if (!L.start || Math.abs(scrollY - L.start.sy) > 2) return;
      show(L.start.x, L.start.y);
    }, PRESS_MS);
  }
  function onMove(e) {
    const t = e.touches[0];
    if (L.active) {
      if (e.cancelable) e.preventDefault();
      if (t) move(t.clientX, t.clientY);
      return;
    }
    if (L.start && t && Math.hypot(t.clientX - L.start.x, t.clientY - L.start.y) > 9) cancelPending();
  }
  function onEnd(e) {
    cancelPending();
    if (L.active) {
      if (e.cancelable) e.preventDefault();     // no click → no viewer
      L.suppressUntil = performance.now() + 500;
      hide();
    }
  }
  function mediaFrom(slot) {
    if (slot.matches('img, video')) return slot;
    return slot.querySelector('img, video');
  }
  function attach(slots) {
    slots.forEach((s) => {
      s.addEventListener('touchstart', onStart, { passive: true });
      s.addEventListener('touchmove', onMove, { passive: false });
      s.addEventListener('touchend', onEnd, { passive: false });
      s.addEventListener('touchcancel', onEnd, { passive: false });
    });
    addEventListener('scroll', () => { if (L.timer) cancelPending(); }, { passive: true });
  }
  return { attach, hide, get suppressed() { return performance.now() < L.suppressUntil || L.active; } };
}

/* ================================================================== project readout */
function mountReadout() {
  const title = document.querySelector(TITLE_SEL);
  if (!title) return null;
  const slots = Array.from(new Set(collectMedia().map(slotOf)));
  if (slots.length < 2) return null;
  title.dataset.fxgTitle = title.textContent.trim();
  const out = el('span', 'fxg-readout');
  out.setAttribute('aria-hidden', 'true');
  title.appendChild(out);
  // The status bar: a fixed copy of the title at the bottom of the screen while the real one is still below it;
  // it hands over (same place, same type) when the title scrolls up into it. No layout change to the page.
  const bar = el('div', 'fxg-status');
  bar.setAttribute('aria-hidden', 'true');
  const barTitle = el('span', 'fxg-status__t', title.dataset.fxgTitle);
  const out2 = el('span', 'fxg-readout');
  bar.append(barTitle, out2);
  document.body.appendChild(bar);
  const n = slots.length;
  let shown = 0, target = 1, stepT = 0, raf = 0, barOn = null;

  function layoutBar() {
    const cs = getComputedStyle(title), r = title.getBoundingClientRect();
    Object.assign(bar.style, {
      left: `${Math.round(r.left)}px`, width: `${Math.round(r.width)}px`,
      fontSize: cs.fontSize, lineHeight: cs.lineHeight, letterSpacing: cs.letterSpacing, color: cs.color,
    });
  }
  function dock() {
    const r = title.getBoundingClientRect();
    const on = r.top > vh() - bar.offsetHeight + 8 - 0.5;
    if (on !== barOn) { barOn = on; bar.classList.toggle('is-on', on); }
  }

  const render = (i) => { out.textContent = out2.textContent = `IMG ${i}/${n}`; };
  function compute() {
    const H = vh(), max = Math.max(0, document.documentElement.scrollHeight - H), y = scrollY;
    const ramp = Math.max(1, Math.min(H / 2, max / 2));
    let line;
    if (max < 4) line = H;
    else if (y < ramp) line = H * (0.25 + 0.25 * (y / ramp));
    else if (y > max - ramp) line = H * (0.5 + 0.48 * ((y - (max - ramp)) / ramp));
    else line = H * 0.5;
    let i = 1;
    slots.forEach((s, k) => { if (s.getBoundingClientRect().top < line) i = k + 1; });
    return i;
  }
  function step() {
    stepT = 0;
    if (shown === target) return;
    shown += shown < target ? 1 : -1;
    render(shown);
    out.classList.add('is-step');
    if (shown !== target) stepT = setTimeout(step, 55);
    else stepT = setTimeout(() => { out.classList.remove('is-step'); stepT = 0; }, 90);
  }
  function update() {
    raf = 0;
    dock();
    target = compute();
    if (still() || !shown) { shown = target; render(shown); return; }
    if (!stepT) step();
  }
  const onScroll = () => { if (!raf) raf = requestAnimationFrame(update); };
  const onResize = () => { layoutBar(); onScroll(); };
  addEventListener('scroll', onScroll, { passive: true });
  addEventListener('resize', onResize, { passive: true });
  layoutBar();
  update();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(onResize, () => {});
  return {
    destroy() {
      removeEventListener('scroll', onScroll); removeEventListener('resize', onResize);
      out.remove(); bar.remove();
    },
  };
}

/* ================================================================== contact */
function mountContact(viewer) {
  const mail = document.querySelector('.contact-info a[href^="mailto:"]');
  const portrait = document.querySelector('.contact-portrait');
  let armedUntil = 0;
  preload('chime');

  async function copy(text) {
    try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; } } catch (e) { /* fall back */ }
    try {
      const ta = el('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, text.length);
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e) { return false; }
  }

  if (mail) {
    mail.addEventListener('click', async (e) => {
      if (performance.now() < armedUntil) { hideTip(); armedUntil = 0; return; }   // second tap: the mailto goes
      e.preventDefault();
      const addr = (mail.textContent || '').trim() || decodeURIComponent(mail.href.replace(/^mailto:/i, ''));
      const ok = await copy(addr);
      const send = el('a', 'fxg-tip__send', 'SEND >');
      send.href = mail.href;
      showTip(ok ? 'COPIED TO CLIPBOARD' : addr.toUpperCase(), mail.getBoundingClientRect(), { ms: 4000, extra: send, above: true });
      if (ok) play('chime', { volume: 0.45 });
      armedUntil = performance.now() + 4000;
    });
  }

  if (!portrait) return { claims: () => false };
  let tilt = false, unsub = null, last = '';
  function apply(mo) {
    const q = (v) => Math.round(v * 2) / 2;                 // half-degree hard steps
    const ry = q(clamp(mo.x, -1, 1) * 4), rx = q(clamp(-mo.y, -1, 1) * 3);
    const sx = Math.round(2 - clamp(mo.x, -1, 1) * 3), sy = Math.round(2 + clamp(mo.y, -1, 1) * 3);
    const key = `${rx}|${ry}|${sx}|${sy}`;
    if (key === last) return;
    last = key;
    portrait.style.transform = `perspective(900px) rotateX(${rx}deg) rotateY(${ry}deg)`;
    portrait.style.boxShadow = `${sx}px ${sy}px 0 ${INK}`;
  }
  async function startTilt(e) {
    const ok = await enableMotion({ ask: true });
    if (!ok) return false;
    tilt = true;
    portrait.classList.add('fxg-tilt');
    apply(motion);
    unsub = motion.subscribe(apply);
    showTip('TILT YOUR PHONE', { left: e.clientX - 40, top: e.clientY, bottom: e.clientY + 4 }, { ms: 1800, above: true });
    return true;
  }
  return {
    /** True if this tap on the portrait was used to turn the tilt on (then no viewer). */
    claims(m, e) {
      if (tilt || still() || !portrait.contains(m)) return false;
      const st = motionState();
      if (st !== 'needs-tap' && st !== 'live') return false;
      startTilt(e).then((ok) => { if (!ok && motionState() !== 'needs-tap') { /* next tap opens the viewer */ } });
      return true;
    },
    destroy() { if (unsub) unsub(); portrait.style.transform = ''; portrait.style.boxShadow = ''; },
  };
}

/* ================================================================== mount */
export async function mount({ page }) {
  const parts = [];
  try {
    html.classList.add('fxg-on');
    const media = collectMedia();
    const slots = Array.from(new Set(media.map(slotOf)));
    const viewer = createViewer(page);
    const loupe = createLoupe();
    loupe.attach(slots);
    const contact = page === 'contact' ? mountContact(viewer) : null;
    if (contact) parts.push(contact);

    // tap → viewer (click = a real tap: never fired for scrolls, suppressed after a loupe)
    const onClick = (e) => {
      if (viewer.isOpen || html.dataset.fxModal || loupe.suppressed) return;
      if (!e.target.closest || e.target.closest('a, button, summary, input, .nav, .fxg-viewer, .fxg-tip')) return;
      let slot = e.target.closest(SLOT_SEL + ', .page img, .page video');
      if (!slot && document.elementsFromPoint) {
        // plain text laid over an image (contact): the tap belongs to the image underneath
        const under = document.elementsFromPoint(e.clientX, e.clientY).find((n) => n.matches && n.matches(SLOT_SEL + ', .page img, .page video'));
        slot = under || null;
      }
      if (!slot || slot.closest('.nav, a, .fxg-viewer')) return;
      const m = slot.matches('img, video') ? slot : slot.querySelector('img, video');
      if (!m || !isShown(slotOf(m))) return;
      if (contact && contact.claims(m, e)) return;
      viewer.open(m);
    };
    document.addEventListener('click', onClick);
    const noMenu = (e) => { if (e.target.closest && e.target.closest(SLOT_SEL + ', .page img, .page video') && !e.target.closest('.nav')) e.preventDefault(); };
    document.addEventListener('contextmenu', noMenu);

    if (page !== 'photography' && page !== 'contact') {
      const ro = mountReadout();
      if (ro) parts.push(ro);
    }
    window.__fxGallery = { viewer, loupe };
    return {
      viewer,
      destroy() {
        document.removeEventListener('click', onClick);
        document.removeEventListener('contextmenu', noMenu);
        if (viewer.isOpen) viewer.close();
        loupe.hide();
        hideTip();
        parts.forEach((p) => p.destroy && p.destroy());
        html.classList.remove('fxg-on');
      },
    };
  } catch (err) {
    console.warn('[fx] m-gallery', err);
    return null;
  }
}
