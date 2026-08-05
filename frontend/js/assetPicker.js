// The "+" picker opened from a shot's Cast & Locations tab: a fast,
// assign-only view over the asset library. Deliberately one-directional -
// clicking an unassigned tile assigns it and closes the modal immediately;
// clicking an already-assigned tile does nothing (removal happens back in
// the tab itself, via the chip's x, not here).
(function (MSE) {
  'use strict';

  const { state, on } = MSE.state;

  const el = {};
  let shotId = null;

  function cacheElements() {
    el.overlay = document.getElementById('asset-picker-modal');
    el.closeBtn = document.getElementById('asset-picker-close-btn');
    el.empty = document.getElementById('asset-picker-empty');
    el.grid = document.getElementById('asset-picker-grid');
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

  function findShot() {
    return state.shots.find((s) => s.id === shotId) || null;
  }

  function renderCard(asset, shot) {
    const assigned = (shot.assetIds || []).includes(asset.id);
    const classified = MSE.assets.isClassified(asset);

    const card = document.createElement('div');
    card.className = 'asset-card asset-picker-card';
    card.classList.toggle('assigned', assigned);
    card.classList.toggle('unavailable', !assigned && !classified);
    card.setAttribute('role', 'button');
    card.tabIndex = 0;
    if (!classified && !assigned) card.title = 'Classify this asset in the Assets tab first';

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

    const check = document.createElement('span');
    check.className = 'asset-picker-check';
    check.textContent = '✓';
    card.appendChild(check);

    function pick() {
      if (assigned || !classified) return;
      MSE.assets.assignAssetToShot(shot.id, asset.id);
      close();
    }
    card.addEventListener('click', pick);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        pick();
      }
    });

    return card;
  }

  function render() {
    const shot = findShot();
    el.grid.innerHTML = '';
    el.empty.style.display = state.assets.length === 0 ? '' : 'none';
    if (!shot) return;
    state.assets.forEach((asset) => el.grid.appendChild(renderCard(asset, shot)));
  }

  function open(id) {
    shotId = id;
    el.overlay.hidden = false;
    render();
  }

  function close() {
    el.overlay.hidden = true;
    shotId = null;
  }

  function wire() {
    el.closeBtn.addEventListener('click', close);
    el.overlay.addEventListener('click', (e) => {
      if (e.target === el.overlay) close();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !el.overlay.hidden) close();
    });
    on('assets-changed', () => {
      if (!el.overlay.hidden) render();
    });
    on('shots-changed', () => {
      if (!el.overlay.hidden) render();
    });
  }

  function init() {
    cacheElements();
    wire();
  }

  document.addEventListener('DOMContentLoaded', init);

  MSE.assetPicker = { open, close };
})(window.MSE = window.MSE || {});
