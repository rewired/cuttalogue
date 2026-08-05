// Context panel: [Cast & Locations] / [Direction] / [Prompt] / [Notes] tabs
// on the right of the shot list. Owns the transient (non-persisted)
// selected-shot id and renders that shot's readouts plus its editable
// prompt/notes fields, which live on the shot itself and round-trip through
// the project JSON.
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

    el.assetsTabEmpty = document.getElementById('assets-tab-empty');
    el.assetsTabDetail = document.getElementById('assets-tab-detail');
    el.directionEmpty = document.getElementById('direction-tab-empty');
    el.directionDetail = document.getElementById('direction-tab-detail');
    el.promptEmpty = document.getElementById('prompt-tab-empty');
    el.promptDetail = document.getElementById('prompt-tab-detail');
    el.notesEmpty = document.getElementById('notes-tab-empty');
    el.notesDetail = document.getElementById('notes-tab-detail');

    el.prompt = document.getElementById('shot-detail-prompt');
    el.notes = document.getElementById('shot-detail-notes');
    el.assignedAssets = document.getElementById('shot-detail-assets');
  }

  function findSelectedShot() {
    return state.shots.find((s) => s.id === selectedShotId) || null;
  }

  // Cast & Locations/Direction/Prompt/Notes only make sense for a selected
  // shot, so each tab toggles its own empty-hint vs detail content the same
  // way the old single Shot tab used to as a whole.
  function renderShotSpecificTabs() {
    const shot = findSelectedShot();
    const hasShot = !!shot;

    el.assetsTabEmpty.style.display = hasShot ? 'none' : '';
    el.assetsTabDetail.style.display = hasShot ? '' : 'none';
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

  // Assigned assets render as thumbnail cards - this is also where an
  // asset's H3 role for THIS shot gets picked (only images have one; casting
  // is a per-shot fact, unlike an asset's kind which is fixed everywhere -
  // see assets.js). Adding happens via the trailing "+" tile, which opens
  // the asset picker modal (assetPicker.js); removing stays right here via
  // each card's own x.
  function renderAssignedAssets() {
    const shot = findSelectedShot();
    el.assignedAssets.innerHTML = '';
    if (!shot) return;

    MSE.assets.assetsForShot(shot).forEach((asset) => {
      const card = document.createElement('div');
      card.className = 'asset-card assigned-asset-card';

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'assigned-asset-remove';
      removeBtn.textContent = '×';
      removeBtn.title = 'Remove from this shot';
      removeBtn.addEventListener('click', () => MSE.assets.removeAssetFromShot(shot.id, asset.id));
      card.appendChild(removeBtn);

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
      name.textContent = MSE.format.stripFileExtension(asset.fileName);
      card.appendChild(name);

      if (asset.type === 'image') {
        const options = MSE.assets.roleOptionsFor(asset.kind);
        if (options) {
          const currentRole = (shot.assetRoles || {})[asset.id] || '';
          const select = document.createElement('select');
          select.className = 'assigned-asset-role-select';
          options.forEach(([value, label]) => {
            const opt = document.createElement('option');
            opt.value = value;
            opt.textContent = label;
            opt.selected = value === currentRole;
            select.appendChild(opt);
          });
          select.addEventListener('change', () => shotsApi.setAssetRole(shot.id, asset.id, select.value || null));
          card.appendChild(select);
        } else {
          // Shouldn't normally happen - the picker blocks assigning an
          // unclassified asset - but projects saved before classification
          // existed can still have one here, so this stays a safe fallback.
          const note = document.createElement('div');
          note.className = 'asset-tags-readout asset-kind-warning';
          note.textContent = 'Not classified';
          card.appendChild(note);
        }
      }

      el.assignedAssets.appendChild(card);
    });

    const addCard = document.createElement('button');
    addCard.type = 'button';
    addCard.className = 'asset-card assigned-asset-add-card';
    addCard.title = 'Assign an asset to this shot';
    addCard.textContent = '+';
    addCard.addEventListener('click', () => MSE.assetPicker.open(shot.id));
    el.assignedAssets.appendChild(addCard);
  }

  function selectShot(shotId) {
    selectedShotId = shotId;
    renderShotSpecificTabs();
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
    renderShotSpecificTabs();
  }

  on('shots-changed', () => {
    // The selected shot's id can disappear from under it (delete/merge/split
    // renumbers), in which case fall back to the empty state instead of
    // showing stale data for an id that no longer exists.
    if (selectedShotId !== null && !findSelectedShot()) selectedShotId = null;
    renderShotSpecificTabs();
  });
  on('assets-changed', () => renderShotSpecificTabs());
  on('project-loaded', () => {
    selectedShotId = null;
    renderShotSpecificTabs();
  });

  document.addEventListener('DOMContentLoaded', init);

  MSE.context = { selectShot, getSelectedShotId };
})(window.MSE = window.MSE || {});
