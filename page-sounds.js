(function () {
  const SOUND_BY_PAGE = {
    'photography.html': 'audio/Chime25.wav',
    'creative-direction.html': 'audio/Error28.wav',
    'paint.html': 'audio/Error20.wav',
    'contact.html': 'audio/Error17.wav'
  };

  const STORAGE_KEY = 'krisha-next-page-sound';
  const page = location.pathname.split('/').pop() || 'index.html';
  const currentSound = SOUND_BY_PAGE[page];
  let retrySound = null;

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

  function playSound(src) {
    const audio = new Audio(src);
    audio.preload = 'auto';
    audio.volume = 0.72;

    const promise = audio.play();
    if (promise && typeof promise.catch === 'function') {
      promise.catch(function () {
        retrySound = src;
      });
    }
  }

  function retryBlockedSound() {
    if (!retrySound) return;

    const sound = retrySound;
    retrySound = null;
    playSound(sound);
  }

  document.addEventListener('pointerdown', markNextPage, { capture: true, passive: true });
  document.addEventListener('click', markNextPage, { capture: true });
  document.addEventListener('pointerdown', retryBlockedSound, { once: true, capture: true, passive: true });
  document.addEventListener('keydown', retryBlockedSound, { once: true, capture: true });

  if (currentSound) {
    playSound(storedSoundForCurrentPage() || currentSound);
  }
})();
