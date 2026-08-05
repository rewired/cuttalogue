// Drag handle between the shot list and the context panel: resizes the shot
// list to a fixed pixel width (the context panel just fills whatever's left
// via flex:1 1 auto). Same pointerdown/move/up idiom as trackHeightResize.js.
(function (MSE) {
  'use strict';

  const STORAGE_KEY = 'cuttalogue.shotListWidth';
  const MIN_WIDTH = 420;
  const MIN_CONTEXT_WIDTH = 320;

  const el = {};
  let dragStartX = 0;
  let dragStartWidth = 0;
  let dragging = false;

  function cacheElements() {
    el.panel = document.getElementById('shot-list-panel');
    el.workArea = document.querySelector('.work-area');
    el.handle = document.getElementById('panel-resize-handle');
  }

  function maxWidth() {
    return Math.max(MIN_WIDTH, el.workArea.clientWidth - MIN_CONTEXT_WIDTH - 16 - 16);
  }

  function setWidth(px) {
    const clamped = Math.max(MIN_WIDTH, Math.min(maxWidth(), Math.round(px)));
    el.panel.style.flexBasis = `${clamped}px`;
    localStorage.setItem(STORAGE_KEY, String(clamped));
  }

  function onPointerMove(e) {
    if (!dragging) return;
    setWidth(dragStartWidth + (e.clientX - dragStartX));
  }

  function onPointerUp() {
    dragging = false;
    document.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('pointerup', onPointerUp);
  }

  function wire() {
    el.handle.addEventListener('pointerdown', (e) => {
      dragging = true;
      dragStartX = e.clientX;
      dragStartWidth = el.panel.getBoundingClientRect().width;
      document.addEventListener('pointermove', onPointerMove);
      document.addEventListener('pointerup', onPointerUp);
      e.preventDefault();
    });
  }

  function init() {
    cacheElements();
    const stored = Number(localStorage.getItem(STORAGE_KEY));
    if (stored) setWidth(stored);
    wire();
  }

  document.addEventListener('DOMContentLoaded', init);
})(window.MSE = window.MSE || {});
