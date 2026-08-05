// Collapses the Tempo/Video/Shot-length fieldsets (set once per song, rarely
// touched afterwards) behind a single flyout button, freeing up the
// permanent header space they used to occupy. Same open/close idiom as
// appMenu.js and projectPicker.js's own submenu.
(function (MSE) {
  'use strict';

  const el = {};

  function cacheElements() {
    el.btn = document.getElementById('grid-tempo-btn');
    el.panel = document.getElementById('grid-tempo-panel');
  }

  function openFlyout() {
    el.panel.hidden = false;
  }

  function closeFlyout() {
    el.panel.hidden = true;
  }

  function wire() {
    el.btn.addEventListener('click', () => {
      if (el.panel.hidden) openFlyout();
      else closeFlyout();
    });

    document.addEventListener('pointerdown', (e) => {
      if (!el.panel.hidden && !el.panel.contains(e.target) && e.target !== el.btn) closeFlyout();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !el.panel.hidden) closeFlyout();
    });
  }

  function init() {
    cacheElements();
    wire();
  }

  document.addEventListener('DOMContentLoaded', init);

  MSE.gridTempoFlyout = {};
})(window.MSE = window.MSE || {});
