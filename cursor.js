(function () {
  if (!window.matchMedia || !window.matchMedia('(pointer: fine)').matches) return;

  document.documentElement.classList.add('krisha-custom-cursor');
})();
