/*
 * cursor-boot.js — classic script in <head> on every page (runs before first paint).
 *
 * 1. Cursor fallback: the CSS data-URI blue dot (same rules as cursor.css, inlined so they apply before
 *    cursor.css loads). Scoped off once fx/cursor-fx.js takes over (html.krisha-cursor-fx).
 * 2. Landing pixel glitter (fx/arrival.js): on the first index visit of the session (motion allowed) add
 *    html.fx-arrival-pending so fx/arrival.css can hide the landing words before they paint. Two
 *    independent failsafes bring them back if arrival.js never takes over: a timer here and a
 *    time-limited CSS animation (the hide itself expires).
 */
(function () {
  var html = document.documentElement;
  var mm = function (q) { return !!(window.matchMedia && window.matchMedia(q).matches); };

  /* ---- 2. landing glitter decision ----------------------------------------------------------- */
  try {
    var isIndex = /(^|\/)(index(\.html)?)?$/.test(location.pathname);
    var seen = false;
    try { seen = sessionStorage.getItem('krisha-arrival') === 'seen'; } catch (e) { seen = true; }
    if (isIndex && !seen && mm('(prefers-reduced-motion: no-preference)') && 'noModule' in document.createElement('script')) {
      html.classList.add('fx-arrival-pending');
      setTimeout(function () { html.classList.remove('fx-arrival-pending'); }, 2400);
    }
  } catch (e) { /* never block the page */ }

  /* ---- 1. cursor fallback --------------------------------------------------------------------- */
  if (!mm('(pointer: fine)')) return;

  var style = document.createElement('style');
  var on = 'html.krisha-custom-cursor:not(.krisha-cursor-fx)';
  var dot = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='13' height='13' viewBox='0 0 13 13'%3E%3Ccircle cx='6.5' cy='6.5' r='6.5' fill='%23000ca9'/%3E%3C/svg%3E\") 6 6, auto !important";
  var big = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='18' height='18' viewBox='0 0 18 18'%3E%3Ccircle cx='9' cy='9' r='9' fill='%23000ca9'/%3E%3C/svg%3E\") 9 9, pointer !important";
  var interactive = ['a', 'button', 'input', 'textarea', 'select', 'summary', 'label', '[role="button"]', '[tabindex]:not([tabindex="-1"])'];

  style.textContent =
    '@media (pointer: fine) {' +
      on + ',' + on + ' * { cursor: ' + dot + '; }' +
      interactive.map(function (s) { return on + ' ' + s; }).join(',') + ' { cursor: ' + big + '; }' +
    '}';

  document.head.appendChild(style);
  html.classList.add('krisha-custom-cursor');
})();
