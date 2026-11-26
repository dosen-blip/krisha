/*
 * fx/transitions.js — the navigation layer, in KRISHA's own system vernacular (a Y2K desktop remembered from Dubai):
 * Win98 zoom rectangles out of the page, the next page's collage loading "interlaced", the prefetch as a progress bar.
 *
 * Leave    A plain left-click (or tap, or Enter) on a same-origin .html link is held back. Zoom rectangles — 1px
 *          KRISHA-blue outlines, STEPS hard steps STEP_MS apart, no tweening between them, a short trail — travel from
 *          the clicked tile's box (or a small box at the click point for a text link) out to the whole viewport. Then a
 *          flat white cover holds while the next page loads (~300ms from the click), `krisha:leave` fires and the
 *          browser navigates. The click goes to sessionStorage ('krisha-fx-tx': { x, y, t, mode: 'zoom', to, w, h }).
 * Arrive   fx/prepaint.js (TRANSITIONS SECTION) reads that hand-off before the first paint and keeps the same white up
 *          (html.fx-tx-cover, transitions.css; a CSS-only failsafe drops it after 1.2s). Here it is dropped — no fade —
 *          once the web font is ready, and `krisha:arrive` { x, y, fromNav: true } fires in the same task:
 *          scroll-reveal.js then refines the collage from coarse pixel blocks, nearest the click first. With no
 *          hand-off it fires at once { centre, fromNav: false }. window.__fxArrived keeps the detail for late listeners.
 * Grow     Links with data-transition="grow" morph their tile's .figure into the destination hero with a cross-document
 *          View Transition (transitions.css: @view-transition, the 'fx-grow' type and the hero names). The new page
 *          cuts in at once; the tile holds inside the morph until the hero's first coarse pass covers it, and the hero
 *          refines as it lands (krisha:arrive fires when the transition starts). Ordinary navigations skip the view
 *          transition (pageswap here, pagereveal in prepaint). Without cross-document view transitions grow falls back
 *          to the zoom from the tile's box.
 * Prefetch On a 60ms pointer rest (and at once on press / focus) the page is fetched with a byte count. Progress goes out
 *          on window as `krisha:prefetch` { href, loaded, total, done, failed } (fx/nav-progress.js draws it on the nav
 *          rule). A grow link also warms its destination hero image so the morph has pixels to refine.
 * Also     bfcache restores drop the cover and fire `krisha:arrive` { restored: true }; reduced motion leaves navigation
 *          alone but still fires `krisha:arrive`; html[data-fx-modal] pauses interception.
 *
 * API: window.__fxTransitions (= window.__fx.mounted.transitions) { go(url, { x, y }), prefetch(url), state }.
 */

const html = document.documentElement;
const KEY = 'krisha-fx-tx';

const STEPS = 7;                  // zoom rectangles from the source box to the viewport (the first is the source)
const STEP_MS = 40;               // hard steps; the white cover lands at STEPS * STEP_MS (280ms)
const TRAIL = 3;                  // rectangles on screen at once: the current one and the two before it
const TEXT_BOX = { w: 22, h: 14 }; // a text link zooms out of a small box at the click point
const COVER_BUDGET = 1100;        // ms since navigation start; the CSS failsafe drops the arrival cover at 1.2s
const FONT_WAIT = 160;            // ms we hold the arrival cover for the web font at most
const GROW_MS = 760;              // keep in sync with transitions.css (::view-transition-group duration)
const INTENT_MS = 60;             // pointer must rest this long on a link before it is prefetched
const STUCK_MS = 6000;            // a leave that never unloads (stopped / failed) drops its cover after this

// Destination heroes of the grow links (also in prepaint.js and transitions.css).
const HEROES = {
  'pralaya-2024.html': '.pralaya-hero',
  'ahlan-2023.html': '.ahlan-hero',
  'talisman-2026.html': '.talisman-hero',
  'when-will-you-free-me-2026.html': '.wwyfm-bg',
  'wardi-2025.html': '.wardi-bg',
  'security-magazine-2025.html': '.sec-hub__issue--00 .sec-hub__cover',
  'security-issue-00.html': '.sec-issue__cover',
  'security-issue-01.html': '.sec-issue__cover',
};

const reducedMQ = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
const motionOK = () => !(reducedMQ && reducedMQ.matches);

/* ------------------------------------------------------------------ helpers */
const pageOf = (url) => url.pathname.split('/').pop() || 'index.html';
const viewW = () => html.clientWidth || innerWidth;
const viewH = () => html.clientHeight || innerHeight;
const centre = () => ({ x: viewW() / 2, y: viewH() / 2 });
const emit = (name, detail) => {
  try { window.dispatchEvent(new CustomEvent(name, { detail })); } catch (e) { /* ignore */ }
};

function store(rec) {
  try { sessionStorage.setItem(KEY, JSON.stringify(rec)); } catch (e) { /* navigation still works */ }
}
function unstore() {
  try { sessionStorage.removeItem(KEY); } catch (e) { /* ignore */ }
}

/** The link a click/pointer event is about, if it is one we transition: same origin, an .html page, not hash-only. */
function eligibleLink(target) {
  const a = target && target.closest ? target.closest('a[href]') : null;
  if (!a || (a.target && a.target !== '_self') || a.hasAttribute('download')) return null;
  let url;
  try { url = new URL(a.href, location.href); } catch (e) { return null; }
  if (url.origin !== location.origin) return null;              // mailto:, tel:, other sites
  if (!/\.html$|\/$/.test(url.pathname)) return null;
  if (url.pathname === location.pathname && url.search === location.search && url.hash) return null;
  return { a, url };
}

/** Run `frame(k)` for k = 0..steps-1 on a hard STEP_MS grid (rAF-polled, timer backstop for hidden tabs), then done(). */
function stepper(steps, ms, frame, done) {
  const t0 = performance.now();
  let raf = 0, shown = -1, finished = false;
  const end = () => {
    if (finished) return;
    finished = true;
    cancelAnimationFrame(raf);
    clearTimeout(backstop);
    done();
  };
  const tick = () => {
    raf = 0;
    const k = Math.floor((performance.now() - t0) / ms);
    if (k >= steps) { end(); return; }
    if (k !== shown) {
      shown = k;
      try { frame(k); } catch (e) { end(); return; }
    }
    raf = requestAnimationFrame(tick);
  };
  const backstop = setTimeout(end, steps * ms + 250);
  tick();
  return { cancel() { finished = true; cancelAnimationFrame(raf); clearTimeout(backstop); } };
}

/* ------------------------------------------------------------------ state */
const state = {
  leaving: false,        // a leave is under way: further link clicks are swallowed
  layer: null,           // the zoom / white cover layer
  leaveOrigin: null,
  leaveAnim: null,
  stuckTimer: 0,
  growFigure: null,      // the tile that carries view-transition-name during a grow
  growUrl: null,
};

function fireArrive(detail) {
  window.__fxArrived = detail;
  emit('krisha:arrive', detail);
}

/* ------------------------------------------------------------------ leave */
function canCrossDocVT() {
  return typeof window.PageSwapEvent === 'function' && typeof window.PageRevealEvent === 'function'
    && !!(window.CSS && CSS.supports && CSS.supports('view-transition-name: fx-grow'));
}

function navigate(url, origin, mode) {
  store({ x: origin.x, y: origin.y, t: Date.now(), mode, to: pageOf(url), w: viewW(), h: viewH() });
  emit('krisha:leave', { url: url.href, x: origin.x, y: origin.y, mode });
  // A navigation that never unloads this page (stopped, offline) must not leave the cover up for good.
  clearTimeout(state.stuckTimer);
  state.stuckTimer = setTimeout(() => recover(), STUCK_MS);
  location.href = url.href;
}

/** A box (viewport px) clipped to the viewport, never thinner than 2px. */
function clipBox(r) {
  const W = viewW(), H = viewH();
  const x0 = Math.max(0, Math.min(W - 2, r.x)), y0 = Math.max(0, Math.min(H - 2, r.y));
  const x1 = Math.max(x0 + 2, Math.min(W, r.x + r.w)), y1 = Math.max(y0 + 2, Math.min(H, r.y + r.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
const boxAt = (p) => clipBox({ x: p.x - TEXT_BOX.w / 2, y: p.y - TEXT_BOX.h / 2, w: TEXT_BOX.w, h: TEXT_BOX.h });
function boxOf(el) {
  const r = el && el.getBoundingClientRect();
  if (!r || r.width < 24 || r.height < 24 || r.bottom <= 0 || r.top >= viewH() || r.right <= 0 || r.left >= viewW()) return null;
  return clipBox({ x: r.left, y: r.top, w: r.width, h: r.height });
}

function leave(url, origin, from) {
  if (state.leaving) return;
  state.leaving = true;
  state.leaveOrigin = origin;
  if (!motionOK()) { navigate(url, origin, 'zoom'); return; }

  const layer = document.createElement('div');
  layer.className = 'fx-tx-zoom';
  layer.setAttribute('aria-hidden', 'true');
  const rects = [];
  for (let j = 0; j < TRAIL; j++) {
    const r = document.createElement('div');
    r.className = 'fx-tx-zoom__rect';
    layer.appendChild(r);
    rects.push(r);
  }
  (document.body || html).appendChild(layer);
  state.layer = layer;

  const W = viewW(), H = viewH();
  const a = from || boxAt(origin);
  // step s of STEPS-1: the source box at 0, the whole viewport at the end; a slight ease-in, snapped to whole px
  const at = (s) => {
    const t = Math.pow(s / (STEPS - 1), 1.3);
    const x = Math.round(a.x * (1 - t)), y = Math.round(a.y * (1 - t));
    const r = Math.round(a.x + a.w + (W - a.x - a.w) * t), b = Math.round(a.y + a.h + (H - a.y - a.h) * t);
    return { x, y, w: Math.max(2, r - x), h: Math.max(2, b - y) };
  };
  const frame = (k) => {
    for (let j = 0; j < TRAIL; j++) {
      const s = k - j, el = rects[j];
      if (s < 0) { el.style.display = 'none'; continue; }
      const q = at(s);
      el.style.cssText = `display:block;left:${q.x}px;top:${q.y}px;width:${q.w}px;height:${q.h}px`;
    }
  };
  state.leaveAnim = stepper(STEPS, STEP_MS, frame, () => {
    state.leaveAnim = null;
    rects.forEach((r) => r.remove());
    layer.classList.add('is-white');                 // flat white while the next page loads
    // let the white reach the screen before the navigation starts (the old page keeps painting until unload)
    let gone = false;
    const go = () => { if (!gone) { gone = true; navigate(url, origin, 'zoom'); } };
    requestAnimationFrame(() => setTimeout(go, 0));
    setTimeout(go, 40);
  });
}

function growTo(url, figure, origin) {
  state.leaving = true;
  state.leaveOrigin = origin;
  state.growFigure = figure;
  state.growUrl = url.href;
  figure.style.viewTransitionName = 'fx-grow';
  navigate(url, origin, 'grow');
}

/** The .figure a grow link morphs: itself, or the tile linking to the same page (for the text labels). */
function growFigureFor(a, url) {
  if (a.matches('.figure')) return a;
  const tiles = document.querySelectorAll('a.figure[href]');
  for (const t of tiles) {
    try { if (new URL(t.href, location.href).pathname === url.pathname) return t; } catch (e) { /* skip */ }
  }
  return a.querySelector('.figure, img') || null;
}

/** Where the zoom starts: a picture link's own box, else a small box at the click point. */
function sourceBox(a, origin) {
  const media = a.matches('.figure, img, video') ? a : a.querySelector('.figure, img, video');
  return boxOf(media) || boxAt(origin);
}

function onClick(e) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const hit = eligibleLink(e.target);
  if (!hit) return;
  if (html.dataset.fxModal) return;                  // a viewer is open: leave the click to it / the browser
  if (!motionOK()) return;                           // reduced motion: plain navigation
  e.preventDefault();
  if (state.leaving) return;                         // one leave at a time
  const { a, url } = hit;
  // Keyboard activation reports 0,0 (detail 0): start from the middle of the link instead.
  let origin;
  if (e.detail === 0 || (e.clientX === 0 && e.clientY === 0)) {
    const r = a.getBoundingClientRect();
    origin = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  } else {
    origin = { x: e.clientX, y: e.clientY };
  }
  if (a.dataset.transition === 'grow') {
    const fig = growFigureFor(a, url);
    const box = boxOf(fig);
    if (fig && box && canCrossDocVT()) { growTo(url, fig, origin); return; }
    if (box) { leave(url, origin, box); return; }    // fallback: zoom out of the tile
  }
  leave(url, origin, sourceBox(a, origin));
}

/** Programmatic navigation for other features: same leave as a click, from a small box at { x, y } (or the centre). */
function go(href, { x, y } = {}) {
  let url;
  try { url = new URL(href, location.href); } catch (e) { return; }
  const o = Number.isFinite(x) && Number.isFinite(y) ? { x, y } : centre();
  if (!motionOK() || url.origin !== location.origin) { location.href = url.href; return; }
  leave(url, o, boxAt(o));
}

/* old document: only a grow navigation keeps its cross-document view transition */
function onPageSwap(e) {
  const vt = e.viewTransition;
  if (!vt) return;
  const quiet = () => {};
  vt.ready.catch(quiet);
  vt.finished.catch(quiet);
  if (vt.updateCallbackDone) vt.updateCallbackDone.catch(quiet);
  let dest = null;
  try { dest = e.activation && e.activation.entry && e.activation.entry.url; } catch (err) { dest = null; }
  const isGrow = state.growUrl && dest && new URL(dest).pathname === new URL(state.growUrl).pathname
    && (!e.activation.navigationType || e.activation.navigationType === 'push' || e.activation.navigationType === 'replace');
  if (isGrow) {
    try { vt.types && vt.types.add('fx-grow'); } catch (err) { /* ignore */ }
  } else {
    vt.skipTransition();
  }
}

/* ------------------------------------------------------------------ recover (bfcache, stuck leave) */
function clearGrowName() {
  if (state.growFigure) state.growFigure.style.viewTransitionName = '';
  state.growFigure = null;
  state.growUrl = null;
}

function recover() {
  clearTimeout(state.stuckTimer);
  if (state.leaveAnim) { state.leaveAnim.cancel(); state.leaveAnim = null; }
  html.classList.remove('fx-tx-cover', 'fx-tx-grow');
  clearGrowName();
  unstore();
  if (state.layer) { state.layer.remove(); state.layer = null; }
  state.leaving = false;
}

function onPageShow(e) {
  if (!e.persisted) return;
  // Back/forward cache: this page was frozen under its own white cover. Drop it (no fade): the page is simply back.
  const o = state.leaveOrigin || centre();
  recover();
  fireArrive({ x: o.x, y: o.y, fromNav: false, restored: true });
}

/* ------------------------------------------------------------------ arrive */
function arriveOrigin(tx) {
  let x = +tx.x, y = +tx.y;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return centre();
  // a different window size (rotated phone): keep the same relative point
  const W = viewW(), H = viewH();
  if (tx.w > 0 && tx.h > 0 && (Math.abs(tx.w - W) > 2 || Math.abs(tx.h - H) > 2)) {
    x = (x / tx.w) * W;
    y = (y / tx.h) * H;
  }
  return { x: Math.max(0, Math.min(W, x)), y: Math.max(0, Math.min(H, y)) };
}

function waitFonts(ms) {
  if (!document.fonts || !document.fonts.ready || document.fonts.status === 'loaded') return Promise.resolve();
  return Promise.race([document.fonts.ready.catch(() => {}), new Promise((r) => setTimeout(r, ms))]);
}

async function arriveCovered(tx) {
  const origin = arriveOrigin(tx);
  await waitFonts(Math.max(0, Math.min(FONT_WAIT, COVER_BUDGET - performance.now())));
  // Drop the white and start the collage in the same task: text is there at once, the images refine.
  html.classList.remove('fx-tx-cover');
  fireArrive({ x: origin.x, y: origin.y, fromNav: true });
}

function arriveGrow(tx) {
  const origin = arriveOrigin(tx);
  const detail = { x: origin.x, y: origin.y, fromNav: true };
  let done = false;
  const fire = () => { if (!done) { done = true; fireArrive(detail); } };
  const end = () => html.classList.remove('fx-tx-grow');
  const handle = (rec) => {
    const vt = rec && rec.vt;
    if (!vt) { end(); fire(); return; }
    vt.ready.then(fire, fire);                       // the morph starts: the hero's first coarse pass goes in
    vt.finished.then(end, end);
    setTimeout(fire, 600);                           // whatever happens, arrive
    setTimeout(end, GROW_MS + 1200);
  };
  if (window.__fxReveal) handle(window.__fxReveal);
  else if ('onpagereveal' in window) {
    addEventListener('pagereveal', () => handle(window.__fxReveal), { once: true });
    setTimeout(() => { if (!window.__fxReveal) handle(null); }, 1200);
  } else handle(null);
}

function arrive() {
  const tx = window.__fxTx;
  if (tx && html.classList.contains('fx-tx-cover')) { arriveCovered(tx); return; }
  if (tx && html.classList.contains('fx-tx-grow')) { arriveGrow(tx); return; }
  // No transition in (direct load, reload, back/forward, reduced motion): arrive at once, from the centre.
  const fire = () => { const c = centre(); fireArrive({ x: c.x, y: c.y, fromNav: false }); };
  requestAnimationFrame(fire);
}

/* ------------------------------------------------------------------ prefetch (with a byte count) */
const prefetched = new Map();     // path+search -> { href, loaded, total, done, failed }

function report(rec) {
  emit('krisha:prefetch', { href: rec.href, loaded: rec.loaded, total: rec.total, done: rec.done, failed: rec.failed });
}

function linkPrefetch(href) {
  const l = document.createElement('link');
  l.rel = 'prefetch';
  l.href = href;
  l.dataset.fx = 'transitions';
  document.head.appendChild(l);
  return l;
}

/** Warm a grow destination's hero image (the morph refines it, so it should have pixels when the page opens). */
function warmHero(url, text) {
  const sel = HEROES[pageOf(url)];
  if (!sel || !text || !window.DOMParser) return;
  try {
    const doc = new DOMParser().parseFromString(text, 'text/html');
    const img = doc.querySelector(`${sel} img[src], img${sel}[src]`);
    if (img) new Image().src = new URL(img.getAttribute('src'), url).href;
  } catch (e) { /* only a warm-up */ }
}

function prefetch(url, { grow = false } = {}) {
  const key = url.pathname + url.search;
  if (key === location.pathname + location.search) return null;
  let rec = prefetched.get(key);
  if (rec) { report(rec); return rec; }
  rec = { href: url.origin + key, loaded: 0, total: 0, done: false, failed: false };
  prefetched.set(key, rec);
  report(rec);
  const streams = typeof window.fetch === 'function' && typeof window.ReadableStream === 'function'
    && typeof TextDecoder === 'function';
  if (!streams) {
    // no byte count here: the plain prefetch hint, done when it loads
    const l = linkPrefetch(rec.href);
    const fin = (ok) => { rec.done = ok; rec.failed = !ok; if (!ok) prefetched.delete(key); report(rec); };
    l.addEventListener('load', () => fin(true), { once: true });
    l.addEventListener('error', () => fin(false), { once: true });
    return rec;
  }
  (async () => {
    const res = await fetch(rec.href, { credentials: 'same-origin' });
    if (!res.ok || !res.body) throw new Error(String(res.status));
    // Content-Length counts encoded bytes; the stream yields decoded ones. Only trust it for identity bodies.
    const enc = (res.headers.get('content-encoding') || '').toLowerCase();
    const len = +res.headers.get('content-length') || 0;
    rec.total = !enc || enc === 'identity' ? len : 0;
    const reader = res.body.getReader();
    const dec = grow ? new TextDecoder() : null;
    let text = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rec.loaded += value.byteLength;
      if (dec) text += dec.decode(value, { stream: true });
      report(rec);
    }
    rec.done = true;
    report(rec);
    // Mark it as a prefetch for the navigation (served from the HTTP cache the fetch just filled).
    linkPrefetch(rec.href);
    if (grow) warmHero(url, text);
  })().catch(() => {
    rec.failed = true;
    prefetched.delete(key);                          // may be tried again on the next rest
    report(rec);
  });
  return rec;
}

const growLink = (a) => a.dataset.transition === 'grow';
let intentLink = null, intentTimer = 0;
function onOver(e) {
  if (e.pointerType === 'touch') return;
  const hit = eligibleLink(e.target);
  const a = hit ? hit.a : null;
  if (a === intentLink) return;
  clearTimeout(intentTimer);
  intentLink = a;
  if (hit) intentTimer = setTimeout(() => prefetch(hit.url, { grow: growLink(hit.a) }), INTENT_MS);
}
function onOut(e) {
  if (!intentLink) return;
  if (e.relatedTarget && intentLink.contains(e.relatedTarget)) return;   // still on the same link
  clearTimeout(intentTimer);
  intentLink = null;
}
function onNow(e) {
  const hit = eligibleLink(e.target);
  if (hit) prefetch(hit.url, { grow: growLink(hit.a) });
}

/* ------------------------------------------------------------------ mount */
export async function mount() {
  const api = { go, prefetch: (href) => { try { return prefetch(new URL(href, location.href)); } catch (e) { return null; } }, state };
  try {
    window.__fxTransitions = api;
    document.addEventListener('click', onClick);
    document.addEventListener('pointerover', onOver, { passive: true });
    document.addEventListener('pointerout', onOut, { passive: true });
    document.addEventListener('pointerdown', onNow, { passive: true, capture: true });
    document.addEventListener('focusin', onNow);
    addEventListener('pageswap', onPageSwap);
    addEventListener('pageshow', onPageShow);
    addEventListener('pagehide', () => clearTimeout(state.stuckTimer));
    arrive();
  } catch (err) {
    console.warn('[fx] transitions', err);
    html.classList.remove('fx-tx-cover', 'fx-tx-grow');
    if (!window.__fxArrived) { const c = centre(); fireArrive({ x: c.x, y: c.y, fromNav: false }); }
  }
  return api;
}
