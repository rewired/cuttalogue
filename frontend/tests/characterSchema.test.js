// Regression coverage for Phase 4a's Character Direction schema extension
// (vocalPerformance/eyes/gesture/bodyMotion + the 'sing' action type) -
// normalization defaults for old data and the serialize/load round-trip.
// Same self-contained Node harness as the other frontend/tests/*.test.js
// files - loads the actual browser sources into the current global scope.
// Compiler output for these fields is covered separately in
// h3CompilerCharacter.test.js (no shots.js/project.js needed there).
//
// Run with: node frontend/tests/characterSchema.test.js
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
loadScript('shots.js');
loadScript('project.js');

const { state } = window.MSE.state;
const { shots, project } = window.MSE;

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

function makeRawShot(subjectSegment) {
  return {
    id: 1,
    startSeconds: 0,
    endSeconds: 10,
    direction: { camera: [], subjects: { char1: [subjectSegment] }, props: {}, beatNotes: [] },
  };
}

// --- Case A: old segment normalization ---------------------------------
{
  const raw = { shots: [makeRawShot({ startSeconds: 0, endSeconds: 2, actionType: 'stand' })] };
  const normalized = project.normalizeProjectData(raw);
  const seg = normalized.shots[0].direction.subjects.char1[0];
  assertEqual(seg.actionType, 'stand', 'Case A: pre-existing actionType is untouched');
  assertEqual(seg.vocalPerformance, '', 'Case A: vocalPerformance defaults to \'\' on an old segment');
  assertEqual(seg.eyes, '', 'Case A: eyes defaults to \'\' on an old segment');
  assertEqual(seg.gesture, '', 'Case A: gesture defaults to \'\' on an old segment');
  assertEqual(seg.bodyMotion, '', 'Case A: bodyMotion defaults to \'\' on an old segment');
}

// --- Case B: round-trip persistence -------------------------------------
{
  state.shots.length = 0;
  state.shots.push({
    id: 1,
    startSeconds: 0,
    endSeconds: 10,
    name: '',
    prompt: '',
    notes: '',
    seed: null,
    takes: [],
    activeTakeId: null,
    assetIds: ['char1'],
    assetRoles: { char1: 'primary_character' },
    videoRefs: {},
    constraints: [],
    direction: { camera: [], subjects: {}, props: {}, beatNotes: [] },
  });
  shots.addSubjectSegment(1, 'char1', {
    startSeconds: 1,
    endSeconds: 3,
    actionType: 'sing',
    vocalPerformance: 'lip_sync',
    eyes: 'closed',
    gesture: 'both hands grip microphone',
    bodyMotion: 'restrained',
  });

  const serialized = project.serializeProject();
  const roundTripped = project.normalizeProjectData(JSON.parse(JSON.stringify(serialized)));
  const seg = roundTripped.shots[0].direction.subjects.char1[0];
  assertEqual(seg.actionType, 'sing', 'Case B: actionType survives save -> load');
  assertEqual(seg.vocalPerformance, 'lip_sync', 'Case B: vocalPerformance survives save -> load');
  assertEqual(seg.eyes, 'closed', 'Case B: eyes survives save -> load');
  assertEqual(seg.gesture, 'both hands grip microphone', 'Case B: gesture survives save -> load, exact text');
  assertEqual(seg.bodyMotion, 'restrained', 'Case B: bodyMotion survives save -> load');
}

// --- Bonus: 'sing' is a first-class ACTION_TYPES entry, not just notes ---
{
  assertEqual(shots.ACTION_TYPES.includes('sing'), true, "Bonus: 'sing' is present in ACTION_TYPES");
  assertEqual(shots.VOCAL_PERFORMANCES.includes('lip_sync'), true, "Bonus: 'lip_sync' is present in VOCAL_PERFORMANCES");
  assertEqual(shots.EYE_STATES.includes('closed'), true, "Bonus: 'closed' is present in EYE_STATES");
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exitCode = 1;
} else {
  console.log('\nAll Character schema checks passed.');
}
