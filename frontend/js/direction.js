// Phase B/C of docs/h3-shot-direction-roadmap.md: direct a shot's already-cast
// subjects (casting itself happens in the Cast & Locations tab - see
// contextPanel.js) on lane-based mini-timelines (Camera + one lane per acting
// subject) scoped to the shot's own duration - draggable/resizable segments,
// not a form of number inputs. Renders inline in the Direction tab; an expand
// button moves the same live DOM subtree into a big modal for more room, no
// separate render path.
(function (MSE) {
  'use strict';

  const { state, on } = MSE.state;
  const shotsApi = MSE.shots;

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
  // { kind: 'camera'|'subject', assetId?, index } - which segment's fields
  // show in the detail panel below the lanes. Cleared whenever the segment
  // it points at might no longer exist (shot switch, remove, project load).
  let selection = null;

  function cacheElements() {
    el.lanesRoot = document.getElementById('direction-lanes-root');
    el.tabDetailContainer = document.getElementById('direction-tab-detail');
    el.expandBtn = document.getElementById('direction-expand-btn');
    el.overlay = document.getElementById('direction-modal');
    el.modalTitle = document.getElementById('direction-modal-title');
    el.modalBody = document.getElementById('direction-modal-body');
    el.closeBtn = document.getElementById('direction-close-btn');
    el.lanes = document.getElementById('direction-lanes');
    el.segmentDetail = document.getElementById('direction-segment-detail');
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

  function nextSegmentStart(segments) {
    if (!segments.length) return 0;
    return Math.max(...segments.map((s) => s.endSeconds));
  }

  function isSelected(opts, index) {
    return !!selection
      && selection.kind === opts.kind
      && selection.index === index
      && (opts.kind !== 'subject' || selection.assetId === opts.assetId);
  }

  function segmentLabelText(seg, opts) {
    if (opts.kind === 'camera') return MOVEMENT_LABELS[seg.movement] || seg.movement || 'Camera';
    return seg.action || 'Action';
  }

  // Pointerdown drives both click-to-select and drag: a `moved` flag (set
  // once the pointer has actually traveled a few px) decides on pointerup
  // whether this was a click (just select, no data change, no emit) or a
  // real drag (commit via notifyDirectionChanged - a single emit at the end,
  // never on every move, or the lane DOM would be rebuilt out from under the
  // drag in progress, same class of bug already fixed once for the shot
  // list's dblclick).
  function wireSegmentDrag(target, segEl, mode, index, duration, opts) {
    target.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      const shot = findShot(currentShotId);
      if (!shot) return;
      const segments = opts.kind === 'camera' ? shot.direction.camera : shot.direction.subjects[opts.assetId];
      const seg = segments[index];
      if (!seg) return;
      // segEl is always the segment element itself (not the handle that may
      // have triggered this), so its parent is reliably the lane content.
      const content = segEl.parentElement;
      const pxPerSecond = content.getBoundingClientRect().width / duration;
      const startX = e.clientX;
      const startStart = seg.startSeconds;
      const startEnd = seg.endSeconds;
      let moved = false;

      function onMove(ev) {
        const dx = ev.clientX - startX;
        if (!moved && Math.abs(dx) < 3) return;
        moved = true;
        const deltaSeconds = dx / pxPerSecond;
        let clamped;
        if (mode === 'move') {
          clamped = opts.kind === 'camera'
            ? shotsApi.moveCameraSegment(shot.id, index, startStart + deltaSeconds)
            : shotsApi.moveSubjectSegment(shot.id, opts.assetId, index, startStart + deltaSeconds);
        } else {
          const targetTime = (mode === 'start' ? startStart : startEnd) + deltaSeconds;
          clamped = opts.kind === 'camera'
            ? shotsApi.moveCameraSegmentEdge(shot.id, index, mode, targetTime)
            : shotsApi.moveSubjectSegmentEdge(shot.id, opts.assetId, index, mode, targetTime);
        }
        if (clamped === null) return;
        // seg is the live array element both move* functions mutated in
        // place, so both edges already reflect the clamped result here.
        segEl.style.left = `${(seg.startSeconds / duration) * 100}%`;
        segEl.style.width = `${Math.max(0, (seg.endSeconds - seg.startSeconds) / duration) * 100}%`;
      }
      function onUp() {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        selection = { kind: opts.kind, assetId: opts.assetId, index };
        if (moved) shotsApi.notifyDirectionChanged();
        else renderAll();
      }
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
    });
  }

  function buildSegmentEl(seg, index, duration, opts) {
    const segEl = document.createElement('div');
    segEl.className = 'direction-segment';
    segEl.classList.toggle('selected', isSelected(opts, index));
    segEl.style.left = `${(seg.startSeconds / duration) * 100}%`;
    segEl.style.width = `${Math.max(0, (seg.endSeconds - seg.startSeconds) / duration) * 100}%`;
    segEl.textContent = segmentLabelText(seg, opts);
    segEl.title = `${seg.startSeconds.toFixed(2)}s – ${seg.endSeconds.toFixed(2)}s`;

    const startHandle = document.createElement('div');
    startHandle.className = 'direction-segment-handle direction-segment-handle-start';
    segEl.appendChild(startHandle);
    const endHandle = document.createElement('div');
    endHandle.className = 'direction-segment-handle direction-segment-handle-end';
    segEl.appendChild(endHandle);

    wireSegmentDrag(segEl, segEl, 'move', index, duration, opts);
    wireSegmentDrag(startHandle, segEl, 'start', index, duration, opts);
    wireSegmentDrag(endHandle, segEl, 'end', index, duration, opts);

    return segEl;
  }

  function buildLaneRow(label, segments, duration, opts) {
    const row = document.createElement('div');
    row.className = 'direction-lane-row';

    const labelEl = document.createElement('div');
    labelEl.className = 'direction-lane-label';
    labelEl.textContent = label;
    labelEl.title = label;
    row.appendChild(labelEl);

    const content = document.createElement('div');
    content.className = 'direction-lane-content';
    content.addEventListener('pointerdown', (e) => {
      if (e.target !== content) return;
      selection = null;
      renderAll();
    });
    row.appendChild(content);

    segments.forEach((seg, index) => content.appendChild(buildSegmentEl(seg, index, duration, opts)));

    const lastEnd = nextSegmentStart(segments);
    if (lastEnd < duration - 1e-6) {
      const addEl = document.createElement('div');
      addEl.className = 'direction-segment-add';
      addEl.textContent = '+';
      addEl.title = opts.kind === 'camera' ? 'Add camera segment' : 'Add action';
      addEl.style.left = `${(lastEnd / duration) * 100}%`;
      addEl.style.width = `${((duration - lastEnd) / duration) * 100}%`;
      addEl.addEventListener('click', (e) => {
        e.stopPropagation();
        opts.onAdd();
      });
      content.appendChild(addEl);
    }

    return row;
  }

  const MAX_GRID_TICKS = 200;

  // Musical grid (from the Tempo panel) reprojected onto the shot's own
  // local 0..duration range, so segments can be dragged/resized against the
  // same bar.beat reference the main Shots timeline snaps to.
  function buildGridRow(shot, duration) {
    const row = document.createElement('div');
    row.className = 'direction-lane-row direction-grid-row';

    const labelEl = document.createElement('div');
    labelEl.className = 'direction-lane-label';
    labelEl.textContent = 'Grid';
    labelEl.title = 'Musical grid (bar.beat) for this shot’s time range';
    row.appendChild(labelEl);

    const content = document.createElement('div');
    content.className = 'direction-lane-content';
    row.appendChild(content);

    const tempo = state.tempo;
    const step = MSE.grid.gridStepSeconds(tempo);
    if (step && step > 0 && duration > 0) {
      const shotStart = shot.startSeconds;
      const shotEnd = shotStart + duration;
      const firstStepIndex = Math.ceil((shotStart - tempo.gridOffsetSeconds) / step);
      let ticks = 0;
      for (let i = firstStepIndex; ticks < MAX_GRID_TICKS; i += 1) {
        const t = tempo.gridOffsetSeconds + i * step;
        if (t > shotEnd + 1e-9) break;
        ticks += 1;
        const pct = ((t - shotStart) / duration) * 100;
        const { bar, beat } = MSE.grid.barBeatAt(t, tempo);

        const tick = document.createElement('div');
        tick.className = 'direction-grid-tick';
        tick.classList.toggle('bar-start', beat === 1);
        tick.style.left = `${pct}%`;
        content.appendChild(tick);

        const label = document.createElement('div');
        label.className = 'direction-grid-label';
        label.style.left = `${pct}%`;
        label.textContent = `${bar}.${beat}`;
        content.appendChild(label);
      }
    }

    return row;
  }

  function buildBeatRow(shot, allSubjects, duration) {
    const row = document.createElement('div');
    row.className = 'direction-lane-row direction-beat-row';

    const labelEl = document.createElement('div');
    labelEl.className = 'direction-lane-label';
    labelEl.textContent = 'Beats';
    labelEl.title = 'Preview of the semantic beats the compiler will actually generate';
    row.appendChild(labelEl);

    const content = document.createElement('div');
    content.className = 'direction-lane-content';
    row.appendChild(content);

    MSE.h3Compiler.collectBeatBoundaries(shot, allSubjects).forEach((t) => {
      const pct = duration > 0 ? (t / duration) * 100 : 0;
      const tick = document.createElement('div');
      tick.className = 'direction-beat-tick';
      tick.style.left = `${pct}%`;
      content.appendChild(tick);

      const tickLabel = document.createElement('div');
      tickLabel.className = 'direction-beat-label';
      tickLabel.style.left = `${pct}%`;
      tickLabel.textContent = `${t.toFixed(1)}s`;
      content.appendChild(tickLabel);
    });

    return row;
  }

  function renderLanes(shot) {
    el.lanes.innerHTML = '';
    const duration = shotsApi.shotDuration(shot);
    if (duration <= 0) return;

    const direction = shot.direction || { camera: [], subjects: {} };

    el.lanes.appendChild(buildGridRow(shot, duration));

    el.lanes.appendChild(
      buildLaneRow('Camera', direction.camera || [], duration, {
        kind: 'camera',
        onAdd: () => {
          const start = nextSegmentStart(direction.camera || []);
          shotsApi.addCameraSegment(shot.id, { startSeconds: start, endSeconds: duration });
        },
      })
    );

    const allSubjects = MSE.h3Compiler.orderedSubjects(shot);
    const actingSubjects = allSubjects.filter((s) => MSE.h3Compiler.isActingRole(s.role));
    actingSubjects.forEach((s) => {
      const track = (direction.subjects && direction.subjects[s.assetId]) || [];
      el.lanes.appendChild(
        buildLaneRow(s.asset ? MSE.format.stripFileExtension(s.asset.fileName) : s.assetId, track, duration, {
          kind: 'subject',
          assetId: s.assetId,
          onAdd: () => {
            const start = nextSegmentStart(track);
            shotsApi.addSubjectSegment(shot.id, s.assetId, { startSeconds: start, endSeconds: duration });
          },
        })
      );
    });

    if ((direction.camera || []).length > 0 || actingSubjects.some((s) => ((direction.subjects || {})[s.assetId] || []).length > 0)) {
      el.lanes.appendChild(buildBeatRow(shot, allSubjects, duration));
    }
  }

  function renderSegmentDetail(shot) {
    el.segmentDetail.innerHTML = '';
    if (!selection) {
      el.segmentDetail.hidden = true;
      return;
    }
    const segments = selection.kind === 'camera'
      ? (shot.direction.camera || [])
      : ((shot.direction.subjects && shot.direction.subjects[selection.assetId]) || []);
    const seg = segments[selection.index];
    if (!seg) {
      selection = null;
      el.segmentDetail.hidden = true;
      return;
    }
    el.segmentDetail.hidden = false;

    const header = document.createElement('div');
    header.className = 'direction-segment-detail-header';
    const timeLabel = document.createElement('span');
    timeLabel.textContent = `${seg.startSeconds.toFixed(2)}s – ${seg.endSeconds.toFixed(2)}s`;
    header.appendChild(timeLabel);
    header.appendChild(
      buildRemoveButton(() => {
        if (selection.kind === 'camera') shotsApi.removeCameraSegment(shot.id, selection.index);
        else shotsApi.removeSubjectSegment(shot.id, selection.assetId, selection.index);
        selection = null;
      })
    );
    el.segmentDetail.appendChild(header);

    const row = document.createElement('div');
    row.className = 'direction-row';
    if (selection.kind === 'camera') {
      const movementOptions = shotsApi.CAMERA_MOVEMENTS.map((m) => [m, MOVEMENT_LABELS[m] || m]);
      row.appendChild(buildSelect(movementOptions, seg.movement, (v) => shotsApi.updateCameraSegment(shot.id, selection.index, { movement: v })));
      row.appendChild(buildTextInput(seg.framing, 'framing (e.g. medium-wide)', (v) => shotsApi.updateCameraSegment(shot.id, selection.index, { framing: v })));
      row.appendChild(
        buildTextInput(
          seg.speed,
          'speed (e.g. slow)',
          (v) => shotsApi.updateCameraSegment(shot.id, selection.index, { speed: v }),
          'direction-text-input direction-speed-input'
        )
      );
    } else {
      row.appendChild(
        buildTextInput(
          seg.action,
          'action...',
          (v) => shotsApi.updateSubjectSegment(shot.id, selection.assetId, selection.index, { action: v }),
          'direction-text-input direction-action-input'
        )
      );
    }
    el.segmentDetail.appendChild(row);
  }

  function renderAll() {
    const shot = findShot(currentShotId);
    if (!shot) return;
    el.modalTitle.textContent = `Direction — Shot #${shot.id}`;
    renderLanes(shot);
    renderSegmentDetail(shot);
  }

  // Percentage-based segment positioning means the same live DOM subtree
  // just reflows correctly at whatever width its new parent gives it - no
  // re-render needed on expand/collapse, only a reparent.
  function expand() {
    el.modalBody.appendChild(el.lanesRoot);
    el.overlay.hidden = false;
  }

  function collapse() {
    el.tabDetailContainer.appendChild(el.lanesRoot);
    el.overlay.hidden = true;
  }

  function wire() {
    el.expandBtn.addEventListener('click', expand);
    el.closeBtn.addEventListener('click', collapse);
    el.overlay.addEventListener('click', (e) => {
      if (e.target === el.overlay) collapse();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !el.overlay.hidden) collapse();
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

    on('shot-selected', () => {
      const shot = selectedShot();
      currentShotId = shot ? shot.id : null;
      selection = null;
      el.compileStatus.textContent = '';
      renderAll();
    });
    on('shots-changed', () => {
      if (currentShotId !== null && !findShot(currentShotId)) {
        currentShotId = null;
        selection = null;
      }
      renderAll();
    });
    on('project-loaded', () => {
      currentShotId = null;
      selection = null;
    });
  }

  function init() {
    cacheElements();
    wire();
  }

  document.addEventListener('DOMContentLoaded', init);

  MSE.direction = { expand, collapse };
})(window.MSE = window.MSE || {});
