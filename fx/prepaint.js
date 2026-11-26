/*
 * fx/prepaint.js — classic (blocking) script, runs in <head> before first paint.
 *
 * GATE SECTION (owned by fx core — keep intact):
 *   Sets capability classes on <html> so CSS can decide what to show before any module loads.
 *   - fx-js            JS is running
 *   - fx-motion        user has NOT asked for reduced motion
 *   - fx-fine          primary pointer is a mouse/trackpad
 *   - fx-phone         <=700px: the mobile (--m) layouts are active; phone features load instead of desktop ones
 *   - fx-gl-candidate  device where the WebGL layer may run (final word: fx/gl.js gate())
 *   Debug: ?gl=off | ?gl=force  (remembered for the session so it survives navigation), ?gl=auto resets.
 *
 * TRANSITIONS SECTION (owned by fx/transitions.js author) — arrival cover logic lives below the gate.
 */
(function () {
  var html = document.documentElement;
  var mm = function (q) { return !!(window.matchMedia && window.matchMedia(q).matches); };

  var flag = 'auto';
  try {
    var q = new URLSearchParams(location.search).get('gl');
    if (q === 'off' || q === 'force' || q === 'auto') sessionStorage.setItem('krisha-gl', q);
    flag = sessionStorage.getItem('krisha-gl') || 'auto';
  } catch (e) { /* storage blocked: stay on auto */ }

  var motion = !mm('(prefers-reduced-motion: reduce)');
  var fine = mm('(pointer: fine)');
  var wide = mm('(min-width: 701px)');
  var saveData = !!(navigator.connection && navigator.connection.saveData);

  // Phone = the <=700px breakpoint where portfolio-pages.css switches to the --m layouts.
  var phone = !wide;

  html.classList.add('fx-js');
  if (motion) html.classList.add('fx-motion');
  if (fine) html.classList.add('fx-fine');
  if (phone) html.classList.add('fx-phone');
  // Desktop: mouse + wide. Phone: its own touch-first features (fx/m-*.js) also get WebGL when capable.
  if (flag === 'force' || (flag !== 'off' && motion && !saveData && (phone || (fine && wide)))) {
    html.classList.add('fx-gl-candidate');
  }
  html.dataset.fxGlFlag = flag;

  /* ---- TRANSITIONS SECTION (arrival cover) ---------------------------------- */
  // The page being left (fx/transitions.js) stored its click in sessionStorage 'krisha-fx-tx' {x,y,t,mode,to,w,h}.
  // A fresh (<4s) hand-off for this page, on a normal navigation (not reload / back-forward), with motion allowed:
  //   mode 'zoom' -> html.fx-tx-cover: the flat white the zoom rectangles ended on, from the very first paint
  //                  (transitions.css), with a CSS-only failsafe that drops it after 1.2s even if no module ever runs;
  //   mode 'grow' -> html.fx-tx-grow: no cover, the cross-document view transition carries the page in.
  // Either way scroll-reveal.js holds the collage back and loads it "interlaced" on krisha:arrive.
  // window.__fxTx = the hand-off (or null) for transitions.js / scroll-reveal.js; window.__fxReveal = pagereveal info.
  var HEROES = {
    'pralaya-2024.html': '.pralaya-hero',
    'ahlan-2023.html': '.ahlan-hero',
    'talisman-2026.html': '.talisman-hero',
    'when-will-you-free-me-2026.html': '.wwyfm-bg',
    'wardi-2025.html': '.wardi-bg',
    'security-magazine-2025.html': '.sec-hub__issue--00 .sec-hub__cover',
    'security-issue-00.html': '.sec-issue__cover',
    'security-issue-01.html': '.sec-issue__cover'
  };
  var here = location.pathname.split('/').pop() || 'index.html';
  var tx = null;
  try {
    var raw = sessionStorage.getItem('krisha-fx-tx');
    if (raw) { sessionStorage.removeItem('krisha-fx-tx'); tx = JSON.parse(raw); }
  } catch (e) { tx = null; }
  var navType = 'navigate';
  try {
    var entry = performance.getEntriesByType('navigation')[0];
    if (entry && entry.type) navType = entry.type;
  } catch (e) { /* old browser: assume a normal navigation */ }
  var age = tx && typeof tx.t === 'number' ? Date.now() - tx.t : Infinity;
  if (!tx || !(age > -1000 && age < 4000) || navType !== 'navigate' || (tx.to && tx.to !== here)) tx = null;
  if (tx) tx.hero = HEROES[here] || null;
  window.__fxTx = tx;
  if (tx && motion) html.classList.add(tx.mode === 'grow' ? 'fx-tx-grow' : 'fx-tx-cover');

  // Cross-document view transitions: only a fresh grow hand-off keeps one (pagereveal must be registered before the
  // first render, hence here). The morph itself is CSS (transitions.css); rec.start marks when it began.
  var revealed = false;
  window.addEventListener('pagereveal', function (e) {
    var vt = e.viewTransition, first = !revealed;
    revealed = true;
    if (first) window.__fxReveal = { vt: null, start: 0 };
    if (!vt) return;
    var quiet = function () {};
    vt.ready.catch(quiet); vt.finished.catch(quiet);
    if (vt.updateCallbackDone) vt.updateCallbackDone.catch(quiet);
    if (!(first && tx && tx.mode === 'grow' && motion)) { vt.skipTransition(); return; }
    var rec = window.__fxReveal = { vt: vt, start: 0 };
    try { vt.types.add('fx-grow'); } catch (err) { /* no types: the CSS keyed on the type stays off, plain cross-fade */ }
    vt.ready.then(function () { rec.start = performance.now(); }, quiet);
  });
})();
