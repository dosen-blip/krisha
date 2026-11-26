/*
 * fx/arrival.js — landing "pixel glitter" (index only, non-GL).
 *
 * On the first index visit of the session the nav words and the identity lines assemble letter by letter, in a
 * random but planned order (planGlitter), on a GIF-like frame clock (GLITTER_PACE.step). Each letter lands with
 * a tiny 4-point pixel sparkle (box-shadow pixels, fx/arrival.css) that pops through 2-3 sizes in hard steps and
 * vanishes. Everything is done within GLITTER_PACE.total (<= 1.2s). No sound.
 *
 * Afterwards the name (KRISHA DAVE) keeps a very sparse glint, like a glitter GIF that is mostly still: one
 * sparkle on a random letter every IDLE.every ms, only while the page is visible and the pointer is idle, for
 * IDLE.life ms in total. Input skips the intro, not the glint.
 *
 * Contract:
 *   - cursor-boot.js (head, pre-paint) decides and sets html.fx-arrival-pending; without it nothing runs.
 *   - starts on `krisha:arrive` (or window.__fxArrived), else 300ms later (DOMContentLoaded + 50ms at the earliest)
 *   - pointerdown / keydown / wheel / touchstart skip to the final state
 *   - links stay clickable; their accessible names come from a visually hidden copy of the original text
 *   - at the end the original text nodes are put back, so the DOM is exactly as authored
 */

const KEY = 'krisha-arrival';
const SELECTOR = '.hero .nav a, .hero .identity__name, .hero .identity__role, .hero .identity__email';
const NAME = '.hero .identity__name';
const SKIP_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'];

/** Sparkle personalities: the sizes it pops through, one GLITTER_PACE.step each (s 3px, m 5px, l 7px cross). */
export const POPS = { blink: ['s', 'm'], pop: ['s', 'l', 'm'], twinkle: ['m', 'l', 's'], flash: ['l', 's'] };
/** Pace (seconds): lead-in [base, random], window over which letters land, frame clock, hard end. */
export const GLITTER_PACE = { lead: [0.04, 0.04], spread: 0.84, step: 0.06, total: 1.15 };
/** Idle glint on the name (ms): first one after [min, max], then every [min, max]; pointer idle; lifetime. */
export const IDLE = { every: [4000, 7000], idle: 1500, life: 30000 };

const msr = (v) => Math.round(v * 1000) / 1000;

/**
 * Order, landing time, sparkle personality and sparkle anchor (fraction of the letter box) for `count` letters.
 * Landing times are quantised to the frame clock, so letters arrive in small batches like GIF frames.
 * @returns {{ delay: number, duration: number, pop: keyof POPS, x: number, y: number }[]}
 */
export function planGlitter(count, random = Math.random, pace = GLITTER_PACE) {
  const order = Array.from({ length: count }, (_, i) => i);
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const kinds = Object.keys(POPS);
  const lead = pace.lead[0] + random() * pace.lead[1];
  const plan = new Array(count);
  order.forEach((index, rank) => {
    const pop = kinds[Math.floor(random() * kinds.length)];
    const duration = POPS[pop].length * pace.step;
    const at = lead + ((rank + random() * 0.8) / Math.max(1, count)) * pace.spread;
    const frame = Math.round(at / pace.step) * pace.step;
    const delay = Math.max(0, Math.min(frame, pace.total - duration));
    plan[index] = { delay: msr(delay), duration: msr(duration), pop, x: msr(0.6 + random() * 0.5), y: msr(random() * 0.3) };
  });
  return plan;
}

export const doneAt = (plan) => plan.reduce((m, p) => Math.max(m, p.delay + p.duration), 0);

/** Sparkle pixel size for a text element: about a sixteenth of its font size, never under 2px. */
const pixelFor = (el) => `${Math.max(2, Math.round(parseFloat(getComputedStyle(el).fontSize) / 16))}px`;

function sparkle(pop) {
  const s = document.createElement('i');
  s.className = `fx-spk fx-spk--${pop}`;
  return s;
}

/** Splits a text-only element into letter spans (each with its sparkle); keeps the original nodes for the restore. */
function split(el) {
  const nodes = [...el.childNodes];
  if (!nodes.length || !nodes.every((n) => n.nodeType === Node.TEXT_NODE)) return null;
  const text = el.textContent;
  if (!text.trim()) return null;

  const sr = document.createElement('span');
  sr.className = 'fx-arr-sr';
  sr.textContent = text;
  const ink = document.createElement('span');
  ink.setAttribute('aria-hidden', 'true');
  ink.style.setProperty('--spk-p', pixelFor(el));
  const letters = [];
  let run = '';
  for (const ch of text) {
    if (/\s/.test(ch)) { run += ch; continue; }
    if (run) { ink.append(run); run = ''; }
    const s = document.createElement('span');
    s.className = 'fx-arr-l';
    s.textContent = ch;
    ink.append(s);
    letters.push(s);
  }
  if (run) ink.append(run);
  el.replaceChildren(sr, ink);
  return { el, nodes, letters };
}

/**
 * The sparse after-glint on the name: single sparkles on random letters, measured with a Range (the name is
 * plain text again by then), drawn in a pointer-transparent layer inside .hero so they move with the page.
 */
function idleGlint() {
  const name = document.querySelector(NAME);
  const hero = name && name.closest('.hero');
  const text = name && name.firstChild;
  if (!hero || !text || text.nodeType !== Node.TEXT_NODE) return () => {};
  const html = document.documentElement;
  const chars = [...text.data].map((c, i) => (/\s/.test(c) ? -1 : i)).filter((i) => i >= 0);
  if (!chars.length) return () => {};

  const layer = document.createElement('div');
  layer.className = 'fx-glint-layer';
  layer.setAttribute('aria-hidden', 'true');
  hero.appendChild(layer);

  const t0 = performance.now();
  let lastMove = 0, timer = 0, stopped = false;
  const rand = (a, b) => a + Math.random() * (b - a);
  const onMove = (e) => { if (e.pointerType !== 'touch') lastMove = performance.now(); };
  addEventListener('pointermove', onMove, { passive: true });

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    removeEventListener('pointermove', onMove);
    removeEventListener('krisha:leave', stop);
    layer.remove();
  };
  addEventListener('krisha:leave', stop);

  const glint = () => {
    if (!text.isConnected) return;
    const i = chars[Math.floor(Math.random() * chars.length)];
    const range = document.createRange();
    range.setStart(text, i);
    range.setEnd(text, i + 1);
    const r = range.getBoundingClientRect();
    const h = hero.getBoundingClientRect();
    if (!r.width) return;
    const kinds = Object.keys(POPS);
    const pop = kinds[Math.floor(Math.random() * kinds.length)];
    const s = sparkle(pop);
    s.style.setProperty('--spk-p', pixelFor(name));
    s.style.setProperty('--sd', `${POPS[pop].length * GLITTER_PACE.step}s`);
    s.style.left = `${Math.round(r.left - h.left + r.width * rand(0.6, 1.1))}px`;
    s.style.top = `${Math.round(r.top - h.top + r.height * rand(0, 0.3))}px`;
    layer.appendChild(s);
    const done = () => s.remove();
    s.addEventListener('animationend', done, { once: true });
    setTimeout(done, 1000);
  };

  const tick = () => {
    if (stopped) return;
    const now = performance.now();
    if (now - t0 > IDLE.life) { stop(); return; }
    // Not now (hidden tab, viewer open, pointer moving): look again shortly instead of skipping a whole beat.
    if (document.hidden || html.dataset.fxModal || now - lastMove < IDLE.idle) { timer = setTimeout(tick, 700); return; }
    glint();
    timer = setTimeout(tick, rand(...IDLE.every));
  };
  timer = setTimeout(tick, rand(...IDLE.every));
  return stop;
}

export async function mount({ core }) {
  const html = document.documentElement;
  if (!html.classList.contains('fx-arrival-pending')) return;   // not a first visit, or the failsafe fired
  const markSeen = () => { try { sessionStorage.setItem(KEY, 'seen'); } catch (e) { /* ignore */ } };

  let started = false, finished = false, held = false;
  let items = [];
  let stopGlint = null;
  const timers = [];
  const later = (fn, ms) => timers.push(setTimeout(fn, ms));

  // Put the authored text nodes back. Never while a button is down: swapping the letter span under a
  // pressed pointer would cancel that click, so wait for the release (click fires in the same task).
  const restore = () => {
    if (held) return;
    removeEventListener('pointerup', onUp, true);
    removeEventListener('pointercancel', onUp, true);
    items.forEach(({ el, nodes }) => { try { el.replaceChildren(...nodes); } catch (e) { /* leave as is */ } });
    items = [];
    if (!stopGlint && core.motionOK) stopGlint = idleGlint();
  };
  function onUp() { held = false; if (finished) setTimeout(restore, 0); }

  // Visual end state at once (letters are plain, visible spans; sparkles hidden without the run class), then restore.
  const finish = () => {
    if (finished) return;
    finished = true;
    timers.forEach(clearTimeout);
    SKIP_EVENTS.forEach((t) => removeEventListener(t, skip, true));
    removeEventListener('krisha:arrive', go);
    html.classList.remove('fx-arrival-run', 'fx-arrival-pending');
    restore();
  };

  function skip(e) {
    if (e && e.type === 'pointerdown') held = true;
    markSeen();
    finish();
  }

  const start = () => {
    if (started || finished) return;
    started = true;
    // The pre-paint failsafe already showed the words: don't hide them again.
    if (!html.classList.contains('fx-arrival-pending') || !core.motionOK) { finish(); return; }
    try {
      items = [...document.querySelectorAll(SELECTOR)].map(split).filter(Boolean);
      const letters = items.flatMap((it) => it.letters);
      const plan = planGlitter(letters.length);
      letters.forEach((s, i) => {
        const p = plan[i];
        s.style.setProperty('--d', `${p.delay}s`);
        const spk = sparkle(p.pop);
        spk.style.setProperty('--sd', `${p.duration}s`);
        spk.style.setProperty('--sx', p.x);
        spk.style.setProperty('--sy', p.y);
        s.append(spk);
      });
      html.classList.add('fx-arrival-run');
      html.classList.remove('fx-arrival-pending');
      markSeen();
      later(finish, (doneAt(plan) + 0.05) * 1000);
    } catch (err) {
      console.warn('[fx] arrival', err);
      finish();
    }
  };

  // Let Pixelify Sans land first (bounded) so the letters assemble in the real face.
  const go = () => {
    if (started || finished) return;
    const fonts = document.fonts;
    if (!fonts || fonts.status === 'loaded') { start(); return; }
    let done = false;
    const once = () => { if (!done) { done = true; start(); } };
    fonts.ready.then(once, once);
    later(once, 350);
  };

  SKIP_EVENTS.forEach((t) => addEventListener(t, skip, { capture: true, passive: true }));
  addEventListener('pointerup', onUp, { capture: true, passive: true });
  addEventListener('pointercancel', onUp, { capture: true, passive: true });

  if (window.__fxArrived) go();
  else {
    addEventListener('krisha:arrive', go, { once: true });
    later(() => {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => later(go, 50), { once: true });
      } else go();
    }, 300);
  }

  return { destroy() { finish(); if (stopGlint) stopGlint(); } };
}
