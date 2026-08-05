// Context panel: [Assets] / [Direction] / [Prompt] / [Notes] tabs on the
// right of the shot list. Owns the transient (non-persisted) selected-shot
// id and renders that shot's readouts plus its editable prompt/notes fields,
// which live on the shot itself and round-trip through the project JSON.
(function (MSE) {
  'use strict';

  const { state, on, emit } = MSE.state;
  const shotsApi = MSE.shots;

  let selectedShotId = null;

  const el = {};

  function cacheElements() {
    el.tabAssetsBtn = document.getElementById('tab-btn-assets');
    el.tabDirectionBtn = document.getElementById('tab-btn-direction');
    el.tabPromptBtn = document.getElementById('tab-btn-prompt');
    el.tabNotesBtn = document.getElementById('tab-btn-notes');
    el.tabAssets = document.getElementById('tab-assets');
    el.tabDirection = document.getElementById('tab-direction');
    el.tabPrompt = document.getElementById('tab-prompt');
    el.tabNotes = document.getElementById('tab-notes');

    el.directionEmpty = document.getElementById('direction-tab-empty');
    el.directionDetail = document.getElementById('direction-tab-detail');
    el.promptEmpty = document.getElementById('prompt-tab-empty');
    el.promptDetail = document.getElementById('prompt-tab-detail');
    el.notesEmpty = document.getElementById('notes-tab-empty');
    el.notesDetail = document.getElementById('notes-tab-detail');

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

  // Direction/Prompt/Notes only make sense for a selected shot, so each tab
  // toggles its own empty-hint vs detail content the same way the old single
  // Shot tab used to as a whole.
  function renderShotSpecificTabs() {
    const shot = findSelectedShot();
    const hasShot = !!shot;

    el.directionEmpty.style.display = hasShot ? 'none' : '';
    el.directionDetail.style.display = hasShot ? '' : 'none';
    el.promptEmpty.style.display = hasShot ? 'none' : '';
    el.promptDetail.style.display = hasShot ? '' : 'none';
    el.notesEmpty.style.display = hasShot ? 'none' : '';
    el.notesDetail.style.display = hasShot ? '' : 'none';

    if (hasShot) {
      // Skip the field currently being typed in, so a re-render triggered by
      // e.g. dragging the shot's edge in the timeline can't clobber live input.
      if (document.activeElement !== el.prompt) el.prompt.value = shot.prompt || '';
      if (document.activeElement !== el.notes) el.notes.value = shot.notes || '';
    }

    renderAssignedAssets();
  }

  function renderAssignedAssets() {
    const shot = findSelectedShot();
    el.assignedAssets.innerHTML = '';

    if (!shot) {
      const span = document.createElement('span');
      span.className = 'placeholder-hint';
      span.textContent = 'Select a shot to see its assigned assets.';
      el.assignedAssets.appendChild(span);
      return;
    }

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

    if ((asset.tags || []).length > 0) {
      const tags = document.createElement('div');
      tags.className = 'asset-tags-readout';
      tags.textContent = asset.tags.join(', ');
      card.appendChild(tags);
    }

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
    renderShotSpecificTabs();
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
    const buttons = {
      assets: el.tabAssetsBtn,
      direction: el.tabDirectionBtn,
      prompt: el.tabPromptBtn,
      notes: el.tabNotesBtn,
    };
    const panels = {
      assets: el.tabAssets,
      direction: el.tabDirection,
      prompt: el.tabPrompt,
      notes: el.tabNotes,
    };
    function activate(tab) {
      Object.keys(buttons).forEach((key) => {
        buttons[key].classList.toggle('active', key === tab);
        panels[key].hidden = key !== tab;
      });
    }
    Object.keys(buttons).forEach((key) => buttons[key].addEventListener('click', () => activate(key)));
  }

  function init() {
    cacheElements();
    wireTabs();
    wireTextInputs();
    wireAssetControls();
    renderShotSpecificTabs();
    renderAssetsTab();
  }

  on('shots-changed', () => {
    // The selected shot's id can disappear from under it (delete/merge/split
    // renumbers), in which case fall back to the empty state instead of
    // showing stale data for an id that no longer exists.
    if (selectedShotId !== null && !findSelectedShot()) selectedShotId = null;
    renderShotSpecificTabs();
    // Assign/remove buttons in the Assets tab reflect the selected shot's
    // assetIds, which is exactly what a 'shots-changed' from (un)assigning
    // an asset changes.
    renderAssetsTab();
  });
  on('assets-changed', () => {
    renderAssetsTab();
    renderShotSpecificTabs();
  });
  on('project-loaded', () => {
    selectedShotId = null;
    renderShotSpecificTabs();
  });

  document.addEventListener('DOMContentLoaded', init);

  MSE.context = { selectShot, getSelectedShotId };
})(window.MSE = window.MSE || {});
