// Phase B/C of docs/h3-shot-direction-roadmap.md: the "Direction" modal where
// a shot's assigned assets get cast into H3 subject roles, plus camera and
// per-subject action tracks the deterministic compiler (below) turns into a
// structured H3 prompt. List-based add/edit/remove rows, not a drag timeline -
// the fine-grained authoring these tracks need doesn't require pixel-precise
// dragging to be useful, and it keeps this module simple.
(function (MSE) {
  'use strict';

  const { state, on } = MSE.state;
  const shotsApi = MSE.shots;

  // What role an asset CAN play is fixed by its kind (assets.js) - a location
  // can never become a character mid-project. What's still a per-shot choice
  // is whether a character is the lead or supporting in THIS particular shot,
  // which is genuinely variable from shot to shot.
  function roleOptionsFor(kind) {
    if (kind === 'character') {
      return [
        ['', 'No role'],
        ['primary_character', 'Primary character'],
        ['supporting_character', 'Supporting character'],
      ];
    }
    if (kind === 'location') {
      return [
        ['', 'Not cast'],
        ['environment', 'Environment / location'],
      ];
    }
    if (kind === 'prop') {
      return [
        ['', 'Not cast'],
        ['prop', 'Prop'],
      ];
    }
    return null;
  }

  const MOVEMENT_LABELS = {
    zoom_in: 'Zoom in',
    zoom_out: 'Zoom out',
    push_in: 'Push in',
    pull_out: 'Pull out',
    pan: 'Pan',
    truck: 'Truck',
    tracking_shot: 'Tracking shot',
    arc_shot: 'Arc shot',
    static_shot: 'Static shot',
  };

  const el = {};
  let currentShotId = null;

  function cacheElements() {
    el.summary = document.getElementById('direction-summary');
    el.openBtn = document.getElementById('open-direction-btn');
    el.overlay = document.getElementById('direction-modal');
    el.title = document.getElementById('direction-modal-title');
    el.closeBtn = document.getElementById('direction-close-btn');
    el.castEmpty = document.getElementById('direction-cast-empty');
    el.castList = document.getElementById('direction-cast-list');
    el.cameraList = document.getElementById('direction-camera-list');
    el.addCameraBtn = document.getElementById('direction-add-camera-btn');
    el.subjectsContainer = document.getElementById('direction-subjects-container');
    el.compileBtn = document.getElementById('direction-compile-btn');
    el.compileStatus = document.getElementById('direction-compile-status');
  }

  function findShot(shotId) {
    return state.shots.find((s) => s.id === shotId) || null;
  }

  function selectedShot() {
    const shotId = MSE.context ? MSE.context.getSelectedShotId() : null;
    return shotId !== null ? findShot(shotId) : null;
  }

  function updateSummary() {
    const shot = selectedShot();
    if (!shot) {
      el.summary.textContent = '';
      el.openBtn.disabled = true;
      return;
    }
    el.openBtn.disabled = false;
    const direction = shot.direction || { camera: [], subjects: {} };
    const castCount = Object.keys(shot.assetRoles || {}).length;
    const cameraCount = (direction.camera || []).length;
    const actionCount = Object.values(direction.subjects || {}).reduce((sum, list) => sum + list.length, 0);
    el.summary.textContent =
      castCount === 0 && cameraCount === 0 && actionCount === 0
        ? 'Not set up yet.'
        : `${castCount} cast, ${cameraCount} camera segment${cameraCount === 1 ? '' : 's'}, ${actionCount} action${actionCount === 1 ? '' : 's'}.`;
  }

  function buildSelect(options, value, onChange) {
    const select = document.createElement('select');
    options.forEach(([optValue, label]) => {
      const opt = document.createElement('option');
      opt.value = optValue;
      opt.textContent = label;
      if (optValue === value) opt.selected = true;
      select.appendChild(opt);
    });
    select.addEventListener('change', () => onChange(select.value));
    return select;
  }

  function buildNumberInput(value, onChange) {
    const input = document.createElement('input');
    input.type = 'number';
    input.step = '0.1';
    input.min = '0';
    input.className = 'direction-number-input';
    input.value = value;
    input.addEventListener('change', () => onChange(Number(input.value) || 0));
    return input;
  }

  function buildTextInput(value, placeholder, onChange, className) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = className || 'direction-text-input';
    input.placeholder = placeholder || '';
    input.value = value || '';
    input.addEventListener('change', () => onChange(input.value));
    return input;
  }

  function buildRemoveButton(onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'direction-remove-btn';
    btn.textContent = '×';
    btn.title = 'Remove';
    btn.addEventListener('click', onClick);
    return btn;
  }

  function renderCast(shot) {
    el.castList.innerHTML = '';
    // Only images can be H3 subjects - audio/video assets (fullmix, lip-sync,
    // motionguide) are assigned to the shot for reference but never cast.
    const assigned = MSE.assets.assetsForShot(shot).filter((a) => a.type === 'image');
    el.castEmpty.style.display = assigned.length === 0 ? '' : 'none';
    assigned.forEach((asset) => {
      const row = document.createElement('div');
      row.className = 'direction-row direction-cast-row';

      const name = document.createElement('span');
      name.className = 'direction-cast-name';
      name.textContent = asset.fileName;
      row.appendChild(name);

      const options = roleOptionsFor(asset.kind);
      if (!options) {
        // Shouldn't normally happen - assigning to a shot is blocked until an
        // asset is classified - but old projects can have assetIds that
        // predate this feature, so this stays a safe fallback, not a crash.
        const note = document.createElement('span');
        note.className = 'placeholder-hint';
        note.textContent = 'Not classified - set this in the Asset library.';
        row.appendChild(note);
      } else {
        const currentRole = (shot.assetRoles || {})[asset.id] || '';
        const select = buildSelect(options, currentRole, (value) => shotsApi.setAssetRole(shot.id, asset.id, value || null));
        row.appendChild(select);
      }

      el.castList.appendChild(row);
    });
  }

  function renderCamera(shot) {
    el.cameraList.innerHTML = '';
    const segments = (shot.direction && shot.direction.camera) || [];
    segments.forEach((seg, index) => {
      const row = document.createElement('div');
      row.className = 'direction-row direction-camera-row';

      row.appendChild(
        buildNumberInput(seg.startSeconds, (v) => shotsApi.updateCameraSegment(shot.id, index, { startSeconds: v }))
      );
      const dash = document.createElement('span');
      dash.textContent = '–';
      row.appendChild(dash);
      row.appendChild(
        buildNumberInput(seg.endSeconds, (v) => shotsApi.updateCameraSegment(shot.id, index, { endSeconds: v }))
      );

      const movementOptions = shotsApi.CAMERA_MOVEMENTS.map((m) => [m, MOVEMENT_LABELS[m] || m]);
      row.appendChild(buildSelect(movementOptions, seg.movement, (v) => shotsApi.updateCameraSegment(shot.id, index, { movement: v })));

      row.appendChild(
        buildTextInput(seg.framing, 'framing (e.g. medium-wide)', (v) => shotsApi.updateCameraSegment(shot.id, index, { framing: v }))
      );
      row.appendChild(
        buildTextInput(
          seg.speed,
          'speed (e.g. slow)',
          (v) => shotsApi.updateCameraSegment(shot.id, index, { speed: v }),
          'direction-text-input direction-speed-input'
        )
      );

      row.appendChild(buildRemoveButton(() => shotsApi.removeCameraSegment(shot.id, index)));

      el.cameraList.appendChild(row);
    });
  }

  function nextSegmentStart(segments) {
    if (!segments.length) return 0;
    return Math.max(...segments.map((s) => s.endSeconds));
  }

  function renderSubjects(shot) {
    el.subjectsContainer.innerHTML = '';
    const roles = shot.assetRoles || {};
    const actingAssetIds = Object.keys(roles).filter(
      (id) => roles[id] === 'primary_character' || roles[id] === 'supporting_character'
    );
    if (actingAssetIds.length === 0) return;

    const duration = shotsApi.shotDuration(shot);

    actingAssetIds.forEach((assetId) => {
      const asset = MSE.assets.findAsset(assetId);
      const heading = document.createElement('h3');
      heading.textContent = `Actions: ${asset ? asset.fileName : assetId}`;
      el.subjectsContainer.appendChild(heading);

      const list = document.createElement('div');
      list.className = 'direction-list';
      const segments = (shot.direction.subjects && shot.direction.subjects[assetId]) || [];
      segments.forEach((seg, index) => {
        const row = document.createElement('div');
        row.className = 'direction-row direction-subject-row';

        row.appendChild(
          buildNumberInput(seg.startSeconds, (v) => shotsApi.updateSubjectSegment(shot.id, assetId, index, { startSeconds: v }))
        );
        const dash = document.createElement('span');
        dash.textContent = '–';
        row.appendChild(dash);
        row.appendChild(
          buildNumberInput(seg.endSeconds, (v) => shotsApi.updateSubjectSegment(shot.id, assetId, index, { endSeconds: v }))
        );

        row.appendChild(
          buildTextInput(
            seg.action,
            'action...',
            (v) => shotsApi.updateSubjectSegment(shot.id, assetId, index, { action: v }),
            'direction-text-input direction-action-input'
          )
        );

        row.appendChild(buildRemoveButton(() => shotsApi.removeSubjectSegment(shot.id, assetId, index)));

        list.appendChild(row);
      });
      el.subjectsContainer.appendChild(list);

      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.textContent = '+ Add action';
      addBtn.addEventListener('click', () => {
        const start = nextSegmentStart(segments);
        shotsApi.addSubjectSegment(shot.id, assetId, { startSeconds: start, endSeconds: duration, action: '' });
      });
      el.subjectsContainer.appendChild(addBtn);
    });
  }

  function renderAll() {
    const shot = findShot(currentShotId);
    if (!shot) return;
    el.title.textContent = `Direction — Shot #${shot.id}`;
    renderCast(shot);
    renderCamera(shot);
    renderSubjects(shot);
  }

  function openModal() {
    const shot = selectedShot();
    if (!shot) return;
    currentShotId = shot.id;
    el.compileStatus.textContent = '';
    renderAll();
    el.overlay.hidden = false;
  }

  function closeModal() {
    el.overlay.hidden = true;
    currentShotId = null;
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

    el.addCameraBtn.addEventListener('click', () => {
      const shot = findShot(currentShotId);
      if (!shot) return;
      const segments = (shot.direction && shot.direction.camera) || [];
      const start = nextSegmentStart(segments);
      shotsApi.addCameraSegment(shot.id, { startSeconds: start, endSeconds: shotsApi.shotDuration(shot) });
    });

    // Explicit, one-shot action - never runs on save or automatically. Writes
    // into the same prompt field the user can otherwise type into directly,
    // exactly like [Describe image] does for asset descriptions.
    el.compileBtn.addEventListener('click', () => {
      const shot = findShot(currentShotId);
      if (!shot) return;
      const text = MSE.h3Compiler.compileH3Prompt(shot);
      shotsApi.setShotPrompt(shot.id, text);
      const nearLimit = text.length > 6000 ? ' - getting close to the 7,000-character API limit' : '';
      el.compileStatus.textContent = `Compiled (${text.length} characters)${nearLimit}.`;
    });

    on('shot-selected', updateSummary);
    on('shots-changed', () => {
      updateSummary();
      if (!el.overlay.hidden) renderAll();
    });
  }

  function init() {
    cacheElements();
    wire();
    updateSummary();
  }

  document.addEventListener('DOMContentLoaded', init);

  MSE.direction = { openModal, closeModal };
})(window.MSE = window.MSE || {});
