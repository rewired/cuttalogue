// Context panel: [Shot] / [Assets] tabs on the right of the shot list. Owns the
// transient (non-persisted) selected-shot id and renders that shot's readouts
// plus its editable prompt/notes fields, which live on the shot itself and
// round-trip through the project JSON.
(function (MSE) {
  'use strict';

  const { state, on, emit } = MSE.state;
  const { formatTime } = MSE.format;
  const { frameCalc } = MSE.frames;
  const shotsApi = MSE.shots;

  let selectedShotId = null;

  const el = {};

  function cacheElements() {
    el.tabShotBtn = document.getElementById('tab-btn-shot');
    el.tabAssetsBtn = document.getElementById('tab-btn-assets');
    el.tabShot = document.getElementById('tab-shot');
    el.tabAssets = document.getElementById('tab-assets');
    el.empty = document.getElementById('shot-detail-empty');
    el.detail = document.getElementById('shot-detail');
    el.id = document.getElementById('shot-detail-id');
    el.start = document.getElementById('shot-detail-start');
    el.end = document.getElementById('shot-detail-end');
    el.duration = document.getElementById('shot-detail-duration');
    el.status = document.getElementById('shot-detail-status');
    el.cutFrames = document.getElementById('shot-detail-cut-frames');
    el.renderFrames = document.getElementById('shot-detail-render-frames');
    el.overhang = document.getElementById('shot-detail-overhang');
    el.prompt = document.getElementById('shot-detail-prompt');
    el.notes = document.getElementById('shot-detail-notes');
  }

  function findSelectedShot() {
    return state.shots.find((s) => s.id === selectedShotId) || null;
  }

  function statusLabel(status) {
    if (status === 'short') return 'too short';
    if (status === 'long') return 'too long';
    return 'valid';
  }

  function renderShotTab() {
    const shot = findSelectedShot();
    if (!shot) {
      el.empty.style.display = '';
      el.detail.style.display = 'none';
      return;
    }
    el.empty.style.display = 'none';
    el.detail.style.display = '';

    const status = shotsApi.shotStatus(shot);
    const calc = frameCalc(shotsApi.shotDuration(shot), state.video);

    el.id.textContent = shot.id;
    el.start.textContent = formatTime(shot.startSeconds);
    el.end.textContent = formatTime(shot.endSeconds);
    el.duration.textContent = `${shotsApi.shotDuration(shot).toFixed(3)} s`;
    el.status.textContent = statusLabel(status);
    el.status.className = `status-cell status-${status}`;
    el.cutFrames.textContent = calc.cutFrames;
    el.renderFrames.textContent = calc.renderFrames;
    el.overhang.textContent = `${calc.overhangFrames} f / ${calc.overhangSeconds.toFixed(3)} s`;

    // Skip the field currently being typed in, so a re-render triggered by
    // e.g. dragging the shot's edge in the timeline can't clobber live input.
    if (document.activeElement !== el.prompt) el.prompt.value = shot.prompt || '';
    if (document.activeElement !== el.notes) el.notes.value = shot.notes || '';
  }

  function selectShot(shotId) {
    selectedShotId = shotId;
    renderShotTab();
    emit('shot-selected', { shotId });
  }

  function getSelectedShotId() {
    return selectedShotId;
  }

  function wireTextInputs() {
    el.prompt.addEventListener('input', () => {
      const shot = findSelectedShot();
      if (shot) shot.prompt = el.prompt.value;
    });
    el.notes.addEventListener('input', () => {
      const shot = findSelectedShot();
      if (shot) shot.notes = el.notes.value;
    });
  }

  function wireTabs() {
    function activate(tab) {
      const isShot = tab === 'shot';
      el.tabShotBtn.classList.toggle('active', isShot);
      el.tabAssetsBtn.classList.toggle('active', !isShot);
      el.tabShot.hidden = !isShot;
      el.tabAssets.hidden = isShot;
    }
    el.tabShotBtn.addEventListener('click', () => activate('shot'));
    el.tabAssetsBtn.addEventListener('click', () => activate('assets'));
  }

  function init() {
    cacheElements();
    wireTabs();
    wireTextInputs();
    renderShotTab();
  }

  on('shots-changed', () => {
    // The selected shot's id can disappear from under it (delete/merge/split
    // renumbers), in which case fall back to the empty state instead of
    // showing stale data for an id that no longer exists.
    if (selectedShotId !== null && !findSelectedShot()) selectedShotId = null;
    renderShotTab();
  });
  on('project-loaded', () => {
    selectedShotId = null;
    renderShotTab();
  });

  document.addEventListener('DOMContentLoaded', init);

  MSE.context = { selectShot, getSelectedShotId };
})(window.MSE = window.MSE || {});
