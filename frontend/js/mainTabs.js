// Top-level Shots/Assets view switcher. Shots is the timeline + shot list +
// per-shot context panel (everything that was the whole app before); Assets
// is the asset library (browse/upload/tag/classify), which used to live
// behind a "Manage assets" modal and now gets a real tab of its own.
(function (MSE) {
  'use strict';

  const { emit } = MSE.state;

  const el = {};

  function cacheElements() {
    el.shotsBtn = document.getElementById('main-tab-btn-shots');
    el.assetsBtn = document.getElementById('main-tab-btn-assets');
    el.shotsView = document.getElementById('main-view-shots');
    el.assetsView = document.getElementById('main-view-assets');
  }

  function activate(view) {
    const isAssets = view === 'assets';
    el.shotsBtn.classList.toggle('active', !isAssets);
    el.assetsBtn.classList.toggle('active', isAssets);
    el.shotsView.hidden = isAssets;
    el.assetsView.hidden = !isAssets;
    emit('main-view-changed', { view });
  }

  function init() {
    cacheElements();
    el.shotsBtn.addEventListener('click', () => activate('shots'));
    el.assetsBtn.addEventListener('click', () => activate('assets'));
  }

  document.addEventListener('DOMContentLoaded', init);
})(window.MSE = window.MSE || {});
