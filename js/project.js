// Project save/load, backed by the Phase 2 backend (project folder on disk),
// plus shot list export (JSON/CSV), which stays a client-side download.
(function (MSE) {
  'use strict';

  const { state, resetState, emit } = MSE.state;
  const { frameCalc } = MSE.frames;
  const shotsApi = MSE.shots;
  const api = MSE.api;

  const PROJECT_ID_STORAGE_KEY = 'cuttalogue.projectId';

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
      name: state.name || '',
      audio: state.audio,
      tempo: state.tempo,
      video: state.video,
      shotLimits: state.shotLimits,
      shots: state.shots.map((s) => ({
        id: s.id,
        startSeconds: s.startSeconds,
        endSeconds: s.endSeconds,
        prompt: s.prompt || '',
        notes: s.notes || '',
        assetIds: s.assetIds || [],
      })),
      assets: state.assets,
      export: state.export,
    };
  }

  function applyLoadedProject(parsed) {
    // Older/foreign project data predates the name/prompt/notes/assetIds/
    // assets/export fields - default them in rather than leaving things undefined.
    parsed.name = parsed.name || '';
    parsed.shots = (parsed.shots || []).map((s) => ({ prompt: '', notes: '', assetIds: [], ...s }));
    parsed.assets = (parsed.assets || []).map((a) => ({ tags: [], ...a }));
    parsed.export = { includeMixSnippet: false, ...(parsed.export || {}) };
    resetState(parsed);
    emit('tempo-changed');
    emit('video-changed');
    emit('limits-changed');
    emit('shots-changed');
    emit('assets-changed', { reason: 'load' });
  }

  // Loads the project last saved to the backend (by id, kept in localStorage
  // so a full page refresh reopens the same project), or creates a fresh one
  // on the backend if there's no stored id yet, or the stored id no longer
  // resolves there. If the backend itself is unreachable, falls back to the
  // in-memory default state so the rest of the editor still works.
  async function initBackendProject() {
    const storedId = localStorage.getItem(PROJECT_ID_STORAGE_KEY);
    try {
      if (storedId) {
        const project = await api.getProject(storedId);
        applyLoadedProject(project);
        return;
      }
    } catch (err) {
      console.warn('Stored project not found on backend, creating a new one.', err);
    }
    try {
      const created = await api.createProject(serializeProject());
      localStorage.setItem(PROJECT_ID_STORAGE_KEY, created.id);
    } catch (err) {
      console.warn('Backend unavailable - project will not persist across reloads.', err);
    }
  }

  async function saveProjectToBackend() {
    const id = localStorage.getItem(PROJECT_ID_STORAGE_KEY);
    if (!id) throw new Error('no project id - backend was unavailable at startup');
    const { jobId } = await api.putProject(id, serializeProject());
    await api.waitForJob(jobId);
  }

  function getProjectId() {
    return localStorage.getItem(PROJECT_ID_STORAGE_KEY);
  }

  // Creates a brand-new, blank project on the backend and switches to it.
  // Does not touch any audio currently loaded in the browser - like project
  // load, the mix/vocal still need to be reselected for the new project.
  async function createNewProject() {
    const fresh = MSE.state.createDefaultState();
    const created = await api.createProject(fresh);
    localStorage.setItem(PROJECT_ID_STORAGE_KEY, created.id);
    applyLoadedProject(created.project);
    return created.id;
  }

  async function openProject(id) {
    const project = await api.getProject(id);
    localStorage.setItem(PROJECT_ID_STORAGE_KEY, id);
    applyLoadedProject(project);
  }

  async function listProjects() {
    const { projects } = await api.listProjects();
    return projects;
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

  MSE.project = {
    initBackendProject,
    saveProjectToBackend,
    getProjectId,
    createNewProject,
    openProject,
    listProjects,
    exportShotsJson,
    exportShotsCsv,
  };
})(window.MSE = window.MSE || {});
