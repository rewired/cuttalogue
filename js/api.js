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

  async function putProject(id, data) {
    const res = await fetch(`/api/projects/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error(`save project failed: ${res.status}`);
    return res.json(); // { jobId }
  }

  // Resolves once the job reaches 'done', rejects on 'error' or a broken stream.
  function waitForJob(jobId) {
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
        }
      };
      source.onerror = () => {
        source.close();
        reject(new Error('job event stream failed'));
      };
    });
  }

  MSE.api = { createProject, getProject, putProject, waitForJob };
})(window.MSE = window.MSE || {});
