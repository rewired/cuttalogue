// Setup modal: application-level AI provider connection (base URL, API key,
// default model), stored on the backend outside of any project - never part
// of project.json or an export. The API key itself is never sent back down
// from the backend (see settings.py's _public_view), so this form only shows
// whether one is saved, not what it is; leaving the key field blank on save
// keeps whatever is already stored.
(function (MSE) {
  'use strict';

  const el = {};

  function cacheElements() {
    el.openBtn = document.getElementById('setup-btn');
    el.overlay = document.getElementById('settings-modal');
    el.closeBtn = document.getElementById('settings-close-btn');
    el.baseUrl = document.getElementById('settings-base-url');
    el.apiKey = document.getElementById('settings-api-key');
    el.keyStatus = document.getElementById('settings-key-status');
    el.defaultModel = document.getElementById('settings-default-model');
    el.modelList = document.getElementById('settings-model-list');
    el.testBtn = document.getElementById('settings-test-btn');
    el.testResult = document.getElementById('settings-test-result');
    el.saveBtn = document.getElementById('settings-save-btn');
    el.saveStatus = document.getElementById('settings-save-status');
  }

  // Also called right after a successful save, to refresh the "an API key is
  // saved" prefill - must NOT touch saveStatus itself, or it would immediately
  // wipe out the "Saved." confirmation the save handler just set.
  async function loadIntoForm() {
    try {
      const { aiProvider } = await MSE.api.getSettings();
      el.baseUrl.value = aiProvider.baseUrl || '';
      el.defaultModel.value = aiProvider.defaultModel || '';
      el.apiKey.value = '';
      el.apiKey.placeholder = aiProvider.hasApiKey ? 'Saved - leave blank to keep it' : 'sk-...';
      el.keyStatus.textContent = aiProvider.hasApiKey ? 'An API key is saved.' : 'No API key saved yet.';
    } catch (err) {
      console.error(err);
      el.saveStatus.textContent = 'Could not load settings - is the backend running?';
    }
  }

  function currentFormValues() {
    return {
      baseUrl: el.baseUrl.value.trim(),
      apiKey: el.apiKey.value.trim(),
      defaultModel: el.defaultModel.value.trim(),
    };
  }

  function openModal() {
    el.overlay.hidden = false;
    el.testResult.textContent = '';
    el.saveStatus.textContent = '';
    loadIntoForm();
  }

  function closeModal() {
    el.overlay.hidden = true;
  }

  function wire() {
    el.openBtn.addEventListener('click', openModal);
    el.closeBtn.addEventListener('click', closeModal);
    el.overlay.addEventListener('click', (e) => {
      if (e.target === el.overlay) closeModal();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !el.overlay.hidden) closeModal();
    });

    el.testBtn.addEventListener('click', async () => {
      el.testBtn.disabled = true;
      el.testResult.textContent = 'Testing...';
      el.testResult.style.color = '';
      try {
        const result = await MSE.api.testSettings(currentFormValues());
        if (Array.isArray(result.models)) {
          el.modelList.innerHTML = '';
          result.models.forEach((id) => {
            const option = document.createElement('option');
            option.value = id;
            el.modelList.appendChild(option);
          });
        }
        el.testResult.textContent = result.message || (result.ok ? 'OK' : 'Failed');
        el.testResult.style.color = result.ok ? '#4caf50' : '#f44336';
      } catch (err) {
        console.error(err);
        el.testResult.textContent = 'Test request failed.';
        el.testResult.style.color = '#f44336';
      } finally {
        el.testBtn.disabled = false;
      }
    });

    el.saveBtn.addEventListener('click', async () => {
      el.saveBtn.disabled = true;
      el.saveStatus.textContent = 'Saving...';
      try {
        await MSE.api.saveSettings(currentFormValues());
        el.saveStatus.textContent = 'Saved.';
        await loadIntoForm();
      } catch (err) {
        console.error(err);
        el.saveStatus.textContent = 'Save failed.';
      } finally {
        el.saveBtn.disabled = false;
      }
    });
  }

  function init() {
    cacheElements();
    wire();
  }

  document.addEventListener('DOMContentLoaded', init);

  MSE.settings = {};
})(window.MSE = window.MSE || {});
