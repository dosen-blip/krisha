/*
 * fx/sound.js — tiny shared sound helper for interaction sounds (not page-arrival sounds, which
 * live in page-sounds.js). Gesture-armed: if autoplay blocks a sound it is dropped, not queued
 * (interaction sounds are only meaningful at the moment they happen).
 *
 *   import { play, soundOn, setSoundOn } from './sound.js';
 *   play('chime', { volume: 0.5 });
 *
 * Mute preference: localStorage 'krisha-sound' = 'off' silences every fx sound.
 */
const SOUNDS = {
  chime: 'audio/Chime25.wav',
  error17: 'audio/Error17.wav',
  error20: 'audio/Error20.wav',
  error28: 'audio/Error28.wav',
};

const cache = new Map();

export function soundOn() {
  try { return localStorage.getItem('krisha-sound') !== 'off'; } catch (e) { return true; }
}
export function setSoundOn(on) {
  try { localStorage.setItem('krisha-sound', on ? 'on' : 'off'); } catch (e) { /* ignore */ }
}

export function play(name, { volume = 0.6, rate = 1 } = {}) {
  if (!soundOn()) return;
  const src = SOUNDS[name] || name;
  let base = cache.get(src);
  if (!base) { base = new Audio(src); base.preload = 'auto'; cache.set(src, base); }
  const a = base.cloneNode();
  a.volume = Math.max(0, Math.min(1, volume));
  a.playbackRate = rate;
  const p = a.play();
  if (p && p.catch) p.catch(() => {});
}

/** Warm the cache so the first play is instant. */
export function preload(...names) {
  names.forEach((n) => {
    const src = SOUNDS[n] || n;
    if (!cache.has(src)) { const a = new Audio(src); a.preload = 'auto'; cache.set(src, a); }
  });
}
