/*
 * fx/flipbook.js — Security magazine you can flip (GL, desktop). Falls back to fx/flipbook-lite.js.
 *
 * Viewer: a full-viewport white overlay (z --fx-z-viewer) with a three.js open magazine. Pages are planes in book
 * space (1 world unit = 1 CSS px at z = 0, spine at x = 0). A turning leaf is deformed in the vertex shader by a
 * cylindrical wrap around a moving fold line: points past the fold roll around a cylinder of radius R and continue
 * flat on the other side, so the grabbed point G lands exactly under the pointer P. The fold is the perpendicular
 * bisector of G and P, shifted by piR/2; the leaf stays bound at the spine (P is clamped to discs around the spine
 * ends and R is limited so the fold never crosses the binding). Shading is ink only (darkening, never brighter):
 * curl normal, gutter, a soft shadow on the revealed page and around the lifted flap. No glow.
 *
 * Interaction: drag a page (edge/corner or anywhere on it) to turn; release past the spine (or flick) completes,
 * otherwise it falls back. Click left/right page, arrow keys, PageUp/Down, Home/End, wheel, "<" ">" also turn.
 * Esc / CLOSE / click outside the book closes. Focus trap; html[data-fx-modal="flipbook"] while open;
 * data-cursor="drag" on the book, "close" on the backdrop. Opening grows the book out of the clicked element
 * (FLIP) and closing returns it into the matching slot (the scan of the current spread, the cover, or the origin).
 *
 * Cover peek: hovering an issue cover swaps the DOM image for an identical GL magazine whose front cover lifts open
 * a few degrees (more toward the pointer) and tilts with it; at rest the DOM image is shown, so the page is unchanged.
 *
 * Pages load lazily (current spread +/- 2) over a per-issue thumbnail atlas that is shown until they arrive.
 */
import { ISSUES } from './security-book.js';
import {
  wireEntries, createLite, pageSrc, atlasSrc, spreadCount, spreadPages, counterText, issueName,
  modalState, trapTab,
} from './flipbook-lite.js';

const PI = Math.PI;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const easeOut = (t) => (t >= 1 ? 1 : 1 - Math.pow(1 - t, 4));
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function loadImg(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      if (img.decode) img.decode().catch(() => {}).then(() => resolve(img));
      else resolve(img);
    };
    img.onerror = () => reject(new Error(`[fx] flipbook: ${src}`));
    img.src = src;
  });
}

/* =================================================================== shaders */
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
  vec2 uv = vec2(vQ.x / uSize.x, vQ.y / uSize.y + 0.5);
  vec3 col;
  vec3 N;
  if (gl_FrontFacing) {
    col = texture2D(uFront, uFrontRect.xy + uv * uFrontRect.zw).rgb;
    N = vNrm;
  } else {
    col = texture2D(uBack, uBackRect.xy + vec2(1.0 - uv.x, uv.y) * uBackRect.zw).rgb;
    N = -vNrm;
  }
  // ink-only shading: the curl darkens as it turns away from an overhead, slightly top-left light
  float shade = 1.0 - 0.46 * (1.0 - clamp(N.z, 0.0, 1.0)) + 0.18 * dot(N.xy, vec2(-0.6, 0.8));
  // gutter: paper curving into the binding
  shade *= 1.0 - uGutter * (0.26 * exp(-uv.x * 34.0) + 0.08 * exp(-uv.x * 6.0));
  // this leaf's own lifted flap shading its flat part
  if (uSelfK > 0.0 && vS <= 0.0) {
    vec2 src = vQ + (PI * uR - 2.0 * vS) * uN;
    shade *= 1.0 - uSelfK * 0.30 * (1.0 - smoothstep(0.0, 3.0 + 0.8 * uR, sdPage(src)));
  }
  // shadows of turning leaves on the pages below
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

/* page-stack edges: fine stripes of paper under the outer edges */
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

/* soft contact shadow of the whole book on the white backdrop */
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

/* =================================================================== texture store */
function createStore(THREE, renderer, onChange) {
  const FULL = new THREE.Vector4(0, 0, 1, 1);
  const white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  white.colorSpace = THREE.SRGBColorSpace;
  white.needsUpdate = true;
  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
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

  /** load pages of spreads k-2..k+2 (nearest first) and drop far ones */
  function want(k) {
    if (!iss) return;
    const lo = Math.max(1, 2 * (k - 2)), top = Math.min(iss.pages, 2 * (k + 2) + 1);
    const list = [];
    for (let n = lo; n <= top; n++) list.push(n);
    list.sort((a, b) => Math.abs(a - (2 * k + 0.5)) - Math.abs(b - (2 * k + 0.5)));
    list.forEach(request);
    if (hi.size > 16) {
      hi.forEach((e, n) => {
        if (n < lo - 4 || n > top + 4) { e.tex && e.tex.dispose(); hi.delete(n); }
      });
    }
  }

  function cell(n, v) {
    const a = iss.atlas, j = n - 1, c = j % a.cols, r = Math.floor(j / a.cols);
    const ix = 0.75 / a.w, iy = 0.75 / a.h;
    v.set(c * a.cw / a.w + ix, 1 - (r + 1) * a.ch / a.h + iy, a.cw / a.w - 2 * ix, a.ch / a.h - 2 * iy);
  }

  /** texture + uv rect for page n (0 / out of range = blank paper) */
  function get(n, uTex, uRect) {
    if (!iss || !n || n < 1 || n > iss.pages) { uTex.value = white; uRect.value.copy(FULL); return; }
    const e = hi.get(n);
    if (e && e.tex) { uTex.value = e.tex; uRect.value.copy(FULL); return; }
    if (atlas) { uTex.value = atlas; cell(n, uRect.value); return; }
    uTex.value = white; uRect.value.copy(FULL);
  }

  return { setIssue, request, want, get, clear, white, get atlasP() { return atlasP; } };
}

/* =================================================================== viewer */
function createViewer(THREE, core, lite) {
  const html = document.documentElement;
  const modal = modalState('flipbook');
  const EPS = 0.35;          // z separation between stacked leaves (px)
  const MAX_ACTIVE = 4;

  let root = null, backdrop, stage, hit, nameEl, countEl, prevBtn, nextBtn, closeBtn;
  let view = null, dead = false, scene, camera, group, store;
  let leafMeshes = [], staticL, staticR, edgeL, edgeR, shadowMesh;
  let iss = null, L = 0, S = 1, leaves = [], active = [], committed = 0;
  let Wp = 300, Hp = 400, Rmax = 40, restY = 0, offsetX = 0;
  let state = 'closed', anim = null, src = null, holdEl = null, drag = null, press = null;
  let wheelAcc = 0, wheelT = 0, wheelTurnT = 0, lastFocus = null;
  let entries = [];
  const gt = { x: 0, y: 0, sx: 1, sy: 1 };   // group transform (book -> world)

  /* ---------------------------------------------------------------- setup */
  function buildDom() {
    root = document.createElement('div');
    root.className = 'sec-book';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.tabIndex = -1;
    root.innerHTML = `
      <div class="sec-book__backdrop" data-cursor="close"></div>
      <div class="sec-book__stage"></div>
      <div class="sec-book__hit" data-cursor="drag" aria-hidden="true"></div>
      <div class="sec-book__bar">
        <span class="sec-book__name"></span>
        <button type="button" class="sec-book__close">CLOSE</button>
      </div>
      <div class="sec-book__nav">
        <button type="button" class="sec-book__prev" aria-label="Previous pages">&lt;</button>
        <span class="sec-book__count" aria-live="polite"></span>
        <button type="button" class="sec-book__next" aria-label="Next pages">&gt;</button>
      </div>`;
    backdrop = root.querySelector('.sec-book__backdrop');
    stage = root.querySelector('.sec-book__stage');
    hit = root.querySelector('.sec-book__hit');
    nameEl = root.querySelector('.sec-book__name');
    countEl = root.querySelector('.sec-book__count');
    prevBtn = root.querySelector('.sec-book__prev');
    nextBtn = root.querySelector('.sec-book__next');
    closeBtn = root.querySelector('.sec-book__close');
    closeBtn.addEventListener('click', () => close());
    prevBtn.addEventListener('click', () => turn(-1));
    nextBtn.addEventListener('click', () => turn(1));
    backdrop.addEventListener('click', () => { if (!drag) close(); });
    root.addEventListener('keydown', onKey);
    root.addEventListener('wheel', onWheel, { passive: false });
    hit.addEventListener('pointerdown', onDown);
    hit.addEventListener('pointermove', onMove);
    hit.addEventListener('pointerup', onUp);
    hit.addEventListener('pointercancel', onUp);
    hit.addEventListener('lostpointercapture', (e) => { if (press && press.id === e.pointerId) onUp(e); });
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
        THREE, host: stage, observe: null, dprMax: 2, pixelBudget: 6.5e6,
        onResize, onFrame, onFail,
      });
    } catch (err) {
      console.warn('[fx] flipbook: no GL view', err);
      dead = true;
      return false;
    }
    view.canvas.style.opacity = '0';
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(20, 1, 10, 10000);
    onResize(view.size);
    group = new THREE.Group();
    scene.add(group);
    store = createStore(THREE, view.renderer, () => view && view.invalidate());
    const geo = new THREE.PlaneGeometry(1, 1, 96, 48);
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
    return true;
  }

  function onFail() {
    // GL gave up (slow / context lost): hand the reader to the lite viewer at the same spread.
    dead = true;
    view = null;
    const wasOpen = state !== 'closed';
    const entry = { iss, spread: committed, el: src };
    finishClose(true);
    if (wasOpen && iss) lite.open(entry);
  }

  /* ---------------------------------------------------------------- layout */
  function computeLayout() {
    if (!iss) return;
    const W = innerWidth, H = innerHeight;
    const top = Math.max(70, H * 0.1), bottom = Math.max(70, H * 0.1), side = Math.max(48, W * 0.06);
    const aspect = iss.w / iss.h;
    Hp = Math.max(100, Math.min(H - top - bottom, (W - 2 * side) / (2 * aspect)));
    Wp = Hp * aspect;
    restY = (bottom - top) / 2;
    Rmax = 0.12 * Wp;
  }

  function onResize({ width, height }) {
    if (!camera) return; // createView sizes once before the camera exists
    camera.aspect = width / height;
    const d = (height / 2) / Math.tan((camera.fov * PI) / 360);
    camera.position.set(0, 0, d);
    camera.near = d * 0.05;
    camera.far = d * 4;
    camera.updateProjectionMatrix();
    const pW = Wp;
    computeLayout();
    if (Math.abs(pW - Wp) > 0.5) {
      active.slice().forEach((a) => settle(a));
      drag = null;
      offsetX = targetOffset();
    }
  }

  /* ---------------------------------------------------------------- book state */
  function setIssue(next) {
    if (iss !== next) {
      iss = next;
      L = Math.ceil(iss.pages / 2);
      S = spreadCount(iss);
      store.setIssue(iss);
      nameEl.textContent = issueName(iss);
      root.setAttribute('aria-label', `Security Issue ${iss.id} — flip-through magazine`);
    }
    computeLayout();
  }

  function goSettled(k) {
    committed = clamp(k, 0, S - 1);
    active.length = 0;
    leaves = [];
    for (let i = 0; i < L; i++) leaves.push({ side: i < committed ? 1 : 0, act: null });
    offsetX = targetOffset();
    store.want(committed);
    updateUi();
  }

  const extentsOf = (k) => ({ xL: k >= 1 ? -Wp : 0, xR: 2 * k + 1 <= iss.pages ? Wp : 0 });
  function targetOffset() { const e = extentsOf(committed); return -(e.xL + e.xR) / 2; }

  function visualExtents() {
    let left = false, right = false;
    for (let i = 0; i < L; i++) {
      const lf = leaves[i];
      if (lf.act) { left = right = true; break; }
      if (lf.side === 1) left = true; else if (2 * i + 1 <= iss.pages) right = true;
    }
    return { xL: left ? -Wp : 0, xR: right ? Wp : 0 };
  }

  function updateUi() {
    if (!iss) return;
    countEl.textContent = counterText(iss, committed);
    prevBtn.disabled = committed <= 0;
    nextBtn.disabled = committed >= S - 1;
  }

  /* ---------------------------------------------------------------- leaf physics */
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

  /** fold line of a leaf whose grabbed point G is at P: {Fx,Fy,nx,ny,R,u,k} or null when flat on the right */
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
    if (a) {                                   // already moving: retarget smoothly
      if (a.mode === 'auto') {
        a.phi0 = a.phi; a.phi1 = to; a.t = 0; a.dur = Math.max(0.25, 0.8 * Math.abs(a.phi1 - a.phi0));
      } else {
        a.mode = 'spring';
        a.T = to ? { x: -a.G.x, y: a.G.y } : { x: a.G.x, y: a.G.y };
      }
      a.to = to;
      return;
    }
    const y = clamp(gy != null ? gy : -Hp * (0.14 + Math.random() * 0.14), -Hp * 0.42, Hp * 0.42);
    const G = { x: Wp, y };
    const busy = active.length > 0;
    a = {
      i, G, to, mode: 'auto',
      P: to ? { x: G.x, y: G.y } : { x: -G.x, y: G.y },
      V: { x: 0, y: 0 },
      phi: to ? 0 : 1, phi0: to ? 0 : 1, phi1: to, t: 0,
      dur: busy ? 0.62 : 0.95,
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
      const f = 1 - Math.exp(-30 * dt);
      a.P.x += (a.target.x - a.P.x) * f;
      a.P.y += (a.target.y - a.P.y) * f;
      clampP(a.P, a.G);
    } else {                                   // spring toward T
      const K = 120, C = 2 * Math.sqrt(K) * 0.9;
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
    if (dir > 0) {
      if (committed >= S - 1) return;
      const i = committed++;
      startTurn(i, 1, gy);
    } else {
      if (committed <= 0) return;
      const i = --committed;
      startTurn(i, 0, gy);
    }
    store.want(committed);
    updateUi();
    view.invalidate();
  }

  function jump(k) {
    if (state !== 'open') return;
    k = clamp(k, 0, S - 1);
    if (k === committed) return;
    const dir = Math.sign(k - committed);
    // turn the nearest leaves visibly, settle the rest
    while (Math.abs(k - committed) > 2) {
      if (dir > 0) leaves[committed++].side = 1; else leaves[--committed].side = 0;
    }
    while (committed !== k) turn(dir);
  }

  /* ---------------------------------------------------------------- pointer */
  const toBook = (cx, cy) => ({
    x: (cx - innerWidth / 2 - gt.x) / gt.sx,
    y: (innerHeight / 2 - cy - gt.y) / gt.sy,
  });

  function onDown(e) {
    if (state !== 'open' || e.button > 0) return;
    e.preventDefault();
    press = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), b: toBook(e.clientX, e.clientY),
      last: null, v: { x: 0, y: 0 } };
    try { hit.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  }

  function beginDrag() {
    const b = press.b;
    if (active.length) return null;            // a page is already in flight: clicks still queue turns
    let i, G, P0;
    if (b.x >= 0) {
      if (committed >= S - 1) return null;
      i = committed;
      G = { x: Math.max(b.x, 0.3 * Wp), y: clamp(b.y, -Hp / 2, Hp / 2) };
      P0 = { x: G.x, y: G.y };
    } else {
      if (committed <= 0) return null;
      i = committed - 1;
      G = { x: Math.max(-b.x, 0.3 * Wp), y: clamp(b.y, -Hp / 2, Hp / 2) };
      P0 = { x: -G.x, y: G.y };
    }
    const a = {
      i, G, P: { ...P0 }, V: { x: 0, y: 0 }, mode: 'drag', to: b.x >= 0 ? 0 : 1, dir: b.x >= 0 ? 1 : -1,
      off: { x: P0.x - b.x, y: P0.y - b.y }, target: { ...P0 },
    };
    leaves[i].act = a;
    active.push(a);
    root.classList.add('is-dragging');
    return a;
  }

  function onMove(e) {
    if (!press || e.pointerId !== press.id) return;
    const b = toBook(e.clientX, e.clientY);
    const now = performance.now();
    if (press.last) {
      const dt = Math.max(1, now - press.last.t) / 1000;
      press.v.x = press.v.x * 0.5 + ((b.x - press.last.x) / dt) * 0.5;
      press.v.y = press.v.y * 0.5 + ((b.y - press.last.y) / dt) * 0.5;
    }
    press.last = { x: b.x, y: b.y, t: now };
    press.now = b;
    if (!drag && !press.blocked && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 6) {
      drag = beginDrag();
      if (!drag) press.blocked = true;
    }
    if (drag) {
      drag.target.x = b.x + drag.off.x;
      drag.target.y = drag.G.y + (b.y + drag.off.y - drag.G.y) * 0.6;   // paper resists vertical pulls
      clampP(drag.target, drag.G);
      view.invalidate();
    }
  }

  function onUp(e) {
    if (!press || (e.pointerId != null && e.pointerId !== press.id)) return;
    const p = press;
    press = null;
    try { hit.releasePointerCapture(p.id); } catch (err) { /* ignore */ }
    root.classList.remove('is-dragging');
    if (drag) {
      const a = drag;
      const b = p.now || p.b;
      const vx = clamp(p.v.x, -4000, 4000), vy = clamp(p.v.y, -4000, 4000);
      let done;
      if (a.dir > 0) done = b.x < 0 || (vx < -700 && b.x < a.G.x - 0.15 * Wp);
      else done = b.x > 0 || (vx > 700 && b.x > -a.G.x + 0.15 * Wp);
      a.mode = 'spring';
      a.V = { x: vx * 0.6, y: vy * 0.6 };
      if (a.dir > 0) {
        a.to = done ? 1 : 0;
        if (done) committed = a.i + 1;
      } else {
        a.to = done ? 0 : 1;
        if (done) committed = a.i;
      }
      a.T = a.to ? { x: -a.G.x, y: a.G.y } : { x: a.G.x, y: a.G.y };
      drag = null;
      store.want(committed);
      updateUi();
      view.invalidate();
      // swallow the click that follows a drag
      const stop = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
      window.addEventListener('click', stop, { capture: true, once: true });
      setTimeout(() => window.removeEventListener('click', stop, { capture: true }), 0);
      return;
    }
    if (e.type === 'pointerup' && performance.now() - p.t < 600) {
      turn(p.b.x >= 0 ? 1 : -1, clamp(p.b.y, -Hp * 0.42, Hp * 0.42));
    }
  }

  function onWheel(e) {
    if (state !== 'open') return;
    e.preventDefault();
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    const now = performance.now();
    if (now - wheelT > 220) wheelAcc = 0;
    wheelT = now;
    wheelAcc += d;
    if (Math.abs(wheelAcc) > 50 && now - wheelTurnT > 420) {
      turn(Math.sign(wheelAcc));
      wheelAcc = 0;
      wheelTurnT = now;
    }
  }

  function onKey(e) {
    if (trapTab(root, e)) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (state !== 'open') return;
    const k = e.key;
    if (k === 'ArrowRight' || k === 'PageDown' || (k === ' ' && !e.shiftKey && e.target === root)) { e.preventDefault(); turn(1); }
    else if (k === 'ArrowLeft' || k === 'PageUp' || (k === ' ' && e.shiftKey && e.target === root)) { e.preventDefault(); turn(-1); }
    else if (k === 'Home') { e.preventDefault(); jump(0); }
    else if (k === 'End') { e.preventDefault(); jump(S - 1); }
  }

  /* ---------------------------------------------------------------- rendering */
  function setLeafUniforms(mesh, i, zNear = 0, zFar = 0) {
    const u = mesh.material.uniforms;
    u.uSize.value.set(Wp, Hp);
    store.get(2 * i + 1, u.uFront, u.uFrontRect);
    store.get(2 * i + 2, u.uBack, u.uBackRect);
    u.uZNear.value = zNear;
    u.uZFar.value = zFar;
    u.uSelfK.value = 0;
    u.uCastN.value = 0;
    u.uGutter.value = 1;
  }

  function assign(folds) {
    let leftTop = -1, rightTop = -1;
    for (let i = 0; i < L; i++) {
      const lf = leaves[i];
      if (lf.act) continue;
      if (lf.side === 1) leftTop = i;
      else if (rightTop < 0 && 2 * i + 1 <= iss.pages) rightTop = i;
    }
    const lonely = active.length === 0 && (leftTop < 0 || rightTop < 0);   // closed cover / back cover

    const casters = folds.filter(Boolean).slice(0, 4);
    const setCasts = (u) => {
      u.uCastN.value = casters.length;
      casters.forEach((f, j) => {
        u.uCastFN.value[j].set(f.Fx, f.Fy, f.nx, f.ny);
        u.uCastRK.value[j].set(f.R, f.k);
      });
    };

    staticL.visible = leftTop >= 0;
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
      u.uGutter.value = lonely ? 0.3 : 1;
      setCasts(u);
    }
    leafMeshes.forEach((m, j) => {
      const a = active[j];
      m.visible = !!a;
      if (!a) return;
      // stacking among pages in flight: on the right the lower leaf lies on top, on the left the higher one
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

    // page-stack edges + contact shadow
    const leftCount = leftTop >= 0 ? leftTop + 1 : 0;
    const rightCount = rightTop >= 0 ? L - rightTop : 0;
    const edge = (mesh, count, sgn) => {
      const t = count ? Math.min(5, 1 + count * 0.07) : 0;
      mesh.visible = t > 0;
      if (!t) return;
      const u = mesh.material.uniforms;
      if (sgn > 0) { u.uPLo.value.set(0, -Hp / 2); u.uPHi.value.set(Wp, Hp / 2); u.uLo.value.set(0, -Hp / 2 - t * 0.7); u.uHi.value.set(Wp + t, Hp / 2 - t * 0.6); }
      else { u.uPLo.value.set(-Wp, -Hp / 2); u.uPHi.value.set(0, Hp / 2); u.uLo.value.set(-Wp - t, -Hp / 2 - t * 0.7); u.uHi.value.set(0, Hp / 2 - t * 0.6); }
      u.uZ.value = -0.8;
    };
    edge(edgeL, leftCount, -1);
    edge(edgeR, rightCount, 1);
    // contact shadow under the pages lying flat (not under empty paper space while the cover turns)
    const sxL = leftTop >= 0 ? -Wp - (leftCount ? 2 : 0) : 0, sxR = rightTop >= 0 ? Wp + 2 : 0;
    shadowMesh.visible = sxR > sxL;
    const su = shadowMesh.material.uniforms;
    su.uLo.value.set(sxL + 5, -Hp / 2 - 7);
    su.uHi.value.set(sxR + 5, Hp / 2 - 5);
    su.uPad.value = 26;
    su.uZ.value = -2;
    su.uAlpha.value = 0.13;
    return visualExtents();
  }

  function applyGroup() {
    group.position.set(gt.x, gt.y, 0);
    group.scale.set(gt.sx, gt.sy, Math.min(gt.sx, gt.sy));
  }

  let hitRect = { l: 0, t: 0, w: 0, h: 0 };
  function updateHit(ex) {
    const W = innerWidth, H = innerHeight;
    const l = W / 2 + gt.x + gt.sx * ex.xL, r = W / 2 + gt.x + gt.sx * ex.xR;
    const t = H / 2 - (gt.y + gt.sy * Hp / 2), b = H / 2 - (gt.y - gt.sy * Hp / 2);
    const n = { l: Math.round(l - 6), t: Math.round(t - 6), w: Math.round(r - l + 12), h: Math.round(b - t + 12) };
    if (n.l !== hitRect.l || n.t !== hitRect.t || n.w !== hitRect.w || n.h !== hitRect.h) {
      hitRect = n;
      hit.style.transform = `translate(${n.l}px, ${n.t}px)`;
      hit.style.width = `${Math.max(0, n.w)}px`;
      hit.style.height = `${Math.max(0, n.h)}px`;
    }
  }

  function rectGroup(rect, ex) {
    const W = innerWidth, H = innerHeight;
    const x0 = rect.left - W / 2, x1 = rect.right - W / 2;
    const y0 = H / 2 - rect.bottom, y1 = H / 2 - rect.top;
    const sx = (x1 - x0) / Math.max(1, ex.xR - ex.xL), sy = (y1 - y0) / Hp;
    return { x: x0 - sx * ex.xL, y: (y0 + y1) / 2, sx, sy };
  }
  const restGroup = () => ({ x: offsetX, y: restY, sx: 1, sy: 1 });
  const lerpG = (a, b, e) => ({ x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e, sx: a.sx + (b.sx - a.sx) * e, sy: a.sy + (b.sy - a.sy) * e });

  function onFrame(dt) {
    if (!iss || state === 'closed') return false;
    let busy = false;

    for (const a of active.slice()) if (stepAct(a, dt)) busy = true;
    if (drag) busy = true;

    const to = targetOffset();
    if (Math.abs(to - offsetX) > 0.2) { offsetX += (to - offsetX) * (1 - Math.exp(-6 * dt)); busy = true; } else offsetX = to;

    if (anim) {
      busy = true;
      anim.t = Math.min(1, anim.t + dt / anim.dur);
      if (anim.kind === 'open') {
        Object.assign(gt, lerpG(anim.from, restGroup(), easeOut(anim.t)));
        const op = clamp(anim.t / 0.16, 0, 1);
        view.canvas.style.opacity = String(op);
        if (op >= 1 && src && !holdEl) { holdEl = src; holdEl.classList.add('sec-fx-hold'); }
        if (anim.t >= 1) { anim = null; state = 'open'; }
      } else {
        const e = easeInOut(anim.t);
        if (anim.to) Object.assign(gt, lerpG(anim.from, anim.to, e));
        else Object.assign(gt, lerpG(anim.from, { ...anim.from, sx: anim.from.sx * 0.92, sy: anim.from.sy * 0.92 }, e));
        const fadeFrom = anim.to ? 0.74 : 0.2;
        const op = anim.t < fadeFrom ? 1 : 1 - (anim.t - fadeFrom) / (1 - fadeFrom);
        view.canvas.style.opacity = String(clamp(op, 0, 1));
        if (anim.t >= fadeFrom && holdEl) { holdEl.classList.remove('sec-fx-hold'); holdEl = null; }
        if (anim.t >= 1) { finishClose(); return false; }
      }
    } else {
      Object.assign(gt, restGroup());
    }

    applyGroup();
    const folds = active.map(foldOf);
    const ex = assign(folds);
    updateHit(ex);
    view.renderer.render(scene, camera);
    return busy;
  }

  /* ---------------------------------------------------------------- open / close */
  function onScreen(el) {
    if (!el || !el.isConnected) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return null;
    return r;
  }

  function warm(entry) {
    if (dead || state !== 'closed') return;
    if (!ensure()) return;
    setIssue(entry.iss);
    const [l, r] = spreadPages(entry.iss, entry.spread);
    store.request(l); store.request(r);
  }

  async function open(entry) {
    if (state !== 'closed') return;
    if (!ensure()) { lite.open(entry); return; }
    state = 'opening';
    lastFocus = document.activeElement;
    src = entry.el;
    setIssue(entry.iss);
    goSettled(entry.spread);
    const [l, r] = spreadPages(iss, committed);
    await Promise.race([Promise.all([store.atlasP, store.request(l), store.request(r)]), wait(420)]);
    if (state !== 'opening' || !view) return;

    root.classList.add('is-mounted');
    modal.on();
    computeLayout();
    offsetX = targetOffset();
    const rect = onScreen(src);
    const ex = extentsOf(committed);
    const from = rect ? rectGroup(rect, ex) : { ...restGroup(), sx: 0.94, sy: 0.94 };
    Object.assign(gt, from);
    anim = { kind: 'open', t: 0, dur: 0.9, from };
    view.canvas.style.opacity = '0';
    root.focus({ preventScroll: true });
    requestAnimationFrame(() => root.classList.add('is-open'));
    view.wake(1400);
    view.invalidate();
  }

  function returnTarget() {
    const mine = entries.filter((en) => en.iss === iss);
    const same = mine.find((en) => en.spread === committed && (committed === 0 ? en.kind === 'cover' : en.kind === 'scan'));
    if (same && onScreen(same.el)) return same.el;
    return src;
  }

  function close() {
    if (state === 'closing' || state === 'closed' || !view) return;
    if (state === 'opening' && !anim) { finishClose(); return; }  // still loading
    if (drag) { drag = null; root.classList.remove('is-dragging'); }
    press = null;
    active.slice().forEach((a) => settle(a));
    offsetX = targetOffset();
    const target = returnTarget();
    if (target !== src) {
      if (holdEl) { holdEl.classList.remove('sec-fx-hold'); holdEl = null; }
      src = target;
    }
    if (src && !holdEl) { holdEl = src; holdEl.classList.add('sec-fx-hold'); }
    const rect = onScreen(src);
    const from = { ...gt };
    anim = { kind: 'close', t: 0, dur: 0.66, from, to: rect ? rectGroup(rect, extentsOf(committed)) : null };
    state = 'closing';
    root.classList.remove('is-open');
    view.wake(1000);
    view.invalidate();
  }

  function finishClose(silent) {
    const hadFocus = root && root.contains(document.activeElement);
    anim = null;
    state = 'closed';
    drag = null;
    press = null;
    if (holdEl) { holdEl.classList.remove('sec-fx-hold'); holdEl = null; }
    if (root) { root.classList.remove('is-open', 'is-mounted', 'is-dragging'); }
    if (view) view.canvas.style.opacity = '0';
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
    debug: () => ({ state, committed, issue: iss && iss.id, active: active.length, Wp, Hp, gt: { ...gt } }),
    destroy() { finishClose(true); view && view.destroy(); root && root.remove(); },
  };
}

/* =================================================================== cover peek */
function createPeek(THREE, core) {
  let view = null, dead = false, host = null;
  let scene, camera, group, cover, coverMat, block, blockTop, gap, gapMat, drop, dropMat;
  let entry = null, ready = false, live = false;
  let hover = 0, hoverT = 0, nx = 0, ny = 0, tnx = 0, tny = 0;
  let w = 1, h = 1, T = 4;
  const cache = new Map();

  function canvasTex(draw, cw, ch) {
    const c = document.createElement('canvas');
    c.width = cw; c.height = ch;
    draw(c.getContext('2d'), cw, ch);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  function ensure() {
    if (view) return true;
    if (dead) return false;
    host = document.createElement('div');
    host.className = 'sec-peek';
    host.setAttribute('aria-hidden', 'true');
    try {
      view = core.createView({ THREE, host, observe: null, dprMax: 2, onResize, onFrame, onFail: () => { dead = true; hideNow(); view = null; } });
    } catch (err) {
      dead = true;
      return false;
    }
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(22, 1, 1, 10000);
    onResize(view.size);
    group = new THREE.Group();
    scene.add(group);
    const side = new THREE.MeshBasicMaterial({ color: 0xdedede });
    const edge = new THREE.MeshBasicMaterial({ color: 0xcfcfcf });
    blockTop = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const bottom = new THREE.MeshBasicMaterial({ color: 0xffffff });
    block = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), [side, side, edge, edge, blockTop, bottom]);
    gapMat = new THREE.MeshBasicMaterial({
      color: 0x000000, transparent: true, opacity: 0, depthWrite: false,
      map: canvasTex((g, cw, ch) => {
        const gr = g.createLinearGradient(0, 0, cw, 0);
        gr.addColorStop(0, 'rgba(0,0,0,0.75)');
        gr.addColorStop(0.7, 'rgba(0,0,0,0.42)');
        gr.addColorStop(1, 'rgba(0,0,0,0.12)');
        g.fillStyle = gr; g.fillRect(0, 0, cw, ch);
      }, 256, 4),
    });
    gap = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), gapMat);
    coverMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const cg = new THREE.PlaneGeometry(1, 1);
    cg.translate(0.5, 0, 0);
    cover = new THREE.Mesh(cg, coverMat);
    dropMat = new THREE.MeshBasicMaterial({
      color: 0x000000, transparent: true, opacity: 0, depthWrite: false,
      map: canvasTex((g, cw, ch) => {
        g.shadowColor = 'rgba(0,0,0,1)';
        g.shadowBlur = 18;
        g.shadowOffsetX = cw * 2;
        g.fillStyle = '#000';
        g.fillRect(-cw * 2 + 22, 22, cw - 44, ch - 44);
      }, 128, 160),
    });
    drop = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), dropMat);
    drop.renderOrder = -1;
    group.add(drop, block, gap, cover);
    return true;
  }

  function onResize({ width, height }) {
    if (!camera) return; // createView sizes once before the camera exists
    camera.aspect = width / height;
    const d = (height / 2) / Math.tan((camera.fov * PI) / 360);
    camera.position.set(0, 0, d);
    camera.near = d * 0.05;
    camera.far = d * 3;
    camera.updateProjectionMatrix();
  }

  function layout() {
    const el = entry.el;
    w = el.offsetWidth; h = el.offsetHeight;
    const mx = Math.round(w * 0.4), my = Math.round(h * 0.22);
    Object.assign(host.style, {
      left: `${el.offsetLeft - mx}px`, top: `${el.offsetTop - my}px`,
      width: `${w + 2 * mx}px`, height: `${h + 2 * my}px`,
    });
    T = Math.max(3, w * 0.016);
    block.scale.set(w, h, T);
    block.position.set(0, 0, -T / 2 - 0.6);
    gap.scale.set(w, h, 1);
    gap.position.set(0, 0, -0.45);
    cover.scale.set(w, h, 1);
    cover.position.set(-w / 2, 0, 0);
    drop.scale.set(w * 1.16, h * 1.12, 1);
  }

  function textures(e) {
    let t = cache.get(e.el);
    if (t) return t.p;
    t = { cover: null, inner: null };
    cache.set(e.el, t);
    const img = e.el.querySelector('img');
    t.p = (async () => {
      if (!img) throw new Error('no cover image');
      if (!img.complete || !img.naturalWidth) { img.loading = 'eager'; await img.decode(); }
      const tex = new THREE.Texture(img);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 8;
      const ea = e.el.offsetWidth / e.el.offsetHeight, ia = img.naturalWidth / img.naturalHeight;
      if (ia > ea) { tex.repeat.set(ea / ia, 1); tex.offset.set((1 - ea / ia) / 2, 0); }
      else { tex.repeat.set(1, ia / ea); tex.offset.set(0, (1 - ia / ea) / 2); }
      tex.needsUpdate = true;
      t.cover = tex;
      // first right-hand inner page, seen under the lifted cover
      loadImg(pageSrc(e.iss, 3)).then((im) => {
        const it = new THREE.Texture(im);
        it.colorSpace = THREE.SRGBColorSpace;
        it.anisotropy = 8;
        it.needsUpdate = true;
        t.inner = it;
        if (entry === e) apply(t);
      }).catch(() => {});
      return t;
    })();
    t.p.catch(() => {});
    return t.p;
  }

  function apply(t) {
    coverMat.map = t.cover; coverMat.needsUpdate = true;
    blockTop.map = t.inner || null; blockTop.color.set(t.inner ? 0xffffff : 0xf2f2f2); blockTop.needsUpdate = true;
    view && view.invalidate();
  }

  function attach(e) {
    if (entry !== e) {
      hideNow();
      entry = e;
      ready = false;
      hover = 0; nx = ny = 0;
      e.el.parentElement.appendChild(host);
    }
    layout();
    if (!ready) {
      textures(e).then((t) => { if (entry !== e) return; apply(t); ready = true; view && view.invalidate(); })
        .catch(() => { /* the static cover stays */ });
    }
  }

  function hideNow() {
    if (!live) return;
    live = false;
    host && host.classList.remove('is-live');
    entry && entry.el.classList.remove('sec-peek-live');
  }

  function onFrame(dt) {
    if (!entry || !ready) return false;
    const rate = hoverT > hover ? 6 : 8;
    hover += (hoverT - hover) * (1 - Math.exp(-rate * dt));
    nx += (tnx - nx) * (1 - Math.exp(-7 * dt));
    ny += (tny - ny) * (1 - Math.exp(-7 * dt));
    const settled = Math.abs(hoverT - hover) < 0.002 && Math.abs(tnx - nx) < 0.002 && Math.abs(tny - ny) < 0.002;
    if (settled && hoverT === 0) { hover = 0; nx = ny = 0; }

    const reach = clamp((nx + 1) / 2, 0, 1);
    const lift = hover * (0.26 + 0.2 * reach);              // ~15..26 degrees, more toward the free edge
    cover.rotation.y = -lift;
    group.rotation.y = 0.11 * nx * hover;
    group.rotation.x = 0.09 * ny * hover;
    coverMat.color.setScalar(1 - 0.5 * (1 - Math.cos(lift)) - 0.04 * hover * Math.max(0, nx));
    gapMat.opacity = clamp(lift / 0.22, 0, 1);
    dropMat.opacity = 0.2 * hover;
    drop.position.set(5 * hover, -8 * hover, -T - 1.5);
    view.renderer.render(scene, camera);

    if (!live && hoverT > 0) {
      live = true;
      host.classList.add('is-live');
      entry.el.classList.add('sec-peek-live');
    }
    if (live && hoverT === 0 && hover === 0) { hideNow(); return false; }
    return !settled;
  }

  const blocked = () => !!document.documentElement.dataset.fxModal;
  // while scroll-reveal is still sliding the figure in, its box is not where layout says: wait for it
  const settledBox = (el) => {
    const r = el.getBoundingClientRect(), p = el.offsetParent && el.offsetParent.getBoundingClientRect();
    return !p || (Math.abs(r.top - (p.top + el.offsetTop)) < 0.75 && Math.abs(r.left - (p.left + el.offsetLeft)) < 0.75);
  };

  return {
    enter(e, ev) {
      if (blocked() || !settledBox(e.el) || !ensure()) return;
      attach(e);
      hoverT = 1;
      if (ev) this.move(e, ev);
      view.invalidate();
    },
    move(e, ev) {
      if ((entry !== e || hoverT === 0) && !blocked()) this.enter(e);   // missed enter (reveal / modal)
      if (entry !== e || !view || blocked()) return;
      const r = e.el.getBoundingClientRect();
      tnx = clamp(((ev.clientX - r.left) / r.width) * 2 - 1, -1, 1);
      tny = clamp(((ev.clientY - r.top) / r.height) * 2 - 1, -1, 1);
      view.invalidate();
    },
    leave(e) {
      if (entry !== e || !view) return;
      hoverT = 0; tnx = 0; tny = 0;
      view.invalidate();
    },
    /** the viewer takes over: snap back to the static cover now */
    release() {
      hoverT = 0; hover = 0; tnx = tny = nx = ny = 0;
      hideNow();
    },
    debug: () => ({ live, ready, hover, entry: entry && entry.iss.id }),
    destroy() { hideNow(); view && view.destroy(); host && host.remove(); },
  };
}

/* =================================================================== mount */
export async function mount(ctx) {
  try {
    const { THREE, core } = ctx;
    if (!THREE || !document.querySelector('.security-page .sec-issue')) return;
    const lite = createLite();
    let viewer = null, peek = null;
    try { viewer = createViewer(THREE, core, lite); } catch (err) { console.warn('[fx] flipbook viewer', err); }
    try { peek = createPeek(THREE, core); } catch (err) { console.warn('[fx] flipbook peek', err); }
    const isCover = (entry) => entry.kind === 'cover' && peek;
    const wiring = wireEntries({
      open(entry) {
        if (isCover(entry)) peek.release();
        if (viewer && viewer.usable) viewer.open(entry);
        else lite.open(entry);
      },
      warm(entry) { viewer && viewer.usable && viewer.warm(entry); },
      enter(entry, e) { if (isCover(entry)) peek.enter(entry, e); },
      move(entry, e) { if (isCover(entry)) peek.move(entry, e); },
      leave(entry, e) { if (isCover(entry)) peek.leave(entry, e); },
    });
    if (viewer) viewer.entries = wiring.entries;
    return {
      viewer, peek, lite, entries: wiring.entries,
      destroy() { wiring.destroy(); viewer && viewer.destroy(); peek && peek.destroy(); lite.destroy(); },
    };
  } catch (err) {
    console.warn('[fx] flipbook', err);
  }
}
