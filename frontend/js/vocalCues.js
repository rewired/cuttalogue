// Vocal cues: project-absolute song-timing anchors (Phase 2 of docs/h3-shot-
// direction-roadmap.md) - manually authored markers like 54.82s "too close"
// that stay meaningful regardless of how shot boundaries move. This is the
// single canonical place that creates/mutates state.vocalCues; the main
// timeline (waveformSync.js) and the Direction editor (direction.js) both
// consume it rather than touching state.vocalCues directly, the same
// separation shots.js/assets.js keep from their own UI layers.
//
// A cue is a timeline anchor, not an H3 prompt instruction - nothing here
// feeds the compiler (h3Compiler.js) or creates a semantic beat boundary by
// itself. Only an authored Direction segment edge does that.
(function (MSE) {
  'use strict';

  const { state, emit } = MSE.state;

  // Identity is a stable, opaque id - never the label - so a later phase can
  // reference "cueId cue-abc123" even after the cue is renamed. Timestamp +
  // counter + a few random base36 chars: unique enough for manually-created
  // cues without pulling in a UUID dependency, matching the lightweight id
  // style already used for takes (contextPanel.js's `local-${Date.now()}`).
  let cueSeq = 0;
  function makeCueId() {
    cueSeq += 1;
    return `cue-${Date.now().toString(36)}-${cueSeq.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  }

  // Array.prototype.sort is spec-guaranteed stable (ES2019+), so cues sharing
  // an exact timestamp keep their prior relative order (insertion order for a
  // freshly-added cue) rather than an arbitrary one - same reasoning as
  // references.js's role sort.
  function sortCues() {
    state.vocalCues.sort((a, b) => a.timeSeconds - b.timeSeconds);
  }

  function list() {
    return state.vocalCues;
  }

  function findCue(cueId) {
    return state.vocalCues.find((c) => c.id === cueId) || null;
  }

  function add(timeSeconds, label) {
    const cue = { id: makeCueId(), timeSeconds: Math.max(0, timeSeconds), label: label || '' };
    state.vocalCues.push(cue);
    sortCues();
    emit('vocal-cues-changed', { reason: 'add', cueId: cue.id });
    return cue;
  }

  // Generic mutator - rename()/move() below are just thin, named wrappers
  // over this for callers that only ever touch one field.
  function update(cueId, patch) {
    const cue = findCue(cueId);
    if (!cue) return;
    if (patch.label !== undefined) cue.label = patch.label;
    if (patch.timeSeconds !== undefined) cue.timeSeconds = Math.max(0, patch.timeSeconds);
    sortCues();
    emit('vocal-cues-changed', { reason: 'update', cueId });
  }

  function rename(cueId, label) {
    update(cueId, { label });
  }

  function move(cueId, timeSeconds) {
    update(cueId, { timeSeconds });
  }

  function remove(cueId) {
    const before = state.vocalCues.length;
    state.vocalCues = state.vocalCues.filter((c) => c.id !== cueId);
    if (state.vocalCues.length === before) return false;
    emit('vocal-cues-changed', { reason: 'remove', cueId });
    return true;
  }

  // Cues whose absolute timestamp lies inside the given shot, each annotated
  // with its shot-relative position - end-exclusive, matching shots.js's own
  // shotAtTime() convention (a time exactly on a shared boundary belongs to
  // the shot starting there, not the one ending there). Never invents cues in
  // H3's render overhang: the bound is shot.endSeconds, not the wider
  // Direction domainDuration.
  function forShot(shot) {
    if (!shot) return [];
    return state.vocalCues
      .filter((c) => c.timeSeconds >= shot.startSeconds && c.timeSeconds < shot.endSeconds)
      .map((c) => ({ ...c, relativeTimeSeconds: c.timeSeconds - shot.startSeconds }));
  }

  // Nearest cue (by absolute song time) to the given time, or null if there
  // are no cues at all. Used for the loop/playhead-style "snap to nearest
  // event" queries - Direction's own grid+cue snap union (see direction.js's
  // snapToDirectionGrid) works in shot-relative space instead and calls
  // forShot() directly rather than this.
  function nearest(timeSeconds) {
    if (!state.vocalCues.length) return null;
    return state.vocalCues.reduce((best, c) =>
      (Math.abs(c.timeSeconds - timeSeconds) < Math.abs(best.timeSeconds - timeSeconds) ? c : best)
    );
  }

  // Picks whichever candidate time lands closest to referenceTime - the
  // union-of-grid-and-cues snap rule Direction's segment drag/resize uses
  // (see direction.js's snapToDirectionGrid): candidates is typically
  // [nearestGridTime, ...cueRelativeTimes]. null/undefined entries (e.g. "no
  // valid grid step at this zoom") are ignored; returns null if nothing's
  // left to snap to.
  function nearestOf(candidates, referenceTime) {
    const valid = candidates.filter((t) => t !== null && t !== undefined);
    if (!valid.length) return null;
    return valid.reduce((best, t) => (Math.abs(t - referenceTime) < Math.abs(best - referenceTime) ? t : best));
  }

  MSE.vocalCues = { list, add, update, rename, move, remove, forShot, nearest, nearestOf };
})(window.MSE = window.MSE || {});
