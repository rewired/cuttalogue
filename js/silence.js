// Simple RMS-threshold silence/gap detection for the vocal stem.
// Purely visual orientation - never creates or moves shots on its own.
(function (MSE) {
  'use strict';

  const WINDOW_SECONDS = 0.05;
  const THRESHOLD_DB = -40;
  const MIN_GAP_SECONDS = 0.6;

  function detectSilence(audioBuffer, options) {
    options = options || {};
    const thresholdDb = options.thresholdDb ?? THRESHOLD_DB;
    const minGapSeconds = options.minGapSeconds ?? MIN_GAP_SECONDS;
    const sampleRate = audioBuffer.sampleRate;
    const windowSize = Math.max(1, Math.floor(sampleRate * WINDOW_SECONDS));
    const channelCount = audioBuffer.numberOfChannels;
    const threshold = Math.pow(10, thresholdDb / 20);
    const length = audioBuffer.length;

    const channels = [];
    for (let c = 0; c < channelCount; c++) channels.push(audioBuffer.getChannelData(c));

    const gaps = [];
    let silentStart = null;

    for (let i = 0; i < length; i += windowSize) {
      const end = Math.min(i + windowSize, length);
      let sumSquares = 0;
      let sampleCount = 0;
      for (let c = 0; c < channelCount; c++) {
        const data = channels[c];
        for (let j = i; j < end; j++) {
          sumSquares += data[j] * data[j];
          sampleCount++;
        }
      }
      const rms = Math.sqrt(sumSquares / Math.max(1, sampleCount));
      const t = i / sampleRate;
      if (rms < threshold) {
        if (silentStart === null) silentStart = t;
      } else if (silentStart !== null) {
        if (t - silentStart >= minGapSeconds) gaps.push({ start: silentStart, end: t });
        silentStart = null;
      }
    }

    if (silentStart !== null) {
      const end = length / sampleRate;
      if (end - silentStart >= minGapSeconds) gaps.push({ start: silentStart, end });
    }

    return gaps;
  }

  MSE.silence = { detectSilence };
})(window.MSE = window.MSE || {});
