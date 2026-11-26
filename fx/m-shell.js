/*
 * fx/m-shell.js — the phone shell (≤700px, html.fx-phone), on every phone page. Non-GL; boot loads it at once.
 *
 * Menu     The MENU word opens a Start menu: 1px KRISHA-blue zoom rects travel from the word to the panel's box in
 *          hard steps, the panel cuts in, then its items land one after another, each one interlaced (every 4th
 *          scanline, every 2nd, whole) with a pixel sparkle at its end (<350ms in all). Closing reverses: the panel
 *          thins out by scanlines and the rects fold back into the word (~150ms). mobile-menu.js hands its toggle
 *          here through window.__fxMenu (CLOSE label untouched: it is [open]).
 *          Pressing an item fills XP progress blocks under it from the real krisha:prefetch events (transitions
 *          prefetches on press); when the page is in, transitions' zoom-rect leave takes over (__fxTransitions.go).
 * Progress A row of XP blocks (6x3px, 2px gaps) along the bottom edge of the sticky nav fills in whole blocks with
 *          the page's scroll progress (not on index; hidden where the page hardly scrolls). Scroll-driven, no loop.
 * Touch    A tap (no scroll, no drag) collapses three 1px zoom rects onto the tap point (3 hard steps, 120ms).
 *          A long-press (450ms, still) on a page link shows a Win-style tooltip with its destination
 *          ("PAINT", "PRALAYA, 2024"…) instead of the OS callout; that press doesn't navigate.
 * Index    Tapping a landing nav word (after the glitter intro) puts an MS-Paint marching-ants selection around it
 *          while the transition starts.
 * Reduced motion: the menu opens/closes at once, no bursts, ants or progress hold; the scroll row and tooltip stay
 * (static state, nothing moves). Every overlay is pointer-events: none. Never throws out of mount().
 */
const html = document.documentElement;
const reducedMQ = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
const motionOK = () => !(reducedMQ && reducedMQ.matches);

const MENU_STEPS = 5, MENU_MS = 30;      // MENU word -> panel box: 5 hard steps (150ms)
const ITEM_MS = 24;                      // item landing grid: item i starts at step i, takes 3 steps (+1 sparkle off)
const CLOSE_MS = 25;                     // close: 2 scanline steps + 4 rect steps (150ms)
const BURST = [28, 16, 6], BURST_MS = 40;
const LONG_MS = 450, SLOP = 9;
const BLOCK = 8;                         // 6px block + 2px gap

/* ------------------------------------------------------------------ helpers */
function stepper(steps, ms, frame, done) {
  const t0 = performance.now();
  let raf = 0, shown = -1, finished = false;
  const end = () => {
    if (finished) return;
    finished = true;
    cancelAnimationFrame(raf);
    clearTimeout(backstop);
    try { done && done(); } catch (e) { /* ignore */ }
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

let layer = null;
function getLayer() {
  if (layer && layer.isConnected) return layer;
  layer = document.createElement('div');
  layer.className = 'fx-m-layer';
  layer.setAttribute('aria-hidden', 'true');
  (document.body || html).appendChild(layer);
  return layer;
}
function el(cls, parent) {
  const e = document.createElement('div');
  e.className = cls;
  (parent || getLayer()).appendChild(e);
  return e;
}
const place = (e, q) => { e.style.cssText = `display:block;left:${q.x}px;top:${q.y}px;width:${q.w}px;height:${q.h}px`; };
const rectOf = (r) => ({ x: Math.round(r.left), y: Math.round(r.top), w: Math.max(2, Math.round(r.width)), h: Math.max(2, Math.round(r.height)) });
/** step s of n-1 between boxes a and b, snapped to whole px */
function lerpBox(a, b, s, n) {
  const t = n > 1 ? s / (n - 1) : 1;
  const x = Math.round(a.x + (b.x - a.x) * t), y = Math.round(a.y + (b.y - a.y) * t);
  const r = Math.round(a.x + a.w + (b.x + b.w - a.x - a.w) * t), btm = Math.round(a.y + a.h + (b.y + b.h - a.y - a.h) * t);
  return { x, y, w: Math.max(2, r - x), h: Math.max(2, btm - y) };
}
function textBox(node) {
  try {
    const r = document.createRange();
    r.selectNodeContents(node);
    const b = r.getBoundingClientRect();
    if (b.width > 0) return b;
  } catch (e) { /* fall through */ }
  return node.getBoundingClientRect();
}

/** Same-origin .html link (what transitions animates), else null. */
function pageLink(target) {
  const a = target && target.closest ? target.closest('a[href]') : null;
  if (!a || (a.target && a.target !== '_self') || a.hasAttribute('download')) return null;
  let url;
  try { url = new URL(a.href, location.href); } catch (e) { return null; }
  if (url.origin !== location.origin || !/\.html$|\/$/.test(url.pathname)) return null;
  return { a, url };
}

const NAMES = { index: 'HOME', 'creative-direction': 'CREATIVE DIRECTION' };
function destName(url) {
  const file = (url.pathname.split('/').pop() || 'index.html').replace(/\.html$/, '') || 'index';
  if (NAMES[file]) return NAMES[file];
  const m = file.match(/^(.*)-(\d{4})$/);
  const words = (m ? m[1] : file).replace(/-/g, ' ').toUpperCase();
  return m ? `${words}, ${m[2]}` : words;
}

/* ------------------------------------------------------------------ menu: Start-menu open / close */
const menus = new WeakMap();   // details -> { state, anim, items }

function menuParts(menu) {
  const summary = menu.querySelector('summary');
  const label = summary && (summary.querySelector('.mobile-menu__label-open') || summary);
  const panel = menu.querySelector('.mobile-menu__panel');
  const items = panel ? [...panel.querySelectorAll('a')] : [];
  return { summary, label, panel, items };
}
function rec(menu) {
  let r = menus.get(menu);
  if (!r) { r = { state: menu.open ? 'open' : 'closed', anim: null, sparks: [], rects: [] }; menus.set(menu, r); }
  return r;
}
function clearMenuFx(menu, r) {
  if (r.anim) { r.anim.cancel(); r.anim = null; }
  r.rects.forEach((e) => e.remove()); r.rects = [];
  r.sparks.forEach((e) => e.remove()); r.sparks = [];
  menu.classList.remove('fx-m-opening', 'fx-m-out1', 'fx-m-out2', 'fx-m-gone');
  menuParts(menu).items.forEach((a) => a.classList.remove('fx-m-wait', 'fx-m-il1', 'fx-m-il2'));
}

function menuLayer(menu) {
  let L = menu.querySelector(':scope > .fx-m-layer--menu');
  if (!L) {
    L = document.createElement('div');
    L.className = 'fx-m-layer fx-m-layer--menu';
    L.setAttribute('aria-hidden', 'true');
    menu.appendChild(L);
  }
  return L;
}

function openMenu(menu) {
  const r = rec(menu);
  clearMenuFx(menu, r);
  menu.open = true;
  r.state = 'open';
  if (!motionOK()) return;
  const { label, panel, items } = menuParts(menu);
  if (!label || !panel) return;
  r.state = 'opening';
  menu.classList.add('fx-m-opening');
  items.forEach((a) => a.classList.add('fx-m-wait'));
  const from = rectOf(textBox(label)), to = rectOf(panel.getBoundingClientRect());
  // pad the word box a little, like a selected Start button
  from.x -= 4; from.y -= 4; from.w += 8; from.h += 8;
  r.rects = [0, 1, 2].map(() => el('fx-m-rect', menuLayer(menu)));
  // phase 1: zoom rects (MENU_MS grid)
  r.anim = stepper(MENU_STEPS, MENU_MS, (k) => {
    r.rects.forEach((e, j) => {
      const s = k - j;
      if (s < 0) { e.style.display = 'none'; return; }
      place(e, lerpBox(from, to, s, MENU_STEPS));
    });
  }, () => {
    // phase 2: the panel cuts in, the items land (ITEM_MS grid)
    r.rects.forEach((e) => e.remove()); r.rects = [];
    menu.classList.remove('fx-m-opening');
    const n = items.length;
    const sparks = items.map(() => el('fx-m-spk', menuLayer(menu)));
    r.sparks = sparks;
    r.anim = stepper(n + 3, ITEM_MS, (k) => {
      items.forEach((a, i) => {
        const s = k - i;
        a.classList.toggle('fx-m-wait', s < 0);
        a.classList.toggle('fx-m-il1', s === 0);
        a.classList.toggle('fx-m-il2', s === 1);
        const spk = sparks[i];
        if (s === 2 || s === 3) {
          if (s === 2) {
            const b = textBox(a);
            spk.style.left = `${Math.round(b.right + 7)}px`;
            spk.style.top = `${Math.round(b.top + b.height * 0.3)}px`;
          }
          spk.className = `fx-m-spk is-${s === 2 ? 'l' : 's'}`;
        } else spk.className = 'fx-m-spk';
      });
    }, () => {
      clearMenuFx(menu, r);
      r.state = 'open';
    });
  });
}

function closeMenu(menu, instant) {
  const r = rec(menu);
  clearMenuFx(menu, r);
  const done = () => { clearMenuFx(menu, r); menu.open = false; menu.classList.remove('is-closing'); r.state = 'closed'; };
  if (instant || !motionOK() || !menu.open) { done(); return; }
  const { label, panel } = menuParts(menu);
  if (!label || !panel) { done(); return; }
  r.state = 'closing';
  const from = rectOf(panel.getBoundingClientRect()), to = rectOf(textBox(label));
  to.x -= 4; to.y -= 4; to.w += 8; to.h += 8;
  r.rects = [0, 1].map(() => el('fx-m-rect', menuLayer(menu)));
  const RECT = 4;
  r.anim = stepper(2 + RECT, CLOSE_MS, (k) => {
    menu.classList.toggle('fx-m-out1', k === 0);
    menu.classList.toggle('fx-m-out2', k === 1);
    menu.classList.toggle('fx-m-gone', k >= 2);
    r.rects.forEach((e, j) => {
      const s = k - 2 - j;
      if (s < 0) { e.style.display = 'none'; return; }
      place(e, lerpBox(from, to, s, RECT));
    });
  }, done);
}

function toggleMenu(menu) {
  const r = rec(menu);
  if (r.state === 'open' || r.state === 'opening') closeMenu(menu);
  else openMenu(menu);
}

/* ------------------------------------------------------------------ menu item press: XP progress blocks, then leave */
let pressing = null;
function onPanelClick(e) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const hit = pageLink(e.target);
  const tx = window.__fxTransitions;
  if (!hit || !tx || !motionOK() || html.dataset.fxModal) return;
  if (tx.state && tx.state.leaving) return;
  e.preventDefault();
  if (pressing) return;
  const { a, url } = hit;
  const pt = e.detail === 0 || (e.clientX === 0 && e.clientY === 0)
    ? (() => { const b = a.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()
    : { x: e.clientX, y: e.clientY };

  const N = Math.max(6, Math.min(24, Math.floor((textBox(a).width + 2) / BLOCK)));
  const bar = document.createElement('span');
  bar.className = 'fx-m-bar';
  bar.setAttribute('aria-hidden', 'true');
  bar.style.width = `${N * BLOCK - 2}px`;
  const fill = document.createElement('span');
  fill.className = 'fx-m-bar__fill';
  bar.appendChild(fill);
  a.appendChild(bar);

  const key = url.origin + url.pathname + url.search;
  const same = url.pathname === location.pathname && url.search === location.search;
  const p = { loaded: 0, total: 0, done: same, failed: false };
  const take = (d) => {
    if (!d || d.href !== key) return;
    p.loaded = d.loaded || 0; p.total = d.total || 0; p.done = !!d.done; p.failed = !!d.failed;
  };
  const onPf = (ev) => take(ev.detail);
  addEventListener('krisha:prefetch', onPf);
  if (!same) { try { take(tx.prefetch(url.href)); } catch (err) { /* events still come */ } }

  const t0 = performance.now();
  let shown = 0, lastStep = t0, raf = 0, gone = false;
  const go = () => {
    if (gone) return;
    gone = true;
    cancelAnimationFrame(raf);
    clearTimeout(cap);
    removeEventListener('krisha:prefetch', onPf);
    pressing = null;
    try { tx.go(url.href, pt); } catch (err) { location.href = url.href; }
  };
  const target = (now) => {
    if (p.done || p.failed) return N;
    if (p.total > 0) return Math.min(N - 1, Math.floor((p.loaded / p.total) * N));
    return Math.min(N - 1, Math.floor((now - t0) / 70));      // no byte total: creep, the last block waits for done
  };
  const chunk = Math.max(1, Math.ceil(N / 6));                  // a full bar in ~6 hard steps when the page is in
  const tick = () => {
    raf = 0;
    const now = performance.now();
    if (now - lastStep >= 20 && shown < target(now)) {          // whole blocks per step, never a tween
      shown = Math.min(target(now), shown + chunk); lastStep = now;
      fill.style.width = `${shown * BLOCK - 2}px`;
    }
    if (shown >= N && now - lastStep >= 40) { go(); return; }
    raf = requestAnimationFrame(tick);
  };
  const cap = setTimeout(go, 1400);                             // a slow page: the leave takes over anyway
  pressing = { bar, cancel() { gone = true; cancelAnimationFrame(raf); clearTimeout(cap); removeEventListener('krisha:prefetch', onPf); bar.remove(); pressing = null; } };
  raf = requestAnimationFrame(tick);
}

/* ------------------------------------------------------------------ scroll progress row */
function mountProgress(nav) {
  const row = document.createElement('div');
  row.className = 'fx-m-prog';
  row.setAttribute('aria-hidden', 'true');
  const fill = document.createElement('div');
  fill.className = 'fx-m-prog__fill';
  row.appendChild(fill);
  nav.appendChild(row);
  let N = 0, k = -1, raf = 0;
  const measure = () => { N = Math.max(1, Math.floor((row.clientWidth + 2) / BLOCK)); };
  const update = () => {
    raf = 0;
    const se = document.scrollingElement || html;
    const max = se.scrollHeight - innerHeight;
    if (!N) measure();
    const off = max < 24;
    row.classList.toggle('is-off', off);
    const p = off ? 0 : Math.max(0, Math.min(1, (window.scrollY || se.scrollTop) / max));
    const next = p >= 0.995 ? N : Math.floor(p * N);
    if (next !== k) { k = next; fill.style.width = k > 0 ? `${k * BLOCK - 2}px` : '0px'; }
  };
  const req = () => { if (!raf) raf = requestAnimationFrame(update); };
  addEventListener('scroll', req, { passive: true });
  addEventListener('resize', () => { N = 0; k = -1; req(); }, { passive: true });
  addEventListener('load', req);
  if ('ResizeObserver' in window) { try { new ResizeObserver(req).observe(document.body); } catch (e) { /* ignore */ } }
  req();
}

/* ------------------------------------------------------------------ touch: tap burst, long-press tooltip */
function burst(x, y) {
  const L = getLayer();
  const rects = BURST.map(() => el('fx-m-rect', L));
  stepper(BURST.length, BURST_MS, (k) => {
    rects.forEach((e, j) => {
      if (j !== k && j !== k - 1) { e.style.display = 'none'; return; }      // current + one trailing
      const s = BURST[j];
      place(e, { x: Math.round(x - s / 2), y: Math.round(y - s / 2), w: s, h: s });
    });
  }, () => rects.forEach((e) => e.remove()));
}

let tip = null, tipHide = 0;
function showTip(text, x, y) {
  if (!tip || !tip.isConnected) tip = el('fx-m-tip');
  clearTimeout(tipHide);
  tip.textContent = text;
  tip.style.cssText = 'display:block;left:0;top:0;visibility:hidden';
  const w = tip.offsetWidth, h = tip.offsetHeight, W = html.clientWidth || innerWidth;
  const left = Math.max(8, Math.min(W - w - 8, Math.round(x - w / 2)));
  let top = Math.round(y - 46 - h);                    // above the fingertip
  if (top < 8) top = Math.round(y + 34);
  tip.style.cssText = `display:block;left:${left}px;top:${top}px`;
}
function hideTip(delay) {
  clearTimeout(tipHide);
  if (!tip) return;
  const off = () => { if (tip) tip.style.display = 'none'; };
  if (delay) tipHide = setTimeout(off, delay); else off();
}

function mountTouch(page) {
  let t = null;              // the current press
  let swallow = null;        // { a, until } — the click after a long-press
  let ants = null, antsTimer = 0;
  const dropAnts = () => { clearTimeout(antsTimer); if (ants) { ants.remove(); ants = null; } };

  document.addEventListener('pointerdown', (e) => {
    if (!e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
    hideTip(0);
    const link = pageLink(e.target);
    t = { id: e.pointerId, x: e.clientX, y: e.clientY, t0: performance.now(), moved: false, long: false, link, timer: 0 };
    if (link && e.pointerType !== 'mouse') {
      const cur = t;
      cur.timer = setTimeout(() => {
        if (t !== cur || cur.moved) return;
        if (html.dataset.fxModal) return;
        cur.long = true;
        dropAnts();
        showTip(destName(link.url), cur.x, cur.y);
      }, LONG_MS);
    }
    // Landing: MS-Paint selection around the tapped nav word (after the glitter intro).
    if (page === 'index' && motionOK() && link && link.a.closest('.nav')
      && !html.classList.contains('fx-arrival-run') && !html.classList.contains('fx-arrival-pending')) {
      dropAnts();
      const b = rectOf(link.a.getBoundingClientRect());
      ants = el('fx-m-ants', document.body);
      ants.innerHTML = '<i></i><i></i><i></i><i></i>';
      place(ants, { x: b.x - 5, y: b.y - 4, w: b.w + 10, h: b.h + 8 });
      antsTimer = setTimeout(dropAnts, 1600);
    }
  }, { capture: true, passive: true });

  document.addEventListener('pointermove', (e) => {
    if (!t || e.pointerId !== t.id || t.moved) return;
    if (Math.abs(e.clientX - t.x) > SLOP || Math.abs(e.clientY - t.y) > SLOP) {
      t.moved = true;
      clearTimeout(t.timer);
      if (!t.long) dropAnts();
    }
  }, { capture: true, passive: true });

  const end = (e, cancelled) => {
    if (!t || e.pointerId !== t.id) return;
    const cur = t;
    t = null;
    clearTimeout(cur.timer);
    if (cur.long) {
      hideTip(900);
      swallow = { a: cur.link.a, until: performance.now() + 800 };
      return;
    }
    if (cancelled || cur.moved) { dropAnts(); return; }
    if (performance.now() - cur.t0 < LONG_MS && motionOK() && !html.dataset.fxModal) burst(e.clientX, e.clientY);
  };
  document.addEventListener('pointerup', (e) => end(e, false), { capture: true, passive: true });
  document.addEventListener('pointercancel', (e) => end(e, true), { capture: true, passive: true });

  // A long-press is a peek, not a visit; and no OS context menu over the tooltip (Android).
  addEventListener('click', (e) => {
    if (!swallow) return;
    const s = swallow;
    swallow = null;
    if (performance.now() < s.until && s.a.contains(e.target)) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);
  addEventListener('contextmenu', (e) => {
    if ((t && t.link) || (tip && tip.style.display === 'block')) {
      if (pageLink(e.target)) e.preventDefault();
    }
  }, true);
  addEventListener('scroll', () => { if (tip && tip.style.display === 'block' && !t) hideTip(0); }, { passive: true });
  addEventListener('pageshow', (e) => { if (e.persisted) { dropAnts(); hideTip(0); } });
}

/* ------------------------------------------------------------------ mount */
export async function mount(ctx) {
  const page = (ctx && ctx.page) || 'index';
  try {
    html.classList.add('fx-m-shell');
    const mm = [...document.querySelectorAll('.mobile-menu')];
    // mobile-menu.js hands its summary toggle to us while we are mounted.
    window.__fxMenu = { handles: () => true, toggle: toggleMenu, close: (m) => closeMenu(m, true) };
    mm.forEach((menu) => {
      rec(menu);
      const panel = menu.querySelector('.mobile-menu__panel');
      if (panel) panel.addEventListener('click', onPanelClick);
    });
    addEventListener('pageshow', (e) => {
      if (!e.persisted) return;
      if (pressing) pressing.cancel();
      document.querySelectorAll('.fx-m-bar').forEach((b) => b.remove());
      mm.forEach((m) => { if (m.open) closeMenu(m, true); });
    });

    const nav = document.querySelector('.page > .nav, body > .page .nav');
    if (page !== 'index' && nav && nav.querySelector('.mobile-menu')) mountProgress(nav);

    mountTouch(page);
  } catch (err) {
    console.warn('[fx] m-shell', err);
  }
  return {
    destroy() { html.classList.remove('fx-m-shell'); if (layer) layer.remove(); delete window.__fxMenu; },
  };
}
