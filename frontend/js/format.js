// Formatting helpers for time and numbers.
(function (MSE) {
  'use strict';

  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
    // Round the combined value once, then split - rounding ms separately
    // from seconds let it round up to 1000 right at a second boundary
    // (e.g. 14.9996 -> ms=1000), printing a stray 4-digit ".1000" for a
    // frame instead of rolling over into the next second.
    const totalMs = Math.round(seconds * 1000);
    const ms = totalMs % 1000;
    const totalSeconds = Math.floor(totalMs / 1000);
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
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
