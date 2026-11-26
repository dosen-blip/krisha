/*
 * fx/nav-progress.js — the 1px black rule under the desktop nav (.nav__divider) doubles as an XP-style progress bar
 * for the page prefetch.
 *
 * At rest the rule is the plain line it always was (nothing is drawn). When the pointer rests on an internal link and
 * fx/transitions.js prefetches it (`krisha:prefetch` { href, loaded, total, done, failed }), a row of discrete
 * KRISHA-blue blocks (6×3px, 2px gaps) sitting on the rule fills with the real byte count — under the hovered nav
 * item, or from the left end of the rule for any other link — and completes to a full row once the page is cached.
 * An unknown length (compressed body) fills in stepped estimates until done. Blocks never run ahead of a paced fill,
 * so even an instant (local / cached) fetch reads as a row filling. It clears when the pointer leaves the link.
 *
 * A Canvas2D strip in the nav (scrolls with it), pointer-events: none, positioned on the rule only when shown.
 * rAF runs only while blocks are being added. Desktop fine pointers only; nothing under reduced motion, while
 * html[data-fx-modal] is set, or where the rule is hidden (phones).
 */

const BLOCK_W = 6;         // CSS px
const BLOCK_H = 3;
const GAP = 2;
const PITCH = BLOCK_W + GAP;
const LIFT = 1;            // CSS px between the blocks and the rule
const MIN_BLOCKS = 3;
const ESTIMATE_STEP = 1 / 6; // unknown length: the estimate moves in sixths...
const ESTIMATE_CAP = 5 / 6;  // ...and never claims more than this before the body is in
const ESTIMATE_HALF = 260;   // ms for the estimate to reach half
const INK = '#000ca9';

const mm = (q) => !!(window.matchMedia && window.matchMedia(q).matches);

export async function mount() {
  if (mm('(prefers-reduced-motion: reduce)') || !mm('(pointer: fine)')) return null;
  const divider = document.querySelector('.nav__divider');
  const nav = divider && divider.closest('.nav');
  if (!divider || !nav) return null;

  const html = document.documentElement;
  const canvas = document.createElement('canvas');
  canvas.className = 'fx-nav-progress';
  canvas.setAttribute('aria-hidden', 'true');
  Object.assign(canvas.style, {
    position: 'absolute', left: '0px', top: '0px', width: '0px', height: '0px', margin: '0', padding: '0',
    display: 'none', pointerEvents: 'none', background: 'transparent',
  });
  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) return null;
  divider.after(canvas);

  let hovered = null;      // { a, key }  the link the pointer is on
  let bar = null;          // the row being shown
  let raf = 0, destroyed = false;

  const keyOf = (href) => {
    try { const u = new URL(href, location.href); return u.origin + u.pathname + u.search; } catch (e) { return null; }
  };

  function internalLink(target) {
    const a = target && target.closest ? target.closest('a[href]') : null;
    if (!a || (a.target && a.target !== '_self')) return null;
    let u;
    try { u = new URL(a.href, location.href); } catch (e) { return null; }
    if (u.origin !== location.origin || !/\.html$|\/$/.test(u.pathname)) return null;
    return { a, key: u.origin + u.pathname + u.search };
  }

  // Half the strip height: whole CSS px that are also whole device px, so the strip shares the rule's sub-pixel phase.
  function stripHeight(dpr) {
    for (const k of [8, 6, 10, 12, 4, 16]) if (Math.abs(k * dpr - Math.round(k * dpr)) < 0.01) return k;
    return 8;
  }

  /** Lay the strip over the rule and work out the row for link `a`; null where the rule isn't shown. */
  function place(a) {
    if (getComputedStyle(divider).display === 'none') return null;
    const dr = divider.getBoundingClientRect();
    if (dr.width < PITCH * MIN_BLOCKS) return null;
    const nr = nav.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const k = stripHeight(dpr);
    canvas.style.left = `${dr.left - nr.left - nav.clientLeft}px`;
    canvas.style.top = `${dr.top - nr.top - nav.clientTop - k}px`;
    canvas.style.width = `${dr.width}px`;
    canvas.style.height = `${k}px`;
    canvas.width = Math.max(1, Math.round(dr.width * dpr));
    canvas.height = Math.round(k * dpr);
    // any other link: a row from the left end of the rule, clear of the logo that hangs down onto it
    let x0 = 0;
    const logo = nav.querySelector('.nav__logo');
    if (logo) {
      const lr = logo.getBoundingClientRect();
      if (lr.width > 0 && lr.bottom > dr.top - k) x0 = Math.max(0, Math.ceil(lr.right - dr.left) + GAP);
    }
    let n = Math.max(MIN_BLOCKS, Math.floor((dr.width - x0 + GAP) / PITCH));
    // a nav item: a row centred under its label
    if (a.parentElement === nav) {
      const r = a.getBoundingClientRect();
      n = Math.max(MIN_BLOCKS, Math.floor((r.width + GAP) / PITCH));
      x0 = Math.round(r.left - dr.left + (r.width - (n * PITCH - GAP)) / 2);
      x0 = Math.max(0, Math.min(Math.floor(dr.width) - (n * PITCH - GAP), x0));
    }
    const bottom = Math.round((k - LIFT) * dpr);
    return { dpr, x0, n, top: bottom - Math.max(1, Math.round(BLOCK_H * dpr)), bottom, fill: 150 + n * 1.2 };
  }

  function clear() {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    if (bar) {
      bar = null;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      canvas.style.display = 'none';
    }
  }

  // Share of the page in: the real byte count, a stepped estimate when the length is unknown, all of it once cached.
  function progress(b, now) {
    const p = b.rec;
    if (p.done) return 1;
    if (p.total > 0) return Math.min(0.96, p.loaded / p.total);
    const est = 1 - Math.pow(0.5, (now - b.t0) / ESTIMATE_HALF);
    return Math.min(ESTIMATE_CAP, Math.floor(est / ESTIMATE_STEP) * ESTIMATE_STEP);
  }

  function draw(now) {
    const b = bar;
    if (!b) return false;
    if (html.dataset.fxModal) { clear(); return false; }
    const paced = Math.min(1, (now - b.t0) / b.fill);
    const target = progress(b, now);
    const count = Math.floor(Math.min(target, paced) * b.n + 1e-6);
    if (count !== b.count) {
      b.count = count;
      const { dpr, x0, top, bottom } = b.geo;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = INK;
      for (let i = 0; i < count; i++) {
        const l = Math.round((x0 + i * PITCH) * dpr), r = Math.round((x0 + i * PITCH + BLOCK_W) * dpr);
        ctx.fillRect(l, top, Math.max(1, r - l), bottom - top);
      }
    }
    // keep going while the row can still grow: pacing behind the progress, or an estimate still moving
    const waiting = !b.rec.done && !b.rec.failed && b.rec.total <= 0;
    return count < b.n && (count < Math.floor(target * b.n + 1e-6) || waiting);
  }

  function loop() {
    raf = 0;
    if (destroyed) return;
    if (draw(performance.now())) raf = requestAnimationFrame(loop);
  }
  const wake = () => { if (!raf && bar) raf = requestAnimationFrame(loop); };

  function onPrefetch(e) {
    const d = e.detail;
    if (!d || !hovered || html.dataset.fxModal) return;
    if (keyOf(d.href) !== hovered.key) return;
    if (d.failed) { clear(); return; }
    if (!bar || bar.a !== hovered.a) {
      clear();
      const geo = place(hovered.a);
      if (!geo) return;
      canvas.style.display = 'block';
      bar = { a: hovered.a, geo, n: geo.n, fill: geo.fill, t0: performance.now(), count: -1, rec: { ...d } };
    } else {
      bar.rec = { ...d };
    }
    if (draw(performance.now())) wake();
  }

  function onOver(e) {
    if (e.pointerType === 'touch') return;
    const hit = internalLink(e.target);
    if (hit && hovered && hit.a === hovered.a) return;
    if (hovered) clear();
    hovered = hit;
  }
  function onOut(e) {
    if (!hovered) return;
    if (e.relatedTarget && hovered.a.contains(e.relatedTarget)) return;   // still on the same link
    hovered = null;
    clear();
  }
  const reset = () => { hovered = null; clear(); };
  const onShow = (e) => { if (e.persisted) reset(); };

  addEventListener('krisha:prefetch', onPrefetch);
  document.addEventListener('pointerover', onOver, { passive: true });
  document.addEventListener('pointerout', onOut, { passive: true });
  document.addEventListener('pointerleave', reset);
  addEventListener('blur', reset);
  addEventListener('pageshow', onShow);

  return {
    destroy() {
      destroyed = true;
      clear();
      removeEventListener('krisha:prefetch', onPrefetch);
      document.removeEventListener('pointerover', onOver);
      document.removeEventListener('pointerout', onOut);
      document.removeEventListener('pointerleave', reset);
      removeEventListener('blur', reset);
      removeEventListener('pageshow', onShow);
      canvas.remove();
    },
  };
}
