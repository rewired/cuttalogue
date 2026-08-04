// Musical grid math: BPM/time signature -> beat/bar durations, grid snapping, bar/beat lookup.
(function (MSE) {
  'use strict';

  function beatDuration(bpm) {
    return 60 / bpm;
  }

  function barDuration(bpm, numerator) {
    return beatDuration(bpm) * numerator;
  }

  // tempo: { bpm, numerator, denominator, gridOffsetSeconds, gridDivision }
  // gridDivision: 'off' | 'beat' | 'half-bar' | 'bar' | 'two-bar'
  function gridStepSeconds(tempo) {
    const bar = barDuration(tempo.bpm, tempo.numerator);
    switch (tempo.gridDivision) {
      case 'beat':
        return beatDuration(tempo.bpm);
      case 'half-bar':
        return bar / 2;
      case 'bar':
        return bar;
      case 'two-bar':
        return bar * 2;
      case 'off':
      default:
        return null;
    }
  }

  function snapToGrid(timeSeconds, tempo) {
    const step = gridStepSeconds(tempo);
    if (!step || step <= 0) return Math.max(0, timeSeconds);
    const rel = timeSeconds - tempo.gridOffsetSeconds;
    const snappedRel = Math.round(rel / step) * step;
    return Math.max(0, tempo.gridOffsetSeconds + snappedRel);
  }

  // Returns { bar, beat } (both 1-based) for a given time.
  function barBeatAt(timeSeconds, tempo) {
    const bd = beatDuration(tempo.bpm);
    const rel = Math.max(0, timeSeconds - tempo.gridOffsetSeconds);
    // Round off float noise (e.g. 180 BPM produces a repeating binary
    // fraction, so a time that is conceptually exactly on beat 28 can come
    // back as 27.999999999999996) before flooring, or a beat boundary
    // occasionally floors down to the previous beat.
    const totalBeats = Math.round((rel / bd) * 1e6) / 1e6;
    const bar = Math.floor(totalBeats / tempo.numerator) + 1;
    const beat = Math.floor(totalBeats % tempo.numerator) + 1;
    return { bar, beat };
  }

  MSE.grid = { beatDuration, barDuration, gridStepSeconds, snapToGrid, barBeatAt };
})(window.MSE = window.MSE || {});
