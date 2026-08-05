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
  function wireSegmentDrag(target, segEl, mode, index, domainDuration, opts) {
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
      const pxPerSecond = content.getBoundingClientRect().width / domainDuration;
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
        segEl.style.left = `${(seg.startSeconds / domainDuration) * 100}%`;
        segEl.style.width = `${Math.max(0, (seg.endSeconds - seg.startSeconds) / domainDuration) * 100}%`;
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

  function buildSegmentEl(seg, index, domainDuration, opts) {
    const segEl = document.createElement('div');
    segEl.className = 'direction-segment';
    segEl.classList.toggle('selected', isSelected(opts, index));
    segEl.style.left = `${(seg.startSeconds / domainDuration) * 100}%`;
    segEl.style.width = `${Math.max(0, (seg.endSeconds - seg.startSeconds) / domainDuration) * 100}%`;
    segEl.textContent = segmentLabelText(seg, opts);
    segEl.title = `${seg.startSeconds.toFixed(2)}s – ${seg.endSeconds.toFixed(2)}s`;
    // Read back by the right-click context menu (setupSegmentContextMenu) to
    // identify which segment was clicked without a separate DOM->data map.
    segEl.dataset.kind = opts.kind;
    if (opts.assetId) segEl.dataset.assetId = opts.assetId;
    segEl.dataset.index = String(index);

    const startHandle = document.createElement('div');
    startHandle.className = 'direction-segment-handle direction-segment-handle-start';
    segEl.appendChild(startHandle);
    const endHandle = document.createElement('div');
    endHandle.className = 'direction-segment-handle direction-segment-handle-end';
    segEl.appendChild(endHandle);

    wireSegmentDrag(segEl, segEl, 'move', index, domainDuration, opts);
    wireSegmentDrag(startHandle, segEl, 'start', index, domainDuration, opts);
    wireSegmentDrag(endHandle, segEl, 'end', index, domainDuration, opts);

    return segEl;
  }

  // duration is the shot's real (cut) duration - segments and the "+" add
  // range never go past it. domainDuration is what 0-100% actually spans
  // (duration, or duration+overhang when there's H3 render padding to show)
  // - every row uses the same domainDuration so ticks/segments/bands all
  // line up across rows.
  function buildLaneRow(label, segments, duration, domainDuration, opts) {
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

    segments.forEach((seg, index) => content.appendChild(buildSegmentEl(seg, index, domainDuration, opts)));

    const lastEnd = nextSegmentStart(segments);
    if (lastEnd < duration - 1e-6) {
      const addEl = document.createElement('div');
      addEl.className = 'direction-segment-add';
      addEl.textContent = '+';
      addEl.title = opts.kind === 'camera' ? 'Add camera segment' : 'Add action';
      addEl.style.left = `${(lastEnd / domainDuration) * 100}%`;
      addEl.style.width = `${((duration - lastEnd) / domainDuration) * 100}%`;
      addEl.addEventListener('click', (e) => {
        e.stopPropagation();
        opts.onAdd();
      });
      content.appendChild(addEl);
    }

    appendOverhangBand(content, duration, domainDuration);

    return row;
  }

  // H3 always renders a valid stride length (4n+1/8n+1), which is usually a
  // few frames longer than the shot's actual cut point - that trailing pad
  // gets trimmed after render, but H3 still has to generate *something* for
  // it despite nothing in the prompt describing it. Marking it here (instead
  // of only in the shot table) keeps that blind spot visible while directing.
  function appendOverhangBand(content, duration, domainDuration) {
    if (domainDuration <= duration + 1e-6) return;
    const band = document.createElement('div');
    band.className = 'direction-overhang-band';
    band.style.left = `${(duration / domainDuration) * 100}%`;
    band.style.width = `${((domainDuration - duration) / domainDuration) * 100}%`;
    band.title = 'H3 render padding after this shot’s cut point (see Render column) - nothing here is described by the prompt.';
    content.appendChild(band);
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

    appendOverhangBand(content, duration, domainDuration);

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

    appendOverhangBand(content, duration, domainDuration);

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
        buildLaneRow(s.asset ? MSE.format.stripFileExtension(s.asset.fileName) : s.assetId, track, duration, domainDuration, {
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
  // track's context menu (waveformSync.js setupShotContextMenu). Delegated
  // on el.lanes rather than per-segment so it keeps working across
  // re-renders and the inline<->modal reparent without rewiring.
  function setupSegmentContextMenu() {
    const menu = el.segmentContextMenu;
    const deleteBtn = el.segmentContextDelete;
    if (!menu || !deleteBtn) return;
    let target = null;

    function hideMenu() {
      menu.style.display = 'none';
      target = null;
    }

    el.lanes.addEventListener('contextmenu', (e) => {
      const segEl = e.target.closest('.direction-segment');
      if (!segEl) {
        hideMenu();
        return;
      }
      e.preventDefault();
      target = {
        kind: segEl.dataset.kind,
        assetId: segEl.dataset.assetId || null,
        index: Number(segEl.dataset.index),
      };
      menu.style.left = `${e.clientX}px`;
      menu.style.top = `${e.clientY}px`;
      menu.style.display = 'block';
    });

    deleteBtn.addEventListener('click', () => {
      if (target && currentShotId !== null) {
        if (selection && selection.kind === target.kind && selection.index === target.index && selection.assetId === target.assetId) {
          selection = null;
        }
        if (target.kind === 'camera') shotsApi.removeCameraSegment(currentShotId, target.index);
        else shotsApi.removeSubjectSegment(currentShotId, target.assetId, target.index);
      }
      hideMenu();
    });

    document.addEventListener('pointerdown', (e) => {
      if (menu.style.display !== 'none' && !menu.contains(e.target)) hideMenu();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') hideMenu();
    });
    window.addEventListener('scroll', hideMenu, true);
    on('shots-changed', hideMenu);
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
  }

  document.addEventListener('DOMContentLoaded', init);

  MSE.direction = { expand, collapse };
})(window.MSE = window.MSE || {});
