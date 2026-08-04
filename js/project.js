// Project save/load (JSON) and shot list export (JSON/CSV).
(function (MSE) {
  'use strict';

  const { state, resetState, emit } = MSE.state;
  const { frameCalc } = MSE.frames;
  const shotsApi = MSE.shots;

  function frameRuleLabel(stride) {
    if (stride === 4) return '4n+1';
    if (stride === 8) return '8n+1';
    return 'free';
  }

  function triggerDownload(filename, content, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function serializeProject() {
    return {
      version: state.version,
      audio: state.audio,
      tempo: state.tempo,
      video: state.video,
      shotLimits: state.shotLimits,
      shots: state.shots.map((s) => ({ id: s.id, startSeconds: s.startSeconds, endSeconds: s.endSeconds })),
    };
  }

  function saveProject() {
    const json = JSON.stringify(serializeProject(), null, 2);
    triggerDownload('project.json', json, 'application/json');
  }

  function loadProjectFromText(text) {
    const parsed = JSON.parse(text);
    resetState(parsed);
    emit('tempo-changed');
    emit('video-changed');
    emit('limits-changed');
    emit('shots-changed');
  }

  function buildShotExportList() {
    return state.shots.map((shot) => {
      const duration = shotsApi.shotDuration(shot);
      const calc = frameCalc(duration, state.video);
      return {
        shot: shot.id,
        startSeconds: shot.startSeconds,
        endSeconds: shot.endSeconds,
        durationSeconds: duration,
        cutFrames: calc.cutFrames,
        renderFrames: calc.renderFrames,
        overhangFrames: calc.overhangFrames,
      };
    });
  }

  function exportShotsJson() {
    const payload = {
      fps: state.video.fpsNumerator / state.video.fpsDenominator,
      frameRule: frameRuleLabel(state.video.frameRule?.stride ?? null),
      shots: buildShotExportList(),
    };
    triggerDownload('shots.json', JSON.stringify(payload, null, 2), 'application/json');
  }

  function exportShotsCsv() {
    const rows = ['shot,start,end,duration,cut_frames,render_frames,overhang_frames'];
    buildShotExportList().forEach((s) => {
      rows.push(
        [
          s.shot,
          s.startSeconds.toFixed(3),
          s.endSeconds.toFixed(3),
          s.durationSeconds.toFixed(3),
          s.cutFrames,
          s.renderFrames,
          s.overhangFrames,
        ].join(',')
      );
    });
    triggerDownload('shots.csv', rows.join('\n'), 'text/csv');
  }

  MSE.project = { saveProject, loadProjectFromText, exportShotsJson, exportShotsCsv };
})(window.MSE = window.MSE || {});
