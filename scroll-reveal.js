(function () {
  const selectors = [
    '.photo',
    '.photo-frame',
    '.figure',
    '.security-logo',
    '.mobile-project-card__image',
    '.mobile-paint-gallery figure'
  ];

  const media = Array.from(document.querySelectorAll(selectors.join(','))).filter(function (element) {
    return !element.closest('.nav');
  });

  if (!media.length) return;

  media.forEach(function (element, index) {
    element.classList.add('reveal-media');
    element.style.setProperty('--reveal-delay', `${(index % 4) * 42}ms`);
  });

  if (!('IntersectionObserver' in window) || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    media.forEach(function (element) {
      element.classList.add('is-visible');
    });
    return;
  }

  const observer = new IntersectionObserver(
    function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;

        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      });
    },
    {
      root: null,
      rootMargin: '0px 0px -6% 0px',
      threshold: 0.04
    }
  );

  media.forEach(function (element) {
    observer.observe(element);
  });
})();
