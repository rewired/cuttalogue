// Regression coverage for Phase 4b's Camera optics schema extension
// (focalLength/depthOfField/focusTarget) - normalization defaults for old
// data and the serialize/load round-trip. Same harness as
// characterSchema.test.js. Compiler output for these fields is covered
// separately in h3CompilerLighting.test.js (no shots.js/project.js needed
// there).
//
// Run with: node frontend/tests/cameraOpticsSchema.test.js
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

// --- Case A: old Camera normalization ------------------------------------
{
  const raw = {
    shots: [
      {
        id: 1,
        startSeconds: 0,
        endSeconds: 10,
        direction: { camera: [{ startSeconds: 0, endSeconds: 5, movement: 'static_shot' }], subjects: {}, props: {}, beatNotes: [] },
      },
    ],
  };
  const normalized = project.normalizeProjectData(raw);
  const seg = normalized.shots[0].direction.camera[0];
  assertEqual(seg.movement, 'static_shot', 'Case A: pre-existing movement is untouched');
  assertEqual(seg.focalLength, '', "Case A: focalLength defaults to '' on an old Camera segment");
  assertEqual(seg.depthOfField, '', "Case A: depthOfField defaults to '' on an old Camera segment");
  assertEqual(seg.focusTarget, '', "Case A: focusTarget defaults to '' on an old Camera segment");
  // Older projects predate the whole Lighting lane, not just optics.
  assertEqual(normalized.shots[0].direction.lighting, [], "Case A: a project with no lighting key normalizes to direction.lighting = []");
}

// --- Case B: persistence --------------------------------------------------
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
    assetIds: [],
    assetRoles: {},
    videoRefs: {},
    constraints: [],
    direction: { camera: [], lighting: [], subjects: {}, props: {}, beatNotes: [] },
  });
  shots.addCameraSegment(1, {
    startSeconds: 0,
    endSeconds: 5,
    movement: 'arc_shot',
    focalLength: '85mm',
    depthOfField: 'shallow',
    focusTarget: 'face',
  });

  const serialized = project.serializeProject();
  const roundTripped = project.normalizeProjectData(JSON.parse(JSON.stringify(serialized)));
  const seg = roundTripped.shots[0].direction.camera[0];
  assertEqual(seg.focalLength, '85mm', 'Case B: focalLength survives save -> load');
  assertEqual(seg.depthOfField, 'shallow', 'Case B: depthOfField survives save -> load');
  assertEqual(seg.focusTarget, 'face', 'Case B: focusTarget survives save -> load');
}

// --- Bonus: controlled vocabularies exported ------------------------------
{
  assertEqual(shots.FOCAL_LENGTHS.includes('85mm'), true, "Bonus: '85mm' is one of the FOCAL_LENGTHS suggestions");
  assertEqual(shots.DEPTH_OF_FIELDS.includes('shallow'), true, "Bonus: 'shallow' is present in DEPTH_OF_FIELDS");
  assertEqual(shots.DEPTH_OF_FIELDS[0], '', "Bonus: '' (unset) is the first DEPTH_OF_FIELDS option");
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exitCode = 1;
} else {
  console.log('\nAll Camera optics schema checks passed.');
}
