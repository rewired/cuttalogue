// Burst Mode modal: bulk-populates a shot's beat timeline with evenly-
// spaced hard cuts (see shots.js's applyBurstBeats) - a convenience over the
// same per-beat isCut primitive the Direction tab's beat detail panel edits
// one at a time.
(function (MSE) {
  'use strict';

  const { state } = MSE.state;
  const shotsApi = MSE.shots;

  const el = {};
  let shotId = null;

  function cacheElements() {
    el.overlay = document.getElementById('burst-beats-modal');
    el.closeBtn = document.getElementById('burst-beats-close-btn');
    el.lengthValue = document.getElementById('burst-beats-length-value');
    el.lengthUnit = document.getElementById('burst-beats-length-unit');
    el.readout = document.getElementById('burst-beats-readout');
    el.randomize = document.getElementById('burst-beats-randomize');
    el.randomizeSubjects = document.getElementById('burst-beats-randomize-subjects');
    el.applyBtn = document.getElementById('burst-beats-apply-btn');
    el.cancelBtn = document.getElementById('burst-beats-cancel-btn');
  }

  function findShot() {
    return state.shots.find((s) => s.id === shotId) || null;
  }

  // Converts the modal's unit + value into seconds - bar-fraction is "x
  // eighths of a bar" (matches the user's own "x/8 Takt" framing), frames
  // uses the project's own video fps (an authoring/timeline concept, unlike
  // H3's own fixed-24fps frame-count grid used at generation time - see
  // backend/app/frames.py's h3_frame_count, which this never touches).
  function beatLengthSeconds(unit, value) {
    if (unit === 'bar-fraction') return MSE.grid.barDuration(state.tempo.bpm, state.tempo.numerator) * (value / 8);
    if (unit === 'frames') return value / MSE.frames.fps(state.video);
    return value;
  }

  function renderReadout() {
    const shot = findShot();
    const value = parseFloat(el.lengthValue.value);
    const duration = shot ? shotsApi.shotDuration(shot) : 0;
    if (!shot || !(value > 0) || !(duration > 0)) {
      el.readout.textContent = '';
      return;
    }
    const lengthSeconds = beatLengthSeconds(el.lengthUnit.value, value);
    if (!(lengthSeconds > 0)) {
      el.readout.textContent = '';
      return;
    }
    const beatCount = Math.max(1, Math.round(duration / lengthSeconds));
    el.readout.textContent = `≈ ${beatCount} beat${beatCount === 1 ? '' : 's'}, ~${lengthSeconds.toFixed(2)}s each`;
  }

  function open(id) {
    shotId = id;
    el.overlay.hidden = false;
    renderReadout();
  }

  function close() {
    el.overlay.hidden = true;
    shotId = null;
  }

  function apply() {
    const shot = findShot();
    if (!shot) return;
    const value = parseFloat(el.lengthValue.value);
    if (!(value > 0)) return;
    const lengthSeconds = beatLengthSeconds(el.lengthUnit.value, value);
    if (!(lengthSeconds > 0)) return;
    shotsApi.applyBurstBeats(shot.id, {
      beatLengthSeconds: lengthSeconds,
      randomizeCamera: el.randomize.checked,
      randomizeSubjects: el.randomizeSubjects.checked,
    });
    close();
  }

  function wire() {
    el.closeBtn.addEventListener('click', close);
    el.cancelBtn.addEventListener('click', close);
    el.applyBtn.addEventListener('click', apply);
    el.overlay.addEventListener('click', (e) => {
      if (e.target === el.overlay) close();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !el.overlay.hidden) close();
    });
    el.lengthValue.addEventListener('input', renderReadout);
    el.lengthUnit.addEventListener('change', renderReadout);
  }

  function init() {
    cacheElements();
    wire();
  }

  document.addEventListener('DOMContentLoaded', init);

  MSE.burstBeatsModal = { open, close };
})(window.MSE = window.MSE || {});
