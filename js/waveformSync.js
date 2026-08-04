// Creates and synchronizes four WaveSurfer instances (Grid, Shots, Mix, Vocal):
// shared zoom, shared scroll, shared playhead, unified seeking, A/B playback
// switching, and the Timeline/Regions/Hover plugin wiring.
(function (MSE) {
  'use strict';

  const { state, emit, on } = MSE.state;
  const { gridStepSeconds, barDuration, barBeatAt, snapToGrid } = MSE.grid;
  const { formatTime } = MSE.format;
  const { frameCalc, fps } = MSE.frames;
  const shotsApi = MSE.shots;
  const silenceApi = MSE.silence;

  const WS = window.WaveSurfer;

  const STATUS_COLOR = {
    valid: 'rgba(76, 175, 80, 0.35)',
    short: 'rgba(255, 193, 7, 0.4)',
    long: 'rgba(244, 67, 54, 0.4)',
  };

  let gridWs = null;
  let shotsWs = null;
  let mixWs = null;
  let vocalWs = null;
  let regionsPlugin = null;
  let timelinePlugin = null;

  let pxPerSecond = 80;
  let isSyncingScroll = false;
  let isSyncingTime = false;
  let vocalSilenceGaps = [];

  // Holding Alt during a shot create/resize drag bypasses the selected grid
  // snap for that one drag. The Regions plugin's update-end event doesn't carry
  // modifier-key state, so it's tracked independently here.
  let altHeld = false;
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Alt') altHeld = true;
  });
  document.addEventListener('keyup', (e) => {
    if (e.key === 'Alt') altHeld = false;
  });
  window.addEventListener('blur', () => {
    altHeld = false;
  });

  const els = {};

  function cacheElements() {
    els.gridContainer = document.getElementById('track-grid');
    els.shotsContainer = document.getElementById('track-shots');
    els.mixContainer = document.getElementById('track-mix');
    els.vocalContainer = document.getElementById('track-vocal');
    els.silenceLayer = document.getElementById('silence-layer');
    els.playhead = document.getElementById('current-time-readout');
  }

  function frameAtTime(seconds) {
    return Math.round(seconds * fps(state.video));
  }

  function hoverLabel(seconds) {
    const { bar, beat } = barBeatAt(seconds, state.tempo);
    return `${formatTime(seconds)} · F${frameAtTime(seconds)} · B${bar}.${beat}`;
  }

  // 'second'/'frame' are grid divisions that depend on video state, not tempo, so
  // musicalGrid.js (deliberately tempo/bar-only) doesn't know about them - resolve
  // them here instead.
  function currentGridStepSeconds() {
    const division = state.tempo.gridDivision;
    if (division === 'second') return 1;
    if (division === 'frame') return 1 / fps(state.video);
    return gridStepSeconds(state.tempo);
  }

  function timelineLabel(seconds) {
    const division = state.tempo.gridDivision;
    if (division === 'off') return formatTime(seconds);
    if (division === 'second') return `${Math.round(seconds)}`;
    if (division === 'frame') return `F${frameAtTime(seconds)}`;
    // The Timeline plugin accumulates notch times via repeated += rather than
    // index*step, so the `seconds` it hands back can carry tiny float drift
    // (worse at BPMs like 180 that aren't exact in binary). Snapping to the
    // grid here keeps bar.beat text clean (e.g. "8" instead of "7.4").
    const snapped = snapToGrid(seconds, state.tempo);
    const { bar, beat } = barBeatAt(snapped, state.tempo);
    return beat === 1 ? `${bar}` : `${bar}.${beat}`;
  }

  function buildTimelineOptions() {
    const division = state.tempo.gridDivision;
    const step = currentGridStepSeconds();
    const base = {
      height: 26,
      timeOffset: state.tempo.gridOffsetSeconds,
      formatTimeCallback: timelineLabel,
      style: { color: 'var(--grid-label)' },
    };
    if (!step) return base;
    // The Timeline plugin decides which notches get a label by comparing
    // Math.round(100*t) against Math.round(100*interval) as it accumulates
    // t += timeInterval. For BPM values whose bar/step duration isn't exact
    // in binary floating point (e.g. 180 BPM -> 1.3333...s bars), that sum
    // drifts past the 2-decimal rounding tolerance after a couple of bars
    // and labels silently stop appearing. primaryLabelSpacing/
    // secondaryLabelSpacing instead compare the integer notch INDEX, which
    // can't drift, so use those rather than the time-based intervals.
    const bar = barDuration(state.tempo.bpm, state.tempo.numerator);
    const primarySpacing = division === 'second' || division === 'frame' ? 1 : Math.max(1, Math.round(bar / step));
    return Object.assign(base, {
      timeInterval: step,
      primaryLabelSpacing: primarySpacing,
      secondaryLabelSpacing: 1,
    });
  }

  function rebuildTimelinePlugin() {
    if (!gridWs) return;
    if (timelinePlugin) {
      gridWs.unregisterPlugin(timelinePlugin);
      timelinePlugin = null;
    }
    timelinePlugin = gridWs.registerPlugin(WS.Timeline.create(buildTimelineOptions()));
  }

  function silentPeaks() {
    return [new Float32Array(2)];
  }

  function createProxyInstance(container, height) {
    return WS.create({
      container,
      height,
      duration: state.audio.mix.durationSeconds,
      peaks: silentPeaks(),
      waveColor: 'transparent',
      progressColor: 'transparent',
      cursorColor: 'var(--cursor)',
      cursorWidth: 2,
      interact: false,
      hideScrollbar: true,
      minPxPerSec: pxPerSecond,
      fillParent: false,
      normalize: false,
    });
  }

  function createAudioInstance(container, url) {
    return WS.create({
      container,
      height: 90,
      url,
      waveColor: '#5b7ea3',
      progressColor: '#8fb8e0',
      cursorColor: 'var(--cursor)',
      cursorWidth: 2,
      interact: true,
      dragToSeek: true,
      hideScrollbar: true,
      minPxPerSec: pxPerSecond,
      fillParent: false,
      normalize: true,
    });
  }

  function forEachInstance(fn) {
    [gridWs, shotsWs, mixWs, vocalWs].forEach((ws) => ws && fn(ws));
  }

  function wireScrollSync(ws) {
    ws.on('scroll', (startTime) => {
      if (isSyncingScroll) return;
      isSyncingScroll = true;
      forEachInstance((other) => {
        if (other !== ws) other.setScrollTime(startTime);
      });
      isSyncingScroll = false;
    });
  }

  // mixWs/vocalWs wrap real <audio> elements: other.setTime() writes to
  // media.currentTime, a genuine seek. timeupdate fires on every animation
  // frame (~60Hz) while playing, so mirroring it to the other real audio
  // element at full rate means ~60 seeks/sec on an element that isn't even
  // playing - enough contention to audibly stutter the track that is
  // playing. The silent grid/shots proxies have no real media, so syncing
  // those every frame stays cheap and keeps the visual cursor smooth.
  const REAL_SYNC_INTERVAL_MS = 80;
  let lastRealSync = 0;

  function wireTimeSync(ws) {
    ws.on('timeupdate', (currentTime) => {
      if (isSyncingTime) return;
      isSyncingTime = true;
      const now = performance.now();
      const syncReal = now - lastRealSync >= REAL_SYNC_INTERVAL_MS;
      if (syncReal) lastRealSync = now;
      forEachInstance((other) => {
        if (other === ws) return;
        if ((other === mixWs || other === vocalWs) && !syncReal) return;
        other.setTime(currentTime);
      });
      isSyncingTime = false;
      updatePlayheadReadout(currentTime);
    });
    ws.on('interaction', (newTime) => {
      isSyncingTime = true;
      lastRealSync = performance.now();
      forEachInstance((other) => {
        if (other !== ws) other.setTime(newTime);
      });
      isSyncingTime = false;
      updatePlayheadReadout(newTime);
    });
  }

  function updatePlayheadReadout(seconds) {
    if (els.playhead) els.playhead.textContent = hoverLabel(seconds);
  }

  function wirePlaybackStateEvents(ws) {
    ws.on('play', () => emit('playback-state-changed', { isPlaying: true }));
    ws.on('pause', () => emit('playback-state-changed', { isPlaying: false }));
    ws.on('finish', () => emit('playback-state-changed', { isPlaying: false }));
  }

  function activeWs() {
    return state.audio.playbackTrack === 'vocal' ? vocalWs : mixWs;
  }

  async function togglePlayback() {
    const ws = activeWs();
    if (!ws) return;
    await ws.playPause();
  }

  function getCurrentTime() {
    const ws = activeWs() || gridWs;
    return ws ? ws.getCurrentTime() : 0;
  }

  async function setPlaybackTrack(track) {
    if (track === state.audio.playbackTrack) return;
    const wasPlaying = activeWs() && activeWs().isPlaying();
    const currentTime = activeWs() ? activeWs().getCurrentTime() : 0;
    if (activeWs()) activeWs().pause();
    state.audio.playbackTrack = track;
    const next = activeWs();
    if (next) {
      next.setTime(currentTime);
      if (wasPlaying) await next.play();
    }
    emit('playback-track-changed', { track });
  }

  function zoomTo(px) {
    pxPerSecond = Math.max(10, px);
    forEachInstance((ws) => ws.zoom(pxPerSecond));
    layoutSilenceOverlay();
  }

  function layoutSilenceOverlay() {
    if (!els.silenceLayer || !vocalWs) return;
    const scroll = vocalWs.getScroll();
    els.silenceLayer.innerHTML = '';
    vocalSilenceGaps.forEach((gap) => {
      const left = gap.start * pxPerSecond - scroll;
      const width = Math.max(1, (gap.end - gap.start) * pxPerSecond);
      const div = document.createElement('div');
      div.className = 'silence-band';
      div.style.left = `${left}px`;
      div.style.width = `${width}px`;
      els.silenceLayer.appendChild(div);
    });
  }

  function renderShots() {
    if (!regionsPlugin) return;
    regionsPlugin.clearRegions();
    state.shots.forEach((shot) => {
      const status = shotsApi.shotStatus(shot);
      const calc = frameCalc(shotsApi.shotDuration(shot), state.video);
      const region = regionsPlugin.addRegion({
        id: `shot-${shot.id}`,
        start: shot.startSeconds,
        end: shot.endSeconds,
        drag: true,
        resize: true,
        resizeStart: true,
        resizeEnd: true,
        color: STATUS_COLOR[status],
        content: buildRegionLabel(shot, status, calc),
      });
      region.on('update', (side) => handleRegionUpdate(region, side));
      region.on('update-end', (side) => handleRegionUpdateEnd(region, side));
    });
    renderShotList();
  }

  function buildRegionLabel(shot, status, calc) {
    const el = document.createElement('div');
    el.className = `shot-region-label status-${status}`;
    el.innerHTML = `<strong>Shot ${shot.id}</strong><span>${shotsApi.shotDuration(shot).toFixed(2)}s</span>`;
    return el;
  }

  function shotIndexFromRegionId(regionId) {
    const id = Number(regionId.replace('shot-', ''));
    return state.shots.findIndex((s) => s.id === id);
  }

  // While actively dragging, the edge moves freely (unsnapped) so every small
  // pointer delta is reflected. Snapping only the final position (see
  // handleRegionUpdateEnd) would otherwise repeatedly reset the edge back to the
  // same grid line on each intermediate move, making the drag feel frozen.
  // Each shot's edges are independent: moving one only clamps against its own
  // opposite edge and its neighbor's facing edge - the neighbor itself never
  // moves, since a gap between shots is a normal, valid state now.
  function handleRegionUpdate(region, side) {
    const index = shotIndexFromRegionId(region.id);
    if (index === -1) return;
    const shot = state.shots[index];
    if (!side) {
      // Whole-shot drag (region body, not a resize handle). The Regions plugin
      // translates start/end freely with no notion of neighboring shots, so
      // moveShot's clamp is what actually stops it at a neighbor or track
      // bound - re-applying it here overrides any further translation once
      // that bound is reached.
      const clamped = shotsApi.moveShot(shot.id, region.start, { snap: false });
      if (clamped === null) return;
      region.setOptions({ start: clamped, end: clamped + shotsApi.shotDuration(shot) });
      // Regions render inside WaveSurfer's own shadow DOM, which the page's
      // stylesheet can't reach - set the dimming directly on the element
      // instead of toggling a CSS class.
      region.element.style.opacity = '0.55';
      refreshShotVisuals(index);
      renderShotList();
      return;
    }
    const time = side === 'end' ? region.end : region.start;
    const clamped = shotsApi.moveEdge(shot.id, side, time, { snap: false });
    if (clamped === null) return;
    region.setOptions({ [side]: clamped });
    refreshShotVisuals(index);
    renderShotList();
  }

  function refreshShotVisuals(index) {
    const shot = state.shots[index];
    if (!shot || !regionsPlugin) return;
    const status = shotsApi.shotStatus(shot);
    const calc = frameCalc(shotsApi.shotDuration(shot), state.video);
    const region = regionsPlugin.getRegions().find((r) => r.id === `shot-${shot.id}`);
    if (region) {
      region.setOptions({ color: STATUS_COLOR[status], content: buildRegionLabel(shot, status, calc) });
    }
  }

  function handleRegionUpdateEnd(region, side) {
    const index = shotIndexFromRegionId(region.id);
    if (index !== -1) {
      const shot = state.shots[index];
      if (side) {
        const time = side === 'end' ? region.end : region.start;
        shotsApi.moveEdge(shot.id, side, time, { snap: !altHeld });
      } else {
        shotsApi.moveShot(shot.id, region.start, { snap: !altHeld });
      }
    }
    // Always re-renders (via 'shots-changed'), which rebuilds every region's
    // DOM element from scratch - that's what clears the dragging opacity
    // class, no manual removal needed.
    shotsApi.notifyBoundaryMoved();
  }

  // Centers the shots/grid/mix/vocal tracks (they scroll in sync) on the given
  // shot's midpoint.
  function scrollToShot(shot) {
    if (!gridWs || !els.shotsContainer) return;
    const center = (shot.startSeconds + shot.endSeconds) / 2;
    const target = Math.max(0, center * pxPerSecond - els.shotsContainer.clientWidth / 2);
    gridWs.setScroll(target);
  }

  function renderShotList() {
    const list = document.getElementById('shot-list');
    if (!list) return;
    list.innerHTML = '';
    const selectedId = MSE.context ? MSE.context.getSelectedShotId() : null;
    state.shots.forEach((shot) => {
      const status = shotsApi.shotStatus(shot);
      const calc = frameCalc(shotsApi.shotDuration(shot), state.video);
      const row = document.createElement('tr');
      row.className = `status-${status}${shot.id === selectedId ? ' selected' : ''}`;
      row.innerHTML = `
        <td>${shot.id}</td>
        <td>${formatTime(shot.startSeconds)}</td>
        <td>${formatTime(shot.endSeconds)}</td>
        <td>${shotsApi.shotDuration(shot).toFixed(3)} s</td>
        <td class="status-cell">${statusLabel(status)}</td>
        <td>${calc.cutFrames}</td>
        <td>${calc.renderFrames}</td>
        <td>${calc.overhangFrames} f / ${calc.overhangSeconds.toFixed(3)} s</td>
      `;
      row.addEventListener('click', () => {
        scrollToShot(shot);
        if (MSE.context) MSE.context.selectShot(shot.id);
      });
      list.appendChild(row);
    });
  }

  function statusLabel(status) {
    if (status === 'short') return 'too short';
    if (status === 'long') return 'too long';
    return 'valid';
  }

  // Clicking inside an existing shot splits it (unchanged). Dragging on empty
  // space (a gap) draws a new shot instead - the two are disambiguated by
  // whether the pointerdown time falls inside a shot or in a gap
  // (shotsApi.gapAt). A plain click in a gap (no real drag) is a no-op.
  function setupShotsInteraction() {
    const wrapper = shotsWs.getWrapper();
    const CLICK_MOVE_THRESHOLD_PX = 4;

    let down = null; // { x, y, t, time, gap }
    let dragging = false;
    let draftEl = null;
    let draftLabelEl = null;

    function timeAtClientX(clientX) {
      const rect = wrapper.getBoundingClientRect();
      const x = clientX - rect.left + shotsWs.getScroll();
      return Math.max(0, x / pxPerSecond);
    }

    function removeDraft() {
      if (draftEl) {
        draftEl.remove();
        draftEl = null;
        draftLabelEl = null;
      }
    }

    // Shows the live (unsnapped) start/end/duration while dragging out a new
    // shot - snapping is only applied once the drag ends, so the label tracks
    // the same raw values the box itself is drawn from.
    function updateDraft(startTime, endTime) {
      if (!draftEl) {
        draftEl = document.createElement('div');
        draftEl.className = 'shot-draft';
        draftLabelEl = document.createElement('div');
        draftLabelEl.className = 'shot-draft-label';
        draftEl.appendChild(draftLabelEl);
        wrapper.appendChild(draftEl);
      }
      const scroll = shotsWs.getScroll();
      const lo = Math.min(startTime, endTime);
      const hi = Math.max(startTime, endTime);
      const left = lo * pxPerSecond - scroll;
      const width = Math.max(1, (hi - lo) * pxPerSecond);
      draftEl.style.left = `${left}px`;
      draftEl.style.width = `${width}px`;
      draftLabelEl.textContent = `${formatTime(lo)} – ${formatTime(hi)} · ${(hi - lo).toFixed(2)}s`;
    }

    function onPointerMove(e) {
      if (!down) return;
      if (!dragging) {
        const movedEnough =
          Math.abs(e.clientX - down.x) > CLICK_MOVE_THRESHOLD_PX || Math.abs(e.clientY - down.y) > CLICK_MOVE_THRESHOLD_PX;
        if (!movedEnough || !down.gap) return;
        dragging = true;
      }
      const rawTime = timeAtClientX(e.clientX);
      const clamped = Math.min(down.gap.end, Math.max(down.gap.start, rawTime));
      updateDraft(down.time, clamped);
    }

    function onPointerUp(e) {
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerUp);

      if (dragging && down.gap) {
        const rawTime = timeAtClientX(e.clientX);
        const clamped = Math.min(down.gap.end, Math.max(down.gap.start, rawTime));
        const snap = !altHeld;
        let start = snap ? shotsApi.snapSeconds(Math.min(down.time, clamped)) : Math.min(down.time, clamped);
        let end = snap ? shotsApi.snapSeconds(Math.max(down.time, clamped)) : Math.max(down.time, clamped);
        // Snapping can push a point past the gap boundary (e.g. onto a
        // neighboring shot snapped to the same grid). Re-clamp to the gap
        // that was actually dragged in, so createShot's own gap lookup can't
        // resolve a different - possibly much later - gap from an
        // out-of-range point.
        start = Math.min(Math.max(start, down.gap.start), down.gap.end);
        end = Math.min(Math.max(end, down.gap.start), down.gap.end);
        shotsApi.createShot(start, end);
      } else if (!dragging && !down.gap) {
        const movedEnough =
          Math.abs(e.clientX - down.x) > CLICK_MOVE_THRESHOLD_PX || Date.now() - down.t > 400;
        if (!movedEnough) shotsApi.splitShotAt(down.time);
      }

      removeDraft();
      down = null;
      dragging = false;
    }

    wrapper.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (e.target.closest('[part*="region-handle"]')) return;
      const time = timeAtClientX(e.clientX);
      down = { x: e.clientX, y: e.clientY, t: Date.now(), time, gap: shotsApi.gapAt(time) };
      dragging = false;
      document.addEventListener('pointermove', onPointerMove);
      document.addEventListener('pointerup', onPointerUp);
    });

    wrapper.addEventListener('dblclick', (e) => {
      const handle = e.target.closest('[part*="region-handle"]');
      if (!handle) return;
      const region = regionsPlugin.getRegions().find((r) => r.element && r.element.contains(handle));
      if (!region) return;
      const index = shotIndexFromRegionId(region.id);
      const isLeftHandle = handle.getAttribute('part').includes('left');
      const boundaryIndex = isLeftHandle ? index - 1 : index;
      shotsApi.removeBoundary(boundaryIndex);
    });
  }

  function setupShotContextMenu() {
    const menu = document.getElementById('shot-context-menu');
    const deleteBtn = document.getElementById('shot-context-delete');
    if (!menu || !deleteBtn) return;
    const wrapper = shotsWs.getWrapper();
    let targetShotId = null;

    function hideMenu() {
      menu.style.display = 'none';
      targetShotId = null;
    }

    wrapper.addEventListener('contextmenu', (e) => {
      const region = regionsPlugin.getRegions().find((r) => r.element && r.element.contains(e.target));
      const index = region ? shotIndexFromRegionId(region.id) : -1;
      if (index === -1) {
        hideMenu();
        return;
      }
      e.preventDefault();
      targetShotId = state.shots[index].id;
      menu.style.left = `${e.clientX}px`;
      menu.style.top = `${e.clientY}px`;
      menu.style.display = 'block';
    });

    deleteBtn.addEventListener('click', () => {
      if (targetShotId !== null) shotsApi.deleteShot(targetShotId);
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

  // WaveSurfer hides its native scrollbar (hideScrollbar:true) and the grid/shots
  // tracks have interact:false, so there is no built-in way to pan horizontally.
  // Translate wheel input (vertical wheel or trackpad horizontal swipe) into a
  // scroll on one instance; wireScrollSync() propagates it to the other three.
  function wireWheelScroll() {
    const area = document.querySelector('.timeline-area');
    if (!area) return;
    area.addEventListener(
      'wheel',
      (e) => {
        if (!gridWs) return;
        const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        if (!delta) return;
        e.preventDefault();
        gridWs.setScroll(gridWs.getScroll() + delta);
      },
      { passive: false }
    );
  }

  async function initTimeline(mixDurationSeconds) {
    cacheElements();
    state.audio.mix.durationSeconds = mixDurationSeconds;

    gridWs = createProxyInstance(els.gridContainer, 2);
    shotsWs = createProxyInstance(els.shotsContainer, 44);

    rebuildTimelinePlugin();
    regionsPlugin = shotsWs.registerPlugin(WS.Regions.create());

    setupShotsInteraction();
    setupShotContextMenu();

    [gridWs, shotsWs].forEach((ws) => {
      wireScrollSync(ws);
      wireTimeSync(ws);
    });

    // Shots may already be in state by the time the timeline is created now
    // that a project can be loaded from the backend before any mix is picked
    // (renderShots() no-ops with no regionsPlugin yet) - draw them now that
    // one exists, instead of waiting for the next unrelated shots-changed.
    renderShots();

    emit('timeline-ready');
  }

  async function loadMix(url, fileName) {
    if (!els.mixContainer) cacheElements();
    if (mixWs) mixWs.destroy();
    mixWs = createAudioInstance(els.mixContainer, url);
    wireScrollSync(mixWs);
    wireTimeSync(mixWs);
    wirePlaybackStateEvents(mixWs);
    await new Promise((resolve) => mixWs.on('ready', resolve));

    const duration = mixWs.getDuration();
    state.audio.mix.fileName = fileName;
    state.audio.mix.durationSeconds = duration;

    if (!gridWs) await initTimeline(duration);

    mixWs.registerPlugin(
      WS.Hover.create({
        lineColor: 'var(--cursor)',
        labelBackground: '#1c1c1c',
        labelColor: '#fff',
        formatTimeCallback: hoverLabel,
      })
    );
    mixWs.zoom(pxPerSecond);
    emit('mix-ready');
  }

  async function loadVocal(url, fileName) {
    if (!els.vocalContainer) cacheElements();
    if (vocalWs) vocalWs.destroy();
    vocalWs = createAudioInstance(els.vocalContainer, url);
    wireScrollSync(vocalWs);
    wireTimeSync(vocalWs);
    wirePlaybackStateEvents(vocalWs);
    await new Promise((resolve) => vocalWs.on('ready', resolve));
    state.audio.vocal.fileName = fileName;
    state.audio.vocal.durationSeconds = vocalWs.getDuration();
    vocalWs.zoom(pxPerSecond);
    vocalWs.on('scroll', layoutSilenceOverlay);
    vocalWs.on('zoom', layoutSilenceOverlay);

    const buffer = vocalWs.getDecodedData();
    if (buffer) {
      vocalSilenceGaps = silenceApi.detectSilence(buffer);
      layoutSilenceOverlay();
    }
    emit('vocal-ready');
  }

  on('tempo-changed', () => rebuildTimelinePlugin());
  on('video-changed', () => renderShots());
  on('limits-changed', () => renderShots());
  on('shots-changed', () => renderShots());

  wireWheelScroll();

  MSE.sync = {
    loadMix,
    loadVocal,
    togglePlayback,
    setPlaybackTrack,
    zoomTo,
    getCurrentTime,
    getPxPerSecond: () => pxPerSecond,
    isTimelineReady: () => !!gridWs,
  };
})(window.MSE = window.MSE || {});
