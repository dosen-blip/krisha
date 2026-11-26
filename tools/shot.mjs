// Headless check for the KRISHA site (served at http://localhost:3456).
// usage: node shot.mjs <path-or-url> <out.png> [--mobile] [--wait=ms] [--scroll=px] [--eval="js"] [--full] [--w=1440 --h=900]
// Prints console errors/warnings, html[data-fx-gl], and the result of --eval. Uses system Chrome with GPU flags.
import { chromium } from '/Users/matiadosen/Documents/framer/node_modules/playwright-core/index.mjs';
const args = process.argv.slice(2);
const opt = Object.fromEntries(args.filter(a => a.startsWith('--')).map(a => { const [k, ...v] = a.slice(2).split('='); return [k, v.length ? v.join('=') : true]; }));
const [target, out] = args.filter(a => !a.startsWith('--'));
const url = /^https?:/.test(target) ? target : `http://localhost:3456/${target.replace(/^\//, '')}`;
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const mobile = !!opt.mobile;
const ctx = await browser.newContext(mobile
  ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
  : { viewport: { width: +(opt.w || 1440), height: +(opt.h || 900) }, deviceScaleFactor: 1, reducedMotion: opt.reduced ? 'reduce' : 'no-preference' });
const page = await ctx.newPage();
const logs = [];
page.on('console', m => { if (['error', 'warning'].includes(m.type()) || m.text().startsWith('[fx]')) logs.push(`${m.type()}: ${m.text()}`); });
page.on('pageerror', e => logs.push(`pageerror: ${e.message}`));
page.on('requestfailed', r => logs.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));
await page.goto(url, { waitUntil: 'load' });
await page.waitForTimeout(+(opt.wait || 2500));
if (opt.scroll) { await page.evaluate(y => window.scrollTo(0, +y), opt.scroll); await page.waitForTimeout(1200); }
let evalOut;
if (opt.eval) evalOut = await page.evaluate(opt.eval);
const gl = await page.evaluate(() => [document.documentElement.dataset.fxGl, document.documentElement.className]);
if (out) await page.screenshot({ path: out, fullPage: !!opt.full });
console.log(JSON.stringify({ url, gl, eval: evalOut, logs }, null, 1));
await browser.close();
