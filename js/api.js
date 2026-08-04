// Thin fetch wrapper around the Phase 2 backend: project CRUD plus the
// job/SSE pattern used for the "save" job (and, later, export/describe jobs).
(function (MSE) {
  'use strict';

  async function createProject(initialData) {
    const res = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(initialData),
    });
    if (!res.ok) throw new Error(`create project failed: ${res.status}`);
    return res.json(); // { id, project }
  }

  async function getProject(id) {
    const res = await fetch(`/api/projects/${id}`);
    if (!res.ok) throw new Error(`get project failed: ${res.status}`);
    return res.json();
  }

  async function listProjects() {
    const res = await fetch('/api/projects');
    if (!res.ok) throw new Error(`list projects failed: ${res.status}`);
    return res.json(); // { projects: [{ id, name, shotCount, updatedAt }] }
  }

  async function uploadAssets(id, fileList) {
    const form = new FormData();
    Array.from(fileList).forEach((file) => form.append('files', file));
    const res = await fetch(`/api/projects/${id}/assets`, { method: 'POST', body: form });
    if (!res.ok) throw new Error(`asset import failed: ${res.status}`);
    return res.json(); // { assets: [...] }
  }

  async function putProject(id, data) {
    const res = await fetch(`/api/projects/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error(`save project failed: ${res.status}`);
    return res.json(); // { jobId }
  }

  async function uploadAudioTrack(id, track, file) {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch(`/api/projects/${id}/audio/${track}`, { method: 'POST', body: form });
    if (!res.ok) throw new Error(`audio upload failed: ${res.status}`);
    return res.json(); // { relativePath, fileName }
  }

  async function exportLipSync(id, shotId) {
    const res = await fetch(`/api/projects/${id}/shots/${shotId}/export/lip-sync`, { method: 'POST' });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.detail || `export failed: ${res.status}`);
    }
    return res.json(); // { jobId, expectedDurationSeconds }
  }

  async function exportProject(id, options) {
    const res = await fetch(`/api/projects/${id}/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(options || {}),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.detail || `export failed: ${res.status}`);
    }
    return res.json(); // { jobId, shotCount }
  }

  async function cancelJob(jobId) {
    const res = await fetch(`/api/jobs/${jobId}/cancel`, { method: 'POST' });
    if (!res.ok) throw new Error(`cancel failed: ${res.status}`);
    return res.json();
  }

  // Resolves once the job reaches a terminal state ('done' or 'cancelled'),
  // rejects on 'error' or a broken stream. onProgress (optional) is called
  // for every intermediate event, e.g. { status: 'running', progressFraction:
  // 0.42, shot: 3, shotCount: 12 } while an ffmpeg job runs.
  function watchJob(jobId, onProgress) {
    return new Promise((resolve, reject) => {
      const source = new EventSource(`/api/jobs/${jobId}/events`);
      source.onmessage = (e) => {
        const event = JSON.parse(e.data);
        if (event.status === 'done' || event.status === 'cancelled') {
          source.close();
          resolve(event);
        } else if (event.status === 'error') {
          source.close();
          reject(new Error(event.message || 'job failed'));
        } else if (onProgress) {
          onProgress(event);
        }
      };
      source.onerror = () => {
        source.close();
        reject(new Error('job event stream failed'));
      };
    });
  }

  function waitForJob(jobId) {
    return watchJob(jobId);
  }

  async function getSettings() {
    const res = await fetch('/api/settings');
    if (!res.ok) throw new Error(`get settings failed: ${res.status}`);
    return res.json(); // { aiProvider: { baseUrl, defaultModel, hasApiKey } }
  }

  async function saveSettings(aiProvider) {
    const res = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aiProvider }),
    });
    if (!res.ok) throw new Error(`save settings failed: ${res.status}`);
    return res.json();
  }

  async function testSettings(aiProvider) {
    const res = await fetch('/api/settings/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aiProvider }),
    });
    if (!res.ok) throw new Error(`connection test failed: ${res.status}`);
    return res.json(); // { ok, message }
  }

  async function describeAsset(projectId, assetId, model) {
    const res = await fetch(`/api/projects/${projectId}/assets/${assetId}/describe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: model || undefined }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.detail || `describe failed: ${res.status}`);
    }
    return res.json(); // { jobId }
  }

  MSE.api = {
    createProject,
    getProject,
    listProjects,
    putProject,
    uploadAssets,
    uploadAudioTrack,
    exportLipSync,
    exportProject,
    cancelJob,
    watchJob,
    waitForJob,
    getSettings,
    saveSettings,
    testSettings,
    describeAsset,
  };
})(window.MSE = window.MSE || {});
