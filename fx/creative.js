/*
 * fx/creative.js — Creative direction: the six project tiles as one WebGL layer (desktop only).
 *
 * The canvas lives inside .creative-page, sized to the tiles' bounding box, so it scrolls natively with
 * the page: no scroll-sync lag against the labels and no renders while the page scrolls. Each tile is a
 * plane carrying a texture rasterised from the DOM <img> with the exact DOM crop, at device-pixel
 * resolution on a device-pixel-snapped box, so at rest it IS the static page. The DOM anchors stay the
 * real click / keyboard targets (the canvas never takes pointer events).
 *
 *   hover or keyboard focus (tile or its label) = the tile is selected. (The MS-Paint selection line with
 *       marching ants and handles is still in the shader but switched off: SHOW_SELECTION.) The tile plays its preview: a stepped flip-book of the project's stills, or a muted video
 *       loop (Security, Talisman: poster first, then the video). The label counts it: "2/4", or "00:07".
 *   every change of picture (frame to frame, and back to the cover on leave)
 *       the Windows "dissolve": an ordered dither (Bayer 4x4, 4px cells) in four hard steps:
 *       25% dots, 50% checker, 75%, whole. Undone step for step if the pointer comes straight back.
 *   leave
 *       selection and count go at once; the picture dissolves back to the cover.
 *   Scrolling does nothing to the tiles.
 *
 * Box, line, dashes, handles and dither cells are all whole device pixels, so they stay crisp at any DPR.
 * Loop: idle unless something changes. Dissolve steps and ant steps wake it by timer (no rAF in between),
 * a playing video renders at <= 30fps (requestVideoFrameCallback). Preview media load on first selection.
 * Fallback: on watchdog / context loss the DOM imgs come back and the canvas is removed.
 */

const PERIOD = 640;        // ms per flip-book frame (hold + dissolve)
const FIRST = 200;         // ms the cover holds before the first dissolve
const STEPS = 4;           // dissolve: 1/4, 2/4, 3/4, 4/4 of the incoming picture (4 of the 16 Bayer ranks each)
const STEP = 70;           // ms per dissolve step
const CELL = 4;            // css px per dither cell
const SHOW_SELECTION = false; // the MS-Paint selection line + handles round a hovered tile (off)
const ANT = 125;           // ms per marching-ants step (1px each: 8 steps a second)
const DASH = 4;            // css px per dash (ink, then white)
const SEL_GAP = 3;         // css px of white between the tile and its selection line
const HANDLE = 5;          // css px handle squares
const MARGIN = 10;         // css px of plane round each tile (the selection lives there)
const VIDEO_FPS = 30;

const COVER = 0;           // picture ids: 0 = cover, 1..n = frames[i - 1], VIDEO = the playing video
const VIDEO = -1;
const IDENT = [0, 0, 1, 1];

const IMG = (n) => `img-webp/${n}.webp`;
const LETTERBOX = [0, 0.188, 1, 0.847]; // pralaya stills: a scope picture inside a 3:2 frame

/** Preview media per tile (found on each project page). The cover is always frame 0. */
export const PROJECTS = {
  'cd-pralaya': {
    frames: [
      { src: IMG('pralaya-01'), band: LETTERBOX, focus: [0.66, 0.5] },
      { src: IMG('pralaya-02'), band: LETTERBOX },
      { src: IMG('pralaya-03'), band: LETTERBOX, focus: [0.3, 0.5] },
      { src: IMG('pralaya-04'), band: LETTERBOX },
      { src: IMG('pralaya-05'), band: LETTERBOX, focus: [0.55, 0.5] },
    ],
  },
  'cd-free-me': { // cover is wwyfm-01
    frames: [
      { src: IMG('wwyfm-02'), focus: [0.5, 0.42] },
      { src: IMG('wwyfm-03'), focus: [0.5, 0.3] },
      { src: IMG('wwyfm-04'), focus: [0.5, 0.28] },
    ],
  },
  'cd-talisman': { video: 'video/wwyfm-test-reel-4.mp4', poster: IMG('talisman-hero') },
  'cd-ahlan': { // cover is ahlan-hero
    frames: [
      { src: IMG('ahlan-01'), focus: [0.5, 0.7] },
      { src: IMG('ahlan-02'), focus: [0.5, 0.62] },
    ],
  },
  'cd-security': { video: 'video/security-issue-00.mp4', poster: IMG('security-issue-00-poster') },
  'cd-wardi': { // cover is wardi-01
    frames: [
      { src: IMG('wardi-02'), focus: [0.5, 0.3] },
      { src: IMG('wardi-03'), focus: [0.5, 0.45] },
      { src: IMG('wardi-bg'), focus: [0.5, 0.32] },
    ],
  },
};

const VERTEX = /* glsl */ `
  uniform vec4 uBox;      // tile box in canvas css px (device-pixel snapped): x, y, w, h
  uniform vec2 uView;     // canvas css size
  uniform float uMargin;
  varying vec2 vLocal;    // css px from the tile's top-left

  void main() {
    vec2 local = vec2(uv.x, 1. - uv.y) * (uBox.zw + 2. * uMargin) - uMargin;
    vec2 p = uBox.xy + local;
    vLocal = local;
    gl_Position = vec4(p.x / uView.x * 2. - 1., 1. - p.y / uView.y * 2., 0., 1.);
  }
`;

const FRAGMENT = /* glsl */ `
  uniform sampler2D uFrom;  // the picture on show
  uniform sampler2D uTo;    // the picture dissolving in
  uniform vec4 uFromXf;     // uv offset.xy, scale.zw (cover-crop for video; identity for stills)
  uniform vec4 uToXf;
  uniform float uStep;      // 0..4: quarters of uTo shown
  uniform float uFlip;      // 1: ranks reversed (a dissolve undone step for step)
  uniform float uCellPx;    // device px per dither cell
  uniform vec2 uSize;       // tile size, device px
  uniform float uDpr;
  uniform float uSel;       // 1 while selected
  uniform float uAnts;      // device px the dashes have marched
  uniform vec4 uSelG;       // selection: gap, line, handle, dash (device px)
  uniform vec3 uInk;
  varying vec2 vLocal;

  // Bayer 4x4 rank 0..15 of a cell
  float b2(vec2 a) { return 2. * mod(a.x + a.y, 2.) + a.y; }
  float bayer4(vec2 c) { c = mod(c, 4.); return 4. * b2(mod(c, 2.)) + b2(floor(c * .5)); }

  void main() {
    vec2 ip = floor(vLocal * uDpr);           // device px from the tile's top-left
    vec3 white = vec3(1.);

    // the picture: whole device px, texel centres, no filtering at rest
    if (all(greaterThanEqual(ip, vec2(0.))) && all(lessThan(ip, uSize))) {
      vec2 uv = (ip + .5) / uSize;
      vec3 a = texture2D(uFrom, uFromXf.xy + uv * uFromXf.zw).rgb;
      vec3 b = texture2D(uTo, uToXf.xy + uv * uToXf.zw).rgb;
      float r = bayer4(floor(ip / uCellPx));
      r = mix(r, 15. - r, uFlip);
      gl_FragColor = vec4(r < uStep * 4. ? b : a, 1.);
      return;
    }
    if (uSel < .5) { gl_FragColor = vec4(0.); return; }

    // the selection, in px from the outer top-left of its line
    float G = uSelG.x, L = uSelG.y, Hs = uSelG.z, D = uSelG.w;
    vec2 o = ip + G + L;
    vec2 W = uSize + 2. * (G + L);

    // eight handles centred on the line (corners and edge midpoints)
    vec3 hx = vec3((L - Hs) * .5, floor((W.x - Hs) * .5), W.x - (L + Hs) * .5);
    vec3 hy = vec3((L - Hs) * .5, floor((W.y - Hs) * .5), W.y - (L + Hs) * .5);
    vec3 inx = step(hx, vec3(o.x)) * step(vec3(o.x), hx + Hs - .5);
    vec3 iny = step(hy, vec3(o.y)) * step(vec3(o.y), hy + Hs - .5);
    float hit = max(inx.x, max(inx.y, inx.z)) * max(iny.x, max(iny.y, iny.z)) * (1. - inx.y * iny.y);
    if (hit > .5) {
      vec2 h = vec2(dot(inx, vec3(o.x) - hx), dot(iny, vec3(o.y) - hy));
      float edge = step(h.x, L - .5) + step(h.y, L - .5) + step(Hs - L - .5, h.x) + step(Hs - L - .5, h.y);
      gl_FragColor = vec4(edge > 0. ? uInk : white, 1.);
      return;
    }

    // the line: dashes counted clockwise from the top-left (the seam hides under that handle)
    bool outer = all(greaterThanEqual(o, vec2(0.))) && all(lessThan(o, W));
    bool inner = all(greaterThanEqual(o, vec2(L))) && all(lessThan(o, W - L));
    if (!outer || inner) { gl_FragColor = vec4(0.); return; }
    float s;
    if (o.y < L) s = o.x;
    else if (o.x >= W.x - L) s = W.x + o.y;
    else if (o.y >= W.y - L) s = 2. * W.x + W.y - 1. - o.x;
    else s = 2. * W.x + 2. * W.y - 1. - o.y;
    float ink = 1. - mod(floor((s - uAnts) / D), 2.);
    gl_FragColor = vec4(mix(white, uInk, ink), 1.);
  }
`;

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const lu = (v) => Math.round(v * 64) / 64; // Blink LayoutUnit
const pad2 = (n) => String(n).padStart(2, '0');
const timecode = (s) => { s = Math.floor(s || 0); return `${pad2(Math.floor(s / 60))}:${pad2(s % 60)}`; };

/** Source rect [sx, sy, sw, sh] that covers aspect `A` from a `w`x`h` source, within `band`, centred on `focus`. */
function coverCrop(w, h, A, band = [0, 0, 1, 1], focus = [0.5, 0.5]) {
  const bx = band[0] * w, by = band[1] * h, bw = (band[2] - band[0]) * w, bh = (band[3] - band[1]) * h;
  if (bw / bh > A) {
    const cw = bh * A;
    return [clamp(bx + focus[0] * bw - cw / 2, bx, bx + bw - cw), by, cw, bh];
  }
  const ch = bw / A;
  return [bx, clamp(by + focus[1] * bh - ch / 2, by, by + bh - ch), bw, ch];
}

function loadImage(src) {
  const img = new Image();
  img.decoding = 'async';
  img.src = src;
  return img.decode().then(() => img);
}

function canvas2d(W, H) {
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d', { alpha: false });
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.fillStyle = '#000';            // the .figure background shows where an image doesn't reach
  g.fillRect(0, 0, W, H);
  return { c, g };
}

export async function mount({ THREE, core }) {
  const page = document.querySelector('.creative-page');
  if (!page || !THREE || !core.motionOK) return;
  const anchors = [...page.querySelectorAll(':scope > a.figure')].filter((a) => a.querySelector('img'));
  if (!anchors.length) return;

  // raw sRGB components: the shader writes colours untouched, exactly like the 2D canvas covers
  const hex = (core.INK || '#000ca9').replace('#', '');
  const inkVec = new THREE.Vector3(...[0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255));

  // ---------------------------------------------------------------- tiles
  const tiles = anchors.map((el) => {
    const key = [...el.classList].find((c) => c.startsWith('cd-') && PROJECTS[c]) || '';
    const cfg = PROJECTS[key] || { frames: [] };
    const href = el.getAttribute('href');
    const label = [...page.querySelectorAll(':scope > a.text')].find((l) => l.getAttribute('href') === href) || null;
    const frames = (cfg.video ? [{ src: cfg.poster }] : cfg.frames || []).map((f) => ({ ...f, img: null, tex: null, key: '' }));
    return {
      el, label, key, cfg, img: el.querySelector('img'), frames, count: null,
      page: null, box: null, rkey: '',
      cover: null, coverKey: '',
      mesh: null, u: null,
      hover: false, hoverLabel: false, focus: false, focusTile: false, focusLabel: false, active: false,
      cur: COVER, next: null, queue: null, t0: 0, flip: false,   // the dissolve
      idx: COVER, timer: 0, since: 0,                             // the preview sequence
      video: null, loading: false,
      ready: false, live: false, released: false, decoded: false, broken: false, pendingHide: false,
    };
  });
  const byEl = new Map();
  tiles.forEach((t) => { byEl.set(t.el, t); if (t.label) byEl.set(t.label, t); });

  // the label's count ("2/4", "00:07"), shown only while its tile is selected
  for (const t of tiles) {
    if (!t.label || !(t.cfg.video || t.frames.length)) continue;
    const c = document.createElement('span');
    c.className = 'cd-fx-count';
    c.setAttribute('aria-hidden', 'true');
    t.label.appendChild(c);
    t.label.classList.add('cd-fx-label');
    t.count = c;
  }

  // ---------------------------------------------------------------- host + view
  const host = document.createElement('div');
  host.className = 'cd-fx-layer';
  host.setAttribute('aria-hidden', 'true');
  page.appendChild(host);
  const hostRect = { x: 0, y: 0, w: 1, h: 1 };

  const readLayout = () => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const t of tiles) {
      const cs = getComputedStyle(t.el);
      if (cs.display === 'none' || !t.el.getClientRects().length) { t.page = null; continue; }
      t.page = { x: parseFloat(cs.left), y: parseFloat(cs.top), w: parseFloat(cs.width), h: parseFloat(cs.height) };
      x0 = Math.min(x0, t.page.x); y0 = Math.min(y0, t.page.y);
      x1 = Math.max(x1, t.page.x + t.page.w); y1 = Math.max(y1, t.page.y + t.page.h);
    }
    if (!isFinite(x0)) return false;
    const pad = MARGIN + 2;
    hostRect.x = Math.floor(x0 - pad); hostRect.y = Math.floor(y0 - pad);
    hostRect.w = Math.ceil(x1 + pad) - hostRect.x; hostRect.h = Math.ceil(y1 + pad) - hostRect.y;
    Object.assign(host.style, {
      left: `${hostRect.x}px`, top: `${hostRect.y}px`, width: `${hostRect.w}px`, height: `${hostRect.h}px`,
    });
    return true;
  };
  readLayout();

  let view = null;
  let dead = false;
  const scene = new THREE.Scene();
  const camera = new THREE.Camera();
  const geometry = new THREE.PlaneGeometry(1, 1);
  const blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  blank.needsUpdate = true;
  let rasterTimer = 0;
  let readyPoll = 0;
  let leaving = false;
  let releaseTimer = 0;
  let wakeTimer = 0, wakeAtT = Infinity;

  // uniforms every tile shares (device-px geometry follows the view's dpr)
  const shared = {
    uView: { value: new THREE.Vector2(1, 1) },
    uDpr: { value: 1 },
    uCellPx: { value: CELL },
    uSelG: { value: new THREE.Vector4(SEL_GAP, 1, HANDLE, DASH) },
    uAnts: { value: 0 },
    uInk: { value: inkVec },
    uMargin: { value: MARGIN },
  };
  const geom = { L: 1, D: DASH };
  const setGeometry = (dpr) => {
    const L = Math.max(1, Math.round(dpr));                                   // 1 css px line
    const G = Math.max(1, Math.round(SEL_GAP * dpr));
    const Hs = L + 2 * Math.max(1, Math.round((HANDLE * dpr - L) / 2));       // centred on the line exactly
    const D = Math.max(1, Math.round(DASH * dpr));
    shared.uSelG.value.set(G, L, Hs, D);
    shared.uCellPx.value = Math.max(1, Math.round(CELL * dpr));
    shared.uDpr.value = dpr;
    geom.L = L; geom.D = D;
  };

  const texFrom = (image) => {
    const tex = new THREE.Texture(image);
    tex.flipY = false;
    tex.generateMipmaps = false;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.colorSpace = THREE.NoColorSpace;
    tex.needsUpdate = true;
    // free the 2D canvas once the pixels are on the GPU
    tex.onUpdate = () => { if (image instanceof HTMLCanvasElement) { image.width = 1; image.height = 1; } };
    return tex;
  };

  /**
   * Layout units per css px: Blink lays out in 1/64 of a layout px, which is a device px where it zooms
   * for the device scale factor and a css px where the compositor scales instead (Chrome on macOS).
   * Probe it: an offset of 1/(64*dpr) css px only survives layout in device-px units.
   */
  let layoutScale = 1, probedFor = 0;
  const probeLayoutScale = () => {
    const ratio = window.devicePixelRatio || 1;
    if (probedFor === ratio) return layoutScale;
    probedFor = ratio;
    layoutScale = 1;
    if (ratio === 1) return 1;
    const d = document.createElement('div');
    const off = 1 / (64 * ratio);
    d.style.cssText = `position:absolute;left:${off}px;top:0;width:1px;height:1px;visibility:hidden;pointer-events:none`;
    page.appendChild(d);
    const x = d.getBoundingClientRect().left - page.getBoundingClientRect().left;
    d.remove();
    if (Math.abs(x - off) < off / 4) layoutScale = ratio;
    return layoutScale;
  };

  /** Tile boxes in canvas css px, pixel-snapped the way Blink snaps them (+ uniforms). */
  const snap = () => {
    if (!view) return;
    const { dpr, width, height } = view.size;
    const S = probeLayoutScale();
    shared.uView.value.set(width, height);
    setGeometry(dpr);
    for (const t of tiles) {
      if (!t.page) { t.box = null; continue; }
      // the figure is a compositing layer (will-change): its offset and its size are each rounded to
      // whole layout px
      const lx = lu((t.page.x - hostRect.x) * S), ly = lu((t.page.y - hostRect.y) * S);
      const x = Math.round(lx) / S, y = Math.round(ly) / S;
      const w = Math.round(lu(t.page.w * S)) / S, h = Math.round(lu(t.page.h * S)) / S;
      const X0 = Math.round(x * dpr), Y0 = Math.round(y * dpr);
      const X1 = Math.round((x + w) * dpr), Y1 = Math.round((y + h) * dpr);
      t.box = { x: X0 / dpr, y: Y0 / dpr, w: (X1 - X0) / dpr, h: (Y1 - Y0) / dpr, W: X1 - X0, H: Y1 - Y0 };
      t.rkey = `${t.box.W}x${t.box.H}@${dpr}/${S}`;
      if (t.u) {
        t.u.uBox.value.set(t.box.x, t.box.y, t.box.w, t.box.h);
        t.u.uSize.value.set(t.box.W, t.box.H);
      }
    }
  };

  /**
   * The cover, exactly as the DOM draws it: the <img> rect is pixel-snapped inside the figure's layer
   * (edges rounded in layout units). Measured bit-exact against the static page in Chrome.
   */
  const rasterCover = (t) => {
    const b = t.box, img = t.img;
    if (!b || !img.naturalWidth || b.W < 2 || b.H < 2) return false;
    const dpr = view.size.dpr, S = layoutScale, k = dpr / S;
    const cs = getComputedStyle(img);
    let ix = lu((parseFloat(cs.left) || 0) * S), iy = lu((parseFloat(cs.top) || 0) * S);
    let iw = lu((parseFloat(cs.width) || t.page.w) * S), ih = lu((parseFloat(cs.height) || t.page.h) * S);
    if (cs.objectFit === 'cover' || cs.objectFit === 'contain') {
      const s = (cs.objectFit === 'cover' ? Math.max : Math.min)(iw / img.naturalWidth, ih / img.naturalHeight);
      const dw = lu(img.naturalWidth * s), dh = lu(img.naturalHeight * s);
      const pos = (cs.objectPosition || '50% 50%').split(/\s+/).map((v) => (v.endsWith('%') ? parseFloat(v) / 100 : 0.5));
      ix += lu((iw - dw) * (pos[0] ?? 0.5)); iy += lu((ih - dh) * (pos[1] ?? 0.5));
      iw = dw; ih = dh;
    }
    const L = Math.round(Math.round(ix) * k), T = Math.round(Math.round(iy) * k);
    const R = Math.round(Math.round(ix + iw) * k), B = Math.round(Math.round(iy + ih) * k);
    const { c, g } = canvas2d(b.W, b.H);
    g.drawImage(img, L, T, R - L, B - T);
    t.cover?.dispose();
    t.cover = texFrom(c);
    t.coverKey = t.rkey;
    return true;
  };

  const rasterFrame = (t, f) => {
    const b = t.box;
    if (!b || !f || !f.img) return false;
    if (f.key === t.rkey && f.tex) return true;
    const { c, g } = canvas2d(b.W, b.H);
    const crop = coverCrop(f.img.naturalWidth, f.img.naturalHeight, b.W / b.H, f.band, f.focus);
    g.drawImage(f.img, crop[0], crop[1], crop[2], crop[3], 0, 0, b.W, b.H);
    f.tex?.dispose();
    f.tex = texFrom(c);
    f.key = t.rkey;
    return true;
  };

  /** Texture + uv transform of a picture id (a stale-size frame is fine until the debounced re-raster). */
  const texOf = (t, id) => {
    if (id === VIDEO && t.video?.tex) return [t.video.tex, t.video.xf];
    if (id > 0) { const f = t.frames[id - 1]; if (f?.tex) return [f.tex, IDENT]; }
    return [t.cover || blank, IDENT];
  };

  const rerasterAll = () => {
    rasterTimer = 0;
    if (dead) return;
    for (const t of tiles) {
      if (!t.ready || !t.box) continue;
      if (t.coverKey !== t.rkey) rasterCover(t);
      for (const id of [t.cur, t.next, t.queue]) if (id > 0) rasterFrame(t, t.frames[id - 1]);
      if (t.video?.tex) setVideoXf(t);
    }
    view.invalidate();
  };

  const onResize = () => {
    snap();
    clearTimeout(rasterTimer);
    rasterTimer = setTimeout(rerasterAll, 140);
  };

  // ---------------------------------------------------------------- the dissolve
  const DONE = (STEPS - 1) * STEP;                         // ms until the incoming picture is whole
  const stepOf = (t, now) => Math.min(STEPS, 1 + Math.floor((now - t.t0) / STEP));

  /** Finish a dissolve whose time is up; start the queued one, if any. */
  const settle = (t, now) => {
    if (t.next === null || now - t.t0 < DONE) return;
    t.cur = t.next; t.next = null; t.flip = false;
    const q = t.queue;
    t.queue = null;
    if (q !== null && q !== t.cur) { t.next = q; t.t0 = now; }
  };

  /** Dissolve to picture `id`: queued behind a running dissolve, or that dissolve undone if `id` is where it came from. */
  const goTo = (t, id) => {
    const now = performance.now();
    settle(t, now);
    if (t.next !== null) {
      if (id === t.next) t.queue = null;
      else if (id === t.cur) {
        const k = STEPS - stepOf(t, now);                    // quarters of the old picture still showing
        [t.cur, t.next] = [t.next, t.cur];
        t.flip = !t.flip;
        t.t0 = now - (k - 1) * STEP;
        t.queue = null;
      } else t.queue = id;
    } else if (id !== t.cur) {
      t.next = id; t.t0 = now; t.flip = false; t.queue = null;
    }
    view && view.invalidate();
  };

  // ---------------------------------------------------------------- preview: stills + video
  const showCount = (t) => {
    if (!t.count) return;
    let txt = '';
    if (t.active) {
      if (t.cfg.video) txt = timecode(t.idx === VIDEO && t.video ? t.video.el.currentTime : 0);
      else txt = `${t.idx + 1}/${t.frames.length + 1}`;
    }
    if (t.count.textContent !== txt) t.count.textContent = txt;
  };

  // in parallel: the flip-book shows whichever frames have arrived, in order (wwyfm-02 alone is 9MB)
  const loadFrames = (t) => {
    if (t.loading) return;
    t.loading = true;
    t.frames.forEach((f) => {
      loadImage(f.src).then((img) => {
        if (dead) return;
        f.img = img;
        if (t.box) rasterFrame(t, f);
        if (t.cfg.video && t.active) pickVideo(t);
      }, () => { f.img = null; });
    });
  };

  const setVideoXf = (t) => {
    const v = t.video, el = v.el, b = t.box;
    if (!b || !el.videoWidth) return;
    const [sx, sy, sw, sh] = coverCrop(el.videoWidth, el.videoHeight, b.W / b.H);
    v.xf = [sx / el.videoWidth, sy / el.videoHeight, sw / el.videoWidth, sh / el.videoHeight];
  };

  const ensureVideo = (t) => {
    if (t.video) return t.video;
    const el = document.createElement('video');
    el.muted = true; el.defaultMuted = true; el.loop = true; el.playsInline = true; el.preload = 'auto';
    el.setAttribute('muted', ''); el.setAttribute('playsinline', '');
    el.src = t.cfg.video;
    const v = t.video = { el, tex: null, xf: IDENT, want: false, armed: false, last: 0, iv: 0 };
    const frameReady = () => {
      if (dead) return;
      if (!v.tex && el.readyState >= 2) {
        v.tex = new THREE.VideoTexture(el);
        v.tex.flipY = false;
        v.tex.colorSpace = THREE.NoColorSpace;
        setVideoXf(t);
      }
      if (t.active) { pickVideo(t); showCount(t); }
    };
    const onVF = (now) => {
      v.armed = false;
      if (dead || !v.want) return;
      frameReady();
      if (now - v.last >= 1000 / VIDEO_FPS - 2) { v.last = now; if (t.cur === VIDEO || t.next === VIDEO) view.invalidate(); }
      v.armed = true;
      el.requestVideoFrameCallback(onVF);
    };
    v.arm = () => {
      if ('requestVideoFrameCallback' in el) {
        if (!v.armed) { v.armed = true; el.requestVideoFrameCallback(onVF); }
      } else if (!v.iv) {
        el.addEventListener('playing', frameReady);
        v.iv = setInterval(() => { if (v.want) { frameReady(); view.invalidate(); } }, 1000 / VIDEO_FPS);
      }
    };
    el.addEventListener('loadeddata', frameReady);
    return v;
  };

  /** Video tiles: cover, then (after FIRST) the poster, then the video once a frame is decoded. */
  const pickVideo = (t) => {
    if (!t.active || !t.ready || t.idx === VIDEO) return;
    if (performance.now() - t.since < FIRST - 4) return;
    const v = t.video;
    if (v?.tex && v.el.readyState >= 2) { t.idx = VIDEO; goTo(t, VIDEO); return; }
    const poster = t.frames[0];
    if (t.idx !== 1 && rasterFrame(t, poster)) { t.idx = 1; goTo(t, 1); }
  };

  /** Flip-book: dissolve to the next loaded frame (the cover is frame 0), every PERIOD. */
  const advance = (t) => {
    t.timer = 0;
    if (!t.active || dead) return;
    if (t.ready) {
      const n = t.frames.length;
      for (let k = 1; k <= n; k++) {
        const j = (t.idx + k) % (n + 1);
        if (j === COVER || rasterFrame(t, t.frames[j - 1])) { t.idx = j; goTo(t, j); break; }
      }
      showCount(t);
    }
    t.timer = setTimeout(() => advance(t), PERIOD);
  };

  const startPreview = (t) => {
    t.since = performance.now();
    clearTimeout(t.timer);
    t.timer = 0;
    if (t.cfg.video) {
      if (!t.loading) loadFrames(t);
      const v = ensureVideo(t);
      v.want = true;
      v.arm();
      const token = (v.token = (v.token || 0) + 1);
      const p = v.el.play();
      // blocked autoplay leaves the poster up; an AbortError is just a quick leave (pause) racing play()
      if (p && p.catch) p.catch((e) => { if (token === v.token && (!e || e.name !== 'AbortError')) v.want = false; });
      t.timer = setTimeout(() => { t.timer = 0; pickVideo(t); }, FIRST);
    } else if (t.frames.length) {
      if (!t.loading) loadFrames(t);
      t.timer = setTimeout(() => advance(t), FIRST);
    }
  };

  const stopPreview = (t) => {
    clearTimeout(t.timer);
    t.timer = 0;
    if (t.video) { t.video.want = false; t.video.el.pause(); }
  };

  // ---------------------------------------------------------------- selection
  const refresh = (t) => {
    const on = !t.released && (t.hover || t.hoverLabel || t.focus);
    if (on === t.active) return;
    t.active = on;
    t.label?.classList.toggle('cd-fx-active', on);
    if (on) startPreview(t);
    else { stopPreview(t); t.idx = COVER; goTo(t, COVER); }
    showCount(t);
    view && view.invalidate();
  };

  const isTouch = (e) => e.pointerType === 'touch';
  const listeners = [];
  const on = (el, type, fn, opts) => { el.addEventListener(type, fn, opts); listeners.push(() => el.removeEventListener(type, fn, opts)); };

  for (const t of tiles) {
    on(t.el, 'pointerenter', (e) => { if (isTouch(e)) return; t.hover = true; refresh(t); });
    on(t.el, 'pointerleave', (e) => { if (isTouch(e)) return; t.hover = false; refresh(t); });
    on(t.el, 'focus', () => { t.focusTile = t.el.matches(':focus-visible'); t.focus = t.focusTile || t.focusLabel; refresh(t); });
    on(t.el, 'blur', () => { t.focusTile = false; t.focus = t.focusLabel; refresh(t); });
    if (t.label) {
      on(t.label, 'pointerenter', (e) => { if (isTouch(e)) return; t.hoverLabel = true; refresh(t); });
      on(t.label, 'pointerleave', (e) => { if (isTouch(e)) return; t.hoverLabel = false; refresh(t); });
      on(t.label, 'focus', () => { t.focusLabel = t.label.matches(':focus-visible'); t.focus = t.focusLabel || t.focusTile; refresh(t); });
      on(t.label, 'blur', () => { t.focusLabel = false; t.focus = t.focusTile; refresh(t); });
    }
  }

  // A grow transition morphs the DOM figure: hand the clicked tile back to the DOM (cover) first.
  const release = (t) => {
    if (t.released) return;
    t.released = true;
    t.hover = t.hoverLabel = t.focus = false;
    refresh(t);
    t.cur = COVER; t.next = null; t.queue = null; t.idx = COVER;
    if (t.mesh) t.mesh.visible = false;
    t.el.classList.remove('cd-fx-gl');
    t.el.classList.add('cd-fx-handoff');
    t.live = false;
    if (view && !view.destroyed) { applyUniforms(performance.now()); view.renderer.render(scene, camera); }
    // navigation didn't happen (no transition, or it was cancelled): take the tile back
    clearTimeout(releaseTimer);
    releaseTimer = setTimeout(() => { if (!leaving && !document.hidden) unrelease(); }, 5000);
  };
  const unrelease = () => {
    for (const t of tiles) {
      if (!t.released) continue;
      t.released = false;
      t.el.classList.remove('cd-fx-handoff');
      if (t.ready && t.mesh) { t.mesh.visible = true; t.pendingHide = true; }
    }
    view && view.invalidate();
  };
  on(document, 'click', (e) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest && e.target.closest('a');
    const t = a && byEl.get(a);
    if (t) release(t);
  }, true);
  on(window, 'krisha:leave', () => { leaving = true; tiles.forEach(release); });
  on(window, 'pageshow', (e) => { if (e.persisted) { leaving = false; unrelease(); } });
  on(document, 'visibilitychange', () => {
    if (!document.hidden) return;
    tiles.forEach((t) => { t.hover = t.hoverLabel = false; refresh(t); });
  });

  // ---------------------------------------------------------------- frame loop
  /** Uniforms for `now`; returns when the picture next changes (a dissolve or ant step), or Infinity. */
  const applyUniforms = (now) => {
    let due = Infinity;
    const ants = Math.floor(now / ANT);
    for (const t of tiles) {
      if (!t.u) continue;
      settle(t, now);
      const u = t.u;
      const [ta, xa] = texOf(t, t.cur);
      u.uFrom.value = ta; u.uFromXf.value.set(xa[0], xa[1], xa[2], xa[3]);
      if (t.next !== null) {
        const [tb, xb] = texOf(t, t.next);
        const k = stepOf(t, now);
        u.uTo.value = tb; u.uToXf.value.set(xb[0], xb[1], xb[2], xb[3]);
        u.uStep.value = k; u.uFlip.value = t.flip ? 1 : 0;
        due = Math.min(due, k < STEPS ? t.t0 + k * STEP : t.t0 + DONE);
      } else {
        u.uTo.value = ta; u.uStep.value = 0; u.uFlip.value = 0;
      }
      // the marching-ants selection is retired (owner, 2026-11-25): hover plays the preview, no border
      u.uSel.value = SHOW_SELECTION && t.active && !t.released && t.ready ? 1 : 0;
      if (u.uSel.value) due = Math.min(due, (ants + 1) * ANT);
    }
    shared.uAnts.value = (ants * geom.L) % (2 * geom.D);
    return due;
  };

  /** One timer wakes the idle loop for the next step (a sooner request replaces a later one). */
  const wakeAt = (at) => {
    if (!isFinite(at) || (wakeTimer && at >= wakeAtT)) return;
    clearTimeout(wakeTimer);
    wakeAtT = at;
    wakeTimer = setTimeout(() => {
      wakeTimer = 0; wakeAtT = Infinity;
      if (view && !view.destroyed) view.invalidate();
    }, Math.max(0, at - performance.now()) + 1);
  };

  const onFrame = () => {
    const due = applyUniforms(performance.now());
    view.renderer.render(scene, camera);
    wakeAt(due);

    // DOM imgs go only after the frame that draws their plane
    const hide = tiles.filter((t) => t.pendingHide && t.mesh?.visible);
    if (hide.length) {
      hide.forEach((t) => { t.pendingHide = false; });
      requestAnimationFrame(() => {
        if (dead) return;
        hide.forEach((t) => { if (!t.released && t.mesh.visible) { t.el.classList.add('cd-fx-gl'); t.live = true; } });
      });
    }
    return false;
  };

  // ---------------------------------------------------------------- teardown
  const restoreDom = () => {
    for (const t of tiles) {
      t.el.classList.remove('cd-fx-gl', 'cd-fx-handoff');
      t.label?.classList.remove('cd-fx-active', 'cd-fx-label');
      t.count?.remove();
      t.count = null;
      t.live = false;
    }
  };

  const destroy = () => {
    if (dead) return;
    dead = true;
    restoreDom();
    clearTimeout(rasterTimer);
    clearTimeout(releaseTimer);
    clearTimeout(wakeTimer);
    clearInterval(readyPoll);
    listeners.forEach((off) => off());
    for (const t of tiles) {
      clearTimeout(t.timer);
      if (t.video) {
        t.video.want = false;
        clearInterval(t.video.iv);
        t.video.el.pause();
        t.video.el.removeAttribute('src');
        t.video.el.load();
        t.video.tex?.dispose();
      }
      t.frames.forEach((f) => f.tex?.dispose());
      t.cover?.dispose();
      t.mesh?.material.dispose();
    }
    geometry.dispose();
    blank.dispose();
    if (view && !view.destroyed) view.destroy();
    host.remove();
  };

  try {
    view = core.createView({
      THREE, host,
      className: 'fx-canvas fx-canvas--passive cd-fx-canvas',
      alpha: true, antialias: false,
      dprMax: 2, pixelBudget: 1.2e7,
      onResize, onFrame,
      onFail: () => destroy(),
    });
  } catch (e) {
    destroy();
    return;
  }

  for (const t of tiles) {
    const u = {
      ...shared,
      uFrom: { value: blank }, uTo: { value: blank },
      uFromXf: { value: new THREE.Vector4(0, 0, 1, 1) }, uToXf: { value: new THREE.Vector4(0, 0, 1, 1) },
      uStep: { value: 0 }, uFlip: { value: 0 }, uSel: { value: 0 },
      uBox: { value: new THREE.Vector4(0, 0, 1, 1) }, uSize: { value: new THREE.Vector2(1, 1) },
    };
    const material = new THREE.ShaderMaterial({
      vertexShader: VERTEX, fragmentShader: FRAGMENT, uniforms: u,
      transparent: true, premultipliedAlpha: true, depthTest: false, depthWrite: false,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.visible = false;
    scene.add(mesh);
    t.mesh = mesh; t.u = u;
  }
  snap();

  // relayout on resize (--u changes); the view's ResizeObserver then calls onResize
  let relayoutRaf = 0;
  on(window, 'resize', () => {
    if (relayoutRaf) return;
    relayoutRaf = requestAnimationFrame(() => { relayoutRaf = 0; if (!dead) { readLayout(); snap(); onResize(); view.invalidate(); } });
  });

  // reduced motion switched on mid-visit: back to the static page
  const rm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)');
  if (rm && rm.addEventListener) on(rm, 'change', () => { if (rm.matches) destroy(); });

  // ---------------------------------------------------------------- take over each tile once its cover is decoded
  // and its scroll-reveal has finished (so the DOM and GL agree on position and opacity)
  const revealed = (t) => {
    if (!t.el.classList.contains('reveal-media')) return true;
    if (!t.el.classList.contains('is-visible')) return false;
    const cs = getComputedStyle(t.el);
    return cs.opacity === '1' && (cs.translate === 'none' || /^0px( 0px)?$/.test(cs.translate));
  };
  tiles.forEach((t) => {
    const done = () => { t.decoded = !!t.img.naturalWidth; t.broken = !t.decoded; };
    t.img.decode().then(done, done);
  });
  const tryTakeOver = () => {
    if (dead) return;
    let left = 0;
    for (const t of tiles) {
      if (t.ready || t.broken) continue;            // a cover that failed to load stays DOM
      if (!t.decoded || !t.box || !revealed(t)) { left++; continue; }
      if (!rasterCover(t)) { left++; continue; }
      t.ready = true;
      t.mesh.visible = !t.released;
      t.pendingHide = true;
      view.invalidate();
    }
    if (!left) clearInterval(readyPoll);
  };
  readyPoll = setInterval(tryTakeOver, 120);
  tryTakeOver();

  return {
    destroy,
    /** debug / integration */
    state: () => ({
      renders: view ? view.renderer.info.render.frame : 0,
      dpr: view && view.size.dpr,
      host: { ...hostRect },
      sel: shared.uSelG.value.toArray(),
      tiles: tiles.map((t) => ({
        key: t.key, ready: t.ready, live: t.live, active: t.active, sel: t.u ? t.u.uSel.value : 0,
        cur: t.cur, next: t.next, step: t.u ? t.u.uStep.value : 0, idx: t.idx,
        frames: t.frames.filter((f) => f.img).length, count: t.count ? t.count.textContent : null,
      })),
    }),
    release: (el) => { const t = byEl.get(el); if (t) release(t); },
  };
}
