/*
 * fx/paint-lite.js — Paint page without WebGL (phones, weak GPUs, ?gl=off, or GL that gave up).
 *
 *  Phones (html.fx-phone, <= 700px): setupPhone()
 *  - The gallery images tilt a few degrees in CSS 3D with a soft sheen once fx/m-motion.js is live (Android at once;
 *    iOS after the KRISHA.EXE dialog, asked on the first painting tap). Rest = no transform at all.
 *  - Tap / Enter on a painting: the same viewer as fx/m-paint.js (its controller and chrome, drawn here with plain
 *    DOM): zoom rectangles, white, the image arrives in pixel blocks, caption types in; tilt turns it a few degrees
 *    with a hard-offset "edge"; tap / pinch = magnifier steps 1x 2x 4x 8x (nearest pixels at 8x); drag pans;
 *    swipe = next / previous through a Bayer dither (CSS masks); CLOSE / swipe down / Esc flies it back into its
 *    slot. The viewer sits above the sticky phone nav (z 92 > 80).
 *  Desktop without GL: setup()
 *  - Each figure tilts toward the pointer with the same sheen; click / Enter opens a plain full-screen view.
 *  Reduced motion: nothing at all (the static page stays as it is).
 */

const MOBILE_Q = '(max-width: 700px)';
const MAX_DEG = 5;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const strip = (h) => { const d = document.createElement('div'); d.innerHTML = h; return d.textContent.replace(/\s+/g, ' ').trim(); };

export async function mount({ core }) {
  try {
    if (core.isPhone) return await setupPhone(core);
    return setup(core);
  } catch (err) {
    console.warn('[fx] paint-lite failed', err);
    return null;
  }
}

function setup(core) {
  const html = document.documentElement;
  const page = document.querySelector('.paint-page');
  if (!page || !core.motionOK) return null;

  const cleanups = [];
  const on = (el, type, fn, opts) => { el.addEventListener(type, fn, opts); cleanups.push(() => el.removeEventListener(type, fn, opts)); };
  const mq = window.matchMedia(MOBILE_Q);

  /* ---------------- targets */
  const gallery = page.querySelector('.mobile-paint-gallery');
  const mobile = [];   // { el: img, fig, sheen, lines }
  if (gallery) {
    gallery.querySelectorAll('figure').forEach((fig) => {
      const cap = fig.querySelector('figcaption');
      const lines = cap ? cap.innerHTML.split(/<br\s*\/?>/i).map(strip).filter(Boolean) : [];
      fig.classList.add('fx-lite-fig');
      fig.querySelectorAll('img').forEach((img) => {
        const sheen = document.createElement('span');
        sheen.className = 'fx-lite-sheen fx-lite-tilt';
        sheen.setAttribute('aria-hidden', 'true');
        fig.append(sheen);
        img.classList.add('fx-lite-tilt');
        mobile.push({ el: img, fig, sheen, lines });
      });
    });
  }
  const desktop = [...page.querySelectorAll(':scope > .figure')].filter((f) => f.querySelector('img')).map((fig) => {
    const d = fig.dataset;
    const lines = [`${d.title || ''}${d.year ? `, ${d.year}` : ''}`, d.medium || '', d.size || ''].filter(Boolean);
    const sheen = document.createElement('span');
    sheen.className = 'fx-lite-sheen';
    sheen.setAttribute('aria-hidden', 'true');
    fig.append(sheen);
    fig.classList.add('fx-lite-tilt');
    return { el: fig, fig, sheen, lines, img: fig.querySelector('img') };
  });
  cleanups.push(() => {
    mobile.forEach((t) => { t.sheen.remove(); t.el.classList.remove('fx-lite-tilt'); t.fig.classList.remove('fx-lite-fig'); });
    desktop.forEach((t) => { clearTimeout(t.rest); t.sheen.remove(); t.el.classList.remove('fx-lite-tilt', 'is-tracking', 'is-live'); });
    if (gallery) gallery.classList.remove('fx-lite-live');
  });

  // keep each mobile sheen exactly over its image
  const placeSheens = () => {
    mobile.forEach(({ el, sheen }) => {
      const s = sheen.style;
      s.left = `${el.offsetLeft}px`; s.top = `${el.offsetTop}px`;
      s.width = `${el.offsetWidth}px`; s.height = `${el.offsetHeight}px`;
    });
  };
  if (mobile.length) {
    placeSheens();
    const ro = new ResizeObserver(placeSheens);
    ro.observe(gallery);
    mobile.forEach((t) => ro.observe(t.el));
    cleanups.push(() => ro.disconnect());
  }

  /* ---------------- a11y: paintings are buttons that open the viewer */
  const label = (lines) => lines.join('. ').toLowerCase().replace(/ x /g, ' by ');
  [...mobile, ...desktop].forEach((t) => {
    const el = t.el;
    t.prev = ['tabindex', 'role', 'aria-label', 'data-cursor'].map((a) => [a, el.getAttribute(a)]);
    el.setAttribute('tabindex', '0');
    el.setAttribute('role', 'button');
    el.setAttribute('aria-label', `${label(t.lines)}. Open painting`);
    el.setAttribute('data-cursor', 'view');
    on(el, 'click', (e) => { if (!e.defaultPrevented) openViewer(t); });
    on(el, 'keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openViewer(t); } });
  });
  cleanups.push(() => [...mobile, ...desktop].forEach((t) => t.prev.forEach(([a, v]) => (v == null ? t.el.removeAttribute(a) : t.el.setAttribute(a, v)))));

  /* ---------------- tilt: shared vars on the gallery (orientation) or per figure (pointer) */
  const setVars = (el, x, y, amt) => {
    const s = el.style;
    s.setProperty('--fx-rx', `${(-y * MAX_DEG).toFixed(2)}deg`);
    s.setProperty('--fx-ry', `${(x * MAX_DEG).toFixed(2)}deg`);
    s.setProperty('--fx-sx', `${(50 - x * 45).toFixed(1)}%`);
    s.setProperty('--fx-sy', `${(50 - y * 45).toFixed(1)}%`);
    s.setProperty('--fx-sheen', amt.toFixed(3));
  };

  // device orientation (touch devices)
  const ori = { tx: 0, ty: 0, x: 0, y: 0, base: null, raf: 0, last: 0 };
  const oriTick = (now) => {
    ori.raf = 0;
    const dt = ori.last ? Math.min(0.1, (now - ori.last) / 1000) : 1 / 60;
    ori.last = now;
    const k = core.damp(6, dt);
    ori.x += (ori.tx - ori.x) * k;
    ori.y += (ori.ty - ori.y) * k;
    if (gallery) setVars(gallery, ori.x, ori.y, clamp(Math.hypot(ori.x, ori.y) * 1.4, 0, 1));
    if (Math.abs(ori.tx - ori.x) + Math.abs(ori.ty - ori.y) > 0.002) ori.raf = requestAnimationFrame(oriTick);
    else ori.last = 0;
  };
  const onOrientation = (e) => {
    if (e.beta == null || e.gamma == null || !mq.matches || html.dataset.fxModal) return;
    let b = e.beta, g = e.gamma;
    const ang = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
    if (ang === 90) [b, g] = [-g, b];
    else if (ang === -90 || ang === 270) [b, g] = [g, -b];
    if (!ori.base) ori.base = { b, g };
    ori.base.b += (b - ori.base.b) * 0.006;      // the way you hold the phone slowly becomes "flat"
    ori.base.g += (g - ori.base.g) * 0.006;
    ori.tx = clamp((g - ori.base.g) / 18, -1, 1);
    ori.ty = clamp((b - ori.base.b) / 18, -1, 1);
    if (gallery && !gallery.classList.contains('fx-lite-live')) gallery.classList.add('fx-lite-live');
    if (!ori.raf) ori.raf = requestAnimationFrame(oriTick);
  };
  if (gallery && !core.finePointer && 'DeviceOrientationEvent' in window) {
    const DOE = window.DeviceOrientationEvent;
    if (typeof DOE.requestPermission === 'function') {
      // iOS: ask once, on the first tap; a "deny" just leaves the gallery still
      const ask = () => {
        DOE.requestPermission().then((state) => {
          if (state === 'granted') on(window, 'deviceorientation', onOrientation);
        }).catch(() => {});
      };
      on(document, 'click', ask, { once: true, capture: true });
    } else {
      on(window, 'deviceorientation', onOrientation);
    }
  }
  cleanups.push(() => ori.raf && cancelAnimationFrame(ori.raf));

  // pointer (desktop without GL; also a narrow desktop window over the mobile gallery)
  if (core.finePointer) {
    [...desktop, ...mobile].forEach((t) => {
      on(t.el, 'pointerenter', (e) => {
        if (e.pointerType === 'touch') return;
        clearTimeout(t.rest);
        t.el.classList.add('is-tracking', 'is-live');
        if (t.sheen.parentNode !== t.el) t.sheen.classList.add('is-live');
      });
      on(t.el, 'pointermove', (e) => {
        if (e.pointerType === 'touch' || html.dataset.fxModal) return;
        const r = t.el.getBoundingClientRect();
        const x = clamp(((e.clientX - r.left) / r.width) * 2 - 1, -1, 1);
        const y = clamp(((e.clientY - r.top) / r.height) * 2 - 1, -1, 1);
        // pressed toward the pointer, like a card under a fingertip
        setVars(t.el, x * 0.7, -y * 0.7, 0.85);
        if (t.sheen !== t.el && t.sheen.parentNode !== t.el) setVars(t.sheen, x * 0.7, -y * 0.7, 0.85);
      });
      on(t.el, 'pointerleave', () => {
        t.el.classList.remove('is-tracking');
        setVars(t.el, 0, 0, 0);
        if (t.sheen.parentNode !== t.el) setVars(t.sheen, 0, 0, 0);
        clearTimeout(t.rest);
        // back to no transform at all once the return has played out
        t.rest = setTimeout(() => { t.el.classList.remove('is-live'); t.sheen.classList.remove('is-live'); }, 700);
      });
    });
  }

  /* ---------------- viewer */
  let view = null;
  function openViewer(t) {
    if (view || html.dataset.fxModal) return;
    const img = t.img || t.el;
    const root = document.createElement('div');
    root.className = 'fx-paint-view';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', t.lines[0] || 'Painting');
    root.setAttribute('data-cursor', 'close');
    const big = document.createElement('img');
    big.className = 'fx-paint-view__img';
    big.src = img.currentSrc || img.src;
    big.alt = '';
    const cap = document.createElement('p');
    cap.className = 'fx-paint-view__cap';
    const [first, ...rest] = t.lines;
    const b = document.createElement('b');
    b.textContent = first || '';
    cap.append(b);
    rest.forEach((line, k) => { if (k) cap.append(document.createElement('br')); cap.append(line); });
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'fx-paint-view__close';
    btn.textContent = 'CLOSE';
    btn.setAttribute('aria-label', 'Close painting');
    root.append(big, cap, btn);
    document.body.append(root);

    const prevOverflow = html.style.overflow;
    html.style.overflow = 'hidden';
    html.dataset.fxModal = 'paint';
    page.inert = true;
    requestAnimationFrame(() => root.classList.add('is-open'));
    try { btn.focus({ preventScroll: true }); } catch (e) { /* ignore */ }

    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      else if (e.key === 'Tab') { e.preventDefault(); btn.focus({ preventScroll: true }); }
    };
    const close = () => {
      if (!view) return;
      view = null;
      document.removeEventListener('keydown', onKey, true);
      root.classList.remove('is-open');
      delete html.dataset.fxModal;
      html.style.overflow = prevOverflow;
      page.inert = false;
      try { t.el.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
      setTimeout(() => root.remove(), 260);
    };
    root.addEventListener('click', close);
    document.addEventListener('keydown', onKey, true);
    view = { close };
  }
  cleanups.push(() => view && view.close());

  return {
    destroy() { cleanups.forEach((fn) => { try { fn(); } catch (e) { /* ignore */ } }); },
  };
}

/* ================================================================== phones */

async function setupPhone(core) {
  const html = document.documentElement;
  const page = document.querySelector('.paint-page');
  const gallery = page && page.querySelector('.mobile-paint-gallery');
  if (!gallery || !core.motionOK) return null;
  const [M, MM] = await Promise.all([import('./m-paint.js?v=3'), import('./m-motion.js')]);
  const { motion, enableMotion } = MM;
  const works = M.readWorks(page);
  if (!works.length) return null;

  const cleanups = [];
  const on = (el, type, fn, opts) => { el.addEventListener(type, fn, opts); cleanups.push(() => el.removeEventListener(type, fn, opts)); };

  /* ---------------- gallery: tilt + sheen from the shared motion sensor */
  const items = [];
  works.forEach((w) => {
    w.fig.classList.add('fx-lite-fig');
    w.imgs.forEach((img) => {
      const sheen = document.createElement('span');
      sheen.className = 'fx-lite-sheen fx-lite-tilt';
      sheen.setAttribute('aria-hidden', 'true');
      w.fig.append(sheen);
      img.classList.add('fx-lite-tilt');
      items.push({ img, sheen });
    });
  });
  const placeSheens = () => items.forEach(({ img, sheen }) => {
    const s = sheen.style;
    s.left = `${img.offsetLeft}px`; s.top = `${img.offsetTop}px`;
    s.width = `${img.offsetWidth}px`; s.height = `${img.offsetHeight}px`;
  });
  placeSheens();
  const ro = new ResizeObserver(placeSheens);
  ro.observe(gallery);
  items.forEach((t) => ro.observe(t.img));
  cleanups.push(() => {
    ro.disconnect();
    items.forEach((t) => { t.sheen.remove(); t.img.classList.remove('fx-lite-tilt'); });
    works.forEach((w) => w.fig.classList.remove('fx-lite-fig', 'fx-mpaint-lifted'));
    gallery.classList.remove('fx-lite-live');
  });
  const setVars = (el, x, y, amt) => {
    const s = el.style;
    s.setProperty('--fx-rx', `${(-y * MAX_DEG).toFixed(2)}deg`);
    s.setProperty('--fx-ry', `${(x * MAX_DEG).toFixed(2)}deg`);
    s.setProperty('--fx-sx', `${(50 - x * 45).toFixed(1)}%`);
    s.setProperty('--fx-sy', `${(50 - y * 45).toFixed(1)}%`);
    s.setProperty('--fx-sheen', amt.toFixed(3));
  };
  cleanups.push(motion.subscribe((m) => {
    if (html.dataset.fxModal) return;
    const still = Math.abs(m.x) + Math.abs(m.y) < 0.004;
    gallery.classList.toggle('fx-lite-live', !still);       // rest = no transform at all
    setVars(gallery, still ? 0 : m.x, still ? 0 : m.y, clamp(Math.hypot(m.x, m.y) * 1.4, 0, 1));
  }));

  /* ---------------- viewer: shared controller, DOM renderer */
  const S = M.buildShell(works.length);
  const veil = document.createElement('div');
  veil.className = 'fx-mpaint__veil';
  S.view.append(veil);
  const mkItem = () => {
    const el = document.createElement('div');
    el.className = 'fx-mpaint__item';
    el.hidden = true;
    S.view.append(el);
    return { el, panels: [], mask: '' };
  };
  const els = [mkItem(), mkItem()];
  const panelAt = (it, j) => {
    while (it.panels.length <= j) {
      const wrap = document.createElement('div');
      wrap.className = 'fx-mpaint__pn';
      const img = document.createElement('img');
      img.alt = '';
      img.decoding = 'async';
      const px = document.createElement('canvas');
      px.hidden = true;
      wrap.append(img, px);
      it.el.append(wrap);
      it.panels.push({ wrap, img, px, key: '' });
    }
    return it.panels[j];
  };
  const setMask = (el, url) => {
    if (el.style.webkitMaskImage === url || el.style.maskImage === url) return;
    el.style.webkitMaskImage = url;
    el.style.maskImage = url;
  };

  function draw(pose) {
    if (!pose) { veil.style.display = 'none'; els.forEach((e) => { e.el.hidden = true; }); return; }
    if (pose.veil <= 0) veil.style.display = 'none';
    else {
      veil.style.display = 'block';
      setMask(veil, pose.veil >= 1 ? 'none' : M.bayerMask(pose.veil));
    }
    els.forEach((E, k) => {
      const it = pose.items[k];
      if (!it) { E.el.hidden = true; return; }
      E.el.hidden = false;
      setMask(E.el, it.mask >= 1 ? 'none' : M.bayerMask(it.mask, !!it.maskInv));
      const turned = Math.abs(it.yaw) + Math.abs(it.pitch) > 1e-4;
      E.el.style.transformOrigin = `${it.gx}px ${it.gy}px`;
      E.el.style.transform = turned ? `perspective(1100px) rotateX(${(-it.pitch).toFixed(4)}rad) rotateY(${it.yaw.toFixed(4)}rad)` : '';
      E.panels.forEach((P, j) => { P.wrap.hidden = j >= it.panels.length; });
      it.panels.forEach((pp, j) => {
        const P = panelAt(E, j);
        const src = pp.pn.img.currentSrc || pp.pn.img.src;
        if (P.img.getAttribute('src') !== src) P.img.src = src;
        const c = pp.crop;
        const ws = P.wrap.style;
        ws.left = `${pp.cx - pp.w / 2}px`; ws.top = `${pp.cy - pp.h / 2}px`;
        ws.width = `${pp.w}px`; ws.height = `${pp.h}px`;
        // the edge: a hard offset in linen, as thick as the canvas, on the side the turn shows
        const d = Math.min(14, pp.depth);
        const ex = -Math.sin(it.yaw) * d * 1.6, ey = Math.sin(it.pitch) * d * 1.6;
        ws.boxShadow = turned ? `${ex.toFixed(1)}px ${ey.toFixed(1)}px 0 #d6cfc1` : '';
        const iw = pp.w / c[2], ih = pp.h / c[3];
        const is = P.img.style;
        is.width = `${iw}px`; is.height = `${ih}px`;
        is.left = `${-c[0] * iw}px`; is.top = `${-c[1] * ih}px`;
        P.wrap.classList.toggle('is-nearest', !!it.nearest);
        // interlaced pass: the visible part of the image at one canvas pixel per block
        if (it.pix > 0 && pp.pn.img.naturalWidth) {
          const cw = Math.max(1, Math.round(pp.w / it.pix)), ch = Math.max(1, Math.round(pp.h / it.pix));
          const key = `${src}|${cw}|${ch}|${c.map((v) => v.toFixed(3)).join(',')}`;
          if (P.key !== key) {
            P.key = key;
            const nw = pp.pn.img.naturalWidth, nh = pp.pn.img.naturalHeight;
            P.px.width = cw; P.px.height = ch;
            try { P.px.getContext('2d').drawImage(pp.pn.img, c[0] * nw, c[1] * nh, c[2] * nw, c[3] * nh, 0, 0, cw, ch); } catch (e) { /* ignore */ }
          }
          P.px.hidden = false;
          P.img.style.visibility = 'hidden';
        } else {
          P.px.hidden = true;
          P.img.style.visibility = '';
        }
      });
    });
  }

  let raf = 0, viewer = null;
  const tick = () => {
    raf = 0;
    if (!viewer) return;
    const { pose, busy } = viewer.frame(performance.now());
    draw(pose);
    if (busy) raf = requestAnimationFrame(tick);
  };
  const renderer = {
    request: () => { if (!raf) raf = requestAnimationFrame(tick); },
    texState: (wi) => (works[wi].imgs.every((img) => img.complete && img.naturalWidth) ? 2 : 0),
    load: (wi) => { works[wi].imgs.forEach((img) => { if (img.decode) img.decode().catch(() => {}); }); },
    show: (onOff) => { if (!onOff) draw(null); },
  };
  const lift = (wi, onOff) => {
    works[wi].fig.classList.toggle('fx-mpaint-lifted', !!onOff);
    if (onOff) { gallery.classList.remove('fx-lite-live'); setVars(gallery, 0, 0, 0); }
  };
  viewer = M.createViewer({
    works, shell: S, renderer, page,
    onLift: (wi, onOff) => lift(wi, onOff),
    onLanded: (wi) => lift(wi, false),
    onClosed: () => works.forEach((w, i) => lift(i, false)),
  });
  cleanups.push(() => { if (raf) cancelAnimationFrame(raf); viewer.destroy(); });

  /* ---------------- input on the gallery */
  let asked = false;
  const label = (lines) => lines.join('. ').toLowerCase().replace(/ x /g, ' by ');
  works.forEach((w, wi) => {
    const el = w.fig;
    const prev = ['tabindex', 'role', 'aria-label', 'aria-haspopup'].map((a) => [a, el.getAttribute(a)]);
    el.setAttribute('tabindex', '0');
    el.setAttribute('role', 'button');
    el.setAttribute('aria-label', `${label(w.lines)}. Open painting`);
    el.setAttribute('aria-haspopup', 'dialog');
    cleanups.push(() => prev.forEach(([a, v]) => (v == null ? el.removeAttribute(a) : el.setAttribute(a, v))));
    const openIt = () => {
      if (!asked) { asked = true; enableMotion({ ask: true }); }
      viewer.open(wi);
    };
    on(el, 'click', (e) => { if (!e.defaultPrevented) openIt(); });
    on(el, 'keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openIt(); } });
  });

  return {
    destroy() { cleanups.forEach((fn) => { try { fn(); } catch (e) { /* ignore */ } }); },
    open: (i) => viewer.open(i),
    close: () => viewer.close(),
    go: (d) => viewer.go(d),
    get state() { return viewer.state; },
    get index() { return viewer.index; },
    get zoom() { return viewer.zoom; },
  };
}
