document.querySelectorAll('.mobile-menu').forEach((menu) => {
  const summary = menu.querySelector('summary');
  const panel = menu.querySelector('.mobile-menu__panel');
  let closeTimer;

  if (!summary || !panel) return;

  const finishClose = () => {
    menu.open = false;
    menu.classList.remove('is-closing');
    closeTimer = null;
  };

  const closeMenu = () => {
    menu.classList.add('is-closing');
    closeTimer = window.setTimeout(finishClose, 220);

    panel.addEventListener(
      'animationend',
      () => {
        window.clearTimeout(closeTimer);
        finishClose();
      },
      { once: true }
    );
  };

  summary.addEventListener('click', (event) => {
    event.preventDefault();

    if (menu.classList.contains('is-closing')) {
      window.clearTimeout(closeTimer);
      menu.classList.remove('is-closing');
      closeTimer = null;
    }

    if (menu.open) {
      closeMenu();
      return;
    }

    menu.open = true;
  });
});
