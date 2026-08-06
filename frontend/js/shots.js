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

  // H3 shot direction (see docs/h3-shot-direction-roadmap.md): which assigned
  // assets play which role in the compiled prompt, plus camera/subject action
  // tracks the deterministic compiler turns into semantic beats. Camera
  // movement is restricted to H3's own official vocabulary; framing/speed and
  // subject actions stay free text.
  const ASSET_ROLES = ['primary_character', 'supporting_character', 'environment'];
  // Official H3 camera vocabulary (see h3-r2v-prompting-guide.md section 6.4
  // and docs/deep-research-report-h3-prompting.md) - kept as the full
  // official set now, not just the ones an early v1 happened to cover.
  const CAMERA_MOVEMENTS = [
    'zoom_in',
    'zoom_out',
    'push_in',
    'pull_out',
    'pan',
    'truck',
    'tilt_up',
    'tilt_down',
    'pedestal_up',
    'pedestal_down',
    'tracking_shot',
    'arc_shot',
    'static_shot',
    'shake_slightly',
    'shake_strongly',
    'pov',
    'roll_cw',
    'roll_ccw',
  ];

  // Free select, not enforced against `movement` - a small closed vocabulary
  // still beats free text for something the compiler wants to phrase
  // consistently ("trucks right" vs "trucks to the right" vs "truck: right").
  const CAMERA_DIRECTIONS = ['', 'left', 'right', 'up', 'down', 'forward', 'backward'];

  // Guide section 6.4: amplitude is one of three camera dimensions
  // (movement/amplitude/speed), only mentioned in the compiled prompt when
  // it means something - '' omits the clause entirely (see h3Compiler.js's
  // phraseCamera).
  const CAMERA_AMPLITUDES = ['', 'small', 'large'];

  // Character action vocabulary (see direction UX discussion): a closed set
  // for the common cases, with '' meaning "unset/custom" - `notes` (free
  // text) always carries the full intent regardless of whether actionType is set.
  const ACTION_TYPES = [
    '',
    'walk',
    'run',
    'stop',
    'sit',
    'stand',
    'turn',
    'reach',
    'pick_up',
    'put_down',
    'drink',
    'check_phone',
    'look',
    'speak',
    'interact',
  ];

  function defaultDirection() {
    return { camera: [], subjects: {}, props: {}, beatNotes: [] };
  }

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

  // Loop locators snap asymmetrically (left locator to shot starts, right
  // locator to shot ends) rather than to "nearest boundary of either kind" -
  // matches the common intent of looping exactly one or more whole shots.
  function nearestShotStart(timeSeconds) {
    if (!state.shots.length) return timeSeconds;
    return state.shots.reduce(
      (best, s) => (Math.abs(s.startSeconds - timeSeconds) < Math.abs(best - timeSeconds) ? s.startSeconds : best),
      state.shots[0].startSeconds
    );
  }

  // Which shot (if any) the given time falls inside - end-exclusive, so a
  // time exactly on a shared boundary belongs to the shot starting there,
  // not the one ending there.
  function shotAtTime(timeSeconds) {
    return state.shots.find((s) => timeSeconds >= s.startSeconds && timeSeconds < s.endSeconds) || null;
  }

  function nearestShotEnd(timeSeconds) {
    if (!state.shots.length) return timeSeconds;
    return state.shots.reduce(
      (best, s) => (Math.abs(s.endSeconds - timeSeconds) < Math.abs(best - timeSeconds) ? s.endSeconds : best),
      state.shots[0].endSeconds
    );
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
    // Casting (assetRoles) isn't time-based, so it carries over to the left
    // half same as assetIds - but direction beats are shot-relative seconds
    // that were authored against the ORIGINAL duration, which no longer
    // matches either half after a split, so both halves start with a blank
    // direction rather than carrying over now-meaningless timings.
    const left = {
      id: 0,
      startSeconds: shot.startSeconds,
      endSeconds: snapped,
      name: shot.name || '',
      prompt: shot.prompt || '',
      notes: shot.notes || '',
      seed: null,
      assetIds: (shot.assetIds || []).slice(),
      assetRoles: { ...(shot.assetRoles || {}) },
      direction: defaultDirection(),
    };
    const right = {
      id: 0,
      startSeconds: snapped,
      endSeconds: shot.endSeconds,
      name: '',
      prompt: '',
      notes: '',
      seed: null,
      assetIds: [],
      assetRoles: {},
      direction: defaultDirection(),
    };
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
    state.shots.push({
      id: 0,
      startSeconds: start,
      endSeconds: end,
      name: '',
      prompt: '',
      notes: '',
      seed: null,
      assetIds: [],
      assetRoles: {},
      direction: defaultDirection(),
    });
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

  // Editable only from the shot list table (not the timeline region itself) -
  // an empty name displays as "unnamed" via placeholder text, never stored as
  // a literal value.
  function setShotName(shotId, name) {
    const shot = state.shots.find((s) => s.id === shotId);
    if (!shot) return;
    shot.name = name;
    emit('shots-changed', { reason: 'name' });
  }

  // Used by the H3 compiler's explicit "Compile prompt" action (see
  // h3Compiler.js) to write its result into the same prompt field the user
  // can otherwise type into directly - emits 'shots-changed' so the Shot
  // tab's own re-render (which already guards against clobbering an
  // in-progress edit via document.activeElement) picks up the new text.
  function setShotPrompt(shotId, prompt) {
    const shot = state.shots.find((s) => s.id === shotId);
    if (!shot) return;
    shot.prompt = prompt;
    emit('shots-changed', { reason: 'prompt' });
  }

  function findShot(shotId) {
    return state.shots.find((s) => s.id === shotId) || null;
  }

  // A role is optional - an asset can stay assigned to a shot without being a
  // "Subject" in the compiled H3 prompt (e.g. a mood reference). Passing a
  // falsy role clears it rather than storing an empty-string role.
  function setAssetRole(shotId, assetId, role) {
    const shot = findShot(shotId);
    if (!shot) return;
    if (!shot.assetRoles) shot.assetRoles = {};
    if (role) shot.assetRoles[assetId] = role;
    else delete shot.assetRoles[assetId];
    emit('shots-changed', { reason: 'asset-role' });
  }

  function ensureDirection(shot) {
    if (!shot.direction) shot.direction = defaultDirection();
    if (!shot.direction.camera) shot.direction.camera = [];
    if (!shot.direction.subjects) shot.direction.subjects = {};
    if (!shot.direction.props) shot.direction.props = {};
    if (!shot.direction.beatNotes) shot.direction.beatNotes = [];
    return shot.direction;
  }

  function sortSegments(list) {
    list.sort((a, b) => a.startSeconds - b.startSeconds);
  }

  function addCameraSegment(shotId, segment) {
    const shot = findShot(shotId);
    if (!shot) return;
    const direction = ensureDirection(shot);
    direction.camera.push({
      startSeconds: 0,
      endSeconds: 0,
      movement: CAMERA_MOVEMENTS[0],
      framing: '',
      speed: '',
      amplitude: '',
      direction: '',
      target: '',
      transitionToNext: '',
      enabled: true,
      ...segment,
    });
    sortSegments(direction.camera);
    emit('shots-changed', { reason: 'direction' });
  }

  function updateCameraSegment(shotId, index, patch) {
    const shot = findShot(shotId);
    if (!shot || !shot.direction || !shot.direction.camera[index]) return;
    Object.assign(shot.direction.camera[index], patch);
    sortSegments(shot.direction.camera);
    emit('shots-changed', { reason: 'direction' });
  }

  function removeCameraSegment(shotId, index) {
    const shot = findShot(shotId);
    if (!shot || !shot.direction || !shot.direction.camera[index]) return;
    shot.direction.camera.splice(index, 1);
    emit('shots-changed', { reason: 'direction' });
  }

  function addSubjectSegment(shotId, assetId, segment) {
    const shot = findShot(shotId);
    if (!shot) return;
    const direction = ensureDirection(shot);
    if (!direction.subjects[assetId]) direction.subjects[assetId] = [];
    direction.subjects[assetId].push({
      startSeconds: 0,
      endSeconds: 0,
      actionType: '',
      manner: '',
      gaze: '',
      expression: '',
      notes: '',
      enabled: true,
      ...segment,
    });
    sortSegments(direction.subjects[assetId]);
    emit('shots-changed', { reason: 'direction' });
  }

  function updateSubjectSegment(shotId, assetId, index, patch) {
    const shot = findShot(shotId);
    const track = shot && shot.direction && shot.direction.subjects[assetId];
    if (!track || !track[index]) return;
    Object.assign(track[index], patch);
    sortSegments(track);
    emit('shots-changed', { reason: 'direction' });
  }

  function removeSubjectSegment(shotId, assetId, index) {
    const shot = findShot(shotId);
    const track = shot && shot.direction && shot.direction.subjects[assetId];
    if (!track || !track[index]) return;
    track.splice(index, 1);
    emit('shots-changed', { reason: 'direction' });
  }

  // Props track: same shape as the subject track above (time-bounded state
  // per cast prop), keyed by shot.direction.props[assetId] - a prop's
  // adjacent segments (e.g. "on saucer" -> "held by Heather" -> "on saucer")
  // ARE the before/after object state, no separate schema needed for it.
  function addPropSegment(shotId, assetId, segment) {
    const shot = findShot(shotId);
    if (!shot) return;
    const direction = ensureDirection(shot);
    if (!direction.props[assetId]) direction.props[assetId] = [];
    direction.props[assetId].push({
      startSeconds: 0,
      endSeconds: 0,
      state: '',
      ownerAssetId: null,
      notes: '',
      enabled: true,
      ...segment,
    });
    sortSegments(direction.props[assetId]);
    emit('shots-changed', { reason: 'direction' });
  }

  function updatePropSegment(shotId, assetId, index, patch) {
    const shot = findShot(shotId);
    const track = shot && shot.direction && shot.direction.props[assetId];
    if (!track || !track[index]) return;
    Object.assign(track[index], patch);
    sortSegments(track);
    emit('shots-changed', { reason: 'direction' });
  }

  function removePropSegment(shotId, assetId, index) {
    const shot = findShot(shotId);
    const track = shot && shot.direction && shot.direction.props[assetId];
    if (!track || !track[index]) return;
    track.splice(index, 1);
    emit('shots-changed', { reason: 'direction' });
  }

  const MIN_SEGMENT_SECONDS = 0.1;

  // Direction segments (camera/subject) live within a single shot's own
  // duration, not the song timeline - clamped against their own neighbor in
  // the same array and against [0, shotDuration], same shape as moveEdge/
  // moveShot but scoped one level down. Deliberately silent (no emit) like
  // moveEdge/moveShot: the lane widget calls these on every pointermove for
  // live dragging and updates the dragged element's own position directly,
  // then calls notifyDirectionChanged() once on pointerup - emitting here on
  // every move would rebuild the lane DOM out from under the drag in
  // progress (the exact bug already fixed once for the shot list's dblclick).
  function clampSegmentEdge(segments, index, side, target, duration) {
    const seg = segments[index];
    if (side === 'start') {
      const prev = segments[index - 1];
      const min = prev ? prev.endSeconds : 0;
      const max = seg.endSeconds - MIN_SEGMENT_SECONDS;
      return Math.min(Math.max(target, min), max);
    }
    const next = segments[index + 1];
    const max = next ? next.startSeconds : duration;
    const min = seg.startSeconds + MIN_SEGMENT_SECONDS;
    return Math.max(Math.min(target, max), min);
  }

  function clampSegmentMove(segments, index, newStart, duration) {
    const seg = segments[index];
    const length = seg.endSeconds - seg.startSeconds;
    const prev = segments[index - 1];
    const next = segments[index + 1];
    const min = prev ? prev.endSeconds : 0;
    const max = (next ? next.startSeconds : duration) - length;
    return Math.min(Math.max(newStart, min), max);
  }

  // Splits segments[index] into two at atTime, both keeping every field of
  // the original except start/end - no-op (returns false) unless atTime
  // leaves at least MIN_SEGMENT_SECONDS on each side.
  function splitSegmentAt(segments, index, atTime) {
    const seg = segments[index];
    if (!seg) return false;
    if (atTime <= seg.startSeconds + MIN_SEGMENT_SECONDS || atTime >= seg.endSeconds - MIN_SEGMENT_SECONDS) return false;
    segments.splice(index, 1, { ...seg, endSeconds: atTime }, { ...seg, startSeconds: atTime });
    return true;
  }

  // Clones segments[index] immediately after it, same duration, clamped
  // against the next neighbor/shot duration - no-op if it can't fit
  // MIN_SEGMENT_SECONDS.
  function duplicateSegmentAfter(segments, index, duration) {
    const seg = segments[index];
    if (!seg) return false;
    const length = seg.endSeconds - seg.startSeconds;
    const next = segments[index + 1];
    const maxEnd = next ? next.startSeconds : duration;
    const start = seg.endSeconds;
    const end = Math.min(start + length, maxEnd);
    if (end - start < MIN_SEGMENT_SECONDS) return false;
    segments.splice(index + 1, 0, { ...seg, startSeconds: start, endSeconds: end });
    return true;
  }

  function toggleSegmentEnabled(segments, index) {
    const seg = segments[index];
    if (!seg) return false;
    seg.enabled = seg.enabled === false;
    return true;
  }

  // Merges segments[index] with segments[index + 1] if they're contiguous
  // (no gap) - the merged segment keeps segments[index]'s own fields (same
  // left-wins convention as removeBoundary above) and extends to the next
  // segment's end. No-op if there's a gap.
  function mergeSegmentWithNext(segments, index) {
    const seg = segments[index];
    const next = segments[index + 1];
    if (!seg || !next) return false;
    if (Math.abs(seg.endSeconds - next.startSeconds) > 1e-6) return false;
    seg.endSeconds = next.endSeconds;
    segments.splice(index + 1, 1);
    return true;
  }

  function moveCameraSegmentEdge(shotId, index, side, newTime) {
    const shot = findShot(shotId);
    const segments = shot && shot.direction && shot.direction.camera;
    if (!segments || !segments[index]) return null;
    const clamped = clampSegmentEdge(segments, index, side, newTime, shotDuration(shot));
    segments[index][side === 'start' ? 'startSeconds' : 'endSeconds'] = clamped;
    return clamped;
  }

  function moveCameraSegment(shotId, index, newStart) {
    const shot = findShot(shotId);
    const segments = shot && shot.direction && shot.direction.camera;
    if (!segments || !segments[index]) return null;
    const clamped = clampSegmentMove(segments, index, newStart, shotDuration(shot));
    const seg = segments[index];
    const length = seg.endSeconds - seg.startSeconds;
    seg.startSeconds = clamped;
    seg.endSeconds = clamped + length;
    return clamped;
  }

  function moveSubjectSegmentEdge(shotId, assetId, index, side, newTime) {
    const shot = findShot(shotId);
    const segments = shot && shot.direction && shot.direction.subjects[assetId];
    if (!segments || !segments[index]) return null;
    const clamped = clampSegmentEdge(segments, index, side, newTime, shotDuration(shot));
    segments[index][side === 'start' ? 'startSeconds' : 'endSeconds'] = clamped;
    return clamped;
  }

  function moveSubjectSegment(shotId, assetId, index, newStart) {
    const shot = findShot(shotId);
    const segments = shot && shot.direction && shot.direction.subjects[assetId];
    if (!segments || !segments[index]) return null;
    const clamped = clampSegmentMove(segments, index, newStart, shotDuration(shot));
    const seg = segments[index];
    const length = seg.endSeconds - seg.startSeconds;
    seg.startSeconds = clamped;
    seg.endSeconds = clamped + length;
    return clamped;
  }

  function movePropSegmentEdge(shotId, assetId, index, side, newTime) {
    const shot = findShot(shotId);
    const segments = shot && shot.direction && shot.direction.props[assetId];
    if (!segments || !segments[index]) return null;
    const clamped = clampSegmentEdge(segments, index, side, newTime, shotDuration(shot));
    segments[index][side === 'start' ? 'startSeconds' : 'endSeconds'] = clamped;
    return clamped;
  }

  function movePropSegment(shotId, assetId, index, newStart) {
    const shot = findShot(shotId);
    const segments = shot && shot.direction && shot.direction.props[assetId];
    if (!segments || !segments[index]) return null;
    const clamped = clampSegmentMove(segments, index, newStart, shotDuration(shot));
    const seg = segments[index];
    const length = seg.endSeconds - seg.startSeconds;
    seg.startSeconds = clamped;
    seg.endSeconds = clamped + length;
    return clamped;
  }

  function splitCameraSegment(shotId, index, atTime) {
    const shot = findShot(shotId);
    const segments = shot && shot.direction && shot.direction.camera;
    if (!segments || !splitSegmentAt(segments, index, atTime)) return false;
    emit('shots-changed', { reason: 'direction' });
    return true;
  }

  function duplicateCameraSegment(shotId, index) {
    const shot = findShot(shotId);
    const segments = shot && shot.direction && shot.direction.camera;
    if (!segments || !duplicateSegmentAfter(segments, index, shotDuration(shot))) return false;
    emit('shots-changed', { reason: 'direction' });
    return true;
  }

  function toggleCameraSegmentEnabled(shotId, index) {
    const shot = findShot(shotId);
    const segments = shot && shot.direction && shot.direction.camera;
    if (!segments || !toggleSegmentEnabled(segments, index)) return false;
    emit('shots-changed', { reason: 'direction' });
    return true;
  }

  function mergeCameraSegments(shotId, index) {
    const shot = findShot(shotId);
    const segments = shot && shot.direction && shot.direction.camera;
    if (!segments || !mergeSegmentWithNext(segments, index)) return false;
    emit('shots-changed', { reason: 'direction' });
    return true;
  }

  function splitSubjectSegment(shotId, assetId, index, atTime) {
    const shot = findShot(shotId);
    const segments = shot && shot.direction && shot.direction.subjects[assetId];
    if (!segments || !splitSegmentAt(segments, index, atTime)) return false;
    emit('shots-changed', { reason: 'direction' });
    return true;
  }

  function duplicateSubjectSegment(shotId, assetId, index) {
    const shot = findShot(shotId);
    const segments = shot && shot.direction && shot.direction.subjects[assetId];
    if (!segments || !duplicateSegmentAfter(segments, index, shotDuration(shot))) return false;
    emit('shots-changed', { reason: 'direction' });
    return true;
  }

  function toggleSubjectSegmentEnabled(shotId, assetId, index) {
    const shot = findShot(shotId);
    const segments = shot && shot.direction && shot.direction.subjects[assetId];
    if (!segments || !toggleSegmentEnabled(segments, index)) return false;
    emit('shots-changed', { reason: 'direction' });
    return true;
  }

  function mergeSubjectSegments(shotId, assetId, index) {
    const shot = findShot(shotId);
    const segments = shot && shot.direction && shot.direction.subjects[assetId];
    if (!segments || !mergeSegmentWithNext(segments, index)) return false;
    emit('shots-changed', { reason: 'direction' });
    return true;
  }

  function splitPropSegment(shotId, assetId, index, atTime) {
    const shot = findShot(shotId);
    const segments = shot && shot.direction && shot.direction.props[assetId];
    if (!segments || !splitSegmentAt(segments, index, atTime)) return false;
    emit('shots-changed', { reason: 'direction' });
    return true;
  }

  function duplicatePropSegment(shotId, assetId, index) {
    const shot = findShot(shotId);
    const segments = shot && shot.direction && shot.direction.props[assetId];
    if (!segments || !duplicateSegmentAfter(segments, index, shotDuration(shot))) return false;
    emit('shots-changed', { reason: 'direction' });
    return true;
  }

  function togglePropSegmentEnabled(shotId, assetId, index) {
    const shot = findShot(shotId);
    const segments = shot && shot.direction && shot.direction.props[assetId];
    if (!segments || !toggleSegmentEnabled(segments, index)) return false;
    emit('shots-changed', { reason: 'direction' });
    return true;
  }

  function mergePropSegments(shotId, assetId, index) {
    const shot = findShot(shotId);
    const segments = shot && shot.direction && shot.direction.props[assetId];
    if (!segments || !mergeSegmentWithNext(segments, index)) return false;
    emit('shots-changed', { reason: 'direction' });
    return true;
  }

  // Beats have no persisted array entry of their own (their boundaries are
  // derived - see h3Compiler.js's collectBeatBoundaries), so a note is
  // matched/created by (startSeconds, endSeconds) via the compiler's own
  // findBeatNote rather than by index. Depends on h3Compiler.js only inside
  // this function body (evaluated well after both modules have loaded), not
  // at top-level, so the reverse of h3Compiler.js's own top-level
  // `shotsApi = MSE.shots` dependency doesn't create a load-order problem.
  function upsertBeatNote(shotId, startSeconds, endSeconds, patch) {
    const shot = findShot(shotId);
    if (!shot) return;
    const direction = ensureDirection(shot);
    const existing = MSE.h3Compiler.findBeatNote(shot, startSeconds, endSeconds);
    if (existing) {
      Object.assign(existing, patch);
    } else {
      direction.beatNotes.push({ startSeconds, endSeconds, intent: '', priority: '', endState: '', ...patch });
    }
    emit('shots-changed', { reason: 'direction' });
  }

  function removeBeatNote(shotId, index) {
    const shot = findShot(shotId);
    if (!shot || !shot.direction || !shot.direction.beatNotes || !shot.direction.beatNotes[index]) return;
    shot.direction.beatNotes.splice(index, 1);
    emit('shots-changed', { reason: 'direction' });
  }

  function setShotConstraints(shotId, constraints) {
    const shot = findShot(shotId);
    if (!shot) return;
    shot.constraints = constraints;
    emit('shots-changed', { reason: 'constraints' });
  }

  function notifyDirectionChanged() {
    emit('shots-changed', { reason: 'direction' });
  }

  MSE.shots = {
    ASSET_ROLES,
    CAMERA_MOVEMENTS,
    CAMERA_DIRECTIONS,
    CAMERA_AMPLITUDES,
    ACTION_TYPES,
    shotDuration,
    shotStatus,
    snapSeconds,
    shotAtTime,
    nearestShotStart,
    nearestShotEnd,
    gapAt,
    splitShotAt,
    createShot,
    deleteShot,
    removeBoundary,
    moveEdge,
    moveShot,
    notifyBoundaryMoved,
    setShotName,
    setShotPrompt,
    setAssetRole,
    setShotConstraints,
    addCameraSegment,
    updateCameraSegment,
    removeCameraSegment,
    splitCameraSegment,
    duplicateCameraSegment,
    toggleCameraSegmentEnabled,
    mergeCameraSegments,
    addSubjectSegment,
    updateSubjectSegment,
    removeSubjectSegment,
    splitSubjectSegment,
    duplicateSubjectSegment,
    toggleSubjectSegmentEnabled,
    mergeSubjectSegments,
    addPropSegment,
    updatePropSegment,
    removePropSegment,
    splitPropSegment,
    duplicatePropSegment,
    togglePropSegmentEnabled,
    mergePropSegments,
    moveCameraSegmentEdge,
    moveCameraSegment,
    moveSubjectSegmentEdge,
    moveSubjectSegment,
    movePropSegmentEdge,
    movePropSegment,
    upsertBeatNote,
    removeBeatNote,
    notifyDirectionChanged,
  };
})(window.MSE = window.MSE || {});
