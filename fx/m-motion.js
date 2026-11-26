/*
 * fx/m-motion.js — shared phone motion sensor (owned by fx core). Phone features import it; don't fork it.
 *
 *   import { motion, enableMotion, motionState } from './m-motion.js';
 *   motion.subscribe((m) => { m.x, m.y })   // smoothed tilt, -1..1 each (x: left/right roll, y: front/back pitch)
 *                                           // relative to how the phone was held when sensing started
 *   await enableMotion({ ask: true })       // -> true if live. On iOS this shows the KRISHA.EXE dialog first;
 *                                           // its OK tap is the user gesture iOS requires for requestPermission().
 *                                           // ask:false never shows UI (only starts where no permission is needed).
 *   motionState()                           // 'live' | 'needs-tap' | 'denied' | 'unsupported'
 *
 * The answer is remembered for the session (sessionStorage 'krisha-motion'), so the dialog appears at most once.
 * Note: iOS only exposes motion sensors on HTTPS (or localhost).
 */
import { motionOK, damp } from './gl.js';

const KEY = 'krisha-motion';
const subs = new Set();
export const motion = {
  x: 0, y: 0, live: false,
  subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
};

const hasEvent = typeof window.DeviceOrientationEvent !== 'undefined';
const needsPermission = hasEvent && typeof DeviceOrientationEvent.requestPermission === 'function';
const remembered = () => { try { return sessionStorage.getItem(KEY); } catch (e) { return null; } };
const remember = (v) => { try { sessionStorage.setItem(KEY, v); } catch (e) { /* ignore */ } };

export function motionState() {
  if (!hasEvent || !motionOK) return 'unsupported';
  if (motion.live) return 'live';
  if (remembered() === 'denied') return 'denied';
  return 'needs-tap';
}

/* ---- sensing: smoothed, calibrated to the first pose, emitted on rAF while changing */
let base = null, rawX = 0, rawY = 0, raf = 0, lastT = 0, started = false;
function onOrient(e) {
  if (e.beta == null || e.gamma == null) return;
  const portrait = !(screen.orientation && /landscape/.test(screen.orientation.type));
  const pitch = portrait ? e.beta : e.gamma;
  const roll = portrait ? e.gamma : -e.beta;
  if (!base) base = { pitch, roll };
  // let the baseline drift slowly toward how the phone is held now
  base.pitch += (pitch - base.pitch) * 0.002;
  base.roll += (roll - base.roll) * 0.002;
  rawX = Math.max(-1, Math.min(1, (roll - base.roll) / 25));
  rawY = Math.max(-1, Math.min(1, (pitch - base.pitch) / 25));
  if (!raf) raf = requestAnimationFrame(tick);
}
function tick(now) {
  raf = 0;
  const dt = lastT ? Math.min(0.1, (now - lastT) / 1000) : 1 / 60;
  lastT = now;
  const k = damp(10, dt);
  motion.x += (rawX - motion.x) * k;
  motion.y += (rawY - motion.y) * k;
  subs.forEach((fn) => { try { fn(motion); } catch (e) { console.warn('[fx] motion', e); } });
  if (Math.abs(rawX - motion.x) > 0.001 || Math.abs(rawY - motion.y) > 0.001) raf = requestAnimationFrame(tick);
  else lastT = 0;
}
function start() {
  if (started) return;
  started = true;
  motion.live = true;
  addEventListener('deviceorientation', onOrient, { passive: true });
  addEventListener('orientationchange', () => { base = null; });
}

/* ---- the KRISHA.EXE permission dialog (Win98 dialog, KRISHA ink) */
function dialog() {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'fx-m-dialog';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.setAttribute('aria-labelledby', 'fx-m-dialog-title');
    wrap.innerHTML = `
      <div class="fx-m-dialog__box">
        <div class="fx-m-dialog__bar"><span id="fx-m-dialog-title">KRISHA.EXE</span><button type="button" class="fx-m-dialog__x" aria-label="Cancel">X</button></div>
        <p class="fx-m-dialog__msg">KRISHA.EXE WOULD LIKE TO USE YOUR PHONE'S MOTION SENSORS SO THE WORK MOVES WHEN YOU TILT IT.</p>
        <div class="fx-m-dialog__btns"><button type="button" class="fx-m-dialog__ok">OK</button><button type="button" class="fx-m-dialog__no">CANCEL</button></div>
      </div>`;
    const css = document.createElement('style');
    css.textContent = `
      .fx-m-dialog{position:fixed;inset:0;z-index:96;display:grid;place-items:center;background:rgba(255,255,255,.55);font-family:'Pixelify Sans',sans-serif}
      .fx-m-dialog__box{width:min(300px,84vw);background:#fff;border:1px solid #000ca9;box-shadow:3px 3px 0 #000ca9}
      .fx-m-dialog__bar{display:flex;justify-content:space-between;align-items:center;background:#000ca9;color:#fff;font-size:13px;padding:3px 4px 3px 7px}
      .fx-m-dialog__x{font:inherit;font-size:12px;line-height:1;width:18px;height:16px;border:1px solid #fff;background:#000ca9;color:#fff;padding:0}
      .fx-m-dialog__msg{margin:14px 12px 16px;font-size:13px;line-height:1.35;color:#000ca9}
      .fx-m-dialog__btns{display:flex;gap:10px;justify-content:flex-end;margin:0 12px 12px}
      .fx-m-dialog__btns button{font:inherit;font-size:13px;min-width:72px;padding:6px 10px;background:#fff;color:#000ca9;border:1px solid #000ca9;box-shadow:2px 2px 0 #000ca9}
      .fx-m-dialog__btns button:active{transform:translate(2px,2px);box-shadow:none}`;
    wrap.prepend(css);
    const done = (ok) => { wrap.remove(); resolve(ok); };
    wrap.querySelector('.fx-m-dialog__ok').addEventListener('click', () => done(true));
    wrap.querySelector('.fx-m-dialog__no').addEventListener('click', () => done(false));
    wrap.querySelector('.fx-m-dialog__x').addEventListener('click', () => done(false));
    document.body.appendChild(wrap);
    wrap.querySelector('.fx-m-dialog__ok').focus();
  });
}

let pending = null;
export function enableMotion({ ask = true } = {}) {
  if (!hasEvent || !motionOK) return Promise.resolve(false);
  if (motion.live) return Promise.resolve(true);
  if (!needsPermission) { start(); return Promise.resolve(true); }
  if (remembered() === 'granted') {
    // iOS keeps the grant for the session but the API still wants a gesture; try silently.
    return DeviceOrientationEvent.requestPermission().then((r) => (r === 'granted' ? (start(), true) : false), () => false);
  }
  if (!ask || remembered() === 'denied') return Promise.resolve(false);
  if (pending) return pending;
  pending = dialog().then((ok) => {
    if (!ok) { remember('denied'); return false; }
    return DeviceOrientationEvent.requestPermission().then((r) => {
      remember(r === 'granted' ? 'granted' : 'denied');
      if (r === 'granted') start();
      return r === 'granted';
    }, () => { remember('denied'); return false; });
  }).finally(() => { pending = null; });
  return pending;
}

// Android & co: no permission needed — start at once (passive, cheap when nobody subscribes).
if (hasEvent && motionOK && !needsPermission) start();
