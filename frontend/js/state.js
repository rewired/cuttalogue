// Central project state, matching the project JSON data model, plus a tiny event bus
// so UI, shot logic and the waveform layer can react to changes without tight coupling.
(function (MSE) {
  'use strict';

  const bus = new EventTarget();

  function on(eventName, handler) {
    bus.addEventListener(eventName, handler);
  }

  function off(eventName, handler) {
    bus.removeEventListener(eventName, handler);
  }

  function emit(eventName, detail) {
    bus.dispatchEvent(new CustomEvent(eventName, { detail }));
  }

  function createDefaultState() {
    return {
      version: 1,
      name: '',
      audio: {
        mix: { fileName: null, durationSeconds: 0, relativePath: null },
        vocal: { fileName: null, durationSeconds: 0, relativePath: null },
        playbackTrack: 'mix', // 'mix' | 'vocal'
      },
      tempo: {
        bpm: 120,
        numerator: 4,
        denominator: 4,
        gridOffsetSeconds: 0,
        gridDivision: 'bar', // 'off' | 'beat' | 'half-bar' | 'bar' | 'two-bar'
      },
      video: {
        fpsNumerator: 25,
        fpsDenominator: 1,
        frameRule: { stride: 8, offset: 1 }, // stride: null (free) | 4 | 8
      },
      shotLimits: {
        minimumSeconds: 8,
        maximumSeconds: 12,
      },
      shots: [], // { id, startSeconds, endSeconds, prompt, notes, assetIds }
      assets: [], // { id, type, fileName, relativePath, thumbnailPath, tags, metadata }
      export: {
        includeMixSnippet: false,
      },
      savedAt: null, // stamped on every real save - see project.js's draft-recovery mechanism
    };
  }

  const state = createDefaultState();

  function resetState(next) {
    Object.keys(state).forEach((key) => delete state[key]);
    Object.assign(state, next);
    emit('project-loaded');
  }

  MSE.state = { state, on, off, emit, createDefaultState, resetState };
})(window.MSE = window.MSE || {});
