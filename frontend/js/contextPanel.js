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

  // Assigned assets render as chips (unchanged), plus a trailing "+" chip
  // that opens the asset picker modal (assetPicker.js) - the only way to
  // add an asset from here now. Picking happens there; removing still
  // happens right here via each chip's own x, same as before.
  function renderAssignedAssets() {
    const shot = findSelectedShot();
    el.assignedAssets.innerHTML = '';
    if (!shot) return;

    MSE.assets.assetsForShot(shot).forEach((asset) => {
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

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'assigned-asset-chip assigned-asset-add-btn';
    addBtn.textContent = '+';
    addBtn.title = 'Assign an asset to this shot';
    addBtn.addEventListener('click', () => MSE.assetPicker.open(shot.id));
    el.assignedAssets.appendChild(addBtn);
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
