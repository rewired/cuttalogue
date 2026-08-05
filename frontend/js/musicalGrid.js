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

  const TICKS_PER_BEAT = 960;

  // Formats a *duration* (not a position - additive, zero-based) as standard
  // DAW length notation: bars.beats.sixteenths.ticks. Unlike barBeatAt (a
  // 1-based position lookup), a 10s shot length at 120 BPM/4:4 is "2.1.3.480",
  // not "3.2.4.480".
  function durationInBarsBeats(durationSeconds, tempo) {
    const bd = beatDuration(tempo.bpm);
    const totalTicks = Math.max(0, Math.round((durationSeconds / bd) * TICKS_PER_BEAT));
    const ticksPerSixteenth = TICKS_PER_BEAT / 4;
    const ticksPerBar = TICKS_PER_BEAT * tempo.numerator;

    const bars = Math.floor(totalTicks / ticksPerBar);
    let remainder = totalTicks - bars * ticksPerBar;
    const beats = Math.floor(remainder / TICKS_PER_BEAT);
    remainder -= beats * TICKS_PER_BEAT;
    const sixteenths = Math.floor(remainder / ticksPerSixteenth);
    remainder -= sixteenths * ticksPerSixteenth;
    const ticks = Math.round(remainder);

    return `${bars}.${beats}.${sixteenths}.${String(ticks).padStart(3, '0')}`;
  }

  // Formats a *position* (not a duration) in the same bars.beats.sixteenths.ticks
  // shape, but bar/beat are 1-based (like barBeatAt) while sixteenth/tick stay
  // 0-based within the beat - standard DAW position notation, e.g. "24.2.3.120".
  function positionInBarsBeats(timeSeconds, tempo) {
    const bd = beatDuration(tempo.bpm);
    const rel = Math.max(0, timeSeconds - tempo.gridOffsetSeconds);
    const totalTicks = Math.round((rel / bd) * TICKS_PER_BEAT);
    const ticksPerSixteenth = TICKS_PER_BEAT / 4;
    const ticksPerBar = TICKS_PER_BEAT * tempo.numerator;

    const bar = Math.floor(totalTicks / ticksPerBar);
    let remainder = totalTicks - bar * ticksPerBar;
    const beat = Math.floor(remainder / TICKS_PER_BEAT);
    remainder -= beat * TICKS_PER_BEAT;
    const sixteenth = Math.floor(remainder / ticksPerSixteenth);
    remainder -= sixteenth * ticksPerSixteenth;
    const tick = Math.round(remainder);

    return `${bar + 1}.${beat + 1}.${sixteenth}.${String(tick).padStart(3, '0')}`;
  }

  MSE.grid = {
    beatDuration,
    barDuration,
    gridStepSeconds,
    snapToGrid,
    barBeatAt,
    durationInBarsBeats,
    positionInBarsBeats,
  };
})(window.MSE = window.MSE || {});
