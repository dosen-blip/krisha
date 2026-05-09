(function () {
  if (!window.matchMedia || !window.matchMedia('(pointer: fine)').matches) return;

  const style = document.createElement('style');

  style.textContent = `
    @media (pointer: fine) {
      html.krisha-custom-cursor,
      html.krisha-custom-cursor * {
        cursor: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='13' height='13' viewBox='0 0 13 13'%3E%3Ccircle cx='6.5' cy='6.5' r='6.5' fill='%23000ca9'/%3E%3C/svg%3E") 6 6, auto !important;
      }

      html.krisha-custom-cursor a,
      html.krisha-custom-cursor button,
      html.krisha-custom-cursor input,
      html.krisha-custom-cursor textarea,
      html.krisha-custom-cursor select,
      html.krisha-custom-cursor summary,
      html.krisha-custom-cursor label,
      html.krisha-custom-cursor [role="button"],
      html.krisha-custom-cursor [tabindex]:not([tabindex="-1"]) {
        cursor: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='18' height='18' viewBox='0 0 18 18'%3E%3Ccircle cx='9' cy='9' r='9' fill='%23000ca9'/%3E%3C/svg%3E") 9 9, pointer !important;
      }
    }
  `;

  document.head.appendChild(style);
  document.documentElement.classList.add('krisha-custom-cursor');
})();
