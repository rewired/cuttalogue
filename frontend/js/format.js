// Formatting helpers for time and numbers.
(function (MSE) {
  'use strict';

  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    const ms = Math.round((seconds - Math.floor(seconds)) * 1000);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
  }

  function formatSeconds(seconds, digits = 3) {
    if (!Number.isFinite(seconds)) return '0.' + '0'.repeat(digits);
    return seconds.toFixed(digits);
  }

  function stripFileExtension(fileName) {
    const dot = fileName.lastIndexOf('.');
    return dot > 0 ? fileName.slice(0, dot) : fileName;
  }

  MSE.format = { formatTime, formatSeconds, stripFileExtension };
})(window.MSE = window.MSE || {});
