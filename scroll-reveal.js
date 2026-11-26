(function () {
  /*
   * Media reveal: KRISHA's collage loads "interlaced", like a progressive JPEG over dial-up. Each image shows as
   * coarse pixel blocks that refine in a few hard steps, then sharp. A block-resolution canvas (stretched with
   * image-rendering: pixelated) sits exactly over the image while it refines and is then removed; the image itself
   * is untouched (only hidden under it). The blocks come from the file decoded and scaled down off the main thread.
   *
   *   arrival  after a page transition (fx/prepaint.js sets window.__fxTx and html.fx-tx-cover / fx-tx-grow) the
   *            media in view wait for `krisha:arrive` and then refine 32 → 12 → 4px blocks → sharp (~300ms each),
   *            nearest the click first, in 40ms waves (all sharp by ~600ms once loaded). A grow transition's hero goes
   *            first and refines more slowly, inside the view-transition morph.
   *   scroll   media below the fold refine 12 → 4px → sharp (~120ms) as they enter the viewport.
   *   direct load / reload / bfcache restore: the media in view are simply there. Reduced motion: no reveal at all.
   *
   * Classes: .reveal-media (held back: opacity 0) → .is-refining (shown, pixels on top) → .is-visible (sharp).
   * fx/creative.js waits for .is-visible before its WebGL takes a tile over.
   */
  const selectors = [
    '.photo',
    '.photo-frame',
    '.figure',
    '.security-logo',
    '.mobile-project-card__image',
    '.mobile-paint-gallery figure'
  ];
  // [block size in CSS px, hold in ms] per pass; sharp after the last one
  const ARRIVE = [[32, 110], [12, 100], [4, 90]];
  const HERO = [[32, 180], [12, 170], [4, 150]];   // inside the 760ms grow morph
  const QUICK = [[12, 60], [4, 60]];
  const WAVE_MS = 40;            // arrival start offsets snap to 40ms waves...
  const MAX_OFFSET = 280;        // ...the farthest image starts this much after the nearest
  const ARRIVE_FAILSAFE = 1250;  // no krisha:arrive (fx layer missing): go anyway
  const LOAD_WAIT = 8000;        // an image still loading after this shows plainly whenever it lands

  const html = document.documentElement;
  const reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const tx = window.__fxTx || null;
  const fromNav = !!tx && !reduced && (html.classList.contains('fx-tx-cover') || html.classList.contains('fx-tx-grow'));

  const media = Array.from(document.querySelectorAll(selectors.join(','))).filter(function (element) {
    return !element.closest('.nav');
  });
  if (!media.length) return;

  if (reduced || !('IntersectionObserver' in window)) {
    media.forEach(function (element) {
      element.classList.add('reveal-media', 'is-visible');
    });
    return;
  }

  let hero = null;
  if (fromNav && tx.mode === 'grow' && tx.hero) {
    try {
      hero = document.querySelector(tx.hero);
    } catch (error) {
      hero = null;
    }
  }

  let canvasOK = false;
  try {
    canvasOK = !!document.createElement('canvas').getContext('2d');
  } catch (error) {
    canvasOK = false;
  }

  function inView(element) {
    const r = element.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  }

  /* ------------------------------------------------------------------ sources and their pixels */

  function sourcesOf(element) {
    if (element.matches('img, video')) return [element];
    return Array.from(element.querySelectorAll('img, video'));
  }

  const bitmapsOK = typeof window.createImageBitmap === 'function' && typeof window.fetch === 'function';
  const finestOf = function (levels) {
    return Math.min.apply(null, levels.map(function (level) { return level[0]; }));
  };

  function loaded(image) {
    if (image.complete) return Promise.resolve();
    return new Promise(function (resolve) {
      image.addEventListener('load', resolve, { once: true });
      image.addEventListener('error', resolve, { once: true });
    });
  }

  // object-fit as a scale per axis (CSS px per image px)
  function fitScale(fit, width, height, w, h) {
    if (fit === 'cover') { const s = Math.max(width / w, height / h); return [s, s]; }
    if (fit === 'contain') { const s = Math.min(width / w, height / h); return [s, s]; }
    if (fit === 'none') return [1, 1];
    if (fit === 'scale-down') { const s = Math.min(1, width / w, height / h); return [s, s]; }
    return [width / w, height / h];
  }

  /**
   * The pixels a source will refine from, once it has any: { image, w, h } (w/h = its natural size for the fit maths)
   * or null. The file's bytes (from the HTTP cache) are decoded and scaled down to block resolution off the main
   * thread (createImageBitmap on a Blob): a big WebP decoded inside drawImage would stall a frame for 10–35ms.
   * Videos: the current frame, else the poster. Falls back to drawing the element itself.
   */
  function pictureOf(source, finest) {
    const video = source.tagName === 'VIDEO';
    let wait;
    if (video) {
      if (source.readyState >= 2 || !source.poster) {
        wait = Promise.resolve();
      } else {
        if (!source.__revealPoster) {
          source.__revealPoster = new Image();
          source.__revealPoster.src = source.poster;
        }
        wait = loaded(source.__revealPoster);
      }
    } else {
      wait = loaded(source);
    }
    const timeout = new Promise(function (resolve) { setTimeout(resolve, LOAD_WAIT); });
    return Promise.race([wait, timeout]).then(function () {
      let image = source, w = source.naturalWidth, h = source.naturalHeight;
      if (video) {
        if (source.readyState >= 2 && source.videoWidth) {
          w = source.videoWidth;
          h = source.videoHeight;
        } else {
          image = source.__revealPoster;
          w = image && image.complete ? image.naturalWidth : 0;
          h = image && image.complete ? image.naturalHeight : 0;
        }
      }
      if (!image || !w || !h) return null;
      const direct = { image, w, h };
      const r = source.getBoundingClientRect();
      if (!bitmapsOK || r.width < 2 || r.height < 2) return direct;
      const scale = fitScale(getComputedStyle(source).objectFit, r.width, r.height, w, h);
      const options = {
        resizeWidth: Math.max(1, Math.min(2048, Math.round((w * scale[0]) / finest))),
        resizeHeight: Math.max(1, Math.min(2048, Math.round((h * scale[1]) / finest))),
        resizeQuality: 'medium'
      };
      const url = image.currentSrc || image.src;
      const made = image.tagName === 'VIDEO'
        ? createImageBitmap(image, options)
        : fetch(url, { cache: 'force-cache', credentials: 'same-origin' })
          .then(function (response) { return response.ok ? response.blob() : Promise.reject(response.status); })
          .then(function (blob) { return createImageBitmap(blob, options); });
      return made.then(function (bitmap) { return { image: bitmap, w, h }; }, function () { return direct; });
    });
  }

  // object-position "x y" (computed: lengths / percentages) → offsets within the free space
  function position(value, freeX, freeY) {
    const parts = String(value || '').trim().split(/\s+/);
    const one = function (token, free) {
      if (!token || token === 'center') return free / 2;
      if (token === 'left' || token === 'top') return 0;
      if (token === 'right' || token === 'bottom') return free;
      const n = parseFloat(token);
      if (!Number.isFinite(n)) return free / 2;
      return /%$/.test(token) ? (free * n) / 100 : n;
    };
    return [one(parts[0], freeX), one(parts[1] || parts[0], freeY)];
  }

  // The source's picture as it is rendered (object-fit / object-position) at `block` px per canvas pixel.
  function drawLevel(pic, style, width, height, block) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(width / block));
    c.height = Math.max(1, Math.round(height / block));
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';   // area-average each block, like a progressive JPEG's first passes
    const scale = fitScale(style.objectFit, width, height, pic.w, pic.h);
    const dw = pic.w * scale[0], dh = pic.h * scale[1];
    const at = position(style.objectPosition, width - dw, height - dh);
    const sx = c.width / width, sy = c.height / height;
    ctx.drawImage(pic.image, at[0] * sx, at[1] * sy, dw * sx, dh * sy);
    return c;
  }

  function coarser(base, width, height, block) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(width / block));
    c.height = Math.max(1, Math.round(height / block));
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(base, 0, 0, c.width, c.height);
    return c;
  }

  // A pixel layer over one source: a canvas right after it, measured onto its box (same containing block and clip).
  function makeLayer(source, levels, pic) {
    if (!pic) return null;
    const style = getComputedStyle(source);
    // hidden or transparent: something else draws it (a WebGL layer) or it isn't shown at all
    if (style.display === 'none' || style.visibility !== 'visible' || parseFloat(style.opacity) === 0) return null;
    const r = source.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return null;
    let frames;
    try {
      const finest = finestOf(levels);
      const base = drawLevel(pic, style, r.width, r.height, finest);
      frames = levels.map(function (l) { return l[0] === finest ? base : coarser(base, r.width, r.height, l[0]); });
    } catch (error) {
      return null;
    }
    const canvas = document.createElement('canvas');
    canvas.className = 'reveal-pixels';
    canvas.setAttribute('aria-hidden', 'true');
    const z = style.position !== 'static' && style.zIndex !== 'auto' ? `z-index:${style.zIndex};` : '';
    canvas.style.cssText = `position:absolute;left:0;top:0;width:${r.width}px;height:${r.height}px;margin:0;padding:0;border:0;max-width:none;max-height:none;${z}`;
    source.after(canvas);
    const at = canvas.getBoundingClientRect();
    canvas.style.left = `${r.left - at.left}px`;
    canvas.style.top = `${r.top - at.top}px`;
    const layer = { source, canvas, ctx: canvas.getContext('2d'), frames, visibility: source.style.visibility };
    source.style.visibility = 'hidden';
    return layer;
  }

  function showFrame(layer, index) {
    const frame = layer.frames[index];
    layer.canvas.width = frame.width;
    layer.canvas.height = frame.height;
    layer.ctx.drawImage(frame, 0, 0);
  }

  /* ------------------------------------------------------------------ jobs: one element refining */

  const jobs = new Map();
  let raf = 0;

  function wake() {
    if (!raf) raf = requestAnimationFrame(tick);
  }

  function finish(job) {
    if (job.done) return;
    job.done = true;
    jobs.delete(job.element);
    (job.layers || []).forEach(function (layer) {
      layer.canvas.remove();
      layer.source.style.visibility = layer.visibility;
    });
    job.element.classList.remove('is-refining');
    job.element.classList.add('is-visible');
  }

  function begin(job, now) {
    job.started = true;
    job.start = now;
    if (document.hidden || !canvasOK) {
      finish(job);
      return;
    }
    job.element.classList.add('is-refining');
    job.layers = job.sources.map(function (source, index) {
      return makeLayer(source, job.levels, job.pictures[index]);
    }).filter(Boolean);
    if (!job.layers.length) {
      finish(job);
      return;
    }
    advance(job, now);
  }

  function advance(job, now) {
    const t = now - job.start;
    let end = 0, index = -1;
    for (let i = 0; i < job.levels.length; i++) {
      end += job.levels[i][1];
      if (t < end) {
        index = i;
        break;
      }
    }
    if (index < 0) {
      finish(job);
      return;
    }
    if (index !== job.step) {
      job.step = index;
      job.layers.forEach(function (layer) { showFrame(layer, index); });
    }
  }

  function tick() {
    raf = 0;
    const now = performance.now();
    let again = false;
    jobs.forEach(function (job) {
      if (!job.started) {
        if (!job.ready) return;              // woken again when its pictures are in
        if (now < job.at) {
          again = true;
          return;
        }
        begin(job, now);
      } else {
        advance(job, now);
      }
      if (!job.done) again = true;
    });
    if (again) wake();
  }

  /** Refine `element` with `levels`, starting at `at` (performance.now ms) or as soon as its pixels are ready. */
  function refine(element, levels, at) {
    if (jobs.has(element)) return;
    const job = { element, levels, at, sources: sourcesOf(element), pictures: [], ready: false, started: false, done: false, step: -1, layers: null };
    jobs.set(element, job);
    const finest = finestOf(levels);
    Promise.all(job.sources.map(function (source) { return pictureOf(source, finest); })).then(function (pictures) {
      if (job.done) return;
      job.pictures = pictures;
      job.ready = true;
      wake();
    });
  }

  // A hidden tab never runs rAF: show everything plainly instead of holding it back.
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) return;
    jobs.forEach(finish);
  });

  /* ------------------------------------------------------------------ wiring */

  media.forEach(function (element) {
    element.classList.add('reveal-media');
  });

  const observer = new IntersectionObserver(
    function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        observer.unobserve(entry.target);
        if (!entry.target.classList.contains('is-visible')) refine(entry.target, QUICK, performance.now());
      });
    },
    { root: null, rootMargin: '0px', threshold: 0 }
  );

  function watchTheRest() {
    media.forEach(function (element) {
      if (!element.classList.contains('is-visible') && !jobs.has(element)) observer.observe(element);
    });
  }

  // distance from the arrival point to the nearest point of the element
  function distance(element, origin) {
    const r = element.getBoundingClientRect();
    const x = Math.min(Math.max(origin.x, r.left), r.right);
    const y = Math.min(Math.max(origin.y, r.top), r.bottom);
    return Math.hypot(x - origin.x, y - origin.y);
  }

  function arrive(origin) {
    const now = performance.now();
    const items = media.filter(function (element) {
      return element === hero || (!element.classList.contains('is-visible') && inView(element));
    });
    const distances = items.map(function (element) { return distance(element, origin); });
    const farthest = Math.max.apply(null, distances.concat([1]));
    // nearest first: the hero, then the rest in 40ms waves
    const order = items.map(function (element, index) { return index; }).sort(function (a, b) {
      return (items[a] === hero ? -1 : distances[a]) - (items[b] === hero ? -1 : distances[b]);
    });
    order.forEach(function (index) {
      const element = items[index];
      if (element === hero) {
        refine(element, HERO, now);
        return;
      }
      const offset = Math.round(((distances[index] / farthest) * MAX_OFFSET) / WAVE_MS) * WAVE_MS;
      refine(element, ARRIVE, now + offset);
    });
    watchTheRest();
  }

  if (fromNav) {
    let done = false;
    const onArrive = function (event) {
      if (done) return;
      done = true;
      const detail = (event && event.detail) || window.__fxArrived || null;
      const origin = detail && Number.isFinite(detail.x) ? { x: detail.x, y: detail.y } : { x: +tx.x || innerWidth / 2, y: +tx.y || innerHeight / 2 };
      arrive(origin);
    };
    if (window.__fxArrived) {
      onArrive(null);
    } else {
      window.addEventListener('krisha:arrive', onArrive, { once: true });
      setTimeout(onArrive, ARRIVE_FAILSAFE);
    }
  } else {
    // direct load / reload / back-forward without bfcache: what is in view is simply there
    media.forEach(function (element) {
      if (inView(element)) element.classList.add('is-visible');
    });
    watchTheRest();
  }
})();
