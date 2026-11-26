(function () {
  /*
   * Page arrival sounds. A page in SOUND_BY_PAGE plays its sound when it is uncovered: on the fx layer's
   * `krisha:arrive` event (fx/transitions.js fires it as the white cover drops and the first image starts its
   * interlaced refine, as a grow morph starts, or right away on a direct load). If the fx layer never runs, a
   * fallback plays it shortly after load. Autoplay blocked: retried on the
   * next pointer/key gesture. Muted by localStorage 'krisha-sound' = 'off' (shared with fx/sound.js).
   */
  const SOUND_BY_PAGE = {
    'photography.html': 'audio/Chime25.wav',
    'creative-direction.html': 'audio/Error28.wav',
    'paint.html': 'audio/Error20.wav',
    'contact.html': 'audio/Error17.wav'
  };

  const STORAGE_KEY = 'krisha-next-page-sound';
  const FALLBACK_MS = 2500;
  const page = location.pathname.split('/').pop() || 'index.html';
  const currentSound = SOUND_BY_PAGE[page];
  let retrySound = null;
  let played = false;

  function soundOn() {
    try {
      return localStorage.getItem('krisha-sound') !== 'off';
    } catch (error) {
      return true;
    }
  }

  function pageFromHref(href) {
    try {
      const url = new URL(href, location.href);
      if (url.origin !== location.origin) return null;
      return url.pathname.split('/').pop() || 'index.html';
    } catch (error) {
      return null;
    }
  }

  function markNextPage(event) {
    const link = event.target.closest && event.target.closest('a[href]');
    if (!link) return;

    const targetPage = pageFromHref(link.href);
    if (!SOUND_BY_PAGE[targetPage]) return;

    try {
      sessionStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ page: targetPage, sound: SOUND_BY_PAGE[targetPage], time: Date.now() })
      );
    } catch (error) {
      /* Navigation still works if sessionStorage is unavailable. */
    }
  }

  function storedSoundForCurrentPage() {
    try {
      const stored = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null');
      sessionStorage.removeItem(STORAGE_KEY);
      if (!stored || stored.page !== page || Date.now() - stored.time >= 10000) return null;
      return stored.sound;
    } catch (error) {
      return null;
    }
  }

  function retryBlockedSound() {
    if (!retrySound) return;

    const sound = retrySound;
    retrySound = null;
    playSound(sound);
  }

  function armRetry() {
    document.addEventListener('pointerdown', retryBlockedSound, { once: true, capture: true, passive: true });
    document.addEventListener('keydown', retryBlockedSound, { once: true, capture: true });
  }

  function playSound(src) {
    if (!soundOn()) return;

    const audio = new Audio(src);
    audio.preload = 'auto';
    audio.volume = 0.72;

    const promise = audio.play();
    if (promise && typeof promise.catch === 'function') {
      promise.catch(function () {
        retrySound = src;
        armRetry();
      });
    }
  }

  document.addEventListener('pointerdown', markNextPage, { capture: true, passive: true });
  document.addEventListener('click', markNextPage, { capture: true });

  if (!currentSound) return;

  // Read (and clear) the hand-off now; play when the page is uncovered.
  const sound = storedSoundForCurrentPage() || currentSound;

  // Warm the file while the page arrives so it starts on cue.
  try {
    const warm = new Audio(sound);
    warm.preload = 'auto';
  } catch (error) {
    /* ignore */
  }

  function arrive() {
    if (played) return;
    played = true;
    playSound(sound);
  }

  if (window.__fxArrived) {
    arrive();
  } else {
    window.addEventListener('krisha:arrive', arrive, { once: true });
    // The fx layer failed to load (or is absent): still play, a beat after load.
    window.addEventListener('load', function () {
      setTimeout(function () {
        if (!played && !window.__fxArrived) arrive();
      }, FALLBACK_MS);
    });
  }
})();
