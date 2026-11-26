/*
 * fx/flipbook-lite.js — Security magazine viewer without WebGL (phones, no WebGL2, reduced motion, ?gl=off),
 * plus the helpers fx/flipbook.js shares (entry wiring, page paths, counter text).
 *
 * Entry points (both modes): each issue cover `.sec-issue__cover` opens its issue at the cover; each photographed
 * spread in `.sec-issue__spreads` opens the matching PDF spread (fx/security-book.js SCANS, matched offline) or the
 * start of the issue. Entries get role=button, tabindex, aria-label and data-cursor="view"; the scans stay visible.
 *
 * Lite viewer: full-screen white dialog, horizontal scroll-snap strip (single pages on phones, spreads on wider
 * screens), swipe / arrow keys / < >, lazy images over an atlas placeholder, CLOSE / Esc, focus trap.
 * Reduced motion: no fades, instant scrolling.
 * Phone (html.fx-phone, no GL): opens after Win98 zoom-rects out of the tapped element (zoomRects, also used by the
 * GL phone reader fx/m-flipbook.js); fx/m-security.css lifts the viewer above the sticky phone nav (z 90).
 */
import { BASE, ISSUES, SCANS } from './security-book.js';

/* ------------------------------------------------------------------ shared helpers */
const pad3 = (n) => String(n).padStart(3, '0');
export const pageSrc = (iss, n) => `${BASE}${iss.id}/${pad3(n)}.webp`;
export const atlasSrc = (iss) => BASE + iss.atlas.src;
/** spreads 0..floor(N/2): spread 0 = cover alone (right), spread k = pages 2k (left), 2k+1 (right) */
export const spreadCount = (iss) => Math.floor(iss.pages / 2) + 1;
export const spreadPages = (iss, k) => [
  k >= 1 && 2 * k <= iss.pages ? 2 * k : 0,
  2 * k + 1 <= iss.pages ? 2 * k + 1 : 0,
];
export function rangeLabel(iss, k) {
  const [l, r] = spreadPages(iss, k);
  return l && r ? `${l}–${r}` : String(l || r);
}
export const counterText = (iss, k) => `ISSUE ${iss.id} · ${rangeLabel(iss, k)} / ${iss.pages}`;
export const issueName = (iss) => `ISSUE ${iss.id} — ${iss.title}`;

/** Atlas cell of page n (1-based) as CSS background-size / -position values. */
function atlasCss(iss, n) {
  const a = iss.atlas;
  const cols = a.cols, rows = Math.round(a.h / a.ch);
  const j = n - 1, c = j % cols, r = Math.floor(j / cols);
  return {
    size: `${cols * 100}% ${rows * 100}%`,
    pos: `${cols > 1 ? (c / (cols - 1)) * 100 : 0}% ${rows > 1 ? (r / (rows - 1)) * 100 : 0}%`,
  };
}

const titleCase = (s) => s.toLowerCase().replace(/\b\w/g, (m) => m.toUpperCase());

/**
 * Turn covers and grid scans into buttons that open the viewer.
 * handlers: { open(entry, event), warm?(entry), enter?(entry, e), move?(entry, e), leave?(entry, e) }
 * entry = { el, iss, spread, kind: 'cover' | 'scan' }
 */
export function wireEntries(handlers) {
  const entries = [];
  const offs = [];
  document.querySelectorAll('.sec-issue').forEach((sec) => {
    const id = (/sec-issue--(\d\d)/.exec(sec.className) || [])[1];
    const iss = ISSUES[id];
    if (!iss) return;
    const cover = sec.querySelector('.sec-issue__cover');
    if (cover) {
      entries.push({ el: cover, iss, spread: 0, kind: 'cover',
        label: `Open Security Issue ${id}, ${titleCase(iss.title)}, as a flip-through magazine` });
    }
    // "READ ISSUE 0X>" + its hint: hidden in the HTML (no reader without JS), opened up here; READ opens the cover
    sec.querySelectorAll('[data-sec-read], .sec-issue__hint').forEach((el) => { el.hidden = false; });
    sec.querySelectorAll('.sec-issue__spreads > .figure').forEach((fig) => {
      const img = fig.querySelector('img');
      const file = img ? (img.getAttribute('src') || '').split('/').pop() : '';
      const m = SCANS[file];
      const spread = m && m.issue === id && m.spread != null ? m.spread : 0;
      entries.push({ el: fig, iss, spread, kind: 'scan',
        label: spread ? `Open Security Issue ${id} at pages ${rangeLabel(iss, spread)}` : `Open Security Issue ${id}` });
    });
  });

  const on = (el, type, fn, opts) => { el.addEventListener(type, fn, opts); offs.push(() => el.removeEventListener(type, fn, opts)); };
  entries.forEach((entry) => {
    const { el } = entry;
    const prev = {
      role: el.getAttribute('role'), tabindex: el.getAttribute('tabindex'),
      label: el.getAttribute('aria-label'), cursor: el.getAttribute('data-cursor'),
    };
    el.setAttribute('role', 'button');
    el.setAttribute('tabindex', '0');
    el.setAttribute('aria-label', entry.label);
    el.setAttribute('aria-haspopup', 'dialog');
    el.setAttribute('data-cursor', 'view');
    el.classList.add('sec-entry');
    offs.push(() => {
      const put = (k, v) => (v == null ? el.removeAttribute(k) : el.setAttribute(k, v));
      put('role', prev.role); put('tabindex', prev.tabindex); put('aria-label', prev.label);
      put('data-cursor', prev.cursor); el.removeAttribute('aria-haspopup'); el.classList.remove('sec-entry');
    });
    on(el, 'click', (e) => { e.preventDefault(); handlers.open(entry, e); });
    on(el, 'keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handlers.open(entry, e); }
    });
    const warm = () => handlers.warm && handlers.warm(entry);
    on(el, 'focus', warm);
    on(el, 'pointerenter', (e) => { warm(); handlers.enter && handlers.enter(entry, e); });
    if (handlers.move) on(el, 'pointermove', (e) => handlers.move(entry, e));
    if (handlers.leave) on(el, 'pointerleave', (e) => handlers.leave(entry, e));
  });
  document.querySelectorAll('.sec-issue [data-sec-read]').forEach((btn) => {
    const cover = entries.find((en) => en.kind === 'cover' && btn.closest('.sec-issue').contains(en.el));
    if (!cover) { btn.hidden = true; return; }
    btn.setAttribute('aria-haspopup', 'dialog');
    on(btn, 'click', (e) => { e.preventDefault(); handlers.open(cover, e); });
    on(btn, 'pointerenter', () => handlers.warm && handlers.warm(cover));
    on(btn, 'focus', () => handlers.warm && handlers.warm(cover));
  });
  return { entries, destroy() { offs.forEach((f) => f()); } };
}

/** Body scroll lock + modal flag shared by both viewers. */
export function modalState(name) {
  const html = document.documentElement;
  let prevOverflow = '';
  return {
    on() {
      prevOverflow = html.style.overflow;
      html.style.overflow = 'hidden';
      html.dataset.fxModal = name;
    },
    off() {
      html.style.overflow = prevOverflow;
      if (html.dataset.fxModal === name) delete html.dataset.fxModal;
    },
  };
}

/** Viewport box {x, y, w, h} of `el` when at least partly on screen, else null. */
export function rectOf(el) {
  if (!el || !el.isConnected) return null;
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return null;
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

/**
 * Win98 zoom rectangles (phone reader open / close): 1px KRISHA-blue outlines step from box `a` to box `b` in hard
 * steps (no tweening between them) with a short trail, on their own layer above the phone nav. Resolves when done;
 * resolves at once with reduced motion or a missing box. `shrink` eases out (closing into a slot).
 */
export function zoomRects(a, b, { steps = 7, ms = 40, trail = 3, shrink = false } = {}) {
  const reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  if (!a || !b || reduced) return Promise.resolve();
  return new Promise((resolve) => {
    const layer = document.createElement('div');
    layer.className = 'sec-zoom';
    layer.setAttribute('aria-hidden', 'true');
    const rects = [];
    for (let j = 0; j < trail; j++) {
      const r = document.createElement('div');
      r.className = 'sec-zoom__rect';
      layer.appendChild(r);
      rects.push(r);
    }
    document.body.appendChild(layer);
    const at = (s) => {
      const u = s / (steps - 1);
      const t = shrink ? 1 - Math.pow(1 - u, 1.3) : Math.pow(u, 1.3);
      const x = Math.round(a.x + (b.x - a.x) * t), y = Math.round(a.y + (b.y - a.y) * t);
      const r = Math.round(a.x + a.w + (b.x + b.w - a.x - a.w) * t), btm = Math.round(a.y + a.h + (b.y + b.h - a.y - a.h) * t);
      return { x, y, w: Math.max(2, r - x), h: Math.max(2, btm - y) };
    };
    const t0 = performance.now();
    let shown = -1, raf = 0, finished = false;
    const end = () => {
      if (finished) return;
      finished = true;
      cancelAnimationFrame(raf);
      clearTimeout(backstop);
      layer.remove();
      resolve();
    };
    const tick = () => {
      raf = 0;
      const k = Math.floor((performance.now() - t0) / ms);
      if (k >= steps) { end(); return; }
      if (k !== shown) {
        shown = k;
        for (let j = 0; j < trail; j++) {
          const s = k - j, el = rects[j];
          if (s < 0) { el.style.display = 'none'; continue; }
          const q = at(s);
          el.style.cssText = `display:block;left:${q.x}px;top:${q.y}px;width:${q.w}px;height:${q.h}px`;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    const backstop = setTimeout(end, steps * ms + 250);
    tick();
  });
}

/** Keep Tab inside `root`; returns the keydown handler part. */
export function trapTab(root, e) {
  if (e.key !== 'Tab') return false;
  const f = Array.from(root.querySelectorAll('button, [href], [tabindex]:not([tabindex="-1"])'))
    .filter((el) => !el.disabled && el.offsetParent !== null);
  if (!f.length) { e.preventDefault(); return true; }
  const i = f.indexOf(document.activeElement);
  const next = e.shiftKey ? (i <= 0 ? f.length - 1 : i - 1) : (i === -1 || i === f.length - 1 ? 0 : i + 1);
  e.preventDefault();
  f[next].focus();
  return true;
}

/* ------------------------------------------------------------------ lite viewer */
export function createLite() {
  const mm = (q) => !!(window.matchMedia && window.matchMedia(q).matches);
  let root = null, track, countEl, nameEl, prevBtn, nextBtn, closeBtn, io = null;
  let iss = null, mode = 'spread', items = [], idx = 0, source = null, isOpen = false;
  let scrollRaf = 0, closeTimer = 0, reduced = false;
  const modal = modalState('flipbook');

  function build() {
    root = document.createElement('div');
    root.className = 'sec-lite';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.tabIndex = -1;
    root.innerHTML = `
      <div class="sec-lite__bar">
        <span class="sec-lite__name"></span>
        <button type="button" class="sec-lite__close" data-cursor="close">CLOSE</button>
      </div>
      <div class="sec-lite__track" tabindex="0" aria-label="Magazine pages"></div>
      <div class="sec-lite__nav">
        <button type="button" class="sec-lite__prev" aria-label="Previous pages">&lt;</button>
        <span class="sec-lite__count" aria-live="polite"></span>
        <button type="button" class="sec-lite__next" aria-label="Next pages">&gt;</button>
      </div>`;
    track = root.querySelector('.sec-lite__track');
    countEl = root.querySelector('.sec-lite__count');
    nameEl = root.querySelector('.sec-lite__name');
    prevBtn = root.querySelector('.sec-lite__prev');
    nextBtn = root.querySelector('.sec-lite__next');
    closeBtn = root.querySelector('.sec-lite__close');
    closeBtn.addEventListener('click', close);
    prevBtn.addEventListener('click', () => go(idx - 1));
    nextBtn.addEventListener('click', () => go(idx + 1));
    root.addEventListener('keydown', onKey);
    track.addEventListener('scroll', () => {
      if (!scrollRaf) scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; sync(); });
    }, { passive: true });
    track.addEventListener('click', onTrackClick);
    document.body.appendChild(root);
  }

  function pageEl(n) {
    const page = document.createElement('div');
    page.className = 'sec-lite__page';
    if (!n) { page.classList.add('is-blank'); return page; }
    const a = atlasCss(iss, n);
    page.style.backgroundImage = `url("${atlasSrc(iss)}")`;
    page.style.backgroundSize = a.size;
    page.style.backgroundPosition = a.pos;
    const img = document.createElement('img');
    img.alt = `Security Issue ${iss.id}, page ${n}`;
    img.decoding = 'async';
    img.dataset.src = pageSrc(iss, n);
    img.addEventListener('load', () => img.classList.add('is-loaded'));
    page.appendChild(img);
    return page;
  }

  function fill() {
    track.textContent = '';
    io && io.disconnect();
    items = [];
    const asp = iss.w / iss.h;
    const add = (pages, label) => {
      const item = document.createElement('div');
      item.className = 'sec-lite__item';
      item.setAttribute('role', 'group');
      item.setAttribute('aria-roledescription', 'slide');
      item.setAttribute('aria-label', label);
      const spread = document.createElement('div');
      spread.className = 'sec-lite__spread';
      const shown = pages.filter(Boolean).length;
      spread.style.setProperty('--a', String(asp * Math.max(1, shown)));
      pages.forEach((n) => { if (n) spread.appendChild(pageEl(n)); });
      item.appendChild(spread);
      track.appendChild(item);
      items.push(item);
    };
    if (mode === 'page') {
      for (let n = 1; n <= iss.pages; n++) add([n], `Page ${n} of ${iss.pages}`);
    } else {
      for (let k = 0; k < spreadCount(iss); k++) add(spreadPages(iss, k), `Pages ${rangeLabel(iss, k)} of ${iss.pages}`);
    }
    io = new IntersectionObserver((entries) => {
      entries.forEach((en) => {
        if (!en.isIntersecting) return;
        en.target.querySelectorAll('img[data-src]').forEach((img) => { img.src = img.dataset.src; img.removeAttribute('data-src'); });
        io.unobserve(en.target);
      });
    }, { root: track, rootMargin: '0px 200% 0px 200%' });
    items.forEach((it) => io.observe(it));
  }

  const width = () => track.clientWidth || window.innerWidth;
  function sync() {
    const i = Math.max(0, Math.min(items.length - 1, Math.round(track.scrollLeft / width())));
    if (i !== idx || !countEl.textContent) {
      idx = i;
      countEl.textContent = mode === 'page'
        ? `ISSUE ${iss.id} · ${idx + 1} / ${iss.pages}`
        : counterText(iss, idx);
    }
    prevBtn.disabled = idx <= 0;
    nextBtn.disabled = idx >= items.length - 1;
  }

  function go(i, instant) {
    i = Math.max(0, Math.min(items.length - 1, i));
    track.scrollTo({ left: i * width(), behavior: instant || reduced ? 'auto' : 'smooth' });
    if (instant) sync();
  }

  function onTrackClick(e) {
    if (mode !== 'spread') return;
    const r = track.getBoundingClientRect();
    go(idx + (e.clientX > r.left + r.width / 2 ? 1 : -1));
  }

  function onKey(e) {
    if (trapTab(root, e)) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); go(idx + 1); }
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); go(idx - 1); }
    else if (e.key === 'Home') { e.preventDefault(); go(0); }
    else if (e.key === 'End') { e.preventDefault(); go(items.length - 1); }
  }

  /** open({ iss, spread, el }) */
  function open(entry) {
    if (!root) build();
    clearTimeout(closeTimer);
    reduced = mm('(prefers-reduced-motion: reduce)');
    const nextMode = mm('(max-width: 700px)') ? 'page' : 'spread';
    if (entry.iss !== iss || nextMode !== mode || !items.length) { iss = entry.iss; mode = nextMode; fill(); }
    source = entry.el || null;
    nameEl.textContent = issueName(iss);
    root.setAttribute('aria-label', `Security Issue ${iss.id}, ${titleCase(iss.title)}`);
    root.classList.toggle('is-reduced', reduced);
    root.classList.add('is-mounted');
    modal.on();
    isOpen = true;
    const k = entry.spread || 0;
    const start = mode === 'page' ? Math.max(0, (k === 0 ? 1 : 2 * k) - 1) : k;
    countEl.textContent = '';
    go(start, true);
    // eager-load the visible item (IO is async)
    items[start] && items[start].querySelectorAll('img[data-src]').forEach((img) => { img.src = img.dataset.src; img.removeAttribute('data-src'); });
    root.focus({ preventScroll: true });
    if (reduced) root.classList.add('is-open');
    else requestAnimationFrame(() => requestAnimationFrame(() => root.classList.add('is-open')));
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    root.classList.remove('is-open');
    const done = () => {
      root.classList.remove('is-mounted');
      modal.off();
      if (source && source.isConnected) source.focus({ preventScroll: true });
    };
    if (reduced) done(); else closeTimer = setTimeout(done, 220);
  }

  return {
    open, close,
    get isOpen() { return isOpen; },
    get index() { return idx; },
    destroy() { close(); io && io.disconnect(); root && root.remove(); root = null; },
  };
}

/* ------------------------------------------------------------------ lite mount */
export async function mount() {
  try {
    if (!document.querySelector('.security-page .sec-issue')) return;
    const lite = createLite();
    // Phone (no WebGL): the viewer zooms out of the tapped cover / scan like the GL reader does (fx/m-flipbook.js).
    const phone = document.documentElement.classList.contains('fx-phone');
    let opening = false;
    const open = async (entry) => {
      if (!phone) { lite.open(entry); return; }
      if (opening || lite.isOpen) return;
      opening = true;
      try { await zoomRects(rectOf(entry.el), { x: 0, y: 0, w: innerWidth, h: innerHeight }); } finally { opening = false; }
      lite.open(entry);
    };
    const wiring = wireEntries({ open });
    return { lite, destroy() { wiring.destroy(); lite.destroy(); } };
  } catch (err) {
    console.warn('[fx] flipbook-lite', err);
  }
}
