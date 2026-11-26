/*
 * fx/cursor-fx.js — KRISHA cursor (fine pointers only; non-GL; loaded on every page by boot.js).
 *
 * Replaces the CSS data-URI dot (cursor.css, the no-JS fallback) with a DOM cursor once the mouse moves:
 *   - main dot: exactly on the pointer, no lag (13px; 18px over links/buttons). Size changes are hard switches.
 *   - pointer trails, the Windows 98 way: GHOSTS snapshots of past pointer positions, re-sampled on a fixed
 *     step (STEP_MS, ~2 frames at 60Hz). Each older ghost is smaller/lighter by a fixed step (CSS). No easing:
 *     the ghosts jump from sample to sample. When the pointer stops the samples repeat every frame, so the
 *     trail folds onto the dot in a few frames, and the loop stops once every sample equals the pointer.
 *   - data-cursor hints: drag -> the animated .ani pixel arrow (cursorImages/krisha/frame-00..05), its trail
 *     made of mini copies of the arrow; view/play/close -> dot + a tiny Win-style tooltip ("VIEW" / "PLAY" /
 *     "CLOSE") that appears TIP_DELAY ms after the hover starts, hard on/off; pressing dismisses it.
 *   - hidden when the pointer leaves the window, over text fields (native caret) and while something is in the
 *     browser top layer (fullscreen / modal dialog), where the fallback CSS cursor comes back
 *   - reduced motion: no trails, no arrow animation; states and the tooltip still switch
 */

const LABELS = { view: 'VIEW', play: 'PLAY', close: 'CLOSE' };
const HINTS = new Set(['drag', 'view', 'play', 'close']);

const GHOSTS = 4;        // trail length (ghost k shows the sample taken k steps ago)
const STEP_MS = 32;      // sampling step while the pointer moves (~2 frames at 60Hz)
const SETTLE_MS = 16;    // once it stops: every frame, so the trail folds in quickly
const TIP_DELAY = 120;   // tooltip hover delay (ms)

// Same set the CSS fallback grows over.
const INTERACTIVE = [
  'a', 'button:not(:disabled)', 'input:not(:disabled)', 'select:not(:disabled)', 'textarea', 'summary', 'label',
  '[role="button"]', '[role="link"]', '[tabindex]:not([tabindex="-1"])',
].join(',');
const TEXTY = [
  'textarea', '[contenteditable]:not([contenteditable="false"])',
  'input:not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="image"]):not([type="checkbox"])' +
    ':not([type="radio"]):not([type="range"]):not([type="color"]):not([type="file"]):not([type="hidden"])',
].join(',');

const FRAMES = Array.from({ length: 6 }, (_, i) => new URL(`../cursorImages/krisha/frame-0${i}.png`, import.meta.url).href);

export async function mount({ core }) {
  const html = document.documentElement;
  const mq = (q) => !!(window.matchMedia && window.matchMedia(q).matches);
  if (!core.finePointer || !mq('(hover: hover)')) return;

  const still = !core.motionOK;
  const cleanups = [];
  const on = (target, type, fn, opts) => {
    target.addEventListener(type, fn, opts);
    cleanups.push(() => target.removeEventListener(type, fn, opts));
  };

  // ---------------------------------------------------------------- DOM
  const root = document.createElement('div');
  root.className = 'kcur' + (still ? ' is-still' : '');
  root.setAttribute('aria-hidden', 'true');
  root.dataset.state = 'default';
  // Oldest ghost first so younger ones paint on top; the main cursor paints over all of them.
  let ghostHtml = '';
  if (!still) for (let k = GHOSTS; k >= 1; k -= 1) ghostHtml += `<i class="kcur__ghost kcur__ghost--${k}"><i></i></i>`;
  root.innerHTML =
    ghostHtml +
    '<div class="kcur__main">' +
    '<div class="kcur__body"><i class="kcur__dot"></i><i class="kcur__arrow"><i></i></i></div>' +
    '<b class="kcur__tip"></b>' +
    '</div>';
  const main = root.querySelector('.kcur__main');
  const tip = root.querySelector('.kcur__tip');
  const ghosts = [];
  // DOM order is ghost--GHOSTS ... ghost--1; ghosts[k - 1] is the ghost of age k.
  root.querySelectorAll('.kcur__ghost').forEach((el, i) => { ghosts[GHOSTS - 1 - i] = { el, vis: true, x: NaN, y: NaN }; });
  // On <html>, not <body>: a transform/filter on body (page transitions) must not capture position: fixed.
  html.appendChild(root);

  buildArrowSprites(root);

  // ---------------------------------------------------------------- state
  let live = false;        // html.krisha-cursor-fx is set (native cursor hidden)
  let shown = false;
  let topLayer = false;
  let lastTarget = null;
  let state = 'default';
  const target = { x: -100, y: -100 };
  // hist[0] = newest sample ... hist[GHOSTS] = oldest; ghost k draws hist[k].
  const hist = Array.from({ length: GHOSTS + 1 }, () => ({ x: -100, y: -100 }));
  let raf = 0, lastSample = 0;

  const setLive = (v) => {
    if (v === live) return;
    live = v;
    html.classList.toggle('krisha-cursor-fx', v);
  };
  const setShown = (v) => {
    if (v === shown) return;
    shown = v;
    root.classList.toggle('is-on', v);
    setTip(v ? LABELS[state] : '');
  };

  // ---------------------------------------------------------------- tooltip
  let tipTimer = 0, tipOn = false;
  function setTip(text) {
    clearTimeout(tipTimer);
    if (!text) {
      if (tipOn) { tipOn = false; root.classList.remove('is-tip'); }
      return;
    }
    tip.textContent = text;
    if (tipOn) return;                                  // already up: swap the text, no second delay
    tipTimer = setTimeout(() => { tipOn = true; root.classList.add('is-tip'); }, TIP_DELAY);
  }

  // ---------------------------------------------------------------- pointer trails
  const same = (a, b) => a.x === b.x && a.y === b.y;

  const paintGhosts = () => {
    for (let k = 1; k <= GHOSTS; k += 1) {
      const g = ghosts[k - 1], p = hist[k];
      // Collapsed onto the pointer, or stacked on a younger ghost: hidden (no darker double-stacks).
      const vis = !same(p, target) && !same(p, hist[k - 1]);
      if (vis !== g.vis) { g.vis = vis; g.el.style.visibility = vis ? '' : 'hidden'; }
      if (vis && (p.x !== g.x || p.y !== g.y)) {
        g.x = p.x; g.y = p.y;
        g.el.style.transform = `translate3d(${p.x}px, ${p.y}px, 0)`;
      }
    }
  };

  const sample = () => {
    const s = hist.pop();
    s.x = target.x; s.y = target.y;
    hist.unshift(s);
  };

  const tick = (now) => {
    raf = 0;
    const step = same(hist[0], target) ? SETTLE_MS : STEP_MS;
    if (now - lastSample >= step - 2) {                 // -2: tolerate rAF jitter at 60Hz
      lastSample = now;
      sample();
      paintGhosts();
    }
    if (hist.every((p) => same(p, target))) { lastSample = 0; return; }   // settled: loop stops
    raf = requestAnimationFrame(tick);
  };
  const kick = () => { if (!still && !raf) raf = requestAnimationFrame(tick); };
  const snapTrail = () => {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    lastSample = 0;
    hist.forEach((p) => { p.x = target.x; p.y = target.y; });
    if (!still) paintGhosts();
  };

  // ---------------------------------------------------------------- states
  const inTopLayer = () => {
    if (document.fullscreenElement || document.webkitFullscreenElement) return true;
    try { return !!document.querySelector(':modal'); } catch (e) { return false; }
  };

  const resolve = (el) => {
    if (!el || el.nodeType !== 1) return 'default';
    if (el.closest(TEXTY)) return 'text';
    const hintEl = el.closest('[data-cursor]');
    const hint = hintEl && hintEl.getAttribute('data-cursor');
    const linkEl = el.closest(INTERACTIVE);
    // The nearer of the two wins (a close button inside a drag surface reads as a link).
    if (hintEl && HINTS.has(hint) && !(linkEl && linkEl !== hintEl && hintEl.contains(linkEl))) return hint;
    if (linkEl) return 'link';
    return 'default';
  };

  const setState = (next) => {
    if (next === state) return;
    state = next;
    root.dataset.state = next;
    setTip(shown ? LABELS[next] : '');
  };

  const evaluate = (el) => {
    lastTarget = el;
    topLayer = inTopLayer();
    if (topLayer) { setLive(false); setShown(false); return; }
    setState(resolve(el));
  };

  const reevaluate = () => {
    if (!shown && !topLayer) return;
    const el = document.elementFromPoint(target.x, target.y);
    evaluate(el);
    if (!topLayer && el) { setLive(true); setShown(true); }
  };

  // ---------------------------------------------------------------- input
  on(window, 'pointermove', (e) => {
    if (e.pointerType === 'touch') return;
    const wasShown = shown;
    target.x = Math.round(e.clientX); target.y = Math.round(e.clientY);
    if (e.target !== lastTarget || topLayer) evaluate(e.target);
    if (topLayer) return;
    main.style.transform = `translate3d(${target.x}px, ${target.y}px, 0)`;
    setLive(true);
    if (!wasShown) { snapTrail(); setShown(true); } else kick();
  }, { passive: true });

  // Hover can change under a still pointer (pointerover fires on DOM changes under it).
  on(window, 'pointerover', (e) => {
    if (e.pointerType === 'touch' || !shown) return;
    evaluate(e.target);
  }, { passive: true });

  on(document, 'mouseout', (e) => {
    if (!e.relatedTarget) setShown(false);           // left the window (or into an iframe)
  });

  let releaseAt = 0, releaseTimer = 0;
  on(window, 'pointerdown', (e) => {
    if (e.pointerType === 'touch') { setShown(false); return; }
    clearTimeout(releaseTimer);
    releaseAt = performance.now() + 110;              // keep the press visible even on a fast click
    root.classList.add('is-down');
    setTip('');                                       // a click dismisses the tooltip, like Windows
  }, { passive: true });
  const release = () => {
    clearTimeout(releaseTimer);
    releaseTimer = setTimeout(() => root.classList.remove('is-down'), Math.max(0, releaseAt - performance.now()));
  };
  on(window, 'pointerup', release, { passive: true });
  on(window, 'pointercancel', release, { passive: true });

  // Content moving under a still pointer: re-read what is under it.
  let scrollRaf = 0;
  on(window, 'scroll', () => {
    if (scrollRaf || !shown) return;
    scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; reevaluate(); });
  }, { passive: true, capture: true });

  const onFs = () => requestAnimationFrame(reevaluate);
  on(document, 'fullscreenchange', onFs);
  on(document, 'webkitfullscreenchange', onFs);

  // Modal state and data-cursor hints flipping on the element under the pointer.
  const mo = new MutationObserver(() => requestAnimationFrame(reevaluate));
  mo.observe(html, { attributes: true, attributeFilter: ['data-fx-modal'] });
  mo.observe(document.body, { attributes: true, subtree: true, attributeFilter: ['data-cursor'] });
  cleanups.push(() => mo.disconnect());

  return {
    destroy() {
      cleanups.forEach((fn) => fn());
      if (raf) cancelAnimationFrame(raf);
      clearTimeout(releaseTimer);
      clearTimeout(tipTimer);
      html.classList.remove('krisha-cursor-fx');
      root.remove();
    },
  };
}

/**
 * Packs the six 32x32 arrow frames into one 192x32 strip (so the step animation never waits on a decode) and
 * derives the 16x16 mini arrow for the drag trail from frame 0: each 2x2 block keeps its majority, outline
 * pixels win ties, so the 1px ink outline survives the halving.
 */
function buildArrowSprites(root) {
  const load = (src) => new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
  Promise.all(FRAMES.map(load)).then((imgs) => {
    const c = document.createElement('canvas');
    c.width = 192; c.height = 32;
    const g = c.getContext('2d');
    imgs.forEach((img, i) => g.drawImage(img, i * 32, 0, 32, 32));
    root.style.setProperty('--kcur-arrow', `url("${c.toDataURL('image/png')}")`);
    try { root.style.setProperty('--kcur-mini', `url("${miniArrow(g.getImageData(0, 0, 32, 32))}")`); } catch (e) { /* CSS fallback */ }
  }).catch(() => {
    root.classList.add('is-sprite-fallback');
    root.style.setProperty('--kcur-arrow', `url("${FRAMES[0]}")`);
  });
}

function miniArrow(src) {
  const c = document.createElement('canvas');
  c.width = 16; c.height = 16;
  const g = c.getContext('2d');
  const out = g.createImageData(16, 16);
  const px = (x, y) => {
    const i = (Math.min(31, y) * 32 + Math.min(31, x)) * 4;
    return [src.data[i], src.data[i + 1], src.data[i + 2], src.data[i + 3]];
  };
  for (let y = 0; y < 16; y += 1) {
    for (let x = 0; x < 16; x += 1) {
      // Block origin (1, 0): the arrow's tip column sits at x = 1 in the 32px frame.
      const block = [px(x * 2 + 1, y * 2), px(x * 2 + 2, y * 2), px(x * 2 + 1, y * 2 + 1), px(x * 2 + 2, y * 2 + 1)];
      const solid = block.filter((p) => p[3] >= 128);
      if (solid.length < 2) continue;
      const lum = (p) => p[0] + p[1] + p[2];
      const ink = solid.filter((p) => lum(p) <= 600);
      const light = solid.filter((p) => lum(p) > 600);
      const pick = ink.length >= 2 || !light.length ? ink.reduce((a, b) => (lum(b) < lum(a) ? b : a)) : light[0];
      out.data.set([pick[0], pick[1], pick[2], 255], (y * 16 + x) * 4);
    }
  }
  g.putImageData(out, 0, 0);
  return c.toDataURL('image/png');
}
