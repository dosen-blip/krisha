# KRISHA — handoff

Status as of 2026-11-25. **Nothing is committed.** Everything below is uncommitted work on `main` on top of `699dccb` ("final final final"). The site is static and has no build step; run it with the `krisha-site` entry in `.claude/launch.json` (`python3 -m http.server 3456`).

Read this file first, then `fx/README.md`, which holds the effects-layer contracts: module API, events, z-index and cache-busting.

A temporary HTTPS tunnel for phone testing may still be running (Cloudflare quick tunnel →
`https://rev-sure-stress-bundle.trycloudflare.com`). It dies with the session. Restart it with
`cloudflared tunnel --no-autoupdate --url http://localhost:3456`. It exposes the whole folder, including `.git` and `img/`.

## What changed

### 1. Security Magazine: hub + one page per issue (client request)
- `security-magazine-2025.html` (URL kept so existing links still work) is now the **hub**: the emblem, the intro copy, then the two issues side by side (cover, `ISSUE 0X / TITLE / YEAR`, `OPEN ISSUE 0X>`). Each opens its own page with the grow transition.
- `security-issue-00.html` (Silken Boundaries, 2025) and `security-issue-01.html` (The Bootleg Issue, 2026) each have:
  - back link, title + meta (year, page count), and a short body copy;
  - the 3D readable magazine: click or tap the cover, or the `READ ISSUE 0X>` button;
  - an "IN THIS ISSUE" list;
  - the flip-through film;
  - next link (00 → 01 → When Will You Free Me).
- The grid of photographed spreads is gone, and the phone creative reel no longer shows the page scans either (Security there = the two films + the two covers). Only `security-00-cover` / `security-01-cover` are still used; the other `security-00-*` / `security-01-*` scans are unused.
- **Body copy and contents lists are drafted from the PDFs** (Issue 00's editor's letter and contents page; Issue 01's article headings and Krisha's "more bootlegs, more hidden histories" line). Get Krisha to approve them.
- Creative label now reads "SECURITY MAGAZINE" (no year, since it covers 2025 and 2026).
- The client PDFs (Desktop `transfer-01a20fc8`) were rendered into `img-webp/security-book/` for the reader: Issue 00 has 115 pages, Issue 01 has 88 (17 MB). Scripts are in `tools/security-book/`.

### 2. Effects layer, desktop (`fx/`, `vendor/three/` = three r170, import map in every head)
Vocabulary: "a Y2K desktop remembered from Dubai". It reuses the *tech* of Matia's other projects (instinct, dosen EPK, matiadosen, sos), never their look. The first pass ported their looks directly; the owner rejected that, and it was rebuilt.

| Feature | Files | What it does |
|---|---|---|
| Gate / loader | `prepaint.js`, `gl.js`, `boot.js`, `fx.css`, `sound.js` | capability classes before paint, WebGL gate, idle render loop, FPS watchdog, lazy feature loading |
| Transitions | `transitions.js/.css`, `scroll-reveal.js` | Win98 zoom-rect leave; "interlaced" pixel-block arrival; tile→hero grow via View Transitions; page sounds on arrival |
| Nav progress | `nav-progress.js` | XP progress blocks on the nav rule fill with real prefetch bytes |
| Ring | `ring.js/.css`, `ring-shape.js` (`tools/trace-ring.py`) | the logo in real 3D: Security emblem (replaces GIF), nav logo. The landing-page hero ring was removed at the client's request (the `hero` code in `ring.js` is now dormant: nothing on the site has `data-fx-ring="hero"`) |
| Cursor | `cursor-fx.js`, `cursor.css`, `cursor-boot.js` | dot on the pointer + Win98 pointer trails; animated pixel arrow on draggables; Win-style VIEW/CLOSE tooltips |
| Landing | `arrival.js/.css` | pixel-glitter letter intro (first visit per session) + sparse glints |
| Creative | `creative.js/.css` | GL tiles: dither-dissolve previews + counter on hover; grow transition. The marching-ants selection border was cut (`SHOW_SELECTION = false`) |
| Paint | `paint.js`, `paint-lite.js`, `paint.css` | thin-box canvases, luminance relief + raking light, click-to-focus at real size with caption |
| Security | `flipbook.js`, `flipbook-lite.js`, `security-book.js`, `security.css` | issue pages only: 3D page-curl reader from the PDFs, opened by the cover or READ; cover peek on hover |

### 3. Effects layer, phone (≤700px, `html.fx-phone`)
Touch-first versions. Phones may use WebGL when capable. Tilt comes from `fx/m-motion.js`, which shows the KRISHA.EXE permission dialog; iOS needs HTTPS for it.

| Feature | Files | What it does |
|---|---|---|
| Shell | `m-shell.js/.css`, `mobile-menu.js` | Start-menu MENU open; XP scroll-progress on the sticky nav (sticky now actually works); tap zoom-rect bursts; long-press destination tooltip |
| Ring | `ring.js` | stepped nav ring, emblem (shares one renderer on Security). No landing ring |
| Creative reel | `m-reel.js`, `m-reel.css` | static collage of links; tapping a hero grows it into the project. The scroll selection and auto previews were cut (`m-reel-lite.js` deleted) |
| Paint | `m-paint.js/.css`, `paint-lite.js` | phone = lamp (tilt or scroll lights the brushwork); viewer with 1–8× magnifier zoom, swipe, dither |
| Security | `m-flipbook.js`, `m-security.css` | issue pages: tilting 3D cover; one-page curl reader, landscape spreads, pinch |
| Galleries | `m-gallery.js/.css` | VIEWER.EXE on photography, project pages and contact; long-press magnifier loupe; "IMG 3/6" readout; contact copy-email + tilting portrait |

Fallbacks: `?gl=off` (sticky per tab) and reduced motion give the static site, plus the lite paths where they exist.

## Verifying
- `node tools/shot.mjs <page.html[?gl=off]> <out.png> [--mobile] [--reduced] [--eval="js"]` runs headless system Chrome on the real GPU. It imports playwright-core from `~/Documents/framer/node_modules`.
- Last full sweep: 13 pages × (phone, phone `?gl=off`, desktop) mounted the expected features, with no console errors and no horizontal overflow.
- **Not done:** real iPhone/Android testing, Safari, Firefox. Everything above was verified in Chrome (headless and the in-app pane).

## Cache-busting (no build step)
Whenever you change a module:
- bump `V` in `fx/boot.js` (now 4) and the `?v=` on the `fx/boot.js` tag in all 13 heads;
- update the hard-coded `?v=` in `paint-lite.js` (m-paint).

Other shared files carry their own `?v=`: `scroll-reveal.js` v4, `scroll-reveal.css` v2, `cursor.css` v3, `cursor-boot.js` v2, `page-sounds.js` v2, `mobile-menu.js` v2, `portfolio-pages.css` v10, `fx/transitions.css` v3.

## Open items
1. **Paint captions (client):** the mobile captions for gallery-03/04/05/07 look shifted by one. Likely mapping: 03 SWORD TO MY HEART, 04 CANDYLAND, 05 MASSARI, 07 UNTITLED SORRY. Desktop focus mode uses the corrected mapping; mobile text is unchanged, so they currently disagree. Confirm with Krisha, then fix `paint.html`.
2. **Years:** the PDFs are named Issue 00 = 2025 and Issue 01 = 2026, but the page title and label still say "SECURITY MAGAZINE 2025". Creative labels also say "WHEN WILL YOU FREE ME 2025" (page 2026) and "AHLAN 2025" (page 2023).
3. **Security copy:** the issue-page body copy and contents lists are drafts written from the PDFs. Confirm with Krisha.
4. **Heavy preview images:** the creative hover previews load `wwyfm-02.webp` (9.2 MB) and `paint-free-me.webp` (8 MB). Make ~1600px copies.
5. **Unused assets:** old `security-02/03/05–10` (img + img-webp), `paint-security.webp`, the Issue 00/01 page scans (`security-0X-01…12`), and the 254 MB `img/` originals (nothing references them).
6. **`index.html`:** a ~100 KB base64 poster sits inline, and `bg.mp4` is listed twice. `krisha-site/` is a stray nested git repo.
7. **Known limits:**
   - Zoom-rects and faint trail dots are hard to see over dark imagery.
   - A bfcache restore skips the interlaced refine.
   - Closing the flip-book mid-turn snaps the page flat.
   - On DPR-3 phones, GL is capped at DPR 2.
   - Chrome and iOS both show the KRISHA.EXE dialog (Chrome now also exposes `requestPermission`).
8. **Small refactor:** `transitions.js` `growFigureFor` only morphs `a.figure`. `m-reel.js` exists only to add `.figure` to the tapped hero.
9. **Commit:** nothing is committed yet. Suggest a feature branch; the new pages are `security-issue-00/01.html`; the new assets add about 37 MB (book pages + videos + scans).
