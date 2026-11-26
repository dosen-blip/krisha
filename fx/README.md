# fx — KRISHA effects layer

No build step. three r170 is vendored in `vendor/three/` and mapped by an import map in every page head:
`"three"` → `vendor/three/build/three.module.min.js`, `"three/addons/"` → `vendor/three/examples/jsm/`
(subset: environments, geometries, utils, math, curves, shaders, postprocessing, objects, lines, loaders/SVGLoader).

## Identity rules
Vocabulary: a Y2K desktop remembered from Dubai — Win98 zoom-rects, interlaced loading, XP progress blocks,
pointer trails, MS-Paint marching ants, dither dissolves, pixel glitter. Reuse tech from other projects, never their look.

1. **Blue ink on white.** Glossy chrome-blue or flat ink (`#000ca9`, links `#0900ff`). No bloom, haze, god rays
   or additive glow on white pages. Pixelify Sans for any text.
2. **The collage stays where it is.** Effects add depth inside the existing absolute (`--u` / `--m`) layouts.
3. **The static page is the fallback.** Reduced motion, phones (≤700px / coarse pointer), weak GPUs → today's site.
4. Never block first paint. Never throw out of `mount()`.

## Files and ownership
| File | Owner | Notes |
|---|---|---|
| `prepaint.js` | core (gate section) + transitions (arrival section) | classic script in `<head>` |
| `gl.js`, `boot.js`, `fx.css`, `sound.js` | core | shared API — don't change signatures |
| `transitions.js/.css`, `nav-progress.js` | transitions | also edits `page-sounds.js`, `scroll-reveal.js` |
| `ring.js/.css` (+ generated shape data) | ring | mounts: `[data-fx-ring="emblem"]` (security), `.nav__logo`. (`[data-fx-ring="hero"]` is supported but no longer used: the landing ring was removed) |
| `paint.js`, `paint-lite.js`, `paint.css` | paint | may edit `paint.html` |
| `creative.js`, `creative-lite.js`, `creative.css` | creative | may edit `creative-direction.html` |
| `flipbook.js`, `flipbook-lite.js`, `security.css` | security issue pages | `security-issue-00/01.html` (`.sec-issue` cover + `[data-sec-read]` open the reader); the hub `security-magazine-2025.html` keeps `data-fx-ring="emblem"` and loads no reader |
| `cursor-fx.js`, `arrival.js/.css` | cursor+arrival | also edits `cursor.css`, `cursor.js`, `cursor-boot.js` |

## Module contract
`export async function mount(ctx)` — `ctx = { gl, THREE, core, page }`. GL modules are imported only when
`core.gate().ok`; otherwise the `lite` module (if any). Use `core.createView()` for every renderer.

## Cross-feature contracts
- **Events** (on `window`):
  - `krisha:leave` `{ url, x, y, mode }` — fired by transitions just before navigating away.
  - `krisha:arrive` `{ x, y, fromNav }` — fired by transitions when the new page is uncovered (or right away
    when there was no transition). `x/y` = viewport point the previous click happened at (centre if none).
- **Cursor hints:** set `data-cursor="drag" | "view" | "play" | "close"` on elements; `cursor-fx.js` reacts.
- **Modal state:** while a full-screen viewer is open set `document.documentElement.dataset.fxModal = '<name>'`
  and remove it on close. Transitions, nav string and cursor read it.
- **Grow transition:** links with `data-transition="grow"` morph their `.figure`/image into the destination
  page's hero (implemented in transitions; creative tiles opt in).
- **z-index:** `--fx-z-overlay` 60, `--fx-z-viewer` 70, `--fx-z-transition` 100, `--fx-z-cursor` 110.
- **Sound:** `import { play } from './sound.js'`; respects `localStorage['krisha-sound'] = 'off'`.

## Globals set by features
- `window.__fxTx` — transition hand-off read in prepaint (`{x,y,t,mode,to,hero}` or null).
- `window.__fxReveal` — pagereveal info for grow transitions.
- `window.__fxArrived` — detail of the `krisha:arrive` that already fired (`restored: true` after bfcache).
- `window.__fxTransitions.go(url, {x, y})` — navigate with the zoom-rect leave from code; `__fxTransitions.prefetch(href)` warms a page.
- `krisha:prefetch` `{ href, loaded, total, done, failed }` — prefetch progress (drives the nav progress bar).
- Grow duration lives in `transitions.js` and `transitions.css` — keep the two in sync.
- `html.fx-arrival-pending` (set by `cursor-boot.js` on first index visit) = landing pixel-glitter intro will run.

## Debug
`?gl=off` / `?gl=force` / `?gl=auto` (sticky per session). `html[data-fx-gl]` shows the gate result.
`window.__fx` exposes the core and mounted features.

## Phone (≤700px) layer
`html.fx-phone` / `core.isPhone` = the `--m` mobile layouts are active. Desktop features (cursor, nav-progress, paint, creative,
flipbook) don't load there; phone features `fx/m-*.js` do, and they may use WebGL on capable phones (same `gate()`).
Same identity and vocabulary as desktop, translated to touch: no hover exists, so **scroll position, taps, long-press,
swipe/drag and tilt** are the inputs.
- `fx/m-motion.js` (core): `motion.subscribe`, `enableMotion({ask})` with the KRISHA.EXE Win98-style permission dialog
  (iOS needs a tap + HTTPS), `motionState()`. Never call `DeviceOrientationEvent.requestPermission` yourself.
- `fx/m-shell.js/.css` — sticky nav, menu, scroll progress, touch feedback (all phone pages).
- `fx/m-reel.js` (tap hand-off only: scroll selection + previews retired), `m-paint.js`, `m-flipbook.js`, `m-gallery.js` + their `m-*.css`.
- `ring.js` handles both desktop and phone placements (on Security the phone emblem + nav ring share one renderer).
- Phone z-index: sticky nav 80, menu rects 86, viewers 90 (m-paint 92), zoom-rect overlays 95, KRISHA.EXE dialog 96, transitions 100.
- Viewers set `html.dataset.fxModal` (`viewer`, `m-paint`, `flipbook`…); shell bursts/progress pause while it is set.
- Creative reel markup: `.mcr` blocks are `<a data-mcr="<group>">`, the group hero has `data-mcr-hero` + `data-transition="grow"`.
- Cache-busting: bump `V` in boot.js, the `?v=` on every boot.js tag, and the hard-coded `?v=` in paint-lite.js.
