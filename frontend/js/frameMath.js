// FPS / H3 frame-rule math: desired frames, nearest valid render length (stride*n+1), overhang.
(function (MSE) {
  'use strict';

  function fps(video) {
    return video.fpsNumerator / video.fpsDenominator;
  }

  function desiredFrames(durationSeconds, fpsValue) {
    return Math.max(1, Math.ceil(durationSeconds * fpsValue));
  }

  // stride: 4 -> 4n+1, 8 -> 8n+1, null/0 -> "free" (no rounding)
  function renderFramesFor(desired, stride) {
    if (!stride) return desired;
    return Math.ceil((desired - 1) / stride) * stride + 1;
  }

  function frameCalc(durationSeconds, video) {
    const fpsValue = fps(video);
    const cutFrames = desiredFrames(durationSeconds, fpsValue);
    const renderFrames = renderFramesFor(cutFrames, (video.frameRule && video.frameRule.stride) || null);
    const overhangFrames = renderFrames - cutFrames;
    const overhangSeconds = fpsValue > 0 ? overhangFrames / fpsValue : 0;
    return { cutFrames, renderFrames, overhangFrames, overhangSeconds };
  }

  MSE.frames = { fps, desiredFrames, renderFramesFor, frameCalc };
})(window.MSE = window.MSE || {});
