// Drag handle below the Vocal track: resizes both the Mix and Vocal
// waveform lanes together (a single shared height, since the user's
// complaint was "both audio tracks are too tall", not one specifically).
// Grid/Shots stay fixed - they're thin utility rows, not something anyone
// needs to see more or less waveform detail in.
(function (MSE) {
  'use strict';

  const el = {};
  let dragStartY = 0;
  let dragStartHeight = 0;
  let dragging = false;

  function cacheElements() {
    el.handle = document.getElementById('track-height-handle');
  }

  function onPointerMove(e) {
    if (!dragging) return;
    const delta = e.clientY - dragStartY;
    MSE.sync.setAudioTrackHeight(dragStartHeight + delta);
  }

  function onPointerUp() {
    dragging = false;
    document.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('pointerup', onPointerUp);
  }

  function wire() {
    el.handle.addEventListener('pointerdown', (e) => {
      dragging = true;
      dragStartY = e.clientY;
      dragStartHeight = MSE.sync.getAudioTrackHeight();
      document.addEventListener('pointermove', onPointerMove);
      document.addEventListener('pointerup', onPointerUp);
      e.preventDefault();
    });
  }

  function init() {
    cacheElements();
    wire();
  }

  document.addEventListener('DOMContentLoaded', init);

  MSE.trackHeightResize = {};
})(window.MSE = window.MSE || {});
