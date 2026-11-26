/*
 * fx/m-flipbook.js — Security magazine on the phone (GL). Loaded by fx/boot.js only on html.fx-phone with a passing
 * gate(); no-GL phones get fx/flipbook-lite.js (DOM viewer, same entry points, same zoom-rect open).
 * Desktop has its own fx/flipbook.js — nothing here runs there. Shares the page manifest / assets
 * (fx/security-book.js, img-webp/security-book/) and the entry wiring (fx/flipbook-lite.js).
 *
 * On the page
 *   Covers  each issue cover becomes a CSS-3D magazine (front, spine, page-block edges, back) standing in for the
 *           static image once it has revealed. Before motion permission it turns a few degrees with scroll
 *           position as it crosses the screen (page block coming in from below, spine leaving at the top); with
 *           fx/m-motion.js live it follows the phone's tilt. Flat at rest in the middle of the screen, so the page is
 *           unchanged there. Only updates on scroll / motion while on screen; reduced motion = static image.
 *   Entries covers and grid scans open the reader at the matched page (fx/security-book.js SCANS). The first tap
 *           on a cover is where enableMotion({ ask: true }) runs (iOS shows the KRISHA.EXE dialog first).
 *
 * Reader (fixed, z 90: above the sticky phone nav at 80, under transitions at 100)
 *   Open    Win98 zoom-rects step from the tapped element to the page, then the page arrives "interlaced"
 *           (32 -> 12 -> 4px blocks -> sharp, hard steps). Close pixelates out and zoom-rects shrink back into the
 *           slot (the scan of the current spread / the cover when on screen, else the element it opened from).
 *   Portrait  ONE page, full-bleed width, the binding at the left screen edge. Drag sideways from either edge:
 *           the page curls after the finger (the fold sits under the touch point when grabbed at an edge); release
 *           past halfway or flick to complete, otherwise it falls back. Tap the outer thirds to turn, the middle
 *           to hide / show the chrome, swipe down to close. Back of a turning page = paper with the print showing
 *           through faintly.
 *   Landscape  two-page spreads like the printed book (cover alone on the right), same curl maths as desktop.
 *   Pinch   zoom in hard steps (100 / 150 / 200 / 300%, Paint-style, read out in the counter) around the fingers;
 *           one finger pans while zoomed; turning resets to 100%.
 *   Tilt    a subtle sway of the page (rotation about the binding) while motion is live.
 *   Pages   lazy-loaded (current +/- 2) over the per-issue atlas thumbnails.
 * Counter "ISSUE 01 · 23 / 88" + XP-style progress blocks; CLOSE, < >, Esc / arrows. GL failure -> lite viewer.
 */
import {
  wireEntries, createLite, pageSrc, atlasSrc, spreadCount, spreadPages, counterText, issueName,
  modalState, trapTab, zoomRects, rectOf,
} from './flipbook-lite.js';
import { motion, enableMotion, motionState } from './m-motion.js';

const PI = Math.PI;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ZOOMS = [1, 1.5, 2, 3];
const Z_READER = 90;

function loadImg(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      if (img.decode) img.decode().catch(() => {}).then(() => resolve(img));
      else resolve(img);
    };
    img.onerror = () => reject(new Error(`[fx] m-flipbook: ${src}`));
    img.src = src;
  });
}

/* =================================================================== shaders (curl maths from fx/flipbook.js) */
const LEAF_VERT = /* glsl */ `
#define PI 3.141592653589793
uniform vec2 uSize;
uniform vec2 uF;
uniform vec2 uN;
uniform float uR;
uniform float uFold;
uniform float uZNear;
uniform float uZFar;
varying vec2 vQ;
varying vec3 vNrm;
varying float vS;
varying vec2 vB;
void main() {
  vec2 q = vec2(position.x * uSize.x, position.y * uSize.y);
  vec3 p = vec3(q, uZNear);
  vec3 nrm = vec3(0.0, 0.0, 1.0);
  float s = dot(q - uF, uN);
  if (uFold > 0.5 && s > 0.0) {
    vec2 base = q - s * uN;
    if (uR < 0.01) {
      p = vec3(base - s * uN, uZFar);
      nrm = vec3(0.0, 0.0, -1.0);
    } else {
      float a = s / uR;
      if (a < PI) {
        p = vec3(base + uN * (uR * sin(a)), uR * (1.0 - cos(a)) + mix(uZNear, uZFar, a / PI));
        nrm = vec3(-uN * sin(a), cos(a));
      } else {
        p = vec3(base - uN * (s - PI * uR), 2.0 * uR + uZFar);
        nrm = vec3(0.0, 0.0, -1.0);
      }
    }
  }
  vQ = q;
  vNrm = nrm;
  vS = s;
  vB = p.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;

const LEAF_FRAG = /* glsl */ `
#define PI 3.141592653589793
uniform sampler2D uFront;
uniform sampler2D uBack;
uniform vec4 uFrontRect;
uniform vec4 uBackRect;
uniform vec2 uSize;
uniform vec2 uF;
uniform vec2 uN;
uniform float uR;
uniform float uSelfK;
uniform float uGutter;
uniform float uGhost;
uniform float uPix;
uniform int uCastN;
uniform vec4 uCastFN[4];
uniform vec2 uCastRK[4];
varying vec2 vQ;
varying vec3 vNrm;
varying float vS;
varying vec2 vB;

float sdPage(vec2 p) {
  vec2 d = abs(p - vec2(0.5 * uSize.x, 0.0)) - 0.5 * uSize;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}

void main() {
  // interlaced arrival: hard pixel blocks (page px) while uPix > 0; at 300% zoom one block = one texel (Paint zoom)
  vec2 qq = uPix > 0.0 ? (floor(vQ / uPix) + 0.5) * uPix : vQ;
  vec2 uv = clamp(vec2(qq.x / uSize.x, qq.y / uSize.y + 0.5), 0.0, 1.0);
  vec3 col;
  vec3 N;
  if (gl_FrontFacing) {
    col = texture2D(uFront, uFrontRect.xy + uv * uFrontRect.zw).rgb;
    N = vNrm;
  } else if (uGhost > 0.5) {
    // single-page reading: the back of the sheet is paper with the print showing through (mirrored)
    col = mix(vec3(0.97), texture2D(uFront, uFrontRect.xy + uv * uFrontRect.zw).rgb, 0.12);
    N = -vNrm;
  } else {
    col = texture2D(uBack, uBackRect.xy + vec2(1.0 - uv.x, uv.y) * uBackRect.zw).rgb;
    N = -vNrm;
  }
  // ink-only shading: darkening, never brighter
  float shade = 1.0 - 0.46 * (1.0 - clamp(N.z, 0.0, 1.0)) + 0.18 * dot(N.xy, vec2(-0.6, 0.8));
  shade *= 1.0 - uGutter * (0.26 * exp(-uv.x * 34.0) + 0.08 * exp(-uv.x * 6.0));
  if (uSelfK > 0.0 && vS <= 0.0) {
    vec2 src = vQ + (PI * uR - 2.0 * vS) * uN;
    shade *= 1.0 - uSelfK * 0.30 * (1.0 - smoothstep(0.0, 3.0 + 0.8 * uR, sdPage(src)));
  }
  for (int i = 0; i < 4; i++) {
    if (i >= uCastN) break;
    vec2 F = uCastFN[i].xy;
    vec2 n = uCastFN[i].zw;
    float R = uCastRK[i].x;
    float k = uCastRK[i].y;
    float s = dot(vB - F, n);
    float sh = 0.0;
    if (s > 0.0) {
      if (vB.x > 0.0) sh = 0.42 * exp(-max(s - R, 0.0) / (0.05 * uSize.x + 0.9 * R));
    } else {
      vec2 src = vB + (PI * R - 2.0 * s) * n;
      sh = 0.36 * (1.0 - smoothstep(0.0, 5.0 + 1.1 * R, sdPage(src)));
    }
    shade *= 1.0 - k * sh;
  }
  gl_FragColor = vec4(col * clamp(shade, 0.0, 1.0), 1.0);
  #include <colorspace_fragment>
}`;

const RECT_VERT = /* glsl */ `
uniform vec2 uLo;
uniform vec2 uHi;
uniform float uPad;
uniform float uZ;
varying vec2 vP;
void main() {
  vP = mix(uLo - uPad, uHi + uPad, position.xy + 0.5);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(vP, uZ, 1.0);
}`;

const EDGE_FRAG = /* glsl */ `
uniform vec2 uPLo;
uniform vec2 uPHi;
varying vec2 vP;
void main() {
  float d = max(max(uPLo.x - vP.x, vP.x - uPHi.x), max(uPLo.y - vP.y, vP.y - uPHi.y));
  float st = step(0.5, fract(d / 1.5));
  gl_FragColor = vec4(vec3(mix(0.56, 0.74, st)), 1.0);
  #include <colorspace_fragment>
}`;

const SHADOW_FRAG = /* glsl */ `
uniform vec2 uLo;
uniform vec2 uHi;
uniform float uPad;
uniform float uAlpha;
varying vec2 vP;
void main() {
  vec2 c = 0.5 * (uLo + uHi);
  vec2 d = abs(vP - c) - 0.5 * (uHi - uLo);
  float sd = length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
  float a = uAlpha * (1.0 - smoothstep(-uPad * 0.25, uPad, sd));
  gl_FragColor = vec4(0.0, 0.0, 0.0, a);
}`;

/* =================================================================== texture store (phone budget) */
function createStore(THREE, renderer, onChange) {
  const FULL = new THREE.Vector4(0, 0, 1, 1);
  const white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  white.colorSpace = THREE.SRGBColorSpace;
  white.needsUpdate = true;
  const aniso = Math.min(4, renderer.capabilities.getMaxAnisotropy());
  let iss = null, atlas = null, atlasP = Promise.resolve(), gen = 0;
  const hi = new Map();

  const makeTex = (img, mips) => {
    const t = new THREE.Texture(img);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = aniso;
    if (!mips) { t.generateMipmaps = false; t.minFilter = THREE.LinearFilter; }
    t.needsUpdate = true;
    try { renderer.initTexture(t); } catch (e) { /* uploads on first use */ }
    return t;
  };

  function clear(keepAtlas) {
    hi.forEach((e) => e.tex && e.tex.dispose());
    hi.clear();
    if (!keepAtlas) { atlas && atlas.dispose(); atlas = null; }
  }

  function setIssue(next) {
    if (iss === next) return atlasP;
    clear(false);
    iss = next;
    const g = ++gen;
    atlasP = loadImg(atlasSrc(iss)).then((img) => {
      if (g !== gen) return;
      atlas = makeTex(img, false);
      onChange();
    }).catch(() => {});
    return atlasP;
  }

  function request(n) {
    if (!iss || !n || n < 1 || n > iss.pages) return Promise.resolve();
    let e = hi.get(n);
    if (e) return e.p;
    const g = gen;
    e = { tex: null };
    e.p = loadImg(pageSrc(iss, n)).then((img) => {
      if (g !== gen || hi.get(n) !== e) return;
      e.tex = makeTex(img, true);
      onChange();
    }).catch(() => {});
    hi.set(n, e);
    return e.p;
  }

  /** load pages lo..hi (nearest `c` first) and drop far ones (phones: keep the cache small) */
  function want(lo, top, c, keep) {
    if (!iss) return;
    lo = Math.max(1, lo); top = Math.min(iss.pages, top);
    const list = [];
    for (let n = lo; n <= top; n++) list.push(n);
    list.sort((a, b) => Math.abs(a - c) - Math.abs(b - c));
    list.forEach(request);
    if (hi.size > keep) {
      hi.forEach((e, n) => {
        if (n < lo - 2 || n > top + 2) { e.tex && e.tex.dispose(); hi.delete(n); }
      });
    }
  }

  function cell(n, v) {
    const a = iss.atlas, j = n - 1, c = j % a.cols, r = Math.floor(j / a.cols);
    const ix = 0.75 / a.w, iy = 0.75 / a.h;
    v.set(c * a.cw / a.w + ix, 1 - (r + 1) * a.ch / a.h + iy, a.cw / a.w - 2 * ix, a.ch / a.h - 2 * iy);
  }

  function get(n, uTex, uRect) {
    if (!iss || !n || n < 1 || n > iss.pages) { uTex.value = white; uRect.value.copy(FULL); return; }
    const e = hi.get(n);
    if (e && e.tex) { uTex.value = e.tex; uRect.value.copy(FULL); return; }
    if (atlas) { uTex.value = atlas; cell(n, uRect.value); return; }
    uTex.value = white; uRect.value.copy(FULL);
  }

  return { setIssue, request, want, get, clear, get atlasP() { return atlasP; } };
}

/* =================================================================== reader */
function createReader(THREE, core, lite, liteOpen) {
  const modal = modalState('flipbook');
  const reducedMQ = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const EPS = 0.35;
  const MAX_ACTIVE = 3;

  let root = null, stage, hit, nameEl, countEl, prevBtn, nextBtn, closeBtn, progEl, tipEl;
  let view = null, dead = false, scene, camera, group, store;
  let leafMeshes = [], staticL, staticR, edgeL, edgeR, shadowMesh;
  const pixU = { value: 0 };
  let iss = null, mode = 'page', L = 0, S = 1, leaves = [], active = [], committed = 0;
  let Wp = 300, Hp = 400, Rmax = 40, restY = 0, offsetX = 0, barT = 44, barB = 48;
  let state = 'closed', src = null, drag = null, press = null, pinch = null, lastFocus = null, reduced = false;
  let zoom = 1, zoomMsgT = 0, entries = [], unsubMotion = null, tipDone = false, tipT = 0;
  const pan = { x: 0, y: 0 };
  const sway = { x: 0, y: 0 };
  const ptrs = new Map();
  const gt = { x: 0, y: 0, sx: 1, sy: 1 };

  /* ---------------------------------------------------------------- dom */
  function buildDom() {
    root = document.createElement('div');
    root.className = 'msec';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.tabIndex = -1;
    root.style.zIndex = String(Z_READER);
    root.innerHTML = `
      <div class="msec__stage"></div>
      <div class="msec__hit" aria-hidden="true"></div>
      <div class="msec__bar">
        <span class="msec__name"></span>
        <button type="button" class="msec__close">CLOSE</button>
      </div>
      <div class="msec__foot">
        <div class="msec__prog" aria-hidden="true"></div>
        <div class="msec__nav">
          <button type="button" class="msec__prev" aria-label="Previous page">&lt;</button>
          <span class="msec__count" aria-live="polite"></span>
          <button type="button" class="msec__next" aria-label="Next page">&gt;</button>
        </div>
      </div>
      <div class="msec__tip" aria-hidden="true">DRAG THE PAGE EDGE TO TURN<br>PINCH TO ZOOM</div>`;
    stage = root.querySelector('.msec__stage');
    hit = root.querySelector('.msec__hit');
    nameEl = root.querySelector('.msec__name');
    countEl = root.querySelector('.msec__count');
    prevBtn = root.querySelector('.msec__prev');
    nextBtn = root.querySelector('.msec__next');
    closeBtn = root.querySelector('.msec__close');
    progEl = root.querySelector('.msec__prog');
    tipEl = root.querySelector('.msec__tip');
    for (let i = 0; i < 24; i++) progEl.appendChild(document.createElement('i'));
    closeBtn.addEventListener('click', () => close());
    prevBtn.addEventListener('click', () => { resetZoom(); turn(-1); });
    nextBtn.addEventListener('click', () => { resetZoom(); turn(1); });
    root.addEventListener('keydown', onKey);
    // the page underneath must not scroll / rubber-band while reading
    root.addEventListener('touchmove', (e) => { if (e.cancelable) e.preventDefault(); }, { passive: false });
    hit.addEventListener('pointerdown', onDown);
    hit.addEventListener('pointermove', onMove);
    hit.addEventListener('pointerup', onUp);
    hit.addEventListener('pointercancel', onUp);
    hit.addEventListener('lostpointercapture', (e) => { if (ptrs.has(e.pointerId)) onUp(e); });
    hit.addEventListener('contextmenu', (e) => e.preventDefault());
    document.body.appendChild(root);
  }

  function leafMaterial() {
    const v4 = () => new THREE.Vector4();
    return new THREE.ShaderMaterial({
      uniforms: {
        uSize: { value: new THREE.Vector2(1, 1) },
        uF: { value: new THREE.Vector2(0, 0) },
        uN: { value: new THREE.Vector2(1, 0) },
        uR: { value: 0 },
        uFold: { value: 0 },
        uZNear: { value: 0 },
        uZFar: { value: 0 },
        uFront: { value: null },
        uBack: { value: null },
        uFrontRect: { value: new THREE.Vector4(0, 0, 1, 1) },
        uBackRect: { value: new THREE.Vector4(0, 0, 1, 1) },
        uSelfK: { value: 0 },
        uGutter: { value: 1 },
        uGhost: { value: 0 },
        uPix: pixU,
        uCastN: { value: 0 },
        uCastFN: { value: [v4(), v4(), v4(), v4()] },
        uCastRK: { value: [new THREE.Vector2(), new THREE.Vector2(), new THREE.Vector2(), new THREE.Vector2()] },
      },
      vertexShader: LEAF_VERT,
      fragmentShader: LEAF_FRAG,
      side: THREE.DoubleSide,
    });
  }

  function rectMesh(frag, transparent) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShaderMaterial({
      uniforms: {
        uLo: { value: new THREE.Vector2() }, uHi: { value: new THREE.Vector2() }, uPad: { value: 0 }, uZ: { value: 0 },
        uPLo: { value: new THREE.Vector2() }, uPHi: { value: new THREE.Vector2() }, uAlpha: { value: 0.1 },
      },
      vertexShader: RECT_VERT, fragmentShader: frag, transparent, depthWrite: !transparent,
    }));
    m.frustumCulled = false;
    return m;
  }

  function ensure() {
    if (view) return true;
    if (dead) return false;
    if (!root) buildDom();
    try {
      view = core.createView({
        THREE, host: stage, observe: null, dprMax: 2, pixelBudget: 3.2e6,
        className: 'msec__canvas',            // not .fx-canvas: the reader is asked for, it stays under reduced motion
        onResize, onFrame, onFail,
      });
    } catch (err) {
      console.warn('[fx] m-flipbook: no GL view', err);
      dead = true;
      return false;
    }
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(20, 1, 10, 10000);
    group = new THREE.Group();
    scene.add(group);
    store = createStore(THREE, view.renderer, () => view && view.invalidate());
    const geo = new THREE.PlaneGeometry(1, 1, 72, 40);
    geo.translate(0.5, 0, 0);
    const mk = () => {
      const m = new THREE.Mesh(geo, leafMaterial());
      m.frustumCulled = false;
      m.visible = false;
      group.add(m);
      return m;
    };
    staticL = mk(); staticR = mk();
    for (let i = 0; i < MAX_ACTIVE; i++) leafMeshes.push(mk());
    edgeL = rectMesh(EDGE_FRAG, false); edgeR = rectMesh(EDGE_FRAG, false);
    shadowMesh = rectMesh(SHADOW_FRAG, true);
    shadowMesh.renderOrder = -1;
    group.add(edgeL, edgeR, shadowMesh);
    onResize(view.size);
    return true;
  }

  function onFail() {
    // GL gave up (slow / context lost): continue in the lite viewer at the same place.
    dead = true;
    view = null;
    const wasOpen = state !== 'closed';
    const entry = { iss, spread: Math.floor(currentPage() / 2), el: src };
    finishClose(true);
    if (wasOpen && iss) lite.open(entry);
  }

  /* ---------------------------------------------------------------- layout + mode */
  const portrait = () => !(innerWidth > innerHeight * 1.05);

  function computeLayout() {
    if (!iss) return;
    const W = innerWidth, H = innerHeight;
    const aspect = iss.w / iss.h;
    if (mode === 'page') {
      barT = 44; barB = 52;
      Wp = Math.max(100, Math.min(W, (H - barT - barB) * aspect));     // full-bleed width
      Hp = Wp / aspect;
      Rmax = 0.14 * Wp;
    } else {
      barT = 34; barB = 40;
      Hp = Math.max(80, Math.min(H - barT - barB - 12, (W - 28) / (2 * aspect)));
      Wp = Hp * aspect;
      Rmax = 0.12 * Wp;
    }
    restY = (barB - barT) / 2;
  }

  function recount() {
    if (mode === 'page') { L = iss.pages; S = iss.pages; } else { L = Math.ceil(iss.pages / 2); S = spreadCount(iss); }
  }

  /** printed page number shown now (left page of a spread) */
  const currentPage = () => (!iss ? 1 : mode === 'page' ? committed + 1 : (committed === 0 ? 1 : Math.min(iss.pages, 2 * committed)));
  const indexFor = (n) => (mode === 'page' ? clamp(n - 1, 0, S - 1) : clamp(Math.floor(n / 2), 0, S - 1));

  function onResize({ width, height }) {
    if (!camera) return;
    camera.aspect = width / height;
    const d = (height / 2) / Math.tan((camera.fov * PI) / 360);
    camera.position.set(0, 0, d);
    camera.near = d * 0.05;
    camera.far = d * 4;
    camera.updateProjectionMatrix();
    if (!iss) return;
    const n = currentPage();
    const nextMode = portrait() ? 'page' : 'spread';
    const pW = Wp, pMode = mode;
    mode = nextMode;
    computeLayout();
    if (mode !== pMode) {
      // rotating the phone: same printed page, one page <-> spreads
      drag = null; press = null; pinch = null; ptrs.clear();
      recount();
      goSettled(indexFor(n));
      resetZoom();
      root.classList.toggle('is-land', mode === 'spread');
    } else if (Math.abs(pW - Wp) > 0.5) {
      active.slice().forEach((a) => settle(a));
      drag = null;
      offsetX = targetOffset();
      resetZoom();
    }
  }

  function setIssue(next) {
    if (iss !== next) {
      iss = next;
      store.setIssue(iss);
      nameEl.textContent = issueName(iss);
      root.setAttribute('aria-label', `Security Issue ${iss.id} — magazine reader`);
    }
    mode = portrait() ? 'page' : 'spread';
    recount();
    computeLayout();
    root.classList.toggle('is-land', mode === 'spread');
  }

  function goSettled(k) {
    committed = clamp(k, 0, S - 1);
    active.length = 0;
    drag = null;
    leaves = [];
    for (let i = 0; i < L; i++) leaves.push({ side: i < committed ? 1 : 0, act: null });
    offsetX = targetOffset();
    want();
    updateUi();
  }

  function want() {
    if (!iss) return;
    if (mode === 'page') { const n = committed + 1; store.want(n - 2, n + 2, n, 8); }
    else { const k = committed; store.want(2 * (k - 2), 2 * (k + 2) + 1, 2 * k + 0.5, 12); }
  }

  /** front / back page numbers of leaf i (page mode: one leaf per page, the back is see-through paper) */
  const facesOf = (i) => (mode === 'page' ? [i + 1, 0] : [2 * i + 1, 2 * i + 2]);
  const hasFront = (i) => (mode === 'page' ? i < L : 2 * i + 1 <= iss.pages);

  const extentsOf = (k) => (mode === 'page' ? { xL: 0, xR: Wp } : { xL: k >= 1 ? -Wp : 0, xR: 2 * k + 1 <= iss.pages ? Wp : 0 });
  function targetOffset() { const e = extentsOf(committed); return -(e.xL + e.xR) / 2; }

  function visualExtents() {
    if (mode === 'page') return { xL: 0, xR: Wp };
    let left = false, right = false;
    for (let i = 0; i < L; i++) {
      const lf = leaves[i];
      if (lf.act) { left = right = true; break; }
      if (lf.side === 1) left = true; else if (hasFront(i)) right = true;
    }
    return { xL: left ? -Wp : 0, xR: right ? Wp : 0 };
  }

  function counterLabel() {
    if (!iss) return '';
    return mode === 'page' ? `ISSUE ${iss.id} · ${committed + 1} / ${iss.pages}` : counterText(iss, committed);
  }

  function updateUi() {
    if (!iss || !root) return;
    if (performance.now() > zoomMsgT) countEl.textContent = counterLabel();
    prevBtn.disabled = committed <= 0;
    nextBtn.disabled = committed >= S - 1;
    prevBtn.setAttribute('aria-label', mode === 'page' ? 'Previous page' : 'Previous pages');
    nextBtn.setAttribute('aria-label', mode === 'page' ? 'Next page' : 'Next pages');
    // XP progress blocks: how far into the issue
    const f = S > 1 ? committed / (S - 1) : 1;
    const on = Math.max(1, Math.round(f * progEl.children.length));
    Array.prototype.forEach.call(progEl.children, (b, j) => b.classList.toggle('on', j < on));
  }

  /* ---------------------------------------------------------------- leaf physics (from fx/flipbook.js) */
  const St = { x: 0, y: 0 }, Sb = { x: 0, y: 0 };
  function clampP(P, G) {
    St.y = Hp / 2; Sb.y = -Hp / 2;
    for (let it = 0; it < 3; it++) {
      for (const Sp of [St, Sb]) {
        const r = Math.hypot(G.x - Sp.x, G.y - Sp.y);
        const dx = P.x - Sp.x, dy = P.y - Sp.y, d = Math.hypot(dx, dy);
        if (d > r && d > 0) { P.x = Sp.x + (dx * r) / d; P.y = Sp.y + (dy * r) / d; }
      }
    }
  }

  function foldOf(a) {
    const { G, P } = a;
    const dx = G.x - P.x, dy = G.y - P.y, len = Math.hypot(dx, dy);
    if (len < 0.25) return null;
    const nx = dx / len, ny = dy / len;
    const u = clamp(dx / (2 * G.x), 0, 1);
    let R = Rmax * Math.pow(Math.min(1, len / (0.35 * Wp)), 0.8) * Math.pow(Math.min(1, (1 - u) * 2.2), 0.8);
    const mx = (G.x + P.x) / 2, my = (G.y + P.y) / 2;
    const sT = -mx * nx + (Hp / 2 - my) * ny, sB = -mx * nx + (-Hp / 2 - my) * ny;
    R = Math.max(0, Math.min(R, (-2 * Math.max(sT, sB)) / PI));
    const k = Math.min(1, len / (0.15 * Wp)) * Math.min(1, (1 - u) * 4);
    return { Fx: mx - (nx * PI * R) / 2, Fy: my - (ny * PI * R) / 2, nx, ny, R, u, k };
  }

  function startTurn(i, to, gy) {
    const lf = leaves[i];
    if (!lf) return;
    let a = lf.act;
    if (a) {
      if (a.mode === 'auto') {
        a.phi0 = a.phi; a.phi1 = to; a.t = 0; a.dur = Math.max(0.25, 0.8 * Math.abs(a.phi1 - a.phi0));
      } else {
        a.mode = 'spring';
        a.T = to ? { x: -a.G.x, y: a.G.y } : { x: a.G.x, y: a.G.y };
      }
      a.to = to;
      return;
    }
    const y = clamp(gy != null ? gy : -Hp * (0.16 + Math.random() * 0.14), -Hp * 0.42, Hp * 0.42);
    const G = { x: Wp, y };
    const busy = active.length > 0;
    a = {
      i, G, to, mode: 'auto',
      P: to ? { x: G.x, y: G.y } : { x: -G.x, y: G.y },
      V: { x: 0, y: 0 },
      phi: to ? 0 : 1, phi0: to ? 0 : 1, phi1: to, t: 0,
      dur: busy ? 0.5 : 0.72,
      lift: Hp * (0.03 + 0.04 * Math.random()) * (y < 0 ? 1 : -0.6),
    };
    lf.act = a;
    active.push(a);
    while (active.length > MAX_ACTIVE) settle(active[0]);
  }

  function settle(a) {
    const lf = leaves[a.i];
    if (lf && lf.act === a) { lf.side = a.to; lf.act = null; }
    const j = active.indexOf(a);
    if (j >= 0) active.splice(j, 1);
    if (drag === a) drag = null;
  }

  function stepAct(a, dt) {
    if (a.mode === 'auto') {
      a.t = Math.min(1, a.t + dt / a.dur);
      a.phi = a.phi0 + (a.phi1 - a.phi0) * easeInOut(a.t);
      a.P.x = a.G.x * Math.cos(PI * a.phi);
      a.P.y = a.G.y + a.lift * Math.sin(PI * a.phi);
      clampP(a.P, a.G);
      if (a.t >= 1) { settle(a); return false; }
    } else if (a.mode === 'drag') {
      const f = 1 - Math.exp(-28 * dt);
      a.P.x += (a.target.x - a.P.x) * f;
      a.P.y += (a.target.y - a.P.y) * f;
      clampP(a.P, a.G);
    } else {
      const K = 140, C = 2 * Math.sqrt(K) * 0.9;
      let rem = dt;
      while (rem > 1e-5) {
        const h = Math.min(rem, 1 / 120);
        rem -= h;
        a.V.x += (K * (a.T.x - a.P.x) - C * a.V.x) * h;
        a.V.y += (K * (a.T.y - a.P.y) - C * a.V.y) * h;
        a.P.x += a.V.x * h;
        a.P.y += a.V.y * h;
      }
      clampP(a.P, a.G);
      if (Math.hypot(a.T.x - a.P.x, a.T.y - a.P.y) < 0.6 && Math.hypot(a.V.x, a.V.y) < 25) { settle(a); return false; }
    }
    return true;
  }

  /* ---------------------------------------------------------------- turning */
  function turn(dir, gy) {
    if (state !== 'open' || !iss) return;
    if (dir > 0 ? committed >= S - 1 : committed <= 0) return;
    const i = dir > 0 ? committed++ : --committed;
    if (reduced) leaves[i].side = dir > 0 ? 1 : 0;
    else startTurn(i, dir > 0 ? 1 : 0, gy);
    want();
    updateUi();
    view.invalidate();
  }

  function jump(k) {
    if (state !== 'open') return;
    k = clamp(k, 0, S - 1);
    if (k === committed) return;
    const dir = Math.sign(k - committed);
    while (Math.abs(k - committed) > 2) {
      if (dir > 0) leaves[committed++].side = 1; else leaves[--committed].side = 0;
    }
    while (committed !== k) turn(dir);
  }

  /* ---------------------------------------------------------------- zoom (hard steps) */
  function quantize(s, cur) {
    let i = Math.max(0, ZOOMS.indexOf(cur));
    while (i < ZOOMS.length - 1 && s > Math.sqrt(ZOOMS[i] * ZOOMS[i + 1]) * 1.05) i++;
    while (i > 0 && s < Math.sqrt(ZOOMS[i - 1] * ZOOMS[i]) / 1.05) i--;
    return ZOOMS[i];
  }

  /** 300%: snap to the page's own texels (MS Paint pixel view) instead of a blurry upscale */
  const texelPix = () => (zoom >= 3 && iss ? Wp / iss.w : 0);

  function setZoom(z) {
    if (z === zoom) return;
    zoom = z;
    pixU.value = texelPix();
    root.classList.toggle('is-zoomed', zoom > 1);
    countEl.textContent = `ZOOM ${Math.round(zoom * 100)}%`;
    zoomMsgT = performance.now() + 900;
    clearTimeout(setZoom.t);
    setZoom.t = setTimeout(() => { zoomMsgT = 0; updateUi(); }, 920);
  }

  function resetZoom() {
    if (zoom === 1 && !pan.x && !pan.y) return;
    clearTimeout(setZoom.t);
    pan.x = pan.y = 0;
    if (root) { zoom = 1; pixU.value = 0; root.classList.remove('is-zoomed'); zoomMsgT = 0; updateUi(); }
    view && view.invalidate();
  }

  /** keep the zoomed page covering the screen between the bars (centred when it is smaller) */
  function clampPan() {
    if (zoom <= 1) { pan.x = pan.y = 0; return; }
    const W = innerWidth, H = innerHeight;
    const ex = visualExtents();
    const ax = (lo, hi, vLo, vHi, p) => {
      if (zoom * (hi - lo) <= vHi - vLo) { const c = (lo + hi) / 2; return c - zoom * c; }
      return clamp(p, vHi - zoom * hi, vLo - zoom * lo);
    };
    pan.x = ax(gt.x + ex.xL * gt.sx, gt.x + ex.xR * gt.sx, -W / 2, W / 2, pan.x);
    pan.y = ax(gt.y - (Hp / 2) * gt.sy, gt.y + (Hp / 2) * gt.sy, -H / 2 + barB, H / 2 - barT, pan.y);
  }

  const toWorld = (cx, cy) => ({ x: cx - innerWidth / 2, y: innerHeight / 2 - cy });
  function toBook(cx, cy) {
    const w = toWorld(cx, cy);
    const X = (w.x - pan.x) / zoom, Y = (w.y - pan.y) / zoom;
    return { x: (X - gt.x) / gt.sx, y: (Y - gt.y) / gt.sy };
  }

  function twoPointers() {
    const it = ptrs.values();
    const a = it.next().value, b = it.next().value;
    return { a, b, d: Math.max(20, Math.hypot(a.x - b.x, a.y - b.y)), m: toWorld((a.x + b.x) / 2, (a.y + b.y) / 2) };
  }

  function startPinch() {
    active.slice().forEach((a) => settle(a));            // anything in flight lands
    const { d, m } = twoPointers();
    pinch = { d0: d, z0: zoom, w0: { x: (m.x - pan.x) / zoom, y: (m.y - pan.y) / zoom } };
    hideTip();
  }

  function updatePinch() {
    const { d, m } = twoPointers();
    setZoom(quantize((pinch.z0 * d) / pinch.d0, zoom));
    pan.x = m.x - zoom * pinch.w0.x;
    pan.y = m.y - zoom * pinch.w0.y;
    clampPan();
    view.invalidate();
  }

  /* ---------------------------------------------------------------- touch */
  function newPress(e, modeName) {
    return { id: e.pointerId, x0: e.clientX, y0: e.clientY, px: e.clientX, py: e.clientY, t: performance.now(),
      b0: toBook(e.clientX, e.clientY), last: null, v: { x: 0, y: 0 }, mode: modeName || null };
  }

  function onDown(e) {
    if (state !== 'open') return;
    if (e.pointerType === 'mouse' && e.button > 0) return;
    e.preventDefault();
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { hit.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    if (ptrs.size === 1) {
      press = newPress(e);
    } else if (ptrs.size === 2) {
      if (drag) releaseDrag(press, true);
      press = null;
      startPinch();
    }
  }

  function beginDrag(dx) {
    active.slice().forEach((a) => settle(a));            // quick successive swipes: the last page lands at once
    const b = press.b0;
    const dir = dx < 0 ? 1 : -1;
    if (dir > 0 ? committed >= S - 1 : committed <= 0) return null;
    const i = dir > 0 ? committed : committed - 1;
    const gy = clamp(b.y, -Hp * 0.42, Hp * 0.42);
    let a;
    if (mode === 'page') {
      // the fold follows the finger: grabbed at an edge it sits under the touch point
      const G = { x: Wp, y: gy };
      const P = { x: dir > 0 ? Wp : -Wp, y: gy };
      a = { i, G, P, V: { x: 0, y: 0 }, mode: 'drag', dir, to: dir > 0 ? 0 : 1, target: { ...P },
        bx0: dir > 0 ? Math.max(b.x, 0.3 * Wp) : Math.min(Math.max(b.x, 0), 0.7 * Wp), by0: b.y, prog: 0,
        lift: Hp * 0.05 * (gy < 0 ? 1 : -0.6) };
    } else {
      // spreads: the free edge follows the finger (as on desktop)
      const onSide = dir > 0 ? b.x >= 0 : b.x < 0;
      const gx = onSide ? Math.max(Math.abs(b.x), 0.3 * Wp) : 0.85 * Wp;
      const G = { x: gx, y: gy };
      const P = { x: dir > 0 ? gx : -gx, y: gy };
      a = { i, G, P, V: { x: 0, y: 0 }, mode: 'drag', dir, to: dir > 0 ? 0 : 1, target: { ...P },
        off: { x: P.x - b.x, y: P.y - b.y } };
    }
    leaves[i].act = a;
    active.push(a);
    root.classList.add('is-dragging');
    hideTip();
    return a;
  }

  function dragTo(b) {
    const a = drag;
    if (mode === 'page') {
      const f = a.dir > 0
        ? Wp * clamp(b.x / a.bx0, 0, 1)
        : Wp * clamp((b.x - a.bx0) / Math.max(1, Wp - a.bx0), 0, 1);
      a.prog = a.dir > 0 ? 1 - f / Wp : f / Wp;
      a.target.x = 2 * f - Wp;
      a.target.y = a.G.y + (b.y - a.by0) * 0.5 + a.lift * Math.sin(PI * (1 - f / Wp));
    } else {
      a.target.x = b.x + a.off.x;
      a.target.y = a.G.y + (b.y + a.off.y - a.G.y) * 0.6;
    }
    clampP(a.target, a.G);
  }

  function releaseDrag(p, cancel) {
    const a = drag;
    drag = null;
    root.classList.remove('is-dragging');
    if (!a) return;
    const fresh = p && p.last && performance.now() - p.last.t < 120;   // a finger held still has no flick
    const vx = fresh ? clamp(p.v.x, -4000, 4000) : 0, vy = fresh ? clamp(p.v.y, -4000, 4000) : 0;
    const flick = a.dir > 0 ? -vx : vx;                  // + = moving in the turning direction
    let done = false;
    if (!cancel) {
      if (mode === 'page') done = (a.prog > 0.5 && flick > -350) || (flick > 450 && a.prog > 0.04);
      else done = (a.dir > 0 ? a.target.x < 0 : a.target.x > 0) || (flick > 500 && Math.abs(a.target.x) < a.G.x - 0.12 * Wp);
    }
    a.mode = 'spring';
    const k = mode === 'page' ? 1.2 : 0.6;
    a.V = { x: vx * k, y: -vy * 0.4 };
    if (a.dir > 0) { a.to = done ? 1 : 0; if (done) committed = a.i + 1; }
    else { a.to = done ? 0 : 1; if (done) committed = a.i; }
    a.T = a.to ? { x: -a.G.x, y: a.G.y } : { x: a.G.x, y: a.G.y };
    want();
    updateUi();
    view.invalidate();
  }

  function onMove(e) {
    const pt = ptrs.get(e.pointerId);
    if (!pt) return;
    pt.x = e.clientX; pt.y = e.clientY;
    if (pinch) { if (ptrs.size >= 2) updatePinch(); return; }
    if (!press || e.pointerId !== press.id) return;
    const now = performance.now();
    if (press.last) {
      const dt = Math.max(1, now - press.last.t) / 1000;
      press.v.x = press.v.x * 0.5 + ((e.clientX - press.last.x) / dt) * 0.5;
      press.v.y = press.v.y * 0.5 + ((e.clientY - press.last.y) / dt) * 0.5;
    }
    press.last = { x: e.clientX, y: e.clientY, t: now };
    const dx = e.clientX - press.x0, dy = e.clientY - press.y0;
    if (!press.mode && Math.hypot(dx, dy) > 8) {
      if (zoom > 1) press.mode = 'pan';
      else if (Math.abs(dx) > Math.abs(dy) * 0.9) { drag = beginDrag(dx); press.mode = drag ? 'turn' : 'none'; }
      else press.mode = dy > 0 ? 'down' : 'none';
    }
    if (press.mode === 'pan') {
      pan.x += e.clientX - press.px;
      pan.y -= e.clientY - press.py;
      clampPan();
      view.invalidate();
    } else if (press.mode === 'turn' && drag) {
      dragTo(toBook(e.clientX, e.clientY));
      view.invalidate();
    }
    press.px = e.clientX; press.py = e.clientY;
  }

  function onUp(e) {
    if (!ptrs.has(e.pointerId)) return;
    ptrs.delete(e.pointerId);
    try { hit.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    if (pinch) {
      if (ptrs.size < 2) {
        pinch = null;
        // the finger still down keeps panning (never turns a page)
        const left = ptrs.entries().next().value;
        press = left ? newPress({ pointerId: left[0], clientX: left[1].x, clientY: left[1].y }, zoom > 1 ? 'pan' : 'none') : null;
      }
      return;
    }
    if (!press || e.pointerId !== press.id) return;
    const p = press;
    press = null;
    if (drag) { releaseDrag(p, e.type === 'pointercancel'); return; }
    if (e.type !== 'pointerup') return;
    if (p.mode === 'down' && e.clientY - p.y0 > 110 && Math.abs(e.clientX - p.x0) < 90 && zoom === 1) { close(); return; }
    if (!p.mode && performance.now() - p.t < 500) tap(e.clientX);
  }

  function tap(x) {
    if (state !== 'open' || zoom > 1) return;
    hideTip();
    const W = innerWidth, edge = mode === 'page' ? W / 3 : W * 0.4;
    if (x > W - edge) turn(1);
    else if (x < edge) turn(-1);
    else root.classList.toggle('is-bare');                    // middle: chrome off / on
  }

  function onKey(e) {
    if (trapTab(root, e)) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (state !== 'open') return;
    const k = e.key;
    if (k === 'ArrowRight' || k === 'PageDown') { e.preventDefault(); resetZoom(); turn(1); }
    else if (k === 'ArrowLeft' || k === 'PageUp') { e.preventDefault(); resetZoom(); turn(-1); }
    else if (k === 'Home') { e.preventDefault(); resetZoom(); jump(0); }
    else if (k === 'End') { e.preventDefault(); resetZoom(); jump(S - 1); }
  }

  /* ---------------------------------------------------------------- rendering */
  function setLeafUniforms(mesh, i, zNear = 0, zFar = 0) {
    const u = mesh.material.uniforms;
    const [f, b] = facesOf(i);
    u.uSize.value.set(Wp, Hp);
    store.get(f, u.uFront, u.uFrontRect);
    if (mode === 'page') {
      u.uGhost.value = 1;
      u.uBack.value = u.uFront.value;
      u.uBackRect.value.copy(u.uFrontRect.value);
    } else {
      u.uGhost.value = 0;
      store.get(b, u.uBack, u.uBackRect);
    }
    u.uZNear.value = zNear;
    u.uZFar.value = zFar;
    u.uSelfK.value = 0;
    u.uCastN.value = 0;
    u.uGutter.value = mode === 'page' ? 0.55 : 1;
  }

  function assign(folds) {
    let leftTop = -1, rightTop = -1;
    for (let i = 0; i < L; i++) {
      const lf = leaves[i];
      if (lf.act) continue;
      if (lf.side === 1) leftTop = i;
      else if (rightTop < 0 && hasFront(i)) rightTop = i;
    }
    const lonely = mode === 'spread' && active.length === 0 && (leftTop < 0 || rightTop < 0);
    const casters = folds.filter(Boolean).slice(0, 4);
    const setCasts = (u) => {
      u.uCastN.value = casters.length;
      casters.forEach((f, j) => {
        u.uCastFN.value[j].set(f.Fx, f.Fy, f.nx, f.ny);
        u.uCastRK.value[j].set(f.R, f.k);
      });
    };

    staticL.visible = mode === 'spread' && leftTop >= 0;      // portrait: the turned stack is off-screen left
    if (staticL.visible) {
      setLeafUniforms(staticL, leftTop);
      const u = staticL.material.uniforms;
      u.uFold.value = 1; u.uR.value = 0; u.uF.value.set(0, 0); u.uN.value.set(1, 0);
      u.uGutter.value = lonely ? 0.3 : 1;
      setCasts(u);
    }
    staticR.visible = rightTop >= 0;
    if (staticR.visible) {
      setLeafUniforms(staticR, rightTop);
      const u = staticR.material.uniforms;
      u.uFold.value = 0;
      if (lonely) u.uGutter.value = 0.3;
      setCasts(u);
    }
    leafMeshes.forEach((m, j) => {
      const a = active[j];
      m.visible = !!a;
      if (!a) return;
      let above = 0, below = 0;
      active.forEach((o) => { if (o !== a) { if (o.i > a.i) above++; else below++; } });
      setLeafUniforms(m, a.i, 0.5 + above * EPS * 2, 0.5 + below * EPS * 2);
      const u = m.material.uniforms, f = folds[j];
      if (f) {
        u.uFold.value = 1; u.uF.value.set(f.Fx, f.Fy); u.uN.value.set(f.nx, f.ny); u.uR.value = f.R;
        u.uSelfK.value = f.k;
      } else {
        u.uFold.value = 0;
      }
    });

    // spreads: page-stack edges + soft contact shadow (portrait is full-bleed: none)
    const spread = mode === 'spread';
    const leftCount = leftTop >= 0 ? leftTop + 1 : 0;
    const rightCount = rightTop >= 0 ? L - rightTop : 0;
    const edge = (mesh, count, sgn) => {
      const t = spread && count ? Math.min(4, 1 + count * 0.06) : 0;
      mesh.visible = t > 0;
      if (!t) return;
      const u = mesh.material.uniforms;
      if (sgn > 0) { u.uPLo.value.set(0, -Hp / 2); u.uPHi.value.set(Wp, Hp / 2); u.uLo.value.set(0, -Hp / 2 - t * 0.7); u.uHi.value.set(Wp + t, Hp / 2 - t * 0.6); }
      else { u.uPLo.value.set(-Wp, -Hp / 2); u.uPHi.value.set(0, Hp / 2); u.uLo.value.set(-Wp - t, -Hp / 2 - t * 0.7); u.uHi.value.set(0, Hp / 2 - t * 0.6); }
      u.uZ.value = -0.8;
    };
    edge(edgeL, leftCount, -1);
    edge(edgeR, rightCount, 1);
    const sxL = leftTop >= 0 ? -Wp - (leftCount ? 2 : 0) : 0, sxR = rightTop >= 0 ? Wp + 2 : 0;
    shadowMesh.visible = spread && sxR > sxL;
    const su = shadowMesh.material.uniforms;
    su.uLo.value.set(sxL + 4, -Hp / 2 - 6);
    su.uHi.value.set(sxR + 4, Hp / 2 - 4);
    su.uPad.value = 18;
    su.uZ.value = -2;
    su.uAlpha.value = 0.13;
  }

  const restGroup = () => ({ x: offsetX, y: restY, sx: 1, sy: 1 });

  function applyGroup() {
    group.position.set(zoom * gt.x + pan.x, zoom * gt.y + pan.y, 0);
    group.scale.set(zoom * gt.sx, zoom * gt.sy, zoom * Math.min(gt.sx, gt.sy));
    group.rotation.set(sway.x, sway.y, 0);
  }

  let frames = 0;
  function onFrame(dt) {
    if (!iss || state === 'closed') return false;
    frames++;
    let busy = false;
    for (const a of active.slice()) if (stepAct(a, dt)) busy = true;
    if (drag) busy = true;

    const to = targetOffset();
    if (Math.abs(to - offsetX) > 0.2 && !reduced) { offsetX += (to - offsetX) * (1 - Math.exp(-6 * dt)); busy = true; }
    else offsetX = to;
    Object.assign(gt, restGroup());

    // tilt: a subtle sway about the binding while motion is live
    const live = motion.live && !reduced && state === 'open';
    const ty = live ? 0.075 * motion.x : 0, tx = live ? -0.05 * motion.y : 0;
    const k = 1 - Math.exp(-8 * dt);
    sway.y += (ty - sway.y) * k; sway.x += (tx - sway.x) * k;
    if (Math.abs(ty - sway.y) > 0.0005 || Math.abs(tx - sway.x) > 0.0005) busy = true;
    else { sway.y = ty; sway.x = tx; }

    applyGroup();
    assign(active.map(foldOf));
    view.renderer.render(scene, camera);
    return busy;
  }

  /* ---------------------------------------------------------------- open / close */
  /** viewport box of the visible page(s) at rest */
  function pageRect() {
    const W = innerWidth, H = innerHeight;
    const ex = extentsOf(committed);
    const g = restGroup();
    const l = W / 2 + g.x + ex.xL, r = W / 2 + g.x + ex.xR;
    const t = H / 2 - (g.y + Hp / 2), b = H / 2 - (g.y - Hp / 2);
    return { x: l, y: t, w: r - l, h: b - t };
  }

  function pixSteps(list, ms) {
    return new Promise((resolve) => {
      let j = 0;
      const step = () => {
        if (j >= list.length || !view) { resolve(); return; }
        pixU.value = list[j++];
        view.invalidate();
        setTimeout(step, ms);
      };
      step();
    });
  }

  function showTip() {
    if (tipDone || reduced) return;
    tipDone = true;
    root.classList.add('has-tip');
    tipT = setTimeout(hideTip, 2600);
  }
  function hideTip() { clearTimeout(tipT); root && root.classList.remove('has-tip'); }

  function warm(entry) {
    if (dead || state !== 'closed' || view) return;
    // build the GL view when the phone is idle, not in the middle of a scroll
    const go = () => { if (!view && !dead && state === 'closed') { ensure() && entry && store.setIssue(entry.iss); } };
    if ('requestIdleCallback' in window) requestIdleCallback(go, { timeout: 600 }); else setTimeout(go, 200);
  }

  async function open(entry) {
    if (state !== 'closed') return;
    if (!ensure()) { liteOpen(entry); return; }
    reduced = !!(reducedMQ && reducedMQ.matches);
    state = 'opening';
    lastFocus = document.activeElement;
    src = entry.el;
    setIssue(entry.iss);
    resetZoom();
    root.classList.remove('is-bare', 'is-zoomed');
    const n = entry.spread ? Math.min(iss.pages, 2 * entry.spread) : 1;     // portrait: left page of the spread
    goSettled(indexFor(n));
    const shown = mode === 'page' ? [committed + 1] : spreadPages(iss, committed);
    const loaded = Promise.race([Promise.all([store.atlasP, ...shown.map((p) => store.request(p))]), wait(320)]);
    await Promise.all([loaded, zoomRects(rectOf(src), pageRect())]);
    if (state !== 'opening' || !view) return;

    pixU.value = reduced ? 0 : 32;
    root.classList.add('is-open');
    modal.on();
    state = 'open';
    unsubMotion = motion.subscribe(() => { if (view && state === 'open') view.invalidate(); });
    root.focus({ preventScroll: true });
    updateUi();
    view.invalidate();
    if (!reduced) await pixSteps([32, 12, 4, 0], 70);
    if (state === 'open') showTip();
  }

  function returnTarget() {
    const n = currentPage();
    const k = n <= 1 ? 0 : Math.floor(n / 2);
    const same = entries.find((en) => en.iss === iss && (k === 0 ? en.kind === 'cover' : en.kind === 'scan' && en.spread === k));
    if (same && rectOf(same.el)) return same.el;
    return src;
  }

  async function close() {
    if (state !== 'open' || !view) return;
    state = 'closing';
    drag = null; press = null; pinch = null; ptrs.clear();
    root.classList.remove('is-dragging');
    active.slice().forEach((a) => settle(a));
    hideTip();
    const target = returnTarget();
    const zoomed = zoom > 1;
    if (!reduced) {
      view.invalidate();
      await pixSteps([4, 12, 32], 45);
    }
    const from = zoomed ? { x: 0, y: 0, w: innerWidth, h: innerHeight } : pageRect();
    finishClose();
    await zoomRects(from, rectOf(target), { shrink: true });
  }

  function finishClose(silent) {
    const hadFocus = root && root.contains(document.activeElement);
    state = 'closed';
    drag = null; press = null; pinch = null; ptrs.clear();
    pixU.value = 0;
    zoom = 1; pan.x = pan.y = 0; sway.x = sway.y = 0;
    if (unsubMotion) { unsubMotion(); unsubMotion = null; }
    if (root) root.classList.remove('is-open', 'is-dragging', 'is-zoomed', 'is-bare', 'has-tip');
    modal.off();
    if (store) store.clear(true);
    const back = src && src.isConnected ? src : lastFocus;
    if (!silent && hadFocus && back && back.focus) back.focus({ preventScroll: true });
  }

  return {
    open, close, warm,
    get usable() { return !dead; },
    get state() { return state; },
    set entries(v) { entries = v; },
    debug: () => ({
      state, mode, committed, page: currentPage(), issue: iss && iss.id, active: active.length, zoom,
      pan: { ...pan }, Wp, Hp, pix: pixU.value, sway: { ...sway },
      fold: drag ? { prog: drag.prog, P: { ...drag.P } } : null, frames,
      size: view && { ...view.size }, vis: [staticL && staticL.visible, staticR && staticR.visible],
    }),
    destroy() { finishClose(true); view && view.destroy(); root && root.remove(); },
  };
}

/* =================================================================== covers: CSS-3D magazines that tilt */
function createCoverTilt(entries) {
  const covers = [];
  let raf = 0, unsub = null;
  const D2R = PI / 180;

  entries.filter((e) => e.kind === 'cover').forEach((e) => {
    const el = e.el, img = el.querySelector('img');
    if (!img) return;
    const mag = document.createElement('div');
    mag.className = 'msec-mag';
    mag.setAttribute('aria-hidden', 'true');
    mag.innerHTML = `
      <div class="msec-mag__shadow"></div>
      <div class="msec-mag__body">
        <div class="msec-mag__face msec-mag__back"></div>
        <div class="msec-mag__face msec-mag__spine"></div>
        <div class="msec-mag__face msec-mag__block msec-mag__block--r"></div>
        <div class="msec-mag__face msec-mag__block msec-mag__block--t"></div>
        <div class="msec-mag__face msec-mag__block msec-mag__block--b"></div>
        <div class="msec-mag__face msec-mag__front"><img alt="" decoding="async"><i class="msec-mag__shade"></i></div>
      </div>`;
    el.appendChild(mag);
    el.classList.add('msec-tilt');
    covers.push({
      el, img, mag, vis: false, loaded: false,
      body: mag.querySelector('.msec-mag__body'),
      front: mag.querySelector('.msec-mag__front img'),
      spine: mag.querySelector('.msec-mag__spine'),
      shade: mag.querySelector('.msec-mag__shade'),
      shadow: mag.querySelector('.msec-mag__shadow'),
    });
  });
  if (!covers.length) return null;

  const size = (c) => {
    const w = c.el.offsetWidth, h = c.el.offsetHeight;
    c.mag.style.setProperty('--w', `${w}px`);
    c.mag.style.setProperty('--h', `${h}px`);
    c.mag.style.setProperty('--t', `${Math.max(8, Math.round(w * 0.045))}px`);
  };
  const load = (c) => {
    if (c.loaded) return;
    c.loaded = true;
    const s = c.img.currentSrc || c.img.src;
    c.front.addEventListener('load', () => c.el.classList.add('msec-ready'), { once: true });
    c.front.src = s;
    c.spine.style.backgroundImage = `url("${s}")`;
  };

  function update() {
    raf = 0;
    if (document.documentElement.dataset.fxModal) return;
    const H = innerHeight, live = motion.live;
    covers.forEach((c) => {
      if (!c.vis) return;
      const r = c.el.getBoundingClientRect();
      // -1 entering from below .. +1 leaving at the top
      const p = clamp((H / 2 - (r.top + r.height / 2)) / (H / 2 + r.height / 2), -1, 1);
      let ry, rx;
      if (live) { ry = 18 * motion.x + 4 * p; rx = -10 * motion.y - 3 * p; }
      else { ry = 13 * p; rx = -5 * p; }
      ry = clamp(ry, -22, 22); rx = clamp(rx, -14, 14);
      c.body.style.transform = `rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg)`;
      // ink only: the face darkens a little as it turns away, the contact shadow slides opposite the turn
      const away = 1 - Math.cos(Math.max(Math.abs(ry), Math.abs(rx)) * D2R);
      c.shade.style.opacity = (Math.min(0.2, away * 2.2 + (ry < 0 ? -ry * 0.002 : 0))).toFixed(3);
      c.shadow.style.transform = `translate(${(-ry * 0.45).toFixed(1)}px, ${(6 + rx * 0.4).toFixed(1)}px)`;
    });
  }
  const schedule = () => { if (!raf) raf = requestAnimationFrame(update); };

  const io = new IntersectionObserver((list) => {
    list.forEach((en) => {
      const c = covers.find((x) => x.el === en.target);
      if (!c) return;
      if (en.isIntersecting) load(c);
      c.vis = en.isIntersecting;
    });
    const any = covers.some((c) => c.vis);
    if (any && !unsub) unsub = motion.subscribe(schedule);
    if (!any && unsub) { unsub(); unsub = null; }
    schedule();
  }, { rootMargin: '60% 0px' });
  covers.forEach((c) => { size(c); io.observe(c.el); });
  const ro = new ResizeObserver(() => { covers.forEach(size); schedule(); });
  covers.forEach((c) => ro.observe(c.el));
  addEventListener('scroll', schedule, { passive: true });
  addEventListener('resize', schedule, { passive: true });

  return {
    covers, update: schedule,
    destroy() {
      io.disconnect(); ro.disconnect();
      removeEventListener('scroll', schedule); removeEventListener('resize', schedule);
      if (unsub) unsub();
      cancelAnimationFrame(raf);
      covers.forEach((c) => { c.mag.remove(); c.el.classList.remove('msec-tilt', 'msec-ready'); });
    },
  };
}

/* =================================================================== mount */
export async function mount(ctx) {
  try {
    const { THREE, core } = ctx;
    if (!document.querySelector('.security-page .sec-issue')) return;
    const lite = createLite();
    const liteOpen = async (entry) => {
      await zoomRects(rectOf(entry.el), { x: 0, y: 0, w: innerWidth, h: innerHeight });
      lite.open(entry);
    };
    let reader = null;
    if (THREE) {
      try { reader = createReader(THREE, core, lite, liteOpen); } catch (err) { console.warn('[fx] m-flipbook reader', err); }
    }
    let asking = false;
    const wiring = wireEntries({
      async open(entry) {
        if (asking || lite.isOpen) return;
        // the first tap on a cover is where motion is asked for (iOS: the KRISHA.EXE dialog, then the system prompt)
        if (entry.kind === 'cover' && motionState() === 'needs-tap') {
          asking = true;
          try { await enableMotion({ ask: true }); } catch (err) { /* stays off */ }
          asking = false;
        }
        if (reader && reader.usable) reader.open(entry);
        else liteOpen(entry);
      },
      warm(entry) { reader && reader.usable && reader.warm(entry); },
    });
    if (reader) reader.entries = wiring.entries;
    let tilt = null;
    if (core.motionOK) {
      try { tilt = createCoverTilt(wiring.entries); } catch (err) { console.warn('[fx] m-flipbook covers', err); }
    }
    return {
      reader, lite, tilt, entries: wiring.entries,
      destroy() { wiring.destroy(); reader && reader.destroy(); tilt && tilt.destroy(); lite.destroy(); },
    };
  } catch (err) {
    console.warn('[fx] m-flipbook', err);
  }
}
