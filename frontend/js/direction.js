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

  // Suggestions only (still a free-text field) - keeps speed phrasing within
  // H3's own guide, which favors natural sentences like "at whip-fast speed"
  // over inventing new movement types for things that are really just an
  // existing movement (pan, zoom_in/out) at an extreme speed.
  const SPEED_SUGGESTIONS = [
    'glacial, almost imperceptible',
    'creeping',
    'slow',
    'moderate',
    'brisk',
    'fast',
    'whip-fast, blurring the frame',
    'crash-fast',
    'ramping from slow to fast',
    'ramping from fast to slow',
  ];

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

  // 'absolute' labels grid ticks with the song's own bar.beat (matches the
  // main Shots timeline); 'relative' re-anchors bar 1 beat 1 to this shot's
  // own start, which reads easier when eyeballing a shot's internal beat
  // count in isolation. Persisted since it's a standing viewing preference,
  // not per-shot data.
  const GRID_MODE_KEY = 'cuttalogue.directionGridMode';
  let gridMode = localStorage.getItem(GRID_MODE_KEY) === 'relative' ? 'relative' : 'absolute';

  function setGridMode(mode) {
    gridMode = mode;
    localStorage.setItem(GRID_MODE_KEY, mode);
    renderAll();
  }

  // Segments snap to whichever grid is currently displayed (see the Grid row
  // toggle above) on drag release only - live dragging stays free, same as
  // the main Shots timeline's own snap-on-release convention. Alt inverts
  // the toggle for that one drag, also mirroring the Shots timeline.
  const SNAP_KEY = 'cuttalogue.directionSnap';
  let snapEnabled = localStorage.getItem(SNAP_KEY) !== 'off';

  function setSnapEnabled(v) {
    snapEnabled = v;
    localStorage.setItem(SNAP_KEY, v ? 'on' : 'off');
    updateSnapToggle();
  }

  function updateSnapToggle() {
    if (!el.snapToggle) return;
    el.snapToggle.textContent = snapEnabled ? 'Snap: on' : 'Snap: off';
    el.snapToggle.classList.toggle('active', snapEnabled);
    el.snapToggle.title = 'Toggle snapping segments to the grid on drag release (hold Alt while dragging to invert for one drag)';
  }

  // Shot-relative time (0 = shot start) -> nearest grid line, in the same
  // domain the Grid row ticks are drawn in (absolute song grid or shot-local,
  // per gridMode) - mirrors shots.js's own snapSeconds, but that one only
  // knows the song timeline, not a shot-relative one.
  function snapToDirectionGrid(relativeTime, shot) {
    const tempo = state.tempo;
    const step = MSE.grid.gridStepSeconds(tempo);
    if (!step || step <= 0) return relativeTime;
    const origin = gridMode === 'relative' ? shot.startSeconds : tempo.gridOffsetSeconds;
    const absoluteTime = shot.startSeconds + relativeTime;
    const snappedRel = Math.round((absoluteTime - origin) / step) * step;
    return Math.max(0, origin + snappedRel - shot.startSeconds);
  }

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
    el.segmentContextMenu = document.getElementById('direction-segment-context-menu');
    el.segmentContextDelete = document.getElementById('direction-segment-context-delete');
    el.snapToggle = document.getElementById('direction-snap-toggle');
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

  // H3 always renders a valid stride length (4n+1/8n+1), which is usually a
  // few frames longer than the shot's actual cut point - that trailing pad
  // gets trimmed after render, but H3 still has to generate *something* for
  // it despite nothing in the prompt describing it. Marking it here (instead
  // of only in the shot table) keeps that blind spot visible while directing.
  const OVERHANG_TITLE = 'H3 render padding after this shot’s cut point (see Render column) - nothing here is described by the prompt.';

  // Segment rendering/drag/resize/select mechanics live in laneWidget.js -
  // this builds the opts contract it expects, wiring shots.js's camera/
  // subject move functions and this module's own selection/snap state
  // through to it. See laneWidget.js's buildLaneRow doc comment for the
  // full opts shape.
  function buildLaneRow(label, segments, duration, domainDuration, opts) {
    return MSE.laneWidget.buildLaneRow(label, segments, duration, domainDuration, {
      labelText: (seg) => segmentLabelText(seg, opts),
      isSelected: (index) => isSelected(opts, index),
      moveSegment: (index, timeValue) => (opts.kind === 'camera'
        ? shotsApi.moveCameraSegment(currentShotId, index, timeValue)
        : shotsApi.moveSubjectSegment(currentShotId, opts.assetId, index, timeValue)),
      moveSegmentEdge: (index, side, timeValue) => (opts.kind === 'camera'
        ? shotsApi.moveCameraSegmentEdge(currentShotId, index, side, timeValue)
        : shotsApi.moveSubjectSegmentEdge(currentShotId, opts.assetId, index, side, timeValue)),
      onSelect: (index) => {
        selection = { kind: opts.kind, assetId: opts.assetId, index };
      },
      onCommit: () => shotsApi.notifyDirectionChanged(),
      onClickOnly: () => renderAll(),
      onDeselect: () => {
        selection = null;
        renderAll();
      },
      onAdd: opts.onAdd,
      addTitle: opts.kind === 'camera' ? 'Add camera segment' : 'Add action',
      snapTime: (currentValue, altKey) => {
        const shot = findShot(currentShotId);
        return snapEnabled && !altKey && shot ? snapToDirectionGrid(currentValue, shot) : currentValue;
      },
      datasetAttrs: opts.assetId ? { kind: opts.kind, assetId: opts.assetId } : { kind: opts.kind },
      overhangTitle: OVERHANG_TITLE,
    });
  }

  const MAX_GRID_TICKS = 200;

  // Same bar/beat math as MSE.grid.barBeatAt, but anchored to the shot's own
  // start (bar 1 beat 1 there) instead of the song's grid offset - only used
  // in 'relative' mode.
  function relativeBarBeatAt(timeSeconds, shotStart, tempo) {
    const bd = MSE.grid.beatDuration(tempo.bpm);
    const rel = Math.max(0, timeSeconds - shotStart);
    const totalBeats = Math.round((rel / bd) * 1e6) / 1e6;
    const bar = Math.floor(totalBeats / tempo.numerator) + 1;
    const beat = Math.floor(totalBeats % tempo.numerator) + 1;
    return { bar, beat };
  }

  // Musical grid (from the Tempo panel) reprojected onto the shot's own
  // local 0..duration range, so segments can be dragged/resized against the
  // same bar.beat reference the main Shots timeline snaps to. The row label
  // doubles as a click-to-toggle switch between absolute (song) and relative
  // (shot-local) bar.beat numbering.
  function buildGridRow(shot, duration, domainDuration) {
    const row = document.createElement('div');
    row.className = 'direction-lane-row direction-grid-row';

    const labelEl = document.createElement('div');
    labelEl.className = 'direction-lane-label direction-grid-toggle';
    labelEl.textContent = gridMode === 'relative' ? 'Grid · rel' : 'Grid · abs';
    labelEl.title = 'Click to toggle between absolute (song) and relative (shot-local) bar.beat numbering';
    labelEl.setAttribute('role', 'button');
    labelEl.tabIndex = 0;
    labelEl.addEventListener('click', () => setGridMode(gridMode === 'relative' ? 'absolute' : 'relative'));
    labelEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        labelEl.click();
      }
    });
    row.appendChild(labelEl);

    const content = document.createElement('div');
    content.className = 'direction-lane-content';
    row.appendChild(content);

    const tempo = state.tempo;
    const step = MSE.grid.gridStepSeconds(tempo);
    if (step && step > 0 && domainDuration > 0) {
      const shotStart = shot.startSeconds;
      const shotEnd = shotStart + domainDuration;
      const origin = gridMode === 'relative' ? shotStart : tempo.gridOffsetSeconds;
      const firstStepIndex = Math.ceil((shotStart - origin) / step);
      let ticks = 0;
      for (let i = firstStepIndex; ticks < MAX_GRID_TICKS; i += 1) {
        const t = origin + i * step;
        if (t > shotEnd + 1e-9) break;
        if (t < shotStart - 1e-9) continue;
        ticks += 1;
        const pct = ((t - shotStart) / domainDuration) * 100;
        const { bar, beat } = gridMode === 'relative'
          ? relativeBarBeatAt(t, shotStart, tempo)
          : MSE.grid.barBeatAt(t, tempo);

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

    MSE.laneWidget.appendOverhangBand(content, duration, domainDuration, OVERHANG_TITLE);

    return row;
  }

  function buildBeatRow(shot, allSubjects, duration, domainDuration) {
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
      const pct = domainDuration > 0 ? (t / domainDuration) * 100 : 0;
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

    MSE.laneWidget.appendOverhangBand(content, duration, domainDuration, OVERHANG_TITLE);

    return row;
  }

  function renderLanes(shot) {
    el.lanes.innerHTML = '';
    const duration = shotsApi.shotDuration(shot);
    if (duration <= 0) return;

    // domainDuration extends past the shot's cut point to cover H3's render
    // padding (see frameMath.js) whenever the frame-rule stride demands one -
    // every row is positioned against this same wider span so the padding
    // lines up as one continuous band across all of them.
    const calc = MSE.frames.frameCalc(duration, state.video);
    const domainDuration = duration + calc.overhangSeconds;

    const direction = shot.direction || { camera: [], subjects: {} };

    el.lanes.appendChild(buildGridRow(shot, duration, domainDuration));

    el.lanes.appendChild(
      buildLaneRow('Camera', direction.camera || [], duration, domainDuration, {
        kind: 'camera',
        onAdd: () => {
          const start = MSE.laneWidget.nextSegmentStart(direction.camera || []);
          shotsApi.addCameraSegment(shot.id, { startSeconds: start, endSeconds: duration });
        },
      })
    );

    const allSubjects = MSE.h3Compiler.orderedSubjects(shot);
    const actingSubjects = allSubjects.filter((s) => MSE.h3Compiler.isActingRole(s.role));
    actingSubjects.forEach((s) => {
      const track = (direction.subjects && direction.subjects[s.assetId]) || [];
      el.lanes.appendChild(
        buildLaneRow(s.asset ? MSE.format.stripFileExtension(s.asset.fileName) : s.assetId, track, duration, domainDuration, {
          kind: 'subject',
          assetId: s.assetId,
          onAdd: () => {
            const start = MSE.laneWidget.nextSegmentStart(track);
            shotsApi.addSubjectSegment(shot.id, s.assetId, { startSeconds: start, endSeconds: duration });
          },
        })
      );
    });

    if ((direction.camera || []).length > 0 || actingSubjects.some((s) => ((direction.subjects || {})[s.assetId] || []).length > 0)) {
      el.lanes.appendChild(buildBeatRow(shot, allSubjects, duration, domainDuration));
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
      const speedInput = buildTextInput(
        seg.speed,
        'speed (e.g. slow)',
        (v) => shotsApi.updateCameraSegment(shot.id, selection.index, { speed: v }),
        'direction-text-input direction-speed-input'
      );
      speedInput.setAttribute('list', 'direction-speed-suggestions');
      row.appendChild(speedInput);
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
    el.expandBtn.hidden = true;
  }

  function collapse() {
    el.tabDetailContainer.appendChild(el.lanesRoot);
    el.overlay.hidden = true;
    el.expandBtn.hidden = false;
  }

  // Right-click delete on a segment, same interaction as the main Shots
  // track's context menu - both go through contextMenu.js now. Delegated on
  // el.lanes rather than per-segment so it keeps working across re-renders
  // and the inline<->modal reparent without rewiring.
  function setupSegmentContextMenu() {
    if (!el.segmentContextMenu || !el.segmentContextDelete) return;
    MSE.contextMenu.create({
      container: el.lanes,
      menuEl: el.segmentContextMenu,
      deleteBtn: el.segmentContextDelete,
      resolveTarget: (e) => {
        const segEl = e.target.closest('.lane-segment');
        if (!segEl) return null;
        return {
          kind: segEl.dataset.kind,
          assetId: segEl.dataset.assetId || null,
          index: Number(segEl.dataset.index),
        };
      },
      onDelete: (target) => {
        if (currentShotId === null) return;
        if (selection && selection.kind === target.kind && selection.index === target.index && selection.assetId === target.assetId) {
          selection = null;
        }
        if (target.kind === 'camera') shotsApi.removeCameraSegment(currentShotId, target.index);
        else shotsApi.removeSubjectSegment(currentShotId, target.assetId, target.index);
      },
    });
  }

  function wire() {
    el.snapToggle.addEventListener('click', () => setSnapEnabled(!snapEnabled));
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

    setupSegmentContextMenu();
  }

  function buildSpeedDatalist() {
    const list = document.createElement('datalist');
    list.id = 'direction-speed-suggestions';
    SPEED_SUGGESTIONS.forEach((suggestion) => {
      const opt = document.createElement('option');
      opt.value = suggestion;
      list.appendChild(opt);
    });
    document.body.appendChild(list);
  }

  function init() {
    cacheElements();
    buildSpeedDatalist();
    wire();
    updateSnapToggle();
  }

  document.addEventListener('DOMContentLoaded', init);

  MSE.direction = { expand, collapse };
})(window.MSE = window.MSE || {});
