/*
 * fx/boot.js — single module entry on every page. Decides which feature modules to load.
 *
 * Feature module contract:
 *   export async function mount(ctx) -> void | { destroy() }
 *   ctx = { gl: boolean, THREE: THREE|null, core: (fx/gl.js namespace), page: string }
 *   - GL modules are only imported when gate() passes; `lite` modules otherwise (may be absent).
 *   - mount() must never throw to the page; boot catches anyway and leaves the static site intact.
 *
 * Load order: `now` features right away (transitions must uncover fast), the rest at idle.
 */
import * as core from './gl.js';

// Bump V (and the ?v= on the boot.js tag in every page head) whenever a feature module changes.
const V = 4;

const page = (location.pathname.split('/').pop() || 'index.html').replace(/\.html$/, '') || 'index';
const has = (sel) => !!document.querySelector(sel);

const desk = () => !core.isPhone;
const phone = () => core.isPhone;

const FEATURES = [
  // shared
  { name: 'transitions', when: () => true,                 lite: () => import(`./transitions.js?v=${V}`),       now: true },
  { name: 'arrival',     when: () => page === 'index',     lite: () => import(`./arrival.js?v=${V}`),           now: true },
  { name: 'ring',        when: () => has('[data-fx-ring], .nav__logo'), gl: () => import(`./ring.js?v=${V}`) },
  // desktop (mouse, wide layouts)
  { name: 'cursor',      when: () => desk() && core.finePointer, lite: () => import(`./cursor-fx.js?v=${V}`),   now: true },
  { name: 'nav-progress', when: () => desk() && has('.nav__divider'), lite: () => import(`./nav-progress.js?v=${V}`) },
  { name: 'paint',       when: () => desk() && has('.paint-page'),   gl: () => import(`./paint.js?v=${V}`),    lite: () => import(`./paint-lite.js?v=${V}`) },
  { name: 'creative',    when: () => desk() && has('.creative-page'), gl: () => import(`./creative.js?v=${V}`) },
  { name: 'flipbook',    when: () => desk() && has('.sec-issue'), gl: () => import(`./flipbook.js?v=${V}`), lite: () => import(`./flipbook-lite.js?v=${V}`) },
  // phone (touch-first, --m layouts)
  { name: 'm-shell',     when: phone,                                   lite: () => import(`./m-shell.js?v=${V}`),       now: true },
  { name: 'm-reel',      when: () => phone() && has('.mobile-creative-reel'), lite: () => import(`./m-reel.js?v=${V}`) },
  { name: 'm-paint',     when: () => phone() && has('.paint-page'),     gl: () => import(`./m-paint.js?v=${V}`),     lite: () => import(`./paint-lite.js?v=${V}`) },
  { name: 'm-flipbook',  when: () => phone() && has('.sec-issue'),  gl: () => import(`./m-flipbook.js?v=${V}`),  lite: () => import(`./flipbook-lite.js?v=${V}`) },
  { name: 'm-gallery',   when: () => phone() && !has('.paint-page, .security-page, .creative-page') && page !== 'index', lite: () => import(`./m-gallery.js?v=${V}`) },
];

const mounted = {};
window.__fx = { core, mounted, page };

async function start(f) {
  try {
    if (!f.when()) return;
    const useGl = !!f.gl && core.gate().ok;
    const loader = useGl ? f.gl : f.lite;
    if (!loader) return;
    const THREE = useGl ? await core.loadThree() : null;
    const mod = await loader();
    if (!mod || typeof mod.mount !== 'function') return;
    mounted[f.name] = (await mod.mount({ gl: useGl, THREE, core, page })) || true;
  } catch (err) {
    // Missing optional module (not built yet) or a feature failure: the static page stays.
    if (!/Failed to fetch dynamically imported module|Importing a module script failed/.test(String(err))) {
      console.warn(`[fx] ${f.name} failed`, err);
    }
  }
}

FEATURES.filter((f) => f.now).forEach(start);

const later = () => FEATURES.filter((f) => !f.now).forEach(start);
if ('requestIdleCallback' in window) requestIdleCallback(later, { timeout: 700 });
else setTimeout(later, 120);
