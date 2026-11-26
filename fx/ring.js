/*
 * fx/ring.js — the KRISHA ring as real 3D (owner: ring).
 *
 * One mount(ctx), three placements, each its own core.createView() (at most two per page):
 *   hero    index.html  [data-fx-ring="hero"]    over the landing video: idle spin, pointer tilt, drag with
 *                                                  inertia, click = spin-up burst + chime. Reflects the video.
 *   emblem  security    [data-fx-ring="emblem"]  replaces the spinning GIF once the first GL frame is drawn:
 *                                                  continuous spin at the GIF's rate, scroll adds spin, drag.
 *   nav     .nav__logo  (every desktop page but index): a canvas over the flat logo whose resting pose is the
 *                                                  flat logo; hovering a nav link turns it a quarter turn and it
 *                                                  settles back; a nearby pointer tilts it. Idle = no frames.
 *
 * Geometry: fx/ring-shape.js (traced offline from img/logo.png by tools/trace-ring.py) -> THREE.Shape ->
 * bevelled ExtrudeGeometry with creased normals. Units are image-height units of logo.png (origin at the
 * image centre, y up), so the mesh registers exactly with the flat <img>.
 *
 * Static images stay in the DOM as the fallback: they are hidden only after the first GL frame and restored
 * if the view gives up (createView onFail) or the module is destroyed.
 */
import { SHAPES, CENTROID, BOUNDS } from './ring-shape.js';
import { play, preload } from './sound.js';

const DEG = Math.PI / 180;
const TAU = Math.PI * 2;
const INK = '#000ca9';
const GIF_TILT = 29.72 * DEG;         // security-04.webp is shown rotate(-29.72deg): its spin axis leans left
const GIF_SPIN = TAU / 2.96;          // the GIF turns once every 148 frames x 20 ms
const PIVOT = { x: CENTROID[0], y: CENTROID[1] };
const INK_H = BOUNDS.maxY - BOUNDS.minY;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

/* ================================================================== geometry */

/** Ramer-Douglas-Peucker on a closed loop given as a flat [x0, y0, x1, y1, ...] array. */
function decimate(flat, tol) {
  const n = flat.length / 2;
  if (!tol || n < 16) return flat;
  const keep = new Uint8Array(n);
  // split at the vertex farthest from vertex 0, simplify both runs
  let far = 0, best = 0;
  for (let i = 1; i < n; i++) {
    const d = (flat[2 * i] - flat[0]) ** 2 + (flat[2 * i + 1] - flat[1]) ** 2;
    if (d > best) { best = d; far = i; }
  }
  const run = (from, to) => {           // indices modulo n, from < to (to may be n -> 0)
    const stack = [[from, to]];
    keep[from % n] = 1; keep[to % n] = 1;
    while (stack.length) {
      const [a, b] = stack.pop();
      const ax = flat[2 * (a % n)], ay = flat[2 * (a % n) + 1], bx = flat[2 * (b % n)], by = flat[2 * (b % n) + 1];
      const dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
      let worst = 0, idx = -1;
      for (let i = a + 1; i < b; i++) {
        const px = flat[2 * (i % n)], py = flat[2 * (i % n) + 1];
        const t = len ? clamp(((px - ax) * dx + (py - ay) * dy) / len, 0, 1) : 0;
        const d = Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
        if (d > worst) { worst = d; idx = i; }
      }
      if (idx >= 0 && worst > tol) { keep[idx % n] = 1; stack.push([a, idx], [idx, b]); }
    }
  };
  run(0, far); run(far, n);
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(flat[2 * i], flat[2 * i + 1]);
  return out.length >= 6 ? out : flat;
}

const toVecs = (THREE, flat, s) => {
  const pts = [];
  for (let i = 0; i < flat.length; i += 2) pts.push(new THREE.Vector2(flat[i] * s, flat[i + 1] * s));
  return pts;
};

/**
 * Bevelled extrusion of the traced logo, centred on PIVOT in x/y and on its mid-plane in z.
 * Built at x1000 scale: toCreasedNormals hashes positions at 0.01, far too coarse for unit-sized input.
 */
function ringGeometry(kit, { depth, bevel, segments, tol = 0, crease = 48 }) {
  const { THREE, toCreasedNormals } = kit;
  const K = 1000;
  const shapes = SHAPES.map((s) => {
    const shape = new THREE.Shape(toVecs(THREE, decimate(s.outer, tol), K));
    shape.holes = s.holes.map((h) => new THREE.Path(toVecs(THREE, decimate(h, tol), K)));
    return shape;
  });
  let geo = new THREE.ExtrudeGeometry(shapes, {
    depth: depth * K, steps: 1, curveSegments: 1,
    bevelEnabled: bevel > 0, bevelThickness: bevel * K, bevelSize: bevel * K,
    bevelOffset: -bevel * K * 0.75, bevelSegments: segments,
  });
  geo = toCreasedNormals(geo, crease * DEG);
  // Caps stay exactly flat: creasing would bend their rim normals toward the bevel, and the long thin cap
  // triangles would then smear that tilt across the face as visible streaks.
  const caps = geo.groups.find((g) => g.materialIndex === 0);
  if (caps) {
    const pos = geo.attributes.position, nor = geo.attributes.normal;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    for (let i = caps.start; i < caps.start + caps.count; i += 3) {
      a.fromBufferAttribute(pos, i); b.fromBufferAttribute(pos, i + 1); c.fromBufferAttribute(pos, i + 2);
      const z = Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) || 1;
      for (let j = 0; j < 3; j++) nor.setXYZ(i + j, 0, 0, z);
    }
    nor.needsUpdate = true;
  }
  geo.scale(1 / K, 1 / K, 1 / K);
  geo.translate(-PIVOT.x, -PIVOT.y, -depth / 2);
  geo.computeBoundingSphere();
  return geo;
}

/** Convex hull of every outline point (Andrew's monotone chain): the flat drag/hover hit area. */
let hullPts = null;
function hullGeometry(THREE) {
  if (!hullPts) {
    const p = [];
    SHAPES.forEach((s) => { for (let i = 0; i < s.outer.length; i += 2) p.push([s.outer[i], s.outer[i + 1]]); });
    p.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = [], hi = [];
    for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
    for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], q) <= 0) hi.pop(); hi.push(q); }
    hullPts = lo.slice(0, -1).concat(hi.slice(0, -1));
  }
  const geo = new THREE.ShapeGeometry(new THREE.Shape(hullPts.map(([x, y]) => new THREE.Vector2(x, y))));
  geo.translate(-PIVOT.x, -PIVOT.y, 0);
  return geo;
}

/* ================================================================== material */

/*
 * Chrome-blue: a blue metal (the env reflection is tinted KRISHA blue) under a clear coat (white glints).
 * Two shader hooks, compiled only where used:
 *   ROOM  the landing video, downsampled, bent by the surface normal into the specular + clear-coat terms.
 *   FLAT  uFlat blends the final colour to exact #000ca9 (after tone mapping, before sRGB encoding), so the
 *         nav logo at rest is pixel-identical in colour to the flat logo.
 */
const ROOM_GLSL = /* glsl */ `
#if defined( RE_IndirectSpecular )
{
  vec3 rn = normalize( geometryNormal );
  vec3 rr = reflect( - geometryViewDir, rn );
  vec2 screenUv = gl_FragCoord.xy * uRoomMap.xy + uRoomMap.zw;
  vec2 uv = mix( screenUv + rn.xy * vec2( 0.06, 0.1 ), 0.5 + rr.xy * vec2( 0.42, 0.5 ), 0.55 );
  vec3 room = texture2D( uRoom, clamp( uv, 0.002, 0.998 ) ).rgb * 0.6
    + texture2D( uRoom, clamp( uv + rr.xy * 0.05, 0.002, 0.998 ) ).rgb * 0.4;
  float fres = pow( 1.0 - saturate( dot( rn, geometryViewDir ) ), 2.0 );
  float k = uRoomMix * ( 0.6 + 0.4 * fres );
  radiance = mix( radiance, room * uRoomGain, k );
  #ifdef USE_CLEARCOAT
    // the clear coat is untinted: this is where the footage shows in its own colours
    clearcoatRadiance = mix( clearcoatRadiance, room * uRoomGain * mix( 12.0, 2.0, fres ), k );
  #endif
}
#endif
`;

function makeMaterial(kit, o, shared) {
  const { THREE } = kit;
  const mat = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(o.color),
    metalness: o.metalness,
    roughness: o.roughness,
    clearcoat: o.clearcoat,
    clearcoatRoughness: o.clearcoatRoughness,
    envMapIntensity: o.env,
  });
  const room = !!o.room;
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uInk = shared.uInk;
    sh.uniforms.uFlat = shared.uFlat;
    let head = 'uniform vec3 uInk;\nuniform float uFlat;\n';
    if (room) {
      Object.assign(sh.uniforms, { uRoom: shared.uRoom, uRoomMap: shared.uRoomMap, uRoomMix: shared.uRoomMix, uRoomGain: shared.uRoomGain });
      head += 'uniform sampler2D uRoom;\nuniform vec4 uRoomMap;\nuniform float uRoomMix;\nuniform float uRoomGain;\n';
      sh.fragmentShader = sh.fragmentShader.replace('#include <lights_fragment_maps>', `#include <lights_fragment_maps>\n${ROOM_GLSL}`);
    }
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\n${head}`)
      .replace('#include <tonemapping_fragment>', '#include <tonemapping_fragment>\ngl_FragColor.rgb = mix( gl_FragColor.rgb, uInk, uFlat );');
  };
  mat.customProgramCacheKey = () => (room ? 'krisha-ring-room' : 'krisha-ring');
  return mat;
}

const LOOK = {
  face: { color: '#0614b0', metalness: 1, roughness: 0.2, clearcoat: 0.75, clearcoatRoughness: 0.04, env: 1.1 },
  side: { color: '#00087a', metalness: 1, roughness: 0.26, clearcoat: 0.8, clearcoatRoughness: 0.08, env: 1 },
};

/* ================================================================== stage */

/**
 * Builds scene + camera + the ring hierarchy for one renderer:
 *   root (pivot) > tilt (pointer) > axis (lean) > spin (turn about local y) > unaxis > mesh
 *                               > proxy (hit area: the front-facing footprint, never spun)
 */
function createStage(kit, renderer, o) {
  const { THREE, RoomEnvironment } = kit;
  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const envRT = pmrem.fromScene(room, 0.035);
  room.dispose();
  pmrem.dispose();
  scene.environment = envRT.texture;

  const shared = {
    uInk: { value: new THREE.Color(INK) },
    uFlat: { value: 0 },
    uRoom: { value: null },
    uRoomMap: { value: new THREE.Vector4(0, 0, 0.5, 0.5) },
    uRoomMix: { value: 0 },
    uRoomGain: { value: 1 },
  };
  const look = o.look || LOOK;
  const face = makeMaterial(kit, { ...look.face, room: o.room }, shared);
  const side = makeMaterial(kit, { ...look.side, room: o.room }, shared);
  const geometry = ringGeometry(kit, o.geometry);
  const mesh = new THREE.Mesh(geometry, [face, side]);
  const proxyMat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  const proxy = new THREE.Mesh(hullGeometry(THREE), proxyMat);
  proxy.visible = false;

  const root = new THREE.Group();
  const tilt = new THREE.Group();
  const axis = new THREE.Group();
  const spin = new THREE.Group();
  const unaxis = new THREE.Group();
  root.add(tilt); tilt.add(axis); axis.add(spin); spin.add(unaxis); unaxis.add(mesh);
  // The hit area does not spin (it stays the front-facing footprint) so the ring can be grabbed edge-on too.
  tilt.add(proxy);
  axis.rotation.z = o.lean || 0;
  unaxis.rotation.z = -(o.lean || 0);
  scene.add(root);

  const camera = new THREE.PerspectiveCamera(o.fov || 22, 1, 0.01, 100);

  /** Frames the camera so `pxPerUnit` CSS px = 1 unit on the plane z = zMatch, looking at (cx, cy). */
  const frame = (width, height, pxPerUnit, zMatch = 0) => {
    camera.aspect = width / Math.max(1, height);
    const visH = height / pxPerUnit;
    const dist = visH / 2 / Math.tan((camera.fov * DEG) / 2);
    camera.position.set(0, 0, zMatch + dist);
    camera.near = Math.max(0.01, dist * 0.2);
    camera.far = dist * 4 + 2;
    camera.lookAt(0, 0, zMatch);
    camera.updateProjectionMatrix();
  };

  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  /** Is the client point over the ring's (convex) area? `rect` = canvas client rect. */
  const hit = (x, y, rect) => {
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return false;
    ndc.set(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    return ray.intersectObject(proxy, false).length > 0;
  };

  const dispose = () => {
    geometry.dispose();
    proxy.geometry.dispose();
    proxyMat.dispose();
    face.dispose();
    side.dispose();
    envRT.dispose();
  };

  return { scene, camera, root, tilt, axis, spin, unaxis, mesh, proxy, shared, frame, hit, dispose };
}

/* ================================================================== drag / hover controller */

/**
 * Gives `host` pointer events only while the pointer is over the ring's area (so links around it keep
 * their clicks), marks it data-cursor="drag", and reports drags / clicks.
 */
function grabber(kit, { host, view, stage, onGrab, onDrag, onRelease, onClick }) {
  const { core } = kit;
  let active = false;
  let drag = null;
  const prevPE = host.style.pointerEvents;

  const setActive = (on) => {
    if (on === active) return;
    active = on;
    host.style.pointerEvents = on ? 'auto' : 'none';
    if (on) host.setAttribute('data-cursor', 'drag');
    else host.removeAttribute('data-cursor');
  };
  const test = () => {
    if (drag || view.destroyed) return;
    if (!core.pointer.active) { setActive(false); return; }
    setActive(stage.hit(core.pointer.x, core.pointer.y, view.canvas.getBoundingClientRect()));
  };

  const down = (e) => {
    if (!active || e.button !== 0 || e.pointerType === 'touch') return;
    const now = performance.now();
    drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, t0: now, t: now, moved: 0, v: 0 };
    try { host.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    e.preventDefault();
    onGrab && onGrab();
  };
  const move = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const now = performance.now();
    const dx = e.clientX - drag.x;
    const dt = Math.max(4, now - drag.t) / 1000;
    drag.moved = Math.max(drag.moved, Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0));
    drag.v = drag.v * 0.35 + (dx / dt) * 0.65;
    drag.x = e.clientX;
    drag.t = now;
    onDrag && onDrag(dx);
  };
  const up = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    try { host.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    const now = performance.now();
    if (e.type !== 'pointercancel' && d.moved < 5 && now - d.t0 < 450) onClick && onClick();
    else onRelease && onRelease(now - d.t > 90 ? 0 : d.v);   // held still before letting go: no fling
    test();
  };

  host.addEventListener('pointerdown', down);
  host.addEventListener('pointermove', move);
  host.addEventListener('pointerup', up);
  host.addEventListener('pointercancel', up);
  host.addEventListener('lostpointercapture', up);
  const offP = core.pointer.subscribe(test);
  const offS = core.scroll.subscribe(test);
  host.style.pointerEvents = 'none';

  return {
    get dragging() { return !!drag; },
    test,
    destroy() {
      offP(); offS();
      host.removeEventListener('pointerdown', down);
      host.removeEventListener('pointermove', move);
      host.removeEventListener('pointerup', up);
      host.removeEventListener('pointercancel', up);
      host.removeEventListener('lostpointercapture', up);
      host.removeAttribute('data-cursor');
      host.style.pointerEvents = prevPE;
    },
  };
}

/* ================================================================== hero (index) */

const HERO_INK = 0.7;          // ring ink height as a share of the host height
const HERO_IDLE = 0.42;        // rad/s

function mountHero(kit, host) {
  const { THREE, core } = kit;
  const video = document.querySelector('.hero__bg');
  let stage = null;
  let grab = null;
  let roomPass = null;
  let first = false;

  const state = { angle: -0.35, vel: HERO_IDLE, dir: 1, tx: 0, ty: 0 };

  const view = core.createView({
    THREE, host, className: 'fx-canvas fx-ring-canvas', dprMax: 2, pixelBudget: 2.2e6,
    onResize: ({ width, height }) => {
      if (!stage) return;
      stage.frame(width, height, (height * HERO_INK) / INK_H);
      roomPass && roomPass.measure();
    },
    onFrame: (dt) => {
      if (!stage) return false;
      if (!grab.dragging) {
        state.vel += (HERO_IDLE * state.dir - state.vel) * core.damp(0.8, dt);
        state.angle += state.vel * dt;
      }
      const p = core.pointer;
      const tY = p.active ? p.nx * 0.24 : 0;
      const tX = p.active ? p.ny * 0.16 : 0;
      state.ty += (tY - state.ty) * core.damp(2.6, dt);
      state.tx += (tX - state.tx) * core.damp(2.6, dt);
      stage.spin.rotation.y = state.angle;
      stage.tilt.rotation.set(state.tx, state.ty, 0);
      roomPass && roomPass.update(view.renderer);
      view.renderer.render(stage.scene, stage.camera);
      if (!first) { first = true; host.classList.add('is-live'); }
      return true;
    },
    onFail: () => { cleanup(); },
  });

  view.renderer.toneMapping = THREE.NeutralToneMapping;
  view.renderer.toneMappingExposure = 1.05;
  try {
    stage = createStage(kit, view.renderer, {
      geometry: { depth: 0.036, bevel: 0.006, segments: 3 },
      lean: GIF_TILT,
      fov: 24,
      room: !!video,
    });
    if (video) roomPass = createRoomPass(kit, view, stage, video);
  } catch (e) { view.destroy(); throw e; }
  stage.frame(view.size.width, view.size.height, (view.size.height * HERO_INK) / INK_H);

  const radiusPx = () => Math.max(40, (view.size.height * HERO_INK) / INK_H * 0.3);
  grab = grabber(kit, {
    host, view, stage,
    onGrab: () => { state.vel = 0; },
    onDrag: (dx) => { state.angle += dx / radiusPx(); },
    onRelease: (v) => {
      state.vel = clamp(v / radiusPx(), -24, 24);
      if (Math.abs(state.vel) > 0.2) state.dir = Math.sign(state.vel);
    },
    onClick: () => {
      state.vel += 15 * state.dir;
      play('chime', { volume: 0.5 });
    },
  });
  preload('chime');
  view.invalidate();

  let cleaned = false;
  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    host.classList.remove('is-live');
    grab && grab.destroy();
    roomPass && roomPass.dispose();
    stage && stage.dispose();
  }
  return { name: 'hero', view, state, get stage() { return stage; }, get room() { return roomPass; }, destroy() { cleanup(); view.destroy(); } };
}

/**
 * The "room": a small, blurred copy of the playing landing video (RGBA8 sRGB, 96x54), redrawn only when the
 * video presents a new frame. Mapped so a fragment looks up the footage that sits behind it on screen.
 */
const ROOM_MIX = 0.7;           // share of the specular term taken by the footage
const ROOM_GAIN = 3.2;          // the footage is dark: lift it so the ring still reads as lit

function createRoomPass(kit, view, stage, video) {
  const { THREE } = kit;
  const W = 96, H = 54;
  const rt = new THREE.WebGLRenderTarget(W, H, {
    depthBuffer: false, colorSpace: THREE.SRGBColorSpace, generateMipmaps: false,
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
  });
  const tex = new THREE.VideoTexture(video);
  tex.colorSpace = THREE.NoColorSpace;   // decoded by hand below (video uploads skip the sRGB format)
  tex.generateMipmaps = false;
  const mat = new THREE.ShaderMaterial({
    uniforms: { uVideo: { value: tex }, uStep: { value: new THREE.Vector2(1 / W, 1 / H) } },
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: `
      uniform sampler2D uVideo; uniform vec2 uStep; varying vec2 vUv;
      vec3 decode(vec3 c) { return mix(pow((c + 0.055) / 1.055, vec3(2.4)), c / 12.92, vec3(lessThanEqual(c, vec3(0.04045)))); }
      void main() {
        vec3 c = vec3(0.0);
        for (int j = -2; j <= 2; j++) for (int i = -2; i <= 2; i++)
          c += decode(texture2D(uVideo, vUv + vec2(float(i), float(j)) * uStep * 0.3).rgb);
        gl_FragColor = vec4(c / 25.0, 1.0);
      }`,
    depthTest: false, depthWrite: false,
  });
  const quadScene = new THREE.Scene();
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  quad.frustumCulled = false;
  quadScene.add(quad);
  const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  let dirty = true;
  let lastTime = -1;
  let rvfc = 0;
  let readable = null;
  const hasRVFC = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
  const onVideoFrame = () => { dirty = true; rvfc = video.requestVideoFrameCallback(onVideoFrame); };
  if (hasRVFC) rvfc = video.requestVideoFrameCallback(onVideoFrame);

  const map = stage.shared.uRoomMap.value;
  stage.shared.uRoomGain.value = ROOM_GAIN;
  const measure = () => {
    const vr = video.getBoundingClientRect();
    const cr = view.canvas.getBoundingClientRect();
    const vw = video.videoWidth || 1920, vh = video.videoHeight || 1080;
    const scale = Math.max(vr.width / vw, vr.height / vh);
    const w = vw * scale, h = vh * scale;
    const x0 = (vr.width - w) / 2, y0 = (vr.height - h) / 2;
    const cL = cr.left - vr.left, cT = cr.top - vr.top;
    const dpr = view.size.dpr || 1;
    map.set(1 / (dpr * w), 1 / (dpr * h), (cL - x0) / w, 1 - (cr.height + cT - y0) / h);
  };
  video.addEventListener('loadedmetadata', measure);
  addEventListener('resize', measure);
  addEventListener('krisha:arrive', measure);   // the arrival cover may have moved things while we measured

  const update = (renderer) => {
    if (video.readyState < 2 || !video.videoWidth) return;
    if (readable === null) {
      // prove the frame can be uploaded (cross-origin would throw) before relying on it
      const gl = renderer.getContext();
      const probe = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, probe);
      try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video); readable = true; } catch (e) { readable = false; }
      gl.deleteTexture(probe);
      renderer.resetState();
      if (readable) { measure(); stage.shared.uRoom.value = rt.texture; }
    }
    if (!readable) return;
    if (!hasRVFC && video.currentTime !== lastTime) { lastTime = video.currentTime; dirty = true; }
    if (!dirty) return;
    dirty = false;
    tex.needsUpdate = true;
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(rt);
    renderer.render(quadScene, quadCam);
    renderer.setRenderTarget(prev);
    const s = stage.shared;
    s.uRoomMix.value += (ROOM_MIX - s.uRoomMix.value) * 0.08;   // fades in over the first frames
  };

  return {
    rt,
    measure,
    update,
    dispose() {
      if (hasRVFC && rvfc) { try { video.cancelVideoFrameCallback(rvfc); } catch (e) { /* ignore */ } }
      video.removeEventListener('loadedmetadata', measure);
      removeEventListener('resize', measure);
      removeEventListener('krisha:arrive', measure);
      stage.shared.uRoom.value = null;
      tex.dispose(); rt.dispose(); mat.dispose(); quad.geometry.dispose();
    },
  };
}

/* ================================================================== emblem (security) */

const EMBLEM_PX_PER_UNIT = 188 / 288.758;   // GIF ring long axis ~147u in the 288.758u box (measured)

function mountEmblem(kit, host) {
  const { THREE, core } = kit;
  const img = host.querySelector('img');
  let stage = null;
  let grab = null;
  let first = false;
  const state = { angle: 0, vel: GIF_SPIN, dir: 1 };

  const view = core.createView({
    THREE, host, className: 'fx-canvas fx-ring-canvas', dprMax: 2, pixelBudget: 1.6e6,
    onResize: ({ width, height }) => {
      stage && stage.frame(width, height, height * EMBLEM_PX_PER_UNIT);
    },
    onFrame: (dt) => {
      if (!stage) return false;
      if (!grab.dragging) {
        const sv = core.scroll.velocity || 0;
        const target = GIF_SPIN * state.dir + clamp(sv * 0.006, -9, 9);
        state.vel += (target - state.vel) * core.damp(Math.abs(sv) > 20 ? 5 : 1.1, dt);
        state.angle += state.vel * dt;
      }
      stage.spin.rotation.y = state.angle;
      view.renderer.render(stage.scene, stage.camera);
      if (!first) { first = true; host.classList.add('fx-ring-live'); }
      return true;
    },
    onFail: () => { cleanup(); },
  });

  view.renderer.toneMapping = THREE.NeutralToneMapping;
  try {
    stage = createStage(kit, view.renderer, {
      geometry: { depth: 0.036, bevel: 0.006, segments: 3 },
      lean: GIF_TILT,
      fov: 24,
    });
  } catch (e) { view.destroy(); throw e; }
  stage.frame(view.size.width, view.size.height, view.size.height * EMBLEM_PX_PER_UNIT);
  // A slight downward view, like the GIF (its extrusion shows along the lower edges).
  stage.tilt.rotation.x = -0.12;

  const radiusPx = () => Math.max(30, view.size.height * EMBLEM_PX_PER_UNIT * 0.3);
  grab = grabber(kit, {
    host, view, stage,
    onGrab: () => { state.vel = 0; },
    onDrag: (dx) => { state.angle += dx / radiusPx(); },
    onRelease: (v) => {
      state.vel = clamp(v / radiusPx(), -30, 30);
      if (Math.abs(state.vel) > 0.3) state.dir = Math.sign(state.vel);
    },
  });
  view.invalidate();

  let cleaned = false;
  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    host.classList.remove('fx-ring-live');     // the GIF comes back
    grab && grab.destroy();
    stage && stage.dispose();
  }
  return { name: 'emblem', view, state, get stage() { return stage; }, destroy() { cleanup(); view.destroy(); } };
}

/* ================================================================== nav logo */

const NAV_PAD = 0.3;          // canvas overhang around the <img> box (share of its height) for the turn
const NAV_REACH = 170;        // px: pointer distance at which the tilt starts

function mountNav(kit, img) {
  const { THREE, core } = kit;
  const parent = img.offsetParent || img.parentElement;
  const wrap = document.createElement('div');
  wrap.className = 'fx-ring-nav';
  wrap.setAttribute('aria-hidden', 'true');
  wrap.style.position = 'absolute';        // inline too: never affects layout even if ring.css is missing
  wrap.style.pointerEvents = 'none';
  img.insertAdjacentElement('afterend', wrap);

  let stage = null;
  let first = false;
  let box = { ppu: 1 };   // CSS px per image-height unit of the displayed logo
  // spring for the turn, damped follow for the tilt
  const st = { a: 0, v: 0, target: 0, tx: 0, ty: 0, ttx: 0, tty: 0, holdUntil: 0 };

  const layout = () => {
    if (!img.isConnected) return;
    const w = img.offsetWidth, h = img.offsetHeight;
    if (!w || !h) { wrap.style.display = 'none'; return; }
    wrap.style.display = '';
    const pad = Math.round(h * NAV_PAD);
    // object-fit: cover (or contain / fill) of the natural image inside the box, centred
    const nw = img.naturalWidth || 1640, nh = img.naturalHeight || 2360;
    const fit = getComputedStyle(img).objectFit;
    const s = fit === 'contain' ? Math.min(w / nw, h / nh) : Math.max(w / nw, h / nh);
    const ppu = fit === 'fill' ? h : nh * s;   // CSS px per image-height unit
    box = { ppu };
    Object.assign(wrap.style, {
      left: `${img.offsetLeft - pad}px`, top: `${img.offsetTop - pad}px`,
      width: `${w + pad * 2}px`, height: `${h + pad * 2}px`,
    });
  };
  layout();

  const zFront = 0.03 / 2;     // match the flat logo on the extrusion's front edge
  const view = core.createView({
    THREE, host: wrap, observe: img, className: 'fx-canvas fx-ring-canvas', dprMax: 2.5, pixelBudget: 4e5,
    onResize: ({ width, height }) => {
      stage && stage.frame(width, height, box.ppu, zFront);
    },
    onFrame: (dt) => {
      if (!stage) return false;
      const now = performance.now();
      if (st.holdUntil && now > st.holdUntil) { st.target = 0; st.holdUntil = 0; }
      // critically-ish damped spring (a little overshoot on the way back)
      const k = 70, c = 2 * Math.sqrt(k) * 0.62;
      const steps = Math.max(1, Math.ceil(dt / (1 / 120)));
      const h = dt / steps;
      for (let i = 0; i < steps; i++) {
        st.v += (k * (st.target - st.a) - c * st.v) * h;
        st.a += st.v * h;
      }
      st.tx += (st.ttx - st.tx) * core.damp(7, dt);
      st.ty += (st.tty - st.ty) * core.damp(7, dt);
      stage.spin.rotation.y = st.a;
      stage.tilt.rotation.set(st.tx, st.ty, 0);
      const pose = Math.abs(st.a) + 0.8 * Math.hypot(st.tx, st.ty);
      stage.shared.uFlat.value = 1 - smooth(0.0, 0.32, pose);
      view.renderer.render(stage.scene, stage.camera);
      if (!first) { first = true; img.classList.add('fx-ring-hidden'); }
      const settled = !st.holdUntil && Math.abs(st.a - st.target) < 2e-4 && Math.abs(st.v) < 2e-3
        && Math.abs(st.tx - st.ttx) < 2e-4 && Math.abs(st.ty - st.tty) < 2e-4;
      if (settled) {
        st.a = st.target; st.v = 0; st.tx = st.ttx; st.ty = st.tty;
        stage.spin.rotation.y = st.a;
        stage.tilt.rotation.set(st.tx, st.ty, 0);
        stage.shared.uFlat.value = 1 - smooth(0.0, 0.32, Math.abs(st.a) + 0.8 * Math.hypot(st.tx, st.ty));
        view.renderer.render(stage.scene, stage.camera);
      }
      return !settled;
    },
    onFail: () => { cleanup(); },
  });
  view.renderer.toneMapping = THREE.NeutralToneMapping;
  try {
    stage = createStage(kit, view.renderer, {
      geometry: { depth: 0.03, bevel: 0.004, segments: 2, tol: 0.0012 },
      lean: 0,
      fov: 20,
    });
  } catch (e) { view.destroy(); wrap.remove(); throw e; }
  stage.frame(view.size.width, view.size.height, box.ppu, zFront);
  // the turn pivots on the ink centroid; the camera stays on the image centre (= the box centre)
  stage.root.position.set(PIVOT.x, PIVOT.y, 0);
  stage.shared.uFlat.value = 1;

  // ---- hover: a quarter turn, then settle back
  const nav = img.closest('nav') || parent;
  let lastLink = null;
  const onOver = (e) => {
    const a = e.target.closest && e.target.closest('a');
    if (!a || !nav.contains(a) || a === lastLink) return;
    lastLink = a;
    st.target = Math.PI / 2;
    st.holdUntil = performance.now() + 240;
    view.invalidate();
  };
  const onOut = (e) => {
    const a = e.target.closest && e.target.closest('a');
    if (a && !(e.relatedTarget && a.contains(e.relatedTarget))) lastLink = null;
  };
  nav.addEventListener('pointerover', onOver);
  nav.addEventListener('pointerout', onOut);

  // ---- nearby pointer: slight tilt toward it
  let rect = null;
  const readRect = () => { rect = img.getBoundingClientRect(); };
  const onPointer = (p) => {
    if (!rect) readRect();
    const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
    const dx = p.x - cx, dy = p.y - cy;
    const d = Math.hypot(dx, dy);
    const f = p.active ? 1 - smooth(NAV_REACH * 0.35, NAV_REACH, d) : 0;
    const ttx = f ? clamp(dy / NAV_REACH, -1, 1) * 0.42 * f : 0;
    const tty = f ? clamp(dx / NAV_REACH, -1, 1) * 0.5 * f : 0;
    if (Math.abs(ttx - st.ttx) > 1e-4 || Math.abs(tty - st.tty) > 1e-4) {
      st.ttx = ttx; st.tty = tty;
      view.invalidate();
    }
  };
  const offP = core.pointer.subscribe(onPointer);
  const offS = core.scroll.subscribe(() => { rect = null; });
  const onResize = () => { rect = null; layout(); };
  addEventListener('resize', onResize);
  const ro = new ResizeObserver(() => { rect = null; layout(); });
  ro.observe(img);
  if (!img.complete) img.addEventListener('load', layout, { once: true });
  view.invalidate();

  let cleaned = false;
  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    img.classList.remove('fx-ring-hidden');
    offP(); offS();
    nav.removeEventListener('pointerover', onOver);
    nav.removeEventListener('pointerout', onOut);
    removeEventListener('resize', onResize);
    ro.disconnect();
    stage && stage.dispose();
    wrap.remove();
  }
  return { name: 'nav', view, state: st, get stage() { return stage; }, destroy() { cleanup(); view.destroy(); } };
}

/* ================================================================== phone (html.fx-phone, the --m layouts) */
/*
 * Phones have no hover: the inputs are touch, tilt (fx/m-motion.js) and scroll. Battery rule: every phone
 * placement renders zero frames once settled, except the security emblem's spin (30 fps, paused offscreen).
 *   hero    full-screen video landing: the ring stands above the nav column. Spins in and comes to rest
 *           three-quarter on; tilt turns it in 3D; a finger drag spins it with inertia (touch-action is
 *           claimed only over the ring box); a tap = spin-up + chime, and the first tap asks for motion.
 *   nav     sticky phone nav logo: front-facing and flat-inked at rest; scroll velocity turns it in hard
 *           12-step increments (a spinning-GIF cadence) and it steps back to front when scrolling stops.
 *   emblem  security: the spinning 3D emblem, tilt leans the spin axis / pitches it, tap = spin burst.
 * On a page with both nav and emblem (security) the two share ONE WebGL renderer (createEngine), so the ring
 * never takes more than one context on a phone page.
 */

const directViews = (kit) => (o) => {
  const v = kit.core.createView(o);
  v.render = (scene, camera) => { v.renderer.render(scene, camera); return true; };
  return v;
};

/**
 * One hidden renderer drawing several placements: each placement gets a visible 2D canvas; a frame is rendered
 * into the lower-left corner of the shared drawing buffer and copied across with drawImage in the same task.
 * make(opts) mirrors core.createView (host, observe, className, onResize, onFrame, onFail) and returns an
 * object with the same surface the placements use (renderer, canvas, size, render, invalidate, wake, destroy).
 */
function createEngine(kit) {
  const { THREE, core } = kit;
  const box = document.createElement('div');
  box.className = 'fx-ring-engine';
  box.setAttribute('aria-hidden', 'true');
  Object.assign(box.style, {
    position: 'fixed', left: '0', top: '0', width: '1px', height: '1px', overflow: 'hidden',
    visibility: 'hidden', pointerEvents: 'none', zIndex: '-1',
  });
  document.body.appendChild(box);
  const subs = new Set();
  const view = core.createView({
    THREE, host: box, observe: null, className: 'fx-canvas', dprMax: 2, pixelBudget: 1.5e6,
    onFrame: (dt, t) => { let more = false; subs.forEach((s) => { if (s._step(dt, t)) more = true; }); return more; },
    onFail: (reason) => { [...subs].forEach((s) => s._fail(reason)); box.remove(); },
  });
  const fit = () => {
    let w = 1, h = 1;
    subs.forEach((s) => { w = Math.max(w, s.size.width); h = Math.max(h, s.size.height); });
    box.style.width = `${w}px`;
    box.style.height = `${h}px`;
  };

  const make = (o) => {
    const { host, observe = host, onResize, onFrame, onFail } = o;
    const canvas = document.createElement('canvas');
    canvas.className = o.className || 'fx-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    host.appendChild(canvas);
    const c2d = canvas.getContext('2d');
    let requested = true, animating = false, wakeUntil = 0, visible = true, paused = false;
    const sub = { THREE, renderer: view.renderer, canvas, size: { width: 1, height: 1, dpr: 1 }, destroyed: false };

    sub.render = (scene, camera) => {
      const r = view.renderer;
      if (view.destroyed) return false;
      const { width: w, height: h } = sub.size;
      const pr = r.getPixelRatio();
      const W = r.domElement.width, H = r.domElement.height;
      const pw = Math.floor(w * pr), ph = Math.floor(h * pr);
      if (pw < 1 || ph < 1 || pw > W || ph > H) { requested = true; return false; }   // buffer still growing
      r.setViewport(0, 0, w, h);
      r.setScissor(0, 0, w, h);
      r.setScissorTest(true);
      r.render(scene, camera);
      r.setScissorTest(false);
      if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; } else c2d.clearRect(0, 0, pw, ph);
      c2d.drawImage(r.domElement, 0, H - ph, pw, ph, 0, 0, pw, ph);
      return true;
    };
    sub.invalidate = () => { if (sub.destroyed) return; requested = true; view.invalidate(); };
    sub.wake = (ms = 1000) => { if (sub.destroyed) return; wakeUntil = Math.max(wakeUntil, performance.now() + ms); view.wake(ms); };
    sub.setPaused = (p) => { paused = !!p; if (!paused) sub.invalidate(); };
    sub._step = (dt, t) => {
      if (sub.destroyed || paused || !visible) return false;
      if (!(requested || animating || performance.now() < wakeUntil)) return false;
      requested = false;
      animating = !!(onFrame && onFrame(dt, t));
      return animating || requested || performance.now() < wakeUntil;
    };

    const resize = () => {
      if (sub.destroyed) return;
      const w = Math.max(1, Math.round(host.clientWidth));
      const h = Math.max(1, Math.round(host.clientHeight));
      if (w === sub.size.width && h === sub.size.height) return;
      sub.size = { width: w, height: h, dpr: view.renderer.getPixelRatio() };
      fit();
      onResize && onResize(sub.size);
      sub.invalidate();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(host);
    let io = null;
    if (observe && 'IntersectionObserver' in window) {
      io = new IntersectionObserver((entries) => {
        visible = entries[entries.length - 1].isIntersecting;
        if (visible) sub.invalidate();
      }, { rootMargin: '10% 0px' });
      io.observe(observe);
    }
    const teardown = () => {
      sub.destroyed = true;
      subs.delete(sub);
      ro.disconnect();
      io && io.disconnect();
      canvas.remove();
    };
    sub._fail = (reason) => { if (sub.destroyed) return; teardown(); onFail && onFail(reason); };
    sub.destroy = () => {
      if (sub.destroyed) return;
      teardown();
      if (!subs.size) { view.destroy(); box.remove(); } else fit();
    };
    subs.add(sub);
    resize();
    return sub;
  };
  return { make, view, dispose() { view.destroy(); box.remove(); } };
}

let motionKit = null;
/** fx/m-motion.js (phones only; never imported on desktop). Same URL as every other phone feature: one sensor. */
async function loadMotion() {
  if (!motionKit) motionKit = import('./m-motion.js').catch(() => null);
  return motionKit;
}

/** Ask for motion on a tap if it still needs one (iOS shows the KRISHA.EXE dialog; elsewhere it's a no-op). */
function askMotion(kit, then) {
  const m = kit.motion;
  if (!m || m.motionState() !== 'needs-tap') return;
  m.enableMotion({ ask: true }).then((ok) => { if (ok && then) then(); }, () => {});
}

/** Subscribe to tilt, waking `view` only for changes worth a frame (sensor noise would otherwise keep it awake). */
function tiltFeed(kit, view, eps = 0.004) {
  const t = { x: 0, y: 0, off: null };
  const m = kit.motion;
  if (!m) return t;
  const take = (s) => {
    if (Math.abs(s.x - t.x) > eps || Math.abs(s.y - t.y) > eps) { t.x = s.x; t.y = s.y; view.invalidate(); }
  };
  if (m.motion.live) take(m.motion);
  t.off = m.motion.subscribe(take);
  return t;
}

const HERO_REST = -0.32;       // resting pose: three-quarter on, so the extrusion reads

function mountHeroPhone(kit, host) {
  const { THREE, core } = kit;
  const video = document.querySelector('.hero__bg');
  let stage = null;
  let roomPass = null;
  let first = false;
  // spins in from a turn and a half away and comes to rest
  const st = { angle: HERO_REST - 4.6, vel: 6.5, dir: 1, seek: null, tx: 0, ty: 0, drag: null };
  let tilt = { x: 0, y: 0 };

  const ppu = (h) => (h * HERO_INK) / INK_H;
  const view = core.createView({
    THREE, host, className: 'fx-canvas fx-ring-canvas', dprMax: 2, pixelBudget: 1.2e6,
    onResize: ({ width, height }) => {
      if (!stage) return;
      stage.frame(width, height, ppu(height));
      roomPass && roomPass.measure();
    },
    onFrame: (dt) => {
      if (!stage) return false;
      if (!st.drag) {
        if (st.seek === null) {
          st.vel *= Math.exp(-1.25 * dt);
          st.angle += st.vel * dt;
          // slow enough: pick the resting pose ahead (or just behind) and spring into it
          if (Math.abs(st.vel) < 1.7) st.seek = HERO_REST + TAU * Math.round((st.angle - HERO_REST) / TAU + 0.3 * Math.sign(st.vel));
        } else {
          const k = 11, c = 2 * Math.sqrt(k) * 0.82;
          const n = Math.max(1, Math.ceil(dt / (1 / 120))), h = dt / n;
          for (let i = 0; i < n; i++) { st.vel += (k * (st.seek - st.angle) - c * st.vel) * h; st.angle += st.vel * h; }
        }
      }
      const tY = tilt.x * 0.75, tX = tilt.y * 0.5;
      st.ty += (tY - st.ty) * core.damp(9, dt);
      st.tx += (tX - st.tx) * core.damp(9, dt);
      const settled = !st.drag && st.seek !== null && Math.abs(st.seek - st.angle) < 6e-4 && Math.abs(st.vel) < 4e-3
        && Math.abs(tY - st.ty) < 6e-4 && Math.abs(tX - st.tx) < 6e-4;
      if (settled) {
        st.angle = st.seek = HERO_REST;   // fold the turns away
        st.vel = 0; st.ty = tY; st.tx = tX;
      }
      stage.spin.rotation.y = st.angle;
      stage.tilt.rotation.set(st.tx, st.ty, 0);
      roomPass && roomPass.update(view.renderer);
      view.renderer.render(stage.scene, stage.camera);
      if (!first) { first = true; host.classList.add('is-live'); }
      return !settled;
    },
    onFail: () => { cleanup(); },
  });

  view.renderer.toneMapping = THREE.NeutralToneMapping;
  view.renderer.toneMappingExposure = 1.05;
  try {
    stage = createStage(kit, view.renderer, {
      geometry: { depth: 0.036, bevel: 0.006, segments: 3, tol: 0.0006 },
      lean: GIF_TILT,
      fov: 24,
      room: !!video,
    });
    if (video) roomPass = createRoomPass(kit, view, stage, video);
  } catch (e) { view.destroy(); throw e; }
  stage.frame(view.size.width, view.size.height, ppu(view.size.height));
  tilt = tiltFeed(kit, view);
  // the reflection needs a frame once the footage is actually there
  const onVideo = () => view.invalidate();
  if (video) { video.addEventListener('loadeddata', onVideo); video.addEventListener('playing', onVideo); }

  // ---- touch: drag spins (inertia), tap = spin-up + chime (+ the motion question the first time)
  const radiusPx = () => Math.max(36, ppu(view.size.height) * 0.3);
  const near = (x, y) => {
    const r = view.canvas.getBoundingClientRect();
    if (stage.hit(x, y, r)) return true;
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    return Math.hypot(x - cx, y - cy) < r.height * 0.36;
  };
  const down = (e) => {
    if (st.drag || !stage || (e.pointerType === 'mouse' && e.button !== 0)) return;
    if (!near(e.clientX, e.clientY)) return;
    const now = performance.now();
    st.drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, t0: now, t: now, moved: 0, v: 0 };
    try { host.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    st.vel = 0; st.seek = null;
    view.invalidate();
  };
  const move = (e) => {
    const d = st.drag;
    if (!d || e.pointerId !== d.id) return;
    const now = performance.now();
    const dx = e.clientX - d.x;
    const dt = Math.max(4, now - d.t) / 1000;
    d.moved = Math.max(d.moved, Math.hypot(e.clientX - d.x0, e.clientY - d.y0));
    d.v = d.v * 0.35 + (dx / dt) * 0.65;
    d.x = e.clientX; d.t = now;
    st.angle += dx / radiusPx();
    view.invalidate();
  };
  const up = (e) => {
    const d = st.drag;
    if (!d || e.pointerId !== d.id) return;
    st.drag = null;
    try { host.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    const now = performance.now();
    if (e.type !== 'pointercancel' && e.type !== 'lostpointercapture' && d.moved < 9 && now - d.t0 < 400) {
      st.vel = (Math.abs(st.vel) + 14) * st.dir;
      play('chime', { volume: 0.5 });
      askMotion(kit, () => view.invalidate());
    } else {
      st.vel = clamp((now - d.t > 90 ? 0 : d.v) / radiusPx(), -24, 24);
      if (Math.abs(st.vel) > 0.3) st.dir = Math.sign(st.vel);
    }
    st.seek = null;
    view.invalidate();
  };
  host.addEventListener('pointerdown', down);
  host.addEventListener('pointermove', move);
  host.addEventListener('pointerup', up);
  host.addEventListener('pointercancel', up);
  host.addEventListener('lostpointercapture', up);
  preload('chime');
  view.invalidate();

  let cleaned = false;
  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    host.classList.remove('is-live');
    tilt.off && tilt.off();
    if (video) { video.removeEventListener('loadeddata', onVideo); video.removeEventListener('playing', onVideo); }
    host.removeEventListener('pointerdown', down);
    host.removeEventListener('pointermove', move);
    host.removeEventListener('pointerup', up);
    host.removeEventListener('pointercancel', up);
    host.removeEventListener('lostpointercapture', up);
    roomPass && roomPass.dispose();
    stage && stage.dispose();
  }
  return { name: 'hero', view, state: st, get stage() { return stage; }, get room() { return roomPass; }, destroy() { cleanup(); view.destroy(); } };
}

const EMBLEM_PHONE_PPU = 188 / 211.661;   // ring px per unit, relative to the displayed GIF's width (desktop ratio)
const EMBLEM_PHONE_FPS = 30;

function mountEmblemPhone(kit, host) {
  const { THREE, core } = kit;
  const img = host.querySelector('img');
  // the spin sweeps past the GIF's box on phones (the GIF fills it): draw in an overhanging stage
  const wrap = document.createElement('div');
  wrap.className = 'fx-ring-emblem';
  wrap.setAttribute('aria-hidden', 'true');
  Object.assign(wrap.style, { position: 'absolute', pointerEvents: 'none' });
  host.appendChild(wrap);

  let stage = null;
  let first = false;
  let acc = 1;
  const st = { angle: 0, vel: GIF_SPIN, dir: 1, lean: GIF_TILT, pitch: -0.12 };
  let tilt = { x: 0, y: 0 };
  const ppu = () => (img && img.offsetWidth ? img.offsetWidth : host.clientWidth) * EMBLEM_PHONE_PPU;

  const view = kit.makeView({
    THREE, host: wrap, className: 'fx-canvas fx-ring-canvas', dprMax: 2, pixelBudget: 6e5,
    onResize: ({ width, height }) => { stage && stage.frame(width, height, ppu()); },
    onFrame: (dt) => {
      if (!stage) return false;
      acc += dt;
      if (acc < 1 / EMBLEM_PHONE_FPS - 0.003) return true;      // 30 fps cap
      const step = Math.min(0.1, acc);
      acc = 0;
      const sv = core.scroll.velocity || 0;
      const target = GIF_SPIN * st.dir + clamp(sv * 0.004, -8, 8);
      st.vel += (target - st.vel) * core.damp(Math.abs(sv) > 20 ? 5 : 1.1, step);
      st.angle = (st.angle + st.vel * step) % (TAU * 64);
      // tilt: roll leans the spin axis further, pitch tips it toward / away from you
      st.lean += (GIF_TILT + tilt.x * 0.5 - st.lean) * core.damp(6, step);
      st.pitch += (-0.12 + tilt.y * 0.4 - st.pitch) * core.damp(6, step);
      stage.axis.rotation.z = st.lean;
      stage.tilt.rotation.x = st.pitch;
      stage.spin.rotation.y = st.angle;
      if (view.render(stage.scene, stage.camera) && !first) { first = true; host.classList.add('fx-ring-live'); }
      return true;
    },
    onFail: () => { cleanup(); },
  });

  view.renderer.toneMapping = THREE.NeutralToneMapping;
  try {
    stage = createStage(kit, view.renderer, {
      geometry: { depth: 0.036, bevel: 0.006, segments: 3, tol: 0.0006 },
      lean: GIF_TILT,
      fov: 24,
    });
  } catch (e) { view.destroy(); wrap.remove(); throw e; }
  stage.frame(view.size.width, view.size.height, ppu());
  stage.tilt.rotation.x = st.pitch;
  tilt = tiltFeed(kit, view);

  // a tap (a click: it never fires after a scroll) = a spin burst, and the motion question if still open.
  // No touch-action is claimed here: the page scrolls straight through the emblem.
  const onTap = () => {
    st.vel += 12 * st.dir;
    askMotion(kit, () => view.invalidate());
  };
  host.addEventListener('click', onTap);
  view.invalidate();

  let cleaned = false;
  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    host.classList.remove('fx-ring-live');     // the GIF comes back
    host.removeEventListener('click', onTap);
    tilt.off && tilt.off();
    stage && stage.dispose();
    wrap.remove();
  }
  return { name: 'emblem', view, state: st, get stage() { return stage; }, destroy() { cleanup(); view.destroy(); } };
}

const NAV_STEP = TAU / 12;     // the phone nav logo turns in hard 30-degree steps, like a 12-frame GIF

function mountNavPhone(kit, img) {
  const { THREE, core } = kit;
  const wrap = document.createElement('div');
  wrap.className = 'fx-ring-nav';
  wrap.setAttribute('aria-hidden', 'true');
  wrap.style.position = 'absolute';
  wrap.style.pointerEvents = 'none';
  img.insertAdjacentElement('afterend', wrap);

  let stage = null;
  let first = false;
  let box = { ppu: 1 };
  const st = { a: 0, v: 0, target: 0, shown: 0, kick: false };

  const layout = () => {
    if (!img.isConnected) return;
    const w = img.offsetWidth, h = img.offsetHeight;
    if (!w || !h) { wrap.style.display = 'none'; return; }
    wrap.style.display = '';
    const pad = Math.round(h * NAV_PAD);
    const nw = img.naturalWidth || 1640, nh = img.naturalHeight || 2360;
    const fit = getComputedStyle(img).objectFit;
    const s = fit === 'contain' ? Math.min(w / nw, h / nh) : Math.max(w / nw, h / nh);
    box = { ppu: fit === 'fill' ? h : nh * s };
    Object.assign(wrap.style, {
      left: `${img.offsetLeft - pad}px`, top: `${img.offsetTop - pad}px`,
      width: `${w + pad * 2}px`, height: `${h + pad * 2}px`,
    });
  };
  layout();

  const zFront = 0.03 / 2;
  const draw = (angle) => {
    stage.spin.rotation.y = angle;
    const off = Math.abs(Math.atan2(Math.sin(angle), Math.cos(angle)));
    stage.shared.uFlat.value = 1 - smooth(0.0, 0.32, off);
    if (view.render(stage.scene, stage.camera) && !first) { first = true; img.classList.add('fx-ring-hidden'); }
  };

  const view = kit.makeView({
    THREE, host: wrap, observe: img, className: 'fx-canvas fx-ring-canvas', dprMax: 2, pixelBudget: 4e5,
    onResize: ({ width, height }) => { stage && stage.frame(width, height, box.ppu, zFront); },
    onFrame: (dt) => {
      if (!stage) return false;
      const sv = core.scroll.velocity || 0;
      if (Math.abs(sv) > 30 && !st.kick) {
        // scrolling drives the turn
        st.v += (clamp(sv * 0.0045, -9, 9) - st.v) * core.damp(5, dt);
        st.target = null;
      } else {
        // let go: step on (or back) to the nearest front-facing pose
        if (st.target === null) st.target = TAU * Math.round(st.a / TAU + 0.2 * Math.sign(st.v));
        const d = st.target - st.a;
        st.v += (Math.sign(d) * clamp(Math.abs(d) * 4, 2.4, 9) - st.v) * core.damp(10, dt);
      }
      const prev = st.a;
      st.a += st.v * dt;
      let rest = false;
      if (st.target !== null && (Math.abs(st.target - st.a) < 1e-3 || Math.sign(st.target - st.a) !== Math.sign(st.target - prev))) {
        st.a = 0; st.v = 0; st.target = 0; st.kick = false; rest = true;
      }
      const shown = rest ? 0 : Math.round(st.a / NAV_STEP) * NAV_STEP;
      if (!first || shown !== st.shown) { st.shown = shown; draw(shown); }
      return !rest;
    },
    onFail: () => { cleanup(); },
  });
  view.renderer.toneMapping = THREE.NeutralToneMapping;
  try {
    stage = createStage(kit, view.renderer, {
      geometry: { depth: 0.03, bevel: 0.004, segments: 2, tol: 0.0012 },
      lean: 0,
      fov: 20,
    });
  } catch (e) { view.destroy(); wrap.remove(); throw e; }
  stage.frame(view.size.width, view.size.height, box.ppu, zFront);
  stage.root.position.set(PIVOT.x, PIVOT.y, 0);
  stage.shared.uFlat.value = 1;

  const offS = core.scroll.subscribe((s) => { if (Math.abs(s.velocity) > 30) view.invalidate(); });
  // tap: one full stepped turn. The logo is not a link and nothing here prevents defaults or stops
  // propagation, so a tap goes wherever it went before.
  // (Listened for on the nav: the hidden <img> itself takes no taps.)
  const tapRoot = img.parentElement || document.body;
  const onTap = (e) => {
    const r = img.getBoundingClientRect();
    if (e.clientX < r.left - 6 || e.clientX > r.right + 6 || e.clientY < r.top - 6 || e.clientY > r.bottom + 6) return;
    if (e.target.closest && e.target.closest('a, button, summary, details[open]')) return;
    st.kick = true;
    st.target = (st.target === null ? Math.round(st.a / TAU) * TAU : st.target) + TAU;
    view.invalidate();
  };
  tapRoot.addEventListener('click', onTap);
  const onResize = () => { layout(); };
  addEventListener('resize', onResize);
  const ro = new ResizeObserver(layout);
  ro.observe(img);
  if (!img.complete) img.addEventListener('load', layout, { once: true });
  view.invalidate();

  let cleaned = false;
  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    img.classList.remove('fx-ring-hidden');
    offS();
    tapRoot.removeEventListener('click', onTap);
    removeEventListener('resize', onResize);
    ro.disconnect();
    stage && stage.dispose();
    wrap.remove();
  }
  return { name: 'nav', view, state: st, get stage() { return stage; }, destroy() { cleanup(); view.destroy(); } };
}

/* ================================================================== mount */

export async function mount(ctx) {
  const { THREE, core } = ctx || {};
  if (!THREE || !core || typeof core.createView !== 'function') return;
  const hero = document.querySelector('[data-fx-ring="hero"]');
  const emblem = document.querySelector('[data-fx-ring="emblem"]');
  const navImg = document.querySelector('.nav__logo');
  if (!hero && !emblem && !navImg) return;

  let kit;
  try {
    const [env, utils] = await Promise.all([
      import('three/addons/environments/RoomEnvironment.js'),
      import('three/addons/utils/BufferGeometryUtils.js'),
    ]);
    kit = { THREE, core, RoomEnvironment: env.RoomEnvironment, toCreasedNormals: utils.toCreasedNormals };
  } catch (e) {
    console.warn('[fx] ring: three addons unavailable', e);
    return;
  }

  const live = [];
  const add = (fn, el) => {
    if (el.dataset.fxRingMounted) return;           // one ring per element, even if mount() runs twice
    try {
      const m = fn(kit, el);
      if (!m) return;
      el.dataset.fxRingMounted = m.name;
      const destroy = m.destroy;
      m.destroy = () => { delete el.dataset.fxRingMounted; destroy(); };
      live.push(m);
    } catch (e) { console.warn('[fx] ring mount failed', e); }
  };
  if (core.isPhone) {
    kit.motion = await loadMotion();
    const navOk = !!(navImg && navImg.offsetWidth);
    // nav + emblem on one page (security): one shared renderer for both
    let engine = null;
    if (emblem && navOk) {
      try { engine = createEngine(kit); } catch (e) { console.warn('[fx] ring engine failed', e); }
    }
    kit.makeView = engine ? engine.make : directViews(kit);
    if (hero) add(mountHeroPhone, hero);
    if (emblem) add(mountEmblemPhone, emblem);
    if (navOk) add(mountNavPhone, navImg);
    if (engine && !live.some((m) => m.name !== 'hero')) engine.dispose();
  } else {
    if (hero) add(mountHero, hero);
    if (emblem) add(mountEmblem, emblem);
    if (navImg && navImg.offsetWidth) add(mountNav, navImg);
  }

  return {
    live,
    destroy() { live.splice(0).forEach((m) => { try { m.destroy(); } catch (e) { /* ignore */ } }); },
  };
}
