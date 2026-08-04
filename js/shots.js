// Shot model: an independently-editable list of non-overlapping intervals, sorted by
// start time. Shots do NOT have to cover the whole track - gaps (deliberately no shot)
// are a normal, valid state. Each edge (start/end) of a shot is edited on its own,
// clamped against its own opposite edge and against its immediate neighbor (if any) or
// the track bounds - never against a forced "shared boundary" with a neighbor, since
// that only makes sense when shots must always touch.
(function (MSE) {
  'use strict';

  const { state, emit } = MSE.state;
  const { snapToGrid } = MSE.grid;
  const { fps } = MSE.frames;

  const MIN_GAP_SECONDS = 0.05;

  function renumber() {
    state.shots.sort((a, b) => a.startSeconds - b.startSeconds);
    state.shots.forEach((shot, index) => {
      shot.id = index + 1;
    });
  }

  function shotDuration(shot) {
    return shot.endSeconds - shot.startSeconds;
  }

  function shotStatus(shot) {
    const duration = shotDuration(shot);
    const { minimumSeconds, maximumSeconds } = state.shotLimits;
    if (duration < minimumSeconds) return 'short';
    if (duration > maximumSeconds) return 'long';
    return 'valid';
  }

  // Resolves the currently selected grid division to a snap step in seconds.
  // 'second'/'frame' depend on video state, which musicalGrid.js deliberately
  // doesn't know about, so they're resolved here rather than in gridStepSeconds().
  function snapSeconds(timeSeconds) {
    const division = state.tempo.gridDivision;
    if (division === 'second') return Math.max(0, Math.round(timeSeconds));
    if (division === 'frame') {
      const frameLength = 1 / fps(state.video);
      return Math.max(0, Math.round(timeSeconds / frameLength) * frameLength);
    }
    return snapToGrid(timeSeconds, state.tempo);
  }

  function trackDuration() {
    return state.audio.mix.durationSeconds || 0;
  }

  // Returns the [start, end) bounds of the gap containing timeSeconds (previous
  // shot's end, or 0 .. next shot's start, or track duration), or null if the
  // point falls inside an existing shot.
  function gapAt(timeSeconds) {
    const duration = trackDuration();
    let gapStart = 0;
    for (const shot of state.shots) {
      if (timeSeconds >= shot.startSeconds && timeSeconds <= shot.endSeconds) return null;
      if (timeSeconds < shot.startSeconds) {
        return { start: gapStart, end: shot.startSeconds };
      }
      gapStart = shot.endSeconds;
    }
    return { start: gapStart, end: duration };
  }

  // Splits the shot containing `timeSeconds` into two, snapped to the current grid.
  function splitShotAt(timeSeconds) {
    const snapped = snapSeconds(timeSeconds);
    const index = state.shots.findIndex(
      (shot) => snapped > shot.startSeconds + MIN_GAP_SECONDS && snapped < shot.endSeconds - MIN_GAP_SECONDS
    );
    if (index === -1) return false;
    const shot = state.shots[index];
    const left = { id: 0, startSeconds: shot.startSeconds, endSeconds: snapped, prompt: shot.prompt || '', notes: shot.notes || '' };
    const right = { id: 0, startSeconds: snapped, endSeconds: shot.endSeconds, prompt: '', notes: '' };
    state.shots.splice(index, 1, left, right);
    renumber();
    emit('shots-changed', { reason: 'split' });
    return true;
  }

  // Creates a new shot from rawStart to rawEnd, clamped to the gap that contains
  // it so it can never overlap an existing shot. Returns false if the resulting
  // shot would be shorter than MIN_GAP_SECONDS.
  function createShot(rawStart, rawEnd) {
    const lo = Math.min(rawStart, rawEnd);
    const hi = Math.max(rawStart, rawEnd);
    const gap = gapAt(lo) || gapAt(hi);
    if (!gap) return false;
    const start = Math.max(gap.start, lo);
    const end = Math.min(gap.end, hi);
    if (end - start < MIN_GAP_SECONDS) return false;
    state.shots.push({ id: 0, startSeconds: start, endSeconds: end, prompt: '', notes: '' });
    renumber();
    emit('shots-changed', { reason: 'create' });
    return true;
  }

  function deleteShot(shotId) {
    const before = state.shots.length;
    state.shots = state.shots.filter((s) => s.id !== shotId);
    if (state.shots.length === before) return false;
    renumber();
    emit('shots-changed', { reason: 'delete' });
    return true;
  }

  // Removes the boundary between shot[index] and shot[index+1] by extending the
  // left shot to the right shot's end. Only meaningful when the two shots are
  // actually touching (no gap); otherwise this would silently swallow the gap,
  // so it's a no-op in that case.
  function removeBoundary(index) {
    if (index < 0 || index >= state.shots.length - 1) return false;
    const left = state.shots[index];
    const right = state.shots[index + 1];
    if (Math.abs(left.endSeconds - right.startSeconds) > 1e-9) return false;
    left.endSeconds = right.endSeconds;
    state.shots.splice(index + 1, 1);
    renumber();
    emit('shots-changed', { reason: 'merge' });
    return true;
  }

  // Moves one edge of one shot, clamped against its own opposite edge and against
  // the adjacent neighbor's facing edge (if any) or the track bounds. The
  // neighbor itself is never modified - if there's a gap, moving into it just
  // narrows the gap; if the shots were touching, the edge stops at the neighbor.
  function moveEdge(shotId, side, newTime, options) {
    const snap = !options || options.snap !== false;
    const index = state.shots.findIndex((s) => s.id === shotId);
    if (index === -1) return null;
    const shot = state.shots[index];
    const target = snap ? snapSeconds(newTime) : newTime;

    if (side === 'start') {
      const prev = state.shots[index - 1];
      const min = prev ? prev.endSeconds : 0;
      const max = shot.endSeconds - MIN_GAP_SECONDS;
      const clamped = Math.min(Math.max(target, min), max);
      shot.startSeconds = clamped;
      return clamped;
    }
    if (side === 'end') {
      const next = state.shots[index + 1];
      const max = next ? next.startSeconds : trackDuration();
      const min = shot.startSeconds + MIN_GAP_SECONDS;
      const clamped = Math.max(Math.min(target, max), min);
      shot.endSeconds = clamped;
      return clamped;
    }
    return null;
  }

  // Moves a whole shot (both edges together, duration preserved), clamped so it
  // can't cross its immediate neighbor's facing edge or the track bounds. The
  // neighbor itself is never modified, same as moveEdge.
  function moveShot(shotId, newStart, options) {
    const snap = !options || options.snap !== false;
    const index = state.shots.findIndex((s) => s.id === shotId);
    if (index === -1) return null;
    const shot = state.shots[index];
    const duration = shotDuration(shot);
    const prev = state.shots[index - 1];
    const next = state.shots[index + 1];
    const minStart = prev ? prev.endSeconds : 0;
    const maxStart = (next ? next.startSeconds : trackDuration()) - duration;
    const target = snap ? snapSeconds(newStart) : newStart;
    const clamped = Math.min(Math.max(target, minStart), maxStart);
    shot.startSeconds = clamped;
    shot.endSeconds = clamped + duration;
    return clamped;
  }

  function notifyBoundaryMoved() {
    emit('shots-changed', { reason: 'move' });
  }

  MSE.shots = {
    shotDuration,
    shotStatus,
    snapSeconds,
    gapAt,
    splitShotAt,
    createShot,
    deleteShot,
    removeBoundary,
    moveEdge,
    moveShot,
    notifyBoundaryMoved,
  };
})(window.MSE = window.MSE || {});
