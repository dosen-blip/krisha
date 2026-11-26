/*
 * fx/m-reel.js — Creative direction, phone (≤700px). Tap hand-off only.
 *
 * The reel (.mobile-creative-reel) is a static collage of .mcr links grouped by project (data-mcr). The scroll-driven
 * selection and hero previews were retired (owner, 2026-11-25: previews only make sense on desktop hover).
 * What is left: tapping a group's hero (data-mcr-hero, data-transition="grow") gives it .figure for that tap, because
 * fx/transitions.js only morphs an a.figure into the destination hero. The class comes off again if the tap didn't
 * navigate (cancelled / stuck) or the page is restored from the back-forward cache.
 */
const RELEASE_BACK = 7000;

export async function mount() {
  const reel = document.querySelector('.mobile-creative-reel');
  if (!reel) return undefined;
  let timer = 0;
  const heroes = () => reel.querySelectorAll('a.mcr[data-mcr-hero].figure');
  const unrelease = () => { clearTimeout(timer); heroes().forEach((a) => a.classList.remove('figure')); };
  const onClick = (e) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest && e.target.closest('a.mcr[data-mcr-hero]');
    if (!a || !reel.contains(a)) return;
    a.classList.add('figure');
    clearTimeout(timer);
    timer = setTimeout(() => { if (!document.hidden) unrelease(); }, RELEASE_BACK);
  };
  const onShow = (e) => { if (e.persisted) unrelease(); };
  document.addEventListener('click', onClick, true);   // capture: before transitions.js reads the link
  addEventListener('pageshow', onShow);
  return {
    destroy() { unrelease(); document.removeEventListener('click', onClick, true); removeEventListener('pageshow', onShow); },
  };
}
