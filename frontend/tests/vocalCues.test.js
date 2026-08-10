// Regression coverage for vocal cues (vocalCues.js, Phase 2 of docs/h3-shot-
// direction-roadmap.md: manually-authored, project-absolute song-timing
// anchors). Same self-contained Node harness as references.test.js - no test
// framework/runner installed, loads the actual browser sources index.html
// serves into the current global scope and asserts against them directly.
// Run with: node frontend/tests/vocalCues.test.js
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const JS_DIR = path.join(__dirname, '..', 'js');

function loadScript(fileName) {
  const filePath = path.join(JS_DIR, fileName);
  const code = fs.readFileSync(filePath, 'utf8');
  vm.runInThisContext(code, { filename: filePath });
}

global.window = global;
global.MSE = undefined;

loadScript('state.js');
loadScript('musicalGrid.js');
loadScript('frameMath.js');
loadScript('vocalCues.js');
loadScript('shots.js');
loadScript('project.js');

const { state } = window.MSE.state;
const { vocalCues, shots: shotsApi, project } = window.MSE;

let failures = 0;

function assertEqual(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    failures += 1;
    console.error(`FAIL: ${label}\n  expected: ${e}\n  actual:   ${a}`);
  } else {
    console.log(`ok - ${label}`);
  }
}

function resetCues() {
  state.vocalCues.length = 0;
}

// --- Case A: persistence/default -------------------------------------------
{
  const normalizedEmpty = project.normalizeProjectData({});
  assertEqual(normalizedEmpty.vocalCues, [], 'Case A: a project with no vocalCues field normalizes to []');

  const normalizedForeign = project.normalizeProjectData({
    vocalCues: [
      { id: 'cue-b', timeSeconds: 5, label: 'hi' },
      { id: 'cue-a', timeSeconds: 2 }, // no label - must default to ''
    ],
  });
  assertEqual(
    normalizedForeign.vocalCues.map((c) => ({ id: c.id, timeSeconds: c.timeSeconds, label: c.label })),
    [
      { id: 'cue-a', timeSeconds: 2, label: '' },
      { id: 'cue-b', timeSeconds: 5, label: 'hi' },
    ],
    'Case A: existing cues survive normalization, sorted ascending, missing label defaulted'
  );

  resetCues();
  vocalCues.add(54.82, 'too close');
  vocalCues.add(55.61, 'clooooose');
  const serialized = project.serializeProject();
  assertEqual(
    serialized.vocalCues.map((c) => ({ timeSeconds: c.timeSeconds, label: c.label, hasId: typeof c.id === 'string' && c.id.length > 0 })),
    [
      { timeSeconds: 54.82, label: 'too close', hasId: true },
      { timeSeconds: 55.61, label: 'clooooose', hasId: true },
    ],
    'Case A: serializeProject emits the live cues with stable ids'
  );
  // Round-trip: serialize -> normalize (as if reloaded from disk) -> same data.
  const roundTripped = project.normalizeProjectData(JSON.parse(JSON.stringify(serialized)));
  const shape = (cues) => cues.map((c) => ({ id: c.id, timeSeconds: c.timeSeconds, label: c.label }));
  assertEqual(shape(roundTripped.vocalCues), shape(serialized.vocalCues), 'Case A: cues survive a serialize -> reload round-trip unchanged');
}

// --- Case B: forShot() -------------------------------------------------------
{
  resetCues();
  const shot = { startSeconds: 10, endSeconds: 15 };
  [9.9, 10.0, 12.5, 15.0].forEach((t) => vocalCues.add(t, `cue@${t}`));
  const inShot = vocalCues.forShot(shot);
  assertEqual(inShot.map((c) => c.timeSeconds), [10, 12.5], 'Case B: end-exclusive forShot() returns only in-range cues');
  assertEqual(inShot.map((c) => c.relativeTimeSeconds), [0, 2.5], 'Case B: relativeTimeSeconds = timeSeconds - shot.startSeconds');
}

// --- Case C: deterministic ordering -----------------------------------------
{
  resetCues();
  vocalCues.add(5, 'third');
  vocalCues.add(1, 'first');
  vocalCues.add(3, 'second');
  assertEqual(vocalCues.list().map((c) => c.label), ['first', 'second', 'third'], 'Case C: ascending order regardless of insertion order');

  resetCues();
  vocalCues.add(2, 'alpha');
  vocalCues.add(2, 'beta');
  assertEqual(vocalCues.list().map((c) => c.label), ['alpha', 'beta'], 'Case C: equal-timestamp cues keep insertion order (stable tie-break)');
}

// --- Case D: moving a shot does not mutate cues -----------------------------
{
  resetCues();
  const cue = vocalCues.add(50.0, 'anchor');
  const shot = { startSeconds: 48, endSeconds: 52 };
  assertEqual(vocalCues.forShot(shot)[0].relativeTimeSeconds, 2, 'Case D: relative position before the shot moves');
  // Simulate a shot drag from 48-52 to 49-53 without touching the cue API at all.
  shot.startSeconds = 49;
  shot.endSeconds = 53;
  assertEqual(cue.timeSeconds, 50.0, 'Case D: cue.timeSeconds is untouched by a shot move');
  assertEqual(vocalCues.forShot(shot)[0].relativeTimeSeconds, 1, 'Case D: relative position is recomputed, not stored');
}

// --- Case E: nearest snap target (grid + cues union) ------------------------
{
  assertEqual(vocalCues.nearestOf([2.0, 2.137], 2.12), 2.137, 'Case E: cue candidate wins when it is closer to the pointer');
  assertEqual(vocalCues.nearestOf([2.0, 2.137], 2.02), 2.0, 'Case E: grid candidate wins when it is closer to the pointer');
  assertEqual(vocalCues.nearestOf([null, 2.137], 2.12), 2.137, 'Case E: a null grid candidate (no valid step) is ignored');
  assertEqual(vocalCues.nearestOf([], 1), null, 'Case E: no candidates at all -> null (nothing to snap to)');
}

// --- Case F: shot boundary isolation -----------------------------------------
{
  resetCues();
  vocalCues.add(52, 'boundary');
  const shotA = { startSeconds: 48, endSeconds: 52 };
  const shotB = { startSeconds: 52, endSeconds: 56 };
  assertEqual(vocalCues.forShot(shotA).length, 0, 'Case F: a cue exactly at shot.endSeconds is excluded from that shot');
  assertEqual(vocalCues.forShot(shotB).map((c) => c.relativeTimeSeconds), [0], 'Case F: it belongs to the following shot instead, at relative 0');
}

// --- Case G: project cues survive shot create/split/move/delete ------------
{
  resetCues();
  state.audio.mix.durationSeconds = 100;
  state.shots.length = 0;
  const cue = vocalCues.add(25, 'anchor');

  shotsApi.createShot(20, 30);
  shotsApi.createShot(40, 50);
  const before = JSON.stringify(state.vocalCues);

  shotsApi.splitShotAt(45);
  shotsApi.moveShot(state.shots[0].id, 21, { snap: false });
  shotsApi.deleteShot(state.shots[state.shots.length - 1].id);

  assertEqual(JSON.stringify(state.vocalCues), before, 'Case G: vocalCues array is untouched by shot create/split/move/delete');
  assertEqual(cue.timeSeconds, 25, 'Case G: the cue object itself keeps its original timestamp');
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exitCode = 1;
} else {
  console.log('\nAll vocal cue checks passed.');
}
