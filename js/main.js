// DOM wiring: connects UI controls to state, waveformSync and project modules.
(function (MSE) {
  'use strict';

  const { state, on, emit } = MSE.state;

  const el = {
    mixFile: document.getElementById('mix-file'),
    vocalFile: document.getElementById('vocal-file'),
    mixFilename: document.getElementById('mix-filename'),
    vocalFilename: document.getElementById('vocal-filename'),
    trackMixRadio: document.getElementById('track-mix-radio'),
    trackVocalRadio: document.getElementById('track-vocal-radio'),
    playPauseBtn: document.getElementById('play-pause-btn'),
    zoomSlider: document.getElementById('zoom-slider'),
    placeholder: document.getElementById('timeline-placeholder'),

    bpm: document.getElementById('bpm-input'),
    timeSigNum: document.getElementById('time-sig-num'),
    timeSigDen: document.getElementById('time-sig-den'),
    gridOffset: document.getElementById('grid-offset-input'),
    setOffsetBtn: document.getElementById('set-offset-to-playhead-btn'),
    gridDivision: document.getElementById('grid-division-select'),

    fps: document.getElementById('fps-input'),
    frameRule: document.getElementById('frame-rule-select'),

    minLength: document.getElementById('min-length-input'),
    maxLength: document.getElementById('max-length-input'),

    saveProjectBtn: document.getElementById('save-project-btn'),
    loadProjectFile: document.getElementById('load-project-file'),
    exportJsonBtn: document.getElementById('export-json-btn'),
    exportCsvBtn: document.getElementById('export-csv-btn'),
  };

  function syncSettingsPanelFromState() {
    el.bpm.value = state.tempo.bpm;
    el.timeSigNum.value = state.tempo.numerator;
    el.timeSigDen.value = state.tempo.denominator;
    el.gridOffset.value = state.tempo.gridOffsetSeconds;
    el.gridDivision.value = state.tempo.gridDivision;

    el.fps.value = state.video.fpsNumerator;
    el.frameRule.value = state.video.frameRule && state.video.frameRule.stride ? String(state.video.frameRule.stride) : 'free';

    el.minLength.value = state.shotLimits.minimumSeconds;
    el.maxLength.value = state.shotLimits.maximumSeconds;

    el.trackMixRadio.checked = state.audio.playbackTrack === 'mix';
    el.trackVocalRadio.checked = state.audio.playbackTrack === 'vocal';
  }

  function wireFileInputs() {
    el.mixFile.addEventListener('change', async () => {
      const file = el.mixFile.files[0];
      if (!file) return;
      const url = URL.createObjectURL(file);
      await MSE.sync.loadMix(url, file.name);
      el.mixFilename.textContent = file.name;
      el.placeholder.style.display = 'none';
      el.playPauseBtn.disabled = false;
    });

    el.vocalFile.addEventListener('change', async () => {
      const file = el.vocalFile.files[0];
      if (!file) return;
      const url = URL.createObjectURL(file);
      await MSE.sync.loadVocal(url, file.name);
      el.vocalFilename.textContent = file.name;
    });
  }

  function wireTransport() {
    el.playPauseBtn.addEventListener('click', () => MSE.sync.togglePlayback());

    el.trackMixRadio.addEventListener('change', () => {
      if (el.trackMixRadio.checked) MSE.sync.setPlaybackTrack('mix');
    });
    el.trackVocalRadio.addEventListener('change', () => {
      if (el.trackVocalRadio.checked) MSE.sync.setPlaybackTrack('vocal');
    });

    el.zoomSlider.addEventListener('input', () => {
      MSE.sync.zoomTo(Number(el.zoomSlider.value));
    });

    on('playback-state-changed', (e) => {
      el.playPauseBtn.textContent = e.detail.isPlaying ? '⏸ Pause' : '▶ Play';
    });

    document.addEventListener('keydown', (e) => {
      if (e.code !== 'Space') return;
      const tag = document.activeElement && document.activeElement.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      e.preventDefault();
      MSE.sync.togglePlayback();
    });
  }

  function wireTempoSettings() {
    function applyTempo() {
      state.tempo.bpm = Math.max(1, Number(el.bpm.value) || 120);
      state.tempo.numerator = Math.max(1, Number(el.timeSigNum.value) || 4);
      state.tempo.denominator = Math.max(1, Number(el.timeSigDen.value) || 4);
      state.tempo.gridOffsetSeconds = Number(el.gridOffset.value) || 0;
      state.tempo.gridDivision = el.gridDivision.value;
      emit('tempo-changed');
    }
    [el.bpm, el.timeSigNum, el.timeSigDen, el.gridOffset, el.gridDivision].forEach((input) =>
      input.addEventListener('change', applyTempo)
    );

    el.setOffsetBtn.addEventListener('click', () => {
      el.gridOffset.value = MSE.sync.getCurrentTime().toFixed(3);
      applyTempo();
    });
  }

  function wireVideoSettings() {
    function applyVideo() {
      state.video.fpsNumerator = Math.max(0.001, Number(el.fps.value) || 25);
      state.video.fpsDenominator = 1;
      const rule = el.frameRule.value;
      state.video.frameRule = { stride: rule === 'free' ? null : Number(rule), offset: 1 };
      emit('video-changed');
    }
    [el.fps, el.frameRule].forEach((input) => input.addEventListener('change', applyVideo));
  }

  function wireShotLimits() {
    function applyLimits() {
      state.shotLimits.minimumSeconds = Math.max(0, Number(el.minLength.value) || 0);
      state.shotLimits.maximumSeconds = Math.max(state.shotLimits.minimumSeconds, Number(el.maxLength.value) || 0);
      emit('limits-changed');
    }
    [el.minLength, el.maxLength].forEach((input) => input.addEventListener('change', applyLimits));
  }

  function wireProjectActions() {
    el.saveProjectBtn.addEventListener('click', () => MSE.project.saveProject());

    el.loadProjectFile.addEventListener('change', async () => {
      const file = el.loadProjectFile.files[0];
      if (!file) return;
      const text = await file.text();
      MSE.project.loadProjectFromText(text);
      el.loadProjectFile.value = '';
    });

    el.exportJsonBtn.addEventListener('click', () => MSE.project.exportShotsJson());
    el.exportCsvBtn.addEventListener('click', () => MSE.project.exportShotsCsv());

    on('project-loaded', syncSettingsPanelFromState);
  }

  function init() {
    syncSettingsPanelFromState();
    wireFileInputs();
    wireTransport();
    wireTempoSettings();
    wireVideoSettings();
    wireShotLimits();
    wireProjectActions();
  }

  document.addEventListener('DOMContentLoaded', init);
})(window.MSE = window.MSE || {});
