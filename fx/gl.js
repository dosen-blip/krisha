/*
 * fx/gl.js — shared core for KRISHA's effects layer. No dependencies; three is passed in.
 *
 * Contract every feature module relies on:
 *   gate()            -> { ok, reason }   may the WebGL layer run on this device/page?
 *   loadThree()       -> Promise<THREE>   vendored r170 via the import map ("three")
 *   createView(opts)  -> view            one renderer + canvas with resize, idle loop, offscreen/hidden
 *                                         pause, frame-rate watchdog and context-loss handling
 *   scroll, pointer   shared, smoothed native scroll + pointer trackers (subscribe(fn) -> unsubscribe)
 *   motionOK, finePointer, INK            small shared constants
 *
 * Rules (see fx/README.md): blue ink on white, never additive glow on white; the static page is the
 * fallback; never block first paint; never throw out of mount().
 */

export const INK = '#000ca9';      // KRISHA blue (logo / cursor / nav name)
export const INK_BRIGHT = '#0900ff'; // link blue ("NEXT PROJECT>")

const mm = (q) => !!(window.matchMedia && window.matchMedia(q).matches);
export const motionOK = !mm('(prefers-reduced-motion: reduce)');
export const finePointer = mm('(pointer: fine)');
/** True on the <=700px breakpoint (mobile --m layouts). Decided once at load, like the layouts' first paint. */
export const isPhone = document.documentElement.classList.contains('fx-phone');
export const glFlag = document.documentElement.dataset.fxGlFlag || 'auto';

/* ------------------------------------------------------------------ gate */
let gateResult = null;
export function gate() {
  if (gateResult) return gateResult;
  const html = document.documentElement;
  const done = (ok, reason) => {
    gateResult = { ok, reason };
    html.classList.toggle('fx-gl', ok);
    html.dataset.fxGl = ok ? 'live' : `off:${reason}`;
    return gateResult;
  };
  if (glFlag === 'off') return done(false, 'flag-off');
  const force = glFlag === 'force';
  if (!force && !html.classList.contains('fx-gl-candidate')) return done(false, 'not-candidate');
  if (!force && navigator.deviceMemory && navigator.deviceMemory < 3) return done(false, 'low-memory');
  try {
    const c = document.createElement('canvas');
    const ctx = c.getContext('webgl2', { failIfMajorPerformanceCaveat: !force });
    if (!ctx) return done(false, 'no-webgl2');
    ctx.getExtension('WEBGL_lose_context')?.loseContext();
  } catch (e) {
    return done(false, 'probe-error');
  }
  return done(true, force ? 'forced' : 'ok');
}

/* ------------------------------------------------------------ three */
let threePromise = null;
export function loadThree() {
  if (!threePromise) threePromise = import('three');
  return threePromise;
}

/* ------------------------------------------------------------ view */
/**
 * createView({
 *   THREE,                         required
 *   host,                          element the canvas is appended to (sized by CSS); or pass `canvas`
 *   canvas,                        optional existing canvas
 *   observe = host,                element whose visibility pauses the loop (IntersectionObserver)
 *   alpha = true, antialias = true,
 *   dprMax = 1.75, pixelBudget = 4.5e6,   DPR cap and max drawing-buffer pixels
 *   onResize({ width, height, dpr }),
 *   onFrame(dt, t) -> boolean      return true while animating; false lets the loop idle
 *   onFail(reason)                 called once if the view gives up (slow / context-lost); view is destroyed
 *   watchdog = true,
 * }) -> { THREE, renderer, canvas, size, wake(ms), invalidate(), setPaused(bool), destroy(), destroyed }
 *
 * Loop model: renders a frame when (a) invalidate() was called, (b) wake(ms) window is open, or
 * (c) the previous onFrame returned true. Otherwise rAF stops entirely (idle = zero cost).
 */
export function createView(opts) {
  const {
    THREE, host, observe = host, alpha = true, antialias = true,
    dprMax = 1.75, pixelBudget = 4.5e6, onResize, onFrame, onFail, watchdog = true,
  } = opts;
  if (!THREE) throw new Error('createView needs THREE');

  const canvas = opts.canvas || document.createElement('canvas');
  const ownCanvas = !opts.canvas;
  if (ownCanvas) {
    canvas.className = opts.className || 'fx-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    host.appendChild(canvas);
  }

  const renderer = new THREE.WebGLRenderer({
    canvas, alpha, antialias, premultipliedAlpha: true, powerPreference: 'high-performance',
    stencil: false,
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0x000000, 0);

  const view = {
    THREE, renderer, canvas, destroyed: false,
    size: { width: 1, height: 1, dpr: 1 },
    dprScale: 1,
  };

  let raf = 0, last = 0, wakeUntil = 0, requested = true, animating = false;
  let visible = true, paused = false, failed = false;

  const computeDpr = (w, h) => {
    let dpr = Math.min(window.devicePixelRatio || 1, dprMax) * view.dprScale;
    const px = w * h * dpr * dpr;
    if (px > pixelBudget) dpr *= Math.sqrt(pixelBudget / px);
    return Math.max(0.5, dpr);
  };

  const resize = () => {
    if (view.destroyed) return;
    const el = ownCanvas ? host : canvas;
    const w = Math.max(1, Math.round(el.clientWidth));
    const h = Math.max(1, Math.round(el.clientHeight));
    const dpr = computeDpr(w, h);
    if (w === view.size.width && h === view.size.height && dpr === view.size.dpr) return;
    view.size = { width: w, height: h, dpr };
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);
    onResize && onResize(view.size);
    view.invalidate();
  };

  // ---- frame-rate watchdog: steps resolution down, then gives up
  const wd = { samples: [], warm: 0, steps: 0 };
  const watch = (dt) => {
    if (!watchdog || dt <= 0) return;
    if (wd.warm < 1.5) { wd.warm += dt; return; }       // ignore start-up hitches
    wd.samples.push(dt);
    if (wd.samples.length < 45) return;
    const avg = wd.samples.reduce((a, b) => a + b, 0) / wd.samples.length;
    wd.samples.length = 0;
    if (avg > 1 / 38) {
      if (wd.steps < 2) {
        wd.steps++; view.dprScale *= 0.75; view.size.dpr = 0; resize(); wd.warm = 0.5;
      } else if (avg > 1 / 22) {
        fail('slow');
      }
    }
  };

  const tick = (now) => {
    raf = 0;
    if (view.destroyed) return;
    const t = now / 1000;
    const dt = last ? Math.min(0.1, t - last) : 1 / 60;
    last = t;
    const live = !paused && visible && !document.hidden;
    if (!live) { last = 0; return; }        // resumes via visibility/IO callbacks
    requested = false;
    animating = !!(onFrame && onFrame(dt, t));
    if (animating || performance.now() < wakeUntil) watch(dt); else wd.samples.length = 0;
    schedule();
  };

  const schedule = () => {
    if (raf || view.destroyed) return;
    if (!(requested || animating || performance.now() < wakeUntil)) { last = 0; return; }
    if (paused || !visible || document.hidden) return;
    raf = requestAnimationFrame(tick);
  };

  view.invalidate = () => { requested = true; schedule(); };
  view.wake = (ms = 1000) => { wakeUntil = Math.max(wakeUntil, performance.now() + ms); schedule(); };
  view.setPaused = (p) => { paused = !!p; if (!paused) view.invalidate(); };

  const ro = new ResizeObserver(resize);
  ro.observe(ownCanvas ? host : canvas);
  let io = null;
  if (observe && 'IntersectionObserver' in window) {
    io = new IntersectionObserver((entries) => {
      visible = entries[entries.length - 1].isIntersecting;
      if (visible) view.invalidate();
    }, { rootMargin: '10% 0px' });
    io.observe(observe);
  }
  const onVis = () => { if (!document.hidden) view.invalidate(); };
  document.addEventListener('visibilitychange', onVis);

  const onLost = (e) => { e.preventDefault(); fail('context-lost'); };
  canvas.addEventListener('webglcontextlost', onLost);

  function fail(reason) {
    if (failed) return;
    failed = true;
    console.warn('[fx] view gave up:', reason);
    view.destroy();
    onFail && onFail(reason);
  }

  view.destroy = () => {
    if (view.destroyed) return;
    view.destroyed = true;
    if (raf) cancelAnimationFrame(raf);
    ro.disconnect();
    io && io.disconnect();
    document.removeEventListener('visibilitychange', onVis);
    canvas.removeEventListener('webglcontextlost', onLost);
    try {
      const ctx = renderer.getContext();
      renderer.dispose();
      if (ctx && !ctx.isContextLost()) renderer.forceContextLoss();
    } catch (e) { /* already gone */ }
    if (ownCanvas) canvas.remove();
  };

  resize();
  return view;
}

/* ------------------------------------------------------------ helpers */

/** Rect of `el` relative to the top-left of `ref` (both via getBoundingClientRect). */
export function relRect(el, ref) {
  const a = el.getBoundingClientRect();
  const b = ref ? ref.getBoundingClientRect() : { left: 0, top: 0 };
  return { x: a.left - b.left, y: a.top - b.top, width: a.width, height: a.height };
}

/** Frame-rate independent exponential approach: x += (target - x) * damp(rate, dt). */
export const damp = (rate, dt) => 1 - Math.exp(-rate * dt);

function tracker(init) {
  const subs = new Set();
  const state = { ...init };
  state.subscribe = (fn) => { subs.add(fn); return () => subs.delete(fn); };
  state._emit = () => subs.forEach((fn) => { try { fn(state); } catch (e) { console.warn('[fx]', e); } });
  return state;
}

/** Native scroll tracker: y, velocity (px/s, signed, smoothed), progress 0..1. */
export const scroll = tracker({ y: window.scrollY, velocity: 0, progress: 0 });
{
  let lastY = window.scrollY, lastT = performance.now(), decayRaf = 0;
  const limit = () => Math.max(1, document.documentElement.scrollHeight - innerHeight);
  const decay = () => {
    decayRaf = 0;
    if (performance.now() - lastT > 80) {
      scroll.velocity *= 0.85;
      if (Math.abs(scroll.velocity) < 5) scroll.velocity = 0;
      scroll._emit();
    }
    if (scroll.velocity !== 0) decayRaf = requestAnimationFrame(decay);
  };
  addEventListener('scroll', () => {
    const now = performance.now();
    const dt = Math.max(1, now - lastT) / 1000;
    const v = (window.scrollY - lastY) / dt;
    scroll.velocity = scroll.velocity * 0.6 + v * 0.4;
    scroll.y = window.scrollY;
    scroll.progress = scroll.y / limit();
    lastY = window.scrollY; lastT = now;
    scroll._emit();
    if (!decayRaf) decayRaf = requestAnimationFrame(decay);
  }, { passive: true });
}

/** Pointer tracker (mouse/pen only): client x/y, normalised nx/ny (-1..1), velocity px/s. */
export const pointer = tracker({ x: innerWidth / 2, y: innerHeight / 2, nx: 0, ny: 0, vx: 0, vy: 0, active: false });
{
  let lt = performance.now();
  addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') return;
    const now = performance.now();
    const dt = Math.max(1, now - lt) / 1000;
    pointer.vx = pointer.vx * 0.4 + ((e.clientX - pointer.x) / dt) * 0.6;
    pointer.vy = pointer.vy * 0.4 + ((e.clientY - pointer.y) / dt) * 0.6;
    pointer.x = e.clientX; pointer.y = e.clientY;
    pointer.nx = (e.clientX / innerWidth) * 2 - 1;
    pointer.ny = (e.clientY / innerHeight) * 2 - 1;
    pointer.active = true;
    lt = now;
    pointer._emit();
  }, { passive: true });
  document.addEventListener('pointerleave', () => { pointer.active = false; pointer._emit(); });
}
