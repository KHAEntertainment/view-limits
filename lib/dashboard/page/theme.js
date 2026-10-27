'use strict';
// Issue #141: apply the stored theme before the first paint. The page loads
// this without `defer`, ahead of the stylesheet, so a dark choice never
// flashes light. Same key and values as ./logic.js (THEME_KEY, THEMES). It
// touches only this origin's localStorage and the root's data-theme.
(function () {
  let theme = 'system';
  try {
    const stored = window.localStorage.getItem('vl-theme');
    if (stored === 'light' || stored === 'dark') theme = stored;
  } catch (e) { /* no storage: follow the system */ }
  document.documentElement.setAttribute('data-theme', theme);
}());
