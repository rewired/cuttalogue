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

  // Resolves once the job reaches 'done', rejects on 'error' or a broken
  // stream. onProgress (optional) is called for every intermediate event,
  // e.g. { status: 'running', progressFraction: 0.42 } while an ffmpeg job runs.
  function watchJob(jobId, onProgress) {
    return new Promise((resolve, reject) => {
      const source = new EventSource(`/api/jobs/${jobId}/events`);
      source.onmessage = (e) => {
        const event = JSON.parse(e.data);
        if (event.status === 'done') {
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

  MSE.api = {
    createProject,
    getProject,
    putProject,
    uploadAssets,
    uploadAudioTrack,
    exportLipSync,
    watchJob,
    waitForJob,
  };
})(window.MSE = window.MSE || {});
