// Context panel: [Shot] / [Assets] tabs on the right of the shot list. Owns the
// transient (non-persisted) selected-shot id and renders that shot's readouts
// plus its editable prompt/notes fields, which live on the shot itself and
// round-trip through the project JSON.
(function (MSE) {
  'use strict';

  const { state, on, emit } = MSE.state;
  const { formatTime } = MSE.format;
  const { frameCalc } = MSE.frames;
  const shotsApi = MSE.shots;

  let selectedShotId = null;

  const el = {};

  function cacheElements() {
    el.tabShotBtn = document.getElementById('tab-btn-shot');
    el.tabAssetsBtn = document.getElementById('tab-btn-assets');
    el.tabShot = document.getElementById('tab-shot');
    el.tabAssets = document.getElementById('tab-assets');
    el.empty = document.getElementById('shot-detail-empty');
    el.detail = document.getElementById('shot-detail');
    el.id = document.getElementById('shot-detail-id');
    el.start = document.getElementById('shot-detail-start');
    el.end = document.getElementById('shot-detail-end');
    el.duration = document.getElementById('shot-detail-duration');
    el.status = document.getElementById('shot-detail-status');
    el.cutFrames = document.getElementById('shot-detail-cut-frames');
    el.renderFrames = document.getElementById('shot-detail-render-frames');
    el.overhang = document.getElementById('shot-detail-overhang');
    el.prompt = document.getElementById('shot-detail-prompt');
    el.notes = document.getElementById('shot-detail-notes');
    el.assignedAssets = document.getElementById('shot-detail-assets');

    el.assetFileInput = document.getElementById('asset-file-input');
    el.assetTagFilter = document.getElementById('asset-tag-filter');
    el.assetStatus = document.getElementById('asset-status');
    el.assetEmpty = document.getElementById('asset-empty');
    el.assetGrid = document.getElementById('asset-grid');
  }

  function findSelectedShot() {
    return state.shots.find((s) => s.id === selectedShotId) || null;
  }

  function statusLabel(status) {
    if (status === 'short') return 'too short';
    if (status === 'long') return 'too long';
    return 'valid';
  }

  function renderShotTab() {
    const shot = findSelectedShot();
    if (!shot) {
      el.empty.style.display = '';
      el.detail.style.display = 'none';
      return;
    }
    el.empty.style.display = 'none';
    el.detail.style.display = '';

    const status = shotsApi.shotStatus(shot);
    const calc = frameCalc(shotsApi.shotDuration(shot), state.video);

    el.id.textContent = shot.id;
    el.start.textContent = formatTime(shot.startSeconds);
    el.end.textContent = formatTime(shot.endSeconds);
    el.duration.textContent = `${shotsApi.shotDuration(shot).toFixed(3)} s`;
    el.status.textContent = statusLabel(status);
    el.status.className = `status-cell status-${status}`;
    el.cutFrames.textContent = calc.cutFrames;
    el.renderFrames.textContent = calc.renderFrames;
    el.overhang.textContent = `${calc.overhangFrames} f / ${calc.overhangSeconds.toFixed(3)} s`;

    // Skip the field currently being typed in, so a re-render triggered by
    // e.g. dragging the shot's edge in the timeline can't clobber live input.
    if (document.activeElement !== el.prompt) el.prompt.value = shot.prompt || '';
    if (document.activeElement !== el.notes) el.notes.value = shot.notes || '';

    renderAssignedAssets(shot);
  }

  function renderAssignedAssets(shot) {
    el.assignedAssets.innerHTML = '';
    const assigned = MSE.assets.assetsForShot(shot);
    if (assigned.length === 0) {
      const span = document.createElement('span');
      span.className = 'placeholder-hint';
      span.textContent = 'None assigned.';
      el.assignedAssets.appendChild(span);
      return;
    }
    assigned.forEach((asset) => {
      const chip = document.createElement('span');
      chip.className = 'assigned-asset-chip';
      const label = document.createElement('span');
      label.textContent = asset.fileName;
      chip.appendChild(label);
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.textContent = '×';
      removeBtn.title = 'Remove from this shot';
      removeBtn.addEventListener('click', () => MSE.assets.removeAssetFromShot(shot.id, asset.id));
      chip.appendChild(removeBtn);
      el.assignedAssets.appendChild(chip);
    });
  }

  function assetPreviewUrl(asset) {
    const projectId = MSE.project.getProjectId();
    const path = asset.thumbnailPath || (asset.type === 'image' ? asset.relativePath : null);
    if (!projectId || !path) return null;
    return `/project-files/${projectId}/${path}`;
  }

  function assetTypeLabel(type) {
    if (type === 'audio') return 'AUDIO';
    if (type === 'video') return 'VIDEO';
    if (type === 'other') return 'FILE';
    return 'IMAGE';
  }

  function renderAssetCard(asset) {
    const card = document.createElement('div');
    card.className = 'asset-card';

    const previewUrl = assetPreviewUrl(asset);
    if (previewUrl) {
      const img = document.createElement('img');
      img.src = previewUrl;
      img.alt = asset.fileName;
      card.appendChild(img);
    } else {
      const placeholder = document.createElement('div');
      placeholder.className = 'asset-icon';
      placeholder.textContent = assetTypeLabel(asset.type);
      card.appendChild(placeholder);
    }

    const name = document.createElement('div');
    name.className = 'asset-filename';
    name.title = asset.fileName;
    name.textContent = asset.fileName;
    card.appendChild(name);

    const tagInput = document.createElement('input');
    tagInput.type = 'text';
    tagInput.className = 'asset-tag-input';
    tagInput.placeholder = 'tags, comma, separated';
    tagInput.value = (asset.tags || []).join(', ');
    tagInput.addEventListener('change', () => {
      const tags = tagInput.value
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
      MSE.assets.setAssetTags(asset.id, tags);
    });
    card.appendChild(tagInput);

    const assignBtn = document.createElement('button');
    assignBtn.type = 'button';
    assignBtn.className = 'asset-assign-btn';
    const shot = findSelectedShot();
    if (!shot) {
      assignBtn.textContent = 'Select a shot to assign';
      assignBtn.disabled = true;
    } else {
      const assigned = (shot.assetIds || []).includes(asset.id);
      assignBtn.textContent = assigned ? `Remove from Shot ${shot.id}` : `Assign to Shot ${shot.id}`;
      assignBtn.classList.toggle('assigned', assigned);
      assignBtn.addEventListener('click', () => {
        if (assigned) MSE.assets.removeAssetFromShot(shot.id, asset.id);
        else MSE.assets.assignAssetToShot(shot.id, asset.id);
      });
    }
    card.appendChild(assignBtn);

    return card;
  }

  function renderAssetsTab() {
    const filterText = el.assetTagFilter.value.trim().toLowerCase();
    const filtered = state.assets.filter((asset) => {
      if (!filterText) return true;
      return (asset.tags || []).some((tag) => tag.toLowerCase().includes(filterText));
    });
    el.assetGrid.innerHTML = '';
    el.assetEmpty.style.display = state.assets.length === 0 ? '' : 'none';
    filtered.forEach((asset) => el.assetGrid.appendChild(renderAssetCard(asset)));
  }

  function selectShot(shotId) {
    selectedShotId = shotId;
    renderShotTab();
    renderAssetsTab();
    emit('shot-selected', { shotId });
  }

  function getSelectedShotId() {
    return selectedShotId;
  }

  function wireTextInputs() {
    el.prompt.addEventListener('input', () => {
      const shot = findSelectedShot();
      if (shot) shot.prompt = el.prompt.value;
    });
    el.notes.addEventListener('input', () => {
      const shot = findSelectedShot();
      if (shot) shot.notes = el.notes.value;
    });
  }

  function wireAssetControls() {
    el.assetFileInput.addEventListener('change', async () => {
      const files = el.assetFileInput.files;
      if (!files || files.length === 0) return;
      const projectId = MSE.project.getProjectId();
      if (!projectId) {
        el.assetStatus.textContent = 'Backend unavailable - cannot import assets.';
        el.assetFileInput.value = '';
        return;
      }
      el.assetStatus.textContent = `Importing ${files.length} file(s)...`;
      try {
        const result = await MSE.api.uploadAssets(projectId, files);
        MSE.assets.addAssets(result.assets);
        el.assetStatus.textContent = `Imported ${result.assets.length} file(s).`;
      } catch (err) {
        console.error(err);
        el.assetStatus.textContent = 'Import failed - is the backend running?';
      } finally {
        el.assetFileInput.value = '';
      }
    });

    el.assetTagFilter.addEventListener('input', renderAssetsTab);
  }

  function wireTabs() {
    function activate(tab) {
      const isShot = tab === 'shot';
      el.tabShotBtn.classList.toggle('active', isShot);
      el.tabAssetsBtn.classList.toggle('active', !isShot);
      el.tabShot.hidden = !isShot;
      el.tabAssets.hidden = isShot;
    }
    el.tabShotBtn.addEventListener('click', () => activate('shot'));
    el.tabAssetsBtn.addEventListener('click', () => activate('assets'));
  }

  function init() {
    cacheElements();
    wireTabs();
    wireTextInputs();
    wireAssetControls();
    renderShotTab();
    renderAssetsTab();
  }

  on('shots-changed', () => {
    // The selected shot's id can disappear from under it (delete/merge/split
    // renumbers), in which case fall back to the empty state instead of
    // showing stale data for an id that no longer exists.
    if (selectedShotId !== null && !findSelectedShot()) selectedShotId = null;
    renderShotTab();
    // Assign/remove buttons in the Assets tab reflect the selected shot's
    // assetIds, which is exactly what a 'shots-changed' from (un)assigning
    // an asset changes.
    renderAssetsTab();
  });
  on('assets-changed', () => {
    renderAssetsTab();
    renderShotTab();
  });
  on('project-loaded', () => {
    selectedShotId = null;
    renderShotTab();
  });

  document.addEventListener('DOMContentLoaded', init);

  MSE.context = { selectShot, getSelectedShotId };
})(window.MSE = window.MSE || {});
