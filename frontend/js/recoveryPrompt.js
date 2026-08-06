// Blocking "unsaved draft found" modal shown right after a project load if
// project.js finds a draft newer than the last real save (see
// loadProjectConsideringDraft in project.js). Pure UI - the restore/discard
// decision is reported back through a Promise; all state/storage logic
// stays in project.js. No close button and no backdrop/Escape dismissal on
// purpose: the choice has real consequences (discard deletes the draft), so
// it shouldn't be dismissible by accident.
(function (MSE) {
  'use strict';

  const el = {};

  function cacheElements() {
    el.overlay = document.getElementById('recovery-modal');
    el.timestamp = document.getElementById('recovery-modal-timestamp');
    el.restoreBtn = document.getElementById('recovery-restore-btn');
    el.discardBtn = document.getElementById('recovery-discard-btn');
  }

  function ask(draftUpdatedAt) {
    return new Promise((resolve) => {
      el.timestamp.textContent = new Date(draftUpdatedAt).toLocaleString();
      el.overlay.hidden = false;

      function cleanup(result) {
        el.overlay.hidden = true;
        el.restoreBtn.removeEventListener('click', onRestore);
        el.discardBtn.removeEventListener('click', onDiscard);
        resolve(result);
      }
      function onRestore() {
        cleanup(true);
      }
      function onDiscard() {
        cleanup(false);
      }

      el.restoreBtn.addEventListener('click', onRestore);
      el.discardBtn.addEventListener('click', onDiscard);
    });
  }

  function init() {
    cacheElements();
  }

  document.addEventListener('DOMContentLoaded', init);

  MSE.recoveryPrompt = { ask };
})(window.MSE = window.MSE || {});
