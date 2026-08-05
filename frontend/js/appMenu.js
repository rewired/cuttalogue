// Single header dropdown bundling everything that used to be scattered
// across the header and footer: Projects, Load mix/vocal, Setup, and the
// project-level Save/Export actions. Same open/close idiom as
// projectPicker.js's own Projects submenu, which lives nested inside this
// panel unchanged - its own outside-click handling already treats anything
// that isn't its own button/menu as "outside", so nesting it here needs no
// changes there.
(function (MSE) {
  'use strict';

  const el = {};

  function cacheElements() {
    el.btn = document.getElementById('app-menu-btn');
    el.panel = document.getElementById('app-menu-panel');
  }

  function openMenu() {
    el.panel.hidden = false;
  }

  function closeMenu() {
    el.panel.hidden = true;
  }

  function wire() {
    el.btn.addEventListener('click', () => {
      if (el.panel.hidden) openMenu();
      else closeMenu();
    });

    document.addEventListener('pointerdown', (e) => {
      if (!el.panel.hidden && !el.panel.contains(e.target) && e.target !== el.btn) closeMenu();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !el.panel.hidden) closeMenu();
    });

    // Close after a completed leaf action, so the menu doesn't sit open over
    // the app afterwards. Listed explicitly rather than via a generic "any
    // button click" delegate, because the nested Projects toggle button is a
    // button too but must NOT close this outer panel when opening its own
    // submenu - only actually switching/creating a project should.
    ['setup-btn', 'save-project-btn', 'export-json-btn', 'export-csv-btn', 'export-project-btn'].forEach((id) => {
      const node = document.getElementById(id);
      if (node) node.addEventListener('click', closeMenu);
    });
    ['mix-file', 'vocal-file'].forEach((id) => {
      const node = document.getElementById(id);
      if (node) node.addEventListener('change', closeMenu);
    });

    // Switching/creating a project (via the nested Projects submenu) closes
    // that submenu itself already (projectPicker.js) - close this outer
    // panel too so it doesn't linger open over the freshly loaded project.
    MSE.state.on('project-loaded', closeMenu);
  }

  function init() {
    cacheElements();
    wire();
  }

  document.addEventListener('DOMContentLoaded', init);

  MSE.appMenu = {};
})(window.MSE = window.MSE || {});
