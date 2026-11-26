/*
 * fx/paint.js — Paint page, desktop WebGL: the nine canvases as objects.
 *
 *  - One page-sized canvas (absolute inside .paint-page, under the figures) draws every painting as a thin box
 *    synced to its .figure rect. Page-sized so it scrolls with the compositor: zero work while scrolling and no
 *    drift against the DOM. Each painting gets its own off-axis camera centred on it, so at rest the box is seen
 *    exactly front-on (flat collage, no edge slivers); DOM imgs are hidden per figure only after GL drew it.
 *  - Raking light under the cursor: relief normals come from neighbouring-texel luminance differences in the
 *    shader. Shading only (multiply around 1.0) plus a tiny ridge-only specular; flat areas never brighten.
 *  - Click / Enter: focus mode in a second, viewport-fixed MSAA canvas (z --fx-z-overlay). The work lifts out,
 *    turns to show its painted edge, settles front-on at a size proportional to its real size in cm; the rest
 *    recede under a white veil; the caption types in. Drag orbits (springs back). Esc / CLOSE / backdrop closes.
 *
 * Data: caption + physical size live on the figures in paint.html (data-title, data-year, data-medium, data-size,
 * data-cm="WxH" as photographed, data-work groups a pair, data-seams splits a diptych photo, data-support="wood").
 */

const DEG = Math.PI / 180;
const MOBILE_Q = '(max-width: 700px)';
const TILT = 3 * DEG;            // hover tilt
const OPEN_MS = 1150;
const CLOSE_MS = 820;
// Page textures are oversampled and read with a negative LOD bias: Chrome's own <img> downscale keeps more of the
// paintings' grain than a clean mip chain does, and the rest state has to match it.
const HI_DPR = (window.devicePixelRatio || 1) >= 1.5;
const OVERSAMPLE = HI_DPR ? 1.25 : 2;
const GRAD_SCALE = Math.pow(2, HI_DPR ? -0.4 : -0.75);

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const nowS = () => performance.now() / 1000;

/* ------------------------------------------------------------------ shaders */
const VERT = /* glsl */ `
varying vec3 vLocal;
varying vec3 vNormalL;
varying vec3 vWorld;
void main() {
  vLocal = position;
  vNormalL = normal;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const FRAG = /* glsl */ `
uniform sampler2D map;
uniform vec4 uCrop;      // image uv = crop.xy + faceUv * crop.zw (faceUv: u right, v down)
uniform vec2 uSize;      // box face size, px
uniform float uDepth;    // box depth, px
uniform mat3 uRot;       // box rotation (world)
uniform vec3 uLight;     // cursor light, world px
uniform float uLightAmt;
uniform float uLightR;
uniform vec3 uEye;
uniform float uAlpha;
uniform float uWood;
uniform float uRelief;
uniform float uSeed;
uniform float uGrad;
varying vec3 vLocal;
varying vec3 vNormalL;
varying vec3 vWorld;

float lum(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}

void main() {
  vec3 nl = vNormalL;
  vec3 key = normalize(vec3(-0.38, 0.52, 0.76));        // soft gallery key, upper left
  vec3 Nf = normalize(uRot * nl);                        // this face's world normal
  vec2 fuv = vec2(vLocal.x + 0.5, 0.5 - vLocal.y);
  vec2 uv = uCrop.xy + fuv * uCrop.zw;
  vec2 dx = dFdx(uv), dy = dFdy(uv);
  vec3 col;

  if (nl.z > 0.5) {
    // ---- front: the painting. Rest = the texel, untouched.
    dx *= uGrad; dy *= uGrad;                          // LOD bias: keeps the canvas grain the browser keeps
    col = textureGrad(map, uv, dx, dy).rgb;
    float shade = 1.0 + 0.2 * (dot(Nf, key) - key.z);   // face turning toward / away from the key
    vec3 add = vec3(0.0);
    if (uLightAmt > 0.001) {
      vec3 Lv = uLight - vWorld;
      float q = length(Lv.xy) / uLightR;
      float att = 1.0 / (1.0 + q * q * 2.2);
      att *= att;
      float amt = uLightAmt * att;
      if (amt > 0.003) {
        vec2 px = abs(dx) + abs(dy);                      // uv per screen pixel
        vec2 ox = vec2(px.x, 0.0), oy = vec2(0.0, px.y);
        vec2 g1 = vec2(lum(textureGrad(map, uv + ox, dx, dy).rgb) - lum(textureGrad(map, uv - ox, dx, dy).rgb),
                       lum(textureGrad(map, uv + oy, dx, dy).rgb) - lum(textureGrad(map, uv - oy, dx, dy).rgb));
        vec2 dx3 = dx * 3.0, dy3 = dy * 3.0;
        vec2 g3 = vec2(lum(textureGrad(map, uv + ox * 3.0, dx3, dy3).rgb) - lum(textureGrad(map, uv - ox * 3.0, dx3, dy3).rgb),
                       lum(textureGrad(map, uv + oy * 3.0, dx3, dy3).rgb) - lum(textureGrad(map, uv - oy * 3.0, dx3, dy3).rgb));
        vec2 g = g1 * 0.6 + g3 * 0.5;                     // fine brushwork + broader impasto
        vec3 nT = normalize(vec3(-g.x * uRelief, g.y * uRelief, 1.0));
        vec3 N = normalize(uRot * nT);
        vec3 L = normalize(Lv);
        shade += clamp(amt * 1.25 * (dot(N, L) - dot(Nf, L)), -0.2, 0.16);   // relief only: flat stays 1.0
        vec3 V = normalize(uEye - vWorld);
        vec3 H = normalize(L + V);
        float sp = pow(max(dot(N, H), 0.0), 60.0) - pow(max(dot(Nf, H), 0.0), 60.0);
        add = vec3(max(sp, 0.0) * 0.07 * amt * smoothstep(0.03, 0.16, length(g)));
      }
    }
    col = col * shade + add;
  } else if (nl.z < -0.5) {
    // ---- back: raw linen
    col = vec3(0.86, 0.84, 0.80) * (0.62 + 0.3 * max(dot(Nf, key), 0.0));
  } else {
    // ---- sides: paint wrapped round a stretched canvas (or a plywood panel edge)
    bool xs = abs(nl.x) > 0.5;
    float s = xs ? (0.5 - vLocal.y) : (vLocal.x + 0.5);
    float t = clamp(-vLocal.z, 0.0, 1.0);                 // 0 at the front lip, 1 at the wall
    float sPx = s * (xs ? uSize.y : uSize.x);
    float tPx = t * uDepth;
    vec2 euv = xs ? vec2(nl.x > 0.0 ? 1.0 : 0.0, s) : vec2(s, nl.y > 0.0 ? 0.0 : 1.0);
    vec2 inward = xs ? vec2(nl.x > 0.0 ? -1.0 : 1.0, 0.0) : vec2(0.0, nl.y > 0.0 ? 1.0 : -1.0);
    euv += inward * (0.003 + 0.016 * t);
    vec3 paint = textureLod(map, uCrop.xy + euv * uCrop.zw, 2.5).rgb;
    float weave = sin(sPx * 2.6) * sin(tPx * 2.6) * 0.5 + 0.5;
    vec3 linen = vec3(0.93, 0.91, 0.865) * (0.95 + 0.05 * weave) * (0.96 + 0.07 * vnoise(vec2(sPx, tPx) * 0.4));
    float stop = 0.68 + 0.3 * vnoise(vec2(sPx * 0.05 + uSeed, 1.7));   // where the wrapped paint gives out
    float painted = 1.0 - smoothstep(stop - 0.06, stop + 0.04, t);
    vec3 canvasSide = mix(linen, paint * (0.94 + 0.06 * weave), painted);
    float grain = 0.5 + 0.5 * sin(tPx * 1.9 + vnoise(vec2(sPx * 0.035 + uSeed, tPx * 0.25)) * 5.0);
    vec3 wood = mix(vec3(0.72, 0.56, 0.39), vec3(0.84, 0.70, 0.52), grain);
    vec3 woodSide = mix(wood, paint, 1.0 - smoothstep(0.07, 0.14, t));
    col = mix(canvasSide, woodSide, uWood);
    float shade = 0.6 + 0.32 * max(dot(Nf, key), 0.0);
    if (uLightAmt > 0.001) shade += 0.16 * uLightAmt * max(dot(Nf, normalize(uLight - vWorld)), 0.0);
    col *= shade * (1.0 - 0.1 * t);
  }
  gl_FragColor = vec4(col * uAlpha, uAlpha);
}`;

/* ------------------------------------------------------------------ helpers */
function coverCrop(rw, rh, iw, ih) {
  if (!iw || !ih || !rw || !rh) return [0, 0, 1, 1];
  const ra = rw / rh, ia = iw / ih;
  if (ia > ra) { const sx = ra / ia; return [(1 - sx) / 2, 0, sx, 1]; }
  const sy = ia / ra; return [0, (1 - sy) / 2, 1, sy];
}

function whenLoaded(img) {
  if (img.complete && img.naturalWidth) return Promise.resolve();
  return new Promise((res, rej) => {
    img.addEventListener('load', res, { once: true });
    img.addEventListener('error', rej, { once: true });
  });
}

/** Decoded, downscaled copy of an <img>, off the main thread where the browser allows. */
async function makeBitmap(img, maxSide) {
  await whenLoaded(img);
  const nw = img.naturalWidth, nh = img.naturalHeight;
  const s = Math.min(1, maxSide / Math.max(nw, nh));
  const w = Math.max(1, Math.round(nw * s)), h = Math.max(1, Math.round(nh * s));
  const opts = s < 1 ? { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' } : undefined;
  if ('createImageBitmap' in window) {
    try {
      const blob = await (await fetch(img.currentSrc || img.src, { cache: 'force-cache' })).blob();
      return await createImageBitmap(blob, opts);
    } catch (e) { /* fall through */ }
    try {
      if (img.decode) await img.decode();
      return await createImageBitmap(img, opts);
    } catch (e) { /* fall through */ }
  }
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(img, 0, 0, w, h);
  return c;
}

function makeTexture(THREE, renderer, source) {
  const tex = new THREE.Texture(source);
  tex.flipY = false;                       // the shader samples with v pointing down
  tex.colorSpace = THREE.NoColorSpace;     // pass sRGB texels straight through: rest = the image, exactly
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  tex.needsUpdate = true;
  return tex;
}

/** Camera at (ex, ey, D) looking down -z whose frustum maps the z=0 plane exactly onto the W x H surface
 *  (world x 0..W, y 0..-H). Off-axis: the eye sits over the object, like CSS perspective-origin. */
function aimCamera(cam, ex, ey, D, W, H) {
  const near = 2, far = D * 4, k = near / D;
  cam.projectionMatrix.makePerspective(-ex * k, (W - ex) * k, -ey * k, (-H - ey) * k, near, far);
  cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
  cam.position.set(ex, ey, D);
  cam.updateMatrixWorld(true);
}

function makeUnit(THREE, geo, seed, wood) {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      map: { value: null },
      uCrop: { value: new THREE.Vector4(0, 0, 1, 1) },
      uSize: { value: new THREE.Vector2(1, 1) },
      uDepth: { value: 10 },
      uRot: { value: new THREE.Matrix3() },
      uLight: { value: new THREE.Vector3(0, 0, 100) },
      uLightAmt: { value: 0 },
      uLightR: { value: 300 },
      uEye: { value: new THREE.Vector3() },
      uAlpha: { value: 1 },
      uWood: { value: wood ? 1 : 0 },
      uRelief: { value: 3.6 },
      uSeed: { value: seed },
      uGrad: { value: GRAD_SCALE },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    premultipliedAlpha: true,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = true;
  const scene = new THREE.Scene();
  scene.add(mesh);
  const cam = new THREE.PerspectiveCamera();
  cam.matrixAutoUpdate = true;
  return { mesh, mat, u: mat.uniforms, scene, cam };
}

const _m4 = { m: null };
function setRot(THREE, unit, q) {
  if (!_m4.m) _m4.m = new THREE.Matrix4();
  _m4.m.makeRotationFromQuaternion(q);
  unit.u.uRot.value.setFromMatrix4(_m4.m);
}

/* ------------------------------------------------------------------ mount */
export async function mount(ctx) {
  let api = null;
  try {
    api = await setup(ctx);
    return api;
  } catch (err) {
    console.warn('[fx] paint failed', err);
    try { api && api.destroy(); } catch (e) { /* ignore */ }
    return null;
  }
}

async function mountLite(ctx) {
  try {
    const lite = await import('./paint-lite.js');
    return await lite.mount({ ...ctx, gl: false, THREE: null });
  } catch (e) { return null; }
}

async function setup(ctx) {
  const { THREE, core } = ctx;
  const html = document.documentElement;
  const page = document.querySelector('.paint-page');
  if (!page || !core.motionOK) return null;
  if (window.matchMedia(MOBILE_Q).matches) return mountLite(ctx);
  const figs = [...page.querySelectorAll(':scope > .figure')].filter((f) => f.querySelector('img'));
  if (!figs.length) return null;

  const cleanups = [];
  const on = (el, type, fn, opts) => { el.addEventListener(type, fn, opts); cleanups.push(() => el.removeEventListener(type, fn, opts)); };
  let destroyed = false;

  /* ---------------- data */
  const P = figs.map((el, i) => {
    const d = el.dataset;
    const [cw, ch] = String(d.cm || '80x80').split(/x/i).map(Number);
    return {
      i, el, img: el.querySelector('img'),
      title: d.title || '', year: d.year || '', medium: d.medium || '', sizeText: d.size || '', panelName: d.panel || '',
      cmW0: cw || 80, cmH0: ch || cw || 80, wood: d.support === 'wood',
      seams: String(d.seams || '').split(/[\s,]+/).filter(Boolean).map(Number).filter((v) => v > 0 && v < 1),
      workId: d.work || `pg-${i}`,
      rect: { x: 0, y: 0, w: 0, h: 0 }, alpha: 1, crop: [0, 0, 1, 1],
      checking: true, tex: null, drawn: false,
      tiltX: 0, tiltY: 0, light: 0, recede: 0,
      seed: (i * 7.31) % 10,
      unit: null,
    };
  });
  const phys = (p) => {
    const iw = p.img.naturalWidth, ih = p.img.naturalHeight;
    const area = p.cmW0 * p.cmH0;
    if (!iw || !ih) return { w: p.cmW0, h: p.cmH0 };
    const a = iw / ih;
    return { w: Math.sqrt(area * a), h: Math.sqrt(area / a) };
  };
  const depthCm = (p, longCm) => (p.wood ? 1.8 : clamp(1.6 + 0.02 * longCm, 2.2, 4.2));

  const works = [];
  P.forEach((p) => {
    let w = works.find((x) => x.id === p.workId);
    if (!w) { w = { id: p.workId, items: [] }; works.push(w); }
    w.items.push(p);
    p.work = w;
  });
  const PAIR_GAP_CM = 5, SEAM_GAP_CM = 1.2;
  function workGeometry(w) {
    // panels in cm, left to right (pair = one panel per figure; diptych photo = split at the seams)
    const panels = [];
    w.items.forEach((p) => {
      const ph = phys(p);
      const cuts = [0, ...p.seams, 1];
      for (let k = 0; k < cuts.length - 1; k++) {
        panels.push({ p, u0: cuts[k], u1: cuts[k + 1], cmW: ph.w * (cuts[k + 1] - cuts[k]), cmH: ph.h, gapBefore: panels.length ? (k === 0 ? PAIR_GAP_CM : SEAM_GAP_CM) : 0 });
      }
    });
    const cmW = panels.reduce((s, pn) => s + pn.cmW + pn.gapBefore, 0);
    const cmH = Math.max(...panels.map((pn) => pn.cmH));
    const longCm = Math.max(...panels.map((pn) => Math.max(pn.cmW, pn.cmH)));
    return { panels, cmW, cmH, depthCm: depthCm(w.items[0], longCm) };
  }

  const captionLines = (w) => {
    const p = w.items[0];
    return [`${p.title}${p.year ? `, ${p.year}` : ''}`, p.medium, p.sizeText].filter(Boolean);
  };

  /* ---------------- a11y + hints on the figures */
  const lower = (s) => s.toLowerCase();
  P.forEach((p) => {
    const parts = [`${p.title}${p.year ? `, ${p.year}` : ''}${p.panelName ? `, ${lower(p.panelName)}` : ''}`];
    if (p.medium) parts.push(lower(p.medium));
    if (p.sizeText) parts.push(lower(p.sizeText).replace(/ x /g, ' by '));
    p.label = parts.join('. ');
    p.prevAttrs = ['tabindex', 'role', 'aria-label', 'aria-haspopup', 'data-cursor'].map((a) => [a, p.el.getAttribute(a)]);
    p.el.setAttribute('tabindex', '0');
    p.el.setAttribute('role', 'button');
    p.el.setAttribute('aria-label', `${p.label}. Open painting`);
    p.el.setAttribute('aria-haspopup', 'dialog');
    p.el.setAttribute('data-cursor', 'view');
  });

  /* ---------------- focus state (shared by both views; time = rAF seconds) */
  const F = {
    state: 'closed', work: null, geom: null, opener: null, presented: false,
    tw: { from: 0, to: 0, t0: 0, dur: 1 },
    yawAmp: 40 * DEG, pitchAmp: 6 * DEG, dir: 1, lift: 0,
    p(t) {
      const tw = this.tw;
      const k = clamp((t - tw.t0) / tw.dur, 0, 1);
      return tw.from + (tw.to - tw.from) * k;
    },
    hides(p, t) {
      return this.state !== 'closed' && this.presented && this.work === p.work && this.p(t) > 0.015;
    },
    recedeFor(p, t) {
      if (this.state === 'closed' || !this.work || this.work === p.work) return 0;
      const d = p.focusDelay || 0;
      return ease(clamp(this.p(t) * 1.35 - d, 0, 1));
    },
  };

  /* ---------------- page view */
  const layer = document.createElement('div');
  layer.className = 'fx-paint-layer';
  layer.setAttribute('aria-hidden', 'true');
  page.prepend(layer);

  const geo = new THREE.BoxGeometry(1, 1, 1);
  geo.translate(0, 0, -0.5);                 // front face on z = 0, the box goes back into the wall

  let layoutDirty = true;
  const pending = [];                        // bitmaps waiting for upload (one per frame)

  const pv = core.createView({
    THREE, host: layer, className: 'fx-canvas fx-canvas--passive',
    antialias: false, dprMax: 2, pixelBudget: 8e6,
    onResize: () => { layoutDirty = true; },
    onFrame: pageFrame,
    onFail: (reason) => giveUp(reason),
  });
  pv.renderer.autoClear = false;
  P.forEach((p) => { p.unit = makeUnit(THREE, geo, p.seed, p.wood); });

  const measure = (p) => {
    const a = p.el.getBoundingClientRect();
    const b = layer.getBoundingClientRect();
    // Chrome pixel-snaps each figure (origin and size rounded to device px); match it so edges line up
    const dpr = window.devicePixelRatio || 1;
    const sn = (v) => Math.round(v * dpr) / dpr;
    const w = sn(a.width), h = sn(a.height);
    p.rect = { x: sn(a.left) - b.left, y: sn(a.top) - b.top, w, h };
    p.alpha = parseFloat(getComputedStyle(p.el).opacity);
    if (!(p.alpha >= 0)) p.alpha = 1;
    p.crop = coverCrop(w, h, p.img.naturalWidth, p.img.naturalHeight);
  };

  // scroll-reveal fades/slides the figures in; follow their live state while a transition runs
  const mo = new MutationObserver((list) => {
    list.forEach((m) => { const p = P.find((x) => x.el === m.target); if (p) p.checking = true; });
    pv.invalidate();
  });
  P.forEach((p) => mo.observe(p.el, { attributes: true, attributeFilter: ['class', 'style'] }));
  cleanups.push(() => mo.disconnect());

  // textures: viewport-first, sequential decodes, uploads paced one per frame
  (async () => {
    const order = [...P].sort((a, b) => {
      const ra = a.el.getBoundingClientRect(), rb = b.el.getBoundingClientRect();
      const va = ra.top < innerHeight && ra.bottom > 0 ? 0 : 1, vb = rb.top < innerHeight && rb.bottom > 0 ? 0 : 1;
      return va - vb || ra.top - rb.top;
    });
    const scale = Math.max(1, (screen.width || innerWidth) / innerWidth) * Math.min(2, window.devicePixelRatio || 1);
    for (const p of order) {
      if (destroyed) return;
      try {
        const r = p.el.getBoundingClientRect();
        const side = clamp(Math.ceil(Math.max(r.width, r.height) * scale * OVERSAMPLE), 256, 2048);
        const bmp = await makeBitmap(p.img, side);
        if (destroyed) { bmp.close && bmp.close(); return; }
        pending.push({ p, bmp });
        pv.invalidate();
      } catch (e) { /* this one stays DOM */ }
    }
  })();

  // pointer + scroll wake the page view only when it matters
  const overAny = () => {
    const lr = layer.getBoundingClientRect();
    const x = core.pointer.x - lr.left, y = core.pointer.y - lr.top;
    return P.some((p) => p.tex && x >= p.rect.x && x <= p.rect.x + p.rect.w && y >= p.rect.y && y <= p.rect.y + p.rect.h);
  };
  const lit = () => P.some((p) => p.light > 0 || p.tiltX !== 0 || p.tiltY !== 0);
  const unsubPointer = core.pointer.subscribe(() => {
    if (F.state === 'closed') { if (lit() || overAny()) pv.invalidate(); }
    else if (O) O.view.invalidate();
  });
  const unsubScroll = core.scroll.subscribe(() => { if (core.pointer.active && F.state === 'closed' && (lit() || overAny())) pv.invalidate(); });
  cleanups.push(unsubPointer, unsubScroll);

  const light = { x: 0, y: 0, ready: false };
  const mqMobile = window.matchMedia(MOBILE_Q);

  function pageFrame(dt, t) {
    if (destroyed) return false;
    const R = pv.renderer;
    if (mqMobile.matches) { R.clear(); return false; }

    // upload at most one new texture per frame
    const next = pending.shift();
    if (next) {
      next.p.tex = makeTexture(THREE, R, next.bmp);
      next.p.unit.u.map.value = next.p.tex;
      const bmp = next.bmp;
      next.p.tex.onUpdate = () => { if (bmp.close) setTimeout(() => bmp.close(), 0); };
    }

    let busy = pending.length > 0;
    if (layoutDirty) { P.forEach(measure); layoutDirty = false; }
    for (const p of P) {
      if (!p.checking) continue;
      measure(p);
      const running = p.el.getAnimations ? p.el.getAnimations().length > 0 : false;
      if (running) busy = true; else p.checking = false;
    }

    const W = pv.size.width, H = pv.size.height;
    const D = Math.max(900, innerHeight * 1.5);
    const lr = layer.getBoundingClientRect();
    const modal = F.state !== 'closed';

    // hover: painting under the pointer
    let hover = null;
    const ptr = core.pointer;
    const lx = ptr.x - lr.left, ly = ptr.y - lr.top;
    if (!modal && ptr.active) {
      hover = P.find((p) => p.tex && p.alpha > 0.5 && lx >= p.rect.x && lx <= p.rect.x + p.rect.w && ly >= p.rect.y && ly <= p.rect.y + p.rect.h) || null;
    }
    if (!light.ready) { light.x = lx; light.y = ly; light.ready = true; }
    const kL = core.damp(16, dt);
    light.x += (lx - light.x) * kL; light.y += (ly - light.y) * kL;
    if (Math.abs(lx - light.x) + Math.abs(ly - light.y) > 0.3 && (hover || lit())) busy = true;

    const kT = core.damp(7, dt);
    for (const p of P) {
      const isH = p === hover;
      const tx = isH ? clamp((ly - (p.rect.y + p.rect.h / 2)) / (p.rect.h / 2), -1, 1) * TILT : 0;
      const ty = isH ? clamp((lx - (p.rect.x + p.rect.w / 2)) / (p.rect.w / 2), -1, 1) * TILT : 0;
      p.tiltX += (tx - p.tiltX) * kT;
      p.tiltY += (ty - p.tiltY) * kT;
      p.light += ((isH ? 1 : 0) - p.light) * core.damp(isH ? 5 : 3.2, dt);
      const rc = F.recedeFor(p, t);
      p.recede = rc;
      if (Math.abs(tx - p.tiltX) > 1e-4 || Math.abs(ty - p.tiltY) > 1e-4 || Math.abs((isH ? 1 : 0) - p.light) > 2e-3) busy = true;
      else { p.tiltX = tx; p.tiltY = ty; p.light = isH ? 1 : (p.light < 2e-3 ? 0 : p.light); }
    }

    // draw: hovered last so its tilted corners sit over the neighbours
    R.setRenderTarget(null);
    R.clear(true, true, false);
    const order = hover ? [...P.filter((p) => p !== hover), hover] : P;
    for (const p of order) {
      if (!p.tex || p.rect.w < 1 || p.alpha <= 0.001) { if (p.tex && !p.drawn && p.alpha <= 0.001) markDrawn(p); continue; }
      if (F.hides(p, t)) continue;
      const { mesh, u, cam } = p.unit;
      const r = p.rect;
      const ph = phys(p);
      const depth = depthCm(p, Math.max(ph.w, ph.h)) * (r.w / ph.w);
      const cx = r.x + r.w / 2, cy = -(r.y + r.h / 2);
      const z = -p.recede * D * 0.16;
      mesh.position.set(cx, cy, z);
      mesh.rotation.set(p.tiltX, p.tiltY, 0);
      mesh.scale.set(r.w, r.h, Math.max(1, depth));
      setRot(THREE, p.unit, mesh.quaternion);
      u.uCrop.value.set(p.crop[0], p.crop[1], p.crop[2], p.crop[3]);
      u.uSize.value.set(r.w, r.h);
      u.uDepth.value = depth;
      u.uAlpha.value = p.alpha;
      const big = Math.max(r.w, r.h);
      u.uLight.value.set(light.x, -light.y, big * 0.16);
      u.uLightAmt.value = p.light;
      u.uLightR.value = big * 0.5;
      aimCamera(cam, cx, cy, D, W, H);
      u.uEye.value.copy(cam.position);
      R.clearDepth();
      R.render(p.unit.scene, cam);
      if (!p.drawn) markDrawn(p);
    }
    if (F.state !== 'closed' || P.some((p) => p.recede > 0.001)) busy = true;
    return busy;
  }

  function markDrawn(p) {
    p.drawn = true;
    p.el.dataset.fxGl = 'drawn';
  }

  pv.wake(1600);

  /* ---------------- focus mode (overlay) */
  let O = null;              // overlay: { root, veil, view, units, stage, cap, closeBtn, ... }
  const hiCache = new Map(); // fig -> Promise<bitmap>, small LRU

  function hiSide(w) {
    const g = workGeometry(w);
    const L = focusLayout(g);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    let side = 0;
    w.items.forEach((p) => {
      const mine = g.panels.filter((pn) => pn.p === p);
      const wpx = mine.reduce((acc, pn) => acc + pn.cmW, 0) * L.k;
      side = Math.max(side, wpx, mine[0].cmH * L.k);
    });
    return clamp(Math.ceil(side * dpr), 512, 2048);
  }
  function prefetch(w) {
    if (destroyed) return;
    const side = hiSide(w);
    w.items.forEach((p) => {
      if (hiCache.has(p)) { const v = hiCache.get(p); hiCache.delete(p); hiCache.set(p, v); return; }
      hiCache.set(p, makeBitmap(p.img, side).catch(() => null));
      while (hiCache.size > 3) {
        const [k, v] = hiCache.entries().next().value;
        if (F.work && F.work.items.includes(k)) break;
        hiCache.delete(k);
        v.then((b) => b && b.close && b.close());
      }
    });
  }

  function focusLayout(g) {
    const vw = innerWidth, vh = innerHeight, u = vw / 1280;
    const top = Math.max(54, 64 * u);
    const capH = Math.max(88, 92 * u);
    const availH = Math.max(200, vh - top - capH - 12);
    const availW = vw * 0.84;
    let k = Infinity;                          // one px-per-cm for every work: real sizes stay relative
    works.forEach((w) => {
      const gg = workGeometry(w);
      k = Math.min(k, availW / gg.cmW, availH / gg.cmH);
    });
    k = Math.min(k, availW / g.cmW, availH / g.cmH);
    const long = Math.max(g.cmW, g.cmH) * k;
    const minLong = 0.42 * availH;
    if (long < minLong) k *= minLong / long;
    const W = g.cmW * k, H = g.cmH * k;
    const cx = vw / 2, cy = top + availH / 2;
    return { k, W, H, cx, cy, left: cx - W / 2, top: cy - H / 2 };
  }

  function ensureOverlay() {
    if (O || destroyed) return O;
    const root = document.createElement('div');
    root.className = 'fx-paint-focus';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-labelledby', 'fx-paint-focus-title');
    root.setAttribute('aria-describedby', 'fx-paint-focus-desc');
    const veil = document.createElement('div');
    veil.className = 'fx-paint-focus__veil';
    veil.setAttribute('data-cursor', 'close');
    root.append(veil);
    document.body.append(root);

    let view;
    try {
      view = core.createView({
        THREE, host: root, className: 'fx-canvas fx-canvas--passive fx-paint-focus__canvas',
        antialias: true,
        onResize: () => { if (O && F.work) relayoutFocus(); },
        onFrame: overlayFrame,
        onFail: () => overlayFailed(),
      });
    } catch (e) {
      root.remove();
      return null;
    }
    view.renderer.autoClear = false;

    const stage = document.createElement('div');
    stage.className = 'fx-paint-focus__stage';
    stage.setAttribute('data-cursor', 'drag');
    stage.setAttribute('aria-hidden', 'true');

    const cap = document.createElement('div');
    cap.className = 'fx-paint-focus__caption';
    cap.innerHTML = '<div class="fx-paint-focus__lines" aria-hidden="true"></div>'
      + '<p class="fx-sr" id="fx-paint-focus-title"></p><p class="fx-sr" id="fx-paint-focus-desc"></p>';
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'fx-paint-focus__close';
    closeBtn.textContent = 'CLOSE';
    closeBtn.setAttribute('aria-label', 'Close painting');
    cap.append(closeBtn);
    root.append(stage, cap);

    const units = [0, 1].map((k) => makeUnit(THREE, geo, 3 + k * 4.1, false));
    // compile the program now so the first open does not stall
    try {
      const dummy = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
      dummy.needsUpdate = true;
      units[0].u.map.value = dummy;
      aimCamera(units[0].cam, 0, 0, 1000, 10, 10);
      view.renderer.compile(units[0].scene, units[0].cam);
      units[0].u.map.value = null;
      dummy.dispose();
    } catch (e) { /* compiles on first draw instead */ }

    O = {
      root, veil, view, stage, cap, closeBtn, units,
      lines: cap.querySelector('.fx-paint-focus__lines'),
      title: cap.querySelector('#fx-paint-focus-title'),
      desc: cap.querySelector('#fx-paint-focus-desc'),
      panels: [], layout: null, tex: [],
      orb: { yaw: 0, pitch: 0, vy: 0, vp: 0, ty: 0, tp: 0, drag: null },
      light: { x: 0, y: 0, amt: 0 },
      typing: 0,
    };

    // backdrop / close / drag
    veil.addEventListener('click', () => close());
    closeBtn.addEventListener('click', () => close());
    stage.addEventListener('pointerdown', (e) => {
      if (F.state !== 'open' && F.state !== 'opening') return;
      e.preventDefault();
      try { stage.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      O.orb.drag = { id: e.pointerId, x: e.clientX, y: e.clientY, y0: O.orb.yaw, p0: O.orb.pitch };
      stage.classList.add('is-dragging');
      view.invalidate();
    });
    stage.addEventListener('pointermove', (e) => {
      const d = O.orb.drag;
      if (!d || d.id !== e.pointerId) return;
      O.orb.ty = clamp(d.y0 + (e.clientX - d.x) * 0.32 * DEG, -32 * DEG, 32 * DEG);
      O.orb.tp = clamp(d.p0 + (e.clientY - d.y) * 0.26 * DEG, -18 * DEG, 18 * DEG);
      view.invalidate();
    });
    const endDrag = (e) => {
      const d = O.orb.drag;
      if (!d || d.id !== e.pointerId) return;
      O.orb.drag = null;
      O.orb.ty = 0; O.orb.tp = 0;
      stage.classList.remove('is-dragging');
      view.invalidate();
    };
    stage.addEventListener('pointerup', endDrag);
    stage.addEventListener('pointercancel', endDrag);
    stage.addEventListener('lostpointercapture', endDrag);
    return O;
  }

  function overlayFailed() {
    // the focus canvas gave up: put the work straight back and stop offering focus mode
    if (O) { O.root.remove(); }
    O = null;
    focusDisabled = true;
    if (F.state !== 'closed') finishClose();
  }
  let focusDisabled = false;

  function relayoutFocus() {
    if (!O || !F.work) return;
    const L = focusLayout(F.geom);
    O.layout = L;
    let x = L.left;
    F.geom.panels.forEach((pn, k) => {
      x += pn.gapBefore * L.k;
      const w = pn.cmW * L.k, h = pn.cmH * L.k;
      O.panels[k].target = { cx: x + w / 2, cy: L.cy, w, h };
      x += w;
    });
    const s = O.stage.style;
    s.left = `${L.left}px`; s.top = `${L.top}px`; s.width = `${L.W}px`; s.height = `${L.H}px`;
    const cw = Math.max(L.W, 340);
    const cs = O.cap.style;
    cs.left = `${L.W >= 340 ? L.left : L.cx - cw / 2}px`;
    cs.top = `${L.top + L.H + 14}px`;
    cs.width = `${cw}px`;
    O.view.invalidate();
  }

  function slotOf(p, u0, u1) {
    const br = p.el.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const sn = (v) => Math.round(v * dpr) / dpr;
    const r = { left: sn(br.left), top: sn(br.top), width: sn(br.width), height: sn(br.height) };
    const crop = coverCrop(r.width, r.height, p.img.naturalWidth, p.img.naturalHeight);
    // part of the displayed rect that shows image u in [u0, u1]
    const a = clamp((u0 - crop[0]) / crop[2], 0, 1), b = clamp((u1 - crop[0]) / crop[2], 0, 1);
    const x0 = r.left + r.width * a, x1 = r.left + r.width * b;
    return {
      cx: (x0 + x1) / 2, cy: r.top + r.height / 2, w: x1 - x0, h: r.height,
      crop: [crop[0] + a * crop[2], crop[1], (b - a) * crop[2], crop[3]],
    };
  }

  async function open(p) {
    if (destroyed || focusDisabled || F.state !== 'closed') return;
    if (!p.work.items.every((q) => q.drawn)) return;   // still the DOM image: nothing to lift yet
    const o = ensureOverlay();
    if (!o) return;
    const w = p.work;
    F.state = 'loading';
    prefetch(w);
    const bmps = await Promise.all(w.items.map((q) => hiCache.get(q)));
    if (destroyed || !O) { F.state = 'closed'; return; }
    const R = O.view.renderer;
    O.tex.forEach((tx) => tx.dispose());
    O.tex = [];
    const texOf = new Map();
    w.items.forEach((q, k) => {
      const src = bmps[k];
      if (!src) return;
      const tx = makeTexture(THREE, R, src);
      try { R.initTexture(tx); } catch (e) { /* uploads on first draw */ }
      O.tex.push(tx);
      texOf.set(q, tx);
    });
    if (w.items.some((q) => !texOf.get(q))) { F.state = 'closed'; return; }

    F.work = w;
    F.geom = workGeometry(w);
    F.opener = p;
    F.presented = false;
    O.panels = F.geom.panels.slice(0, 2).map((pn, k) => {
      const unit = O.units[k];
      unit.u.map.value = texOf.get(pn.p);
      unit.u.uWood.value = pn.p.wood ? 1 : 0;
      return { pn, unit, slot: slotOf(pn.p, pn.u0, pn.u1), full: [pn.u0, 0, pn.u1 - pn.u0, 1], target: null };
    });
    relayoutFocus();
    const sc = O.panels.reduce((s, x) => s + x.slot.cx, 0) / O.panels.length;
    F.dir = sc < innerWidth / 2 ? 1 : -1;
    F.lift = Math.min(innerHeight * 0.1, 120);
    // others recede in a ripple from the opened work
    P.forEach((q) => {
      const dx = (q.rect.x + q.rect.w / 2) - (p.rect.x + p.rect.w / 2);
      const dy = (q.rect.y + q.rect.h / 2) - (p.rect.y + p.rect.h / 2);
      q.focusDelay = clamp(Math.hypot(dx, dy) / Math.max(1, innerWidth) * 0.35, 0, 0.3);
    });
    O.orb.yaw = O.orb.pitch = O.orb.vy = O.orb.vp = O.orb.ty = O.orb.tp = 0;
    O.light.amt = 0;

    // caption text (typed later), screen-reader copy now
    const lines = captionLines(w);
    O.title.textContent = lines[0];
    O.desc.textContent = `${lines.slice(1).join('. ')}. Drag to turn the painting. Escape closes.`;
    O.lines.innerHTML = '';
    O.cap.classList.remove('is-on');

    // modal state
    html.dataset.fxModal = 'paint';
    F.prevOverflow = html.style.overflow;
    html.style.overflow = 'hidden';
    page.inert = true;
    F.state = 'opening';
    F.tw = { from: 0, to: 1, t0: nowS(), dur: OPEN_MS / 1000 };
    O.root.classList.add('is-open');
    O.view.invalidate();
    pv.invalidate();
    clearTimeout(O.typing);
    O.typing = setTimeout(() => typeCaption(lines), OPEN_MS * 0.8);
  }

  function typeCaption(lines) {
    if (!O || F.state === 'closing' || F.state === 'closed') return;
    O.cap.classList.add('is-on');
    O.lines.innerHTML = '';
    const els = lines.map((txt, k) => {
      const d = document.createElement('div');
      d.className = k === 0 ? 'fx-paint-focus__title' : 'fx-paint-focus__line';
      O.lines.append(d);
      return d;
    });
    const caret = document.createElement('span');
    caret.className = 'fx-paint-focus__caret';
    let li = 0, ci = 0;
    const step = () => {
      if (!O || F.state === 'closing' || F.state === 'closed') return;
      if (li >= lines.length) { caret.remove(); return; }
      ci++;
      els[li].textContent = lines[li].slice(0, ci);
      els[li].append(caret);
      if (ci >= lines[li].length) { li++; ci = 0; O.typing = setTimeout(step, 90); return; }
      O.typing = setTimeout(step, lines[li][ci - 1] === ' ' ? 10 : 22);
    };
    step();
  }

  function close() {
    if (!O || (F.state !== 'open' && F.state !== 'opening')) return;
    const t = nowS();
    const p = F.p(t);
    // fly back to wherever the slots are now
    O.panels.forEach((x) => { x.slot = slotOf(x.pn.p, x.pn.u0, x.pn.u1); });
    F.state = 'closing';
    F.tw = { from: p, to: 0, t0: t, dur: Math.max(0.25, (CLOSE_MS / 1000) * p) };
    O.orb.drag = null; O.orb.ty = 0; O.orb.tp = 0;
    O.root.classList.remove('is-open');
    O.cap.classList.remove('is-on');
    clearTimeout(O.typing);
    O.view.invalidate();
    pv.invalidate();
  }

  function finishClose() {
    const opener = F.opener;
    F.state = 'closed';
    F.work = null;
    F.presented = false;
    if (O) {
      O.root.classList.remove('is-live', 'is-open');
      O.cap.classList.remove('is-on');
      O.lines.innerHTML = '';
      clearTimeout(O.typing);
      O.view.renderer.clear();
    }
    delete html.dataset.fxModal;
    html.style.overflow = F.prevOverflow || '';
    page.inert = false;
    if (opener && opener.el.isConnected) { try { opener.el.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
    pv.invalidate();
  }

  const _q = { flight: null, orb: null, e: null, v: null };
  function overlayFrame(dt, t) {
    if (!O || destroyed) return false;
    const R = O.view.renderer;
    R.setRenderTarget(null);
    R.clear(true, true, false);
    if (F.state === 'closed' || F.state === 'loading' || !F.work) return false;
    if (!_q.flight) {
      _q.flight = new THREE.Quaternion(); _q.orb = new THREE.Quaternion(); _q.e = new THREE.Euler(); _q.v = new THREE.Vector3();
    }
    const p = F.p(t);
    const L = O.layout;
    const W = O.view.size.width, H = O.view.size.height;
    const D = Math.max(900, H * 1.45);
    let busy = F.state === 'opening' || F.state === 'closing';

    // orbit spring (critically damped while dragging, springy on release)
    const ob = O.orb;
    if (ob.drag) {
      const k = core.damp(14, dt);
      ob.vy = (ob.ty - ob.yaw) * k / Math.max(dt, 1e-3); ob.vp = (ob.tp - ob.pitch) * k / Math.max(dt, 1e-3);
      ob.yaw += (ob.ty - ob.yaw) * k; ob.pitch += (ob.tp - ob.pitch) * k;
      busy = true;
    } else {
      const w0 = 9, z = 0.42;
      for (let s = 0, n = Math.ceil(dt / 0.008); s < n; s++) {
        const h = dt / n;
        ob.vy += (-w0 * w0 * (ob.yaw - ob.ty) - 2 * z * w0 * ob.vy) * h;
        ob.vp += (-w0 * w0 * (ob.pitch - ob.tp) - 2 * z * w0 * ob.vp) * h;
        ob.yaw += ob.vy * h; ob.pitch += ob.vp * h;
      }
      if (Math.abs(ob.yaw) + Math.abs(ob.pitch) + Math.abs(ob.vy) * 0.05 + Math.abs(ob.vp) * 0.05 > 1e-4) busy = true;
      else { ob.yaw = ob.pitch = ob.vy = ob.vp = 0; }
    }

    // cursor light over the work
    const ptr = core.pointer;
    const over = ptr.active && F.state !== 'closing' && L
      && ptr.x > L.left - 20 && ptr.x < L.left + L.W + 20 && ptr.y > L.top - 20 && ptr.y < L.top + L.H + 20;
    const la = O.light;
    const kl = core.damp(16, dt);
    if (la.amt < 0.01) { la.x = ptr.x; la.y = ptr.y; }
    la.x += (ptr.x - la.x) * kl; la.y += (ptr.y - la.y) * kl;
    const ta = over && F.state === 'open' ? 1 : 0;
    la.amt += (ta - la.amt) * core.damp(over ? 5 : 3, dt);
    if (Math.abs(ta - la.amt) > 2e-3 || Math.abs(ptr.x - la.x) + Math.abs(ptr.y - la.y) > 0.3) busy = true;

    const e = ease(p);
    const s = Math.sin(Math.PI * p);
    const gx = L.cx, gy = -L.cy;                       // group centre (world)
    _q.orb.setFromEuler(_q.e.set(ob.pitch, ob.yaw, 0));
    const depthCmV = F.geom.depthCm;

    O.panels.forEach((x) => {
      const { slot, target, unit, pn } = x;
      const cx = lerp(slot.cx, target.cx, e), cy = lerp(slot.cy, target.cy, e);
      const w = lerp(slot.w, target.w, e), h = lerp(slot.h, target.h, e);
      const z = F.lift * Math.pow(s, 0.85);
      _q.flight.setFromEuler(_q.e.set(-F.pitchAmp * s, F.dir * F.yawAmp * s, F.dir * 1.5 * DEG * s));
      // orbit about the group centre
      _q.v.set(cx - gx, -cy - gy, z).applyQuaternion(_q.orb);
      const mesh = unit.mesh;
      mesh.position.set(gx + _q.v.x, gy + _q.v.y, _q.v.z);
      mesh.quaternion.copy(_q.orb).multiply(_q.flight);
      const depth = depthCmV * (w / pn.cmW);
      mesh.scale.set(w, h, Math.max(1, depth));
      setRot(THREE, unit, mesh.quaternion);
      const c = slot.crop, f = x.full;
      unit.u.uCrop.value.set(lerp(c[0], f[0], e), lerp(c[1], f[1], e), lerp(c[2], f[2], e), lerp(c[3], f[3], e));
      unit.u.uSize.value.set(w, h);
      unit.u.uDepth.value = depth;
      unit.u.uAlpha.value = 1;
      const big = Math.max(w, h);
      unit.u.uLight.value.set(la.x, -la.y, big * 0.16);
      unit.u.uLightAmt.value = la.amt * (F.state === 'closing' ? p : 1);
      unit.u.uLightR.value = big * 0.5;
      const ex = lerp(slot.cx, L.cx, e), ey = -lerp(slot.cy, L.cy, e);
      aimCamera(unit.cam, ex, ey, D, W, H);
      unit.u.uEye.value.copy(unit.cam.position);
      R.clearDepth();
      R.render(unit.scene, unit.cam);
    });

    if (!F.presented) {
      F.presented = true;
      O.root.classList.add('is-live');
      try { O.closeBtn.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
      pv.invalidate();
    }
    if (F.state === 'opening' && p >= 1) { F.state = 'open'; }
    if (F.state === 'closing' && p <= 0) { finishClose(); return false; }
    return busy;
  }

  /* ---------------- input on the figures */
  P.forEach((p) => {
    on(p.el, 'click', (e) => { if (e.defaultPrevented) return; open(p); });
    on(p.el, 'keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(p); }
    });
    on(p.el, 'pointerenter', () => {
      if (focusDisabled) return;
      prefetch(p.work);
      if (!O) (window.requestIdleCallback || setTimeout)(() => ensureOverlay());
    });
    on(p.el, 'focus', () => { if (!focusDisabled) prefetch(p.work); });
  });
  on(document, 'keydown', (e) => {
    if (F.state === 'closed' || F.state === 'loading' || !O) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key === 'Tab') { e.preventDefault(); O.closeBtn.focus({ preventScroll: true }); return; }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const k = 3.2;
      if (e.key === 'ArrowLeft') O.orb.vy -= k;
      if (e.key === 'ArrowRight') O.orb.vy += k;
      if (e.key === 'ArrowUp') O.orb.vp -= k * 0.6;
      if (e.key === 'ArrowDown') O.orb.vp += k * 0.6;
      O.view.invalidate();
    }
  });

  /* ---------------- failure / teardown */
  function restoreDom() {
    P.forEach((p) => {
      delete p.el.dataset.fxGl;
      p.prevAttrs.forEach(([a, v]) => (v == null ? p.el.removeAttribute(a) : p.el.setAttribute(a, v)));
    });
  }
  function teardown() {
    destroyed = true;
    if (F.state !== 'closed') finishClose();
    cleanups.forEach((fn) => { try { fn(); } catch (e) { /* ignore */ } });
    hiCache.forEach((v) => v.then((b) => b && b.close && b.close()));
    hiCache.clear();
    pending.forEach(({ bmp }) => bmp.close && bmp.close());
    pending.length = 0;
    if (O) { try { O.view.destroy(); } catch (e) { /* ignore */ } O.root.remove(); O = null; }
    try { pv.destroy(); } catch (e) { /* ignore */ }
    P.forEach((p) => { p.tex && p.tex.dispose(); p.unit && p.unit.mat.dispose(); });
    geo.dispose();
    layer.remove();
    restoreDom();
  }
  function giveUp(reason) {
    if (destroyed) return;
    console.warn('[fx] paint: static fallback', reason);
    teardown();
    mountLite(ctx);
  }

  const api = {
    destroy: teardown,
    open: (i) => open(P[i]),
    close: () => close(),
    get state() { return F.state; },
    get drawn() { return P.filter((p) => p.drawn).length; },
  };
  return api;
}
