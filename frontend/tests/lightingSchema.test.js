// Regression coverage for Phase 4b's Lighting lane (direction.lighting) -
// old-project defaulting, persistence, and CRUD through the canonical
// shots.js mutators (same generic laneWidget-backed shape as Camera - see
// clampSegmentEdge/clampSegmentMove/splitSegmentAt/etc. in shots.js, which
// Lighting reuses unmodified). Same harness as cameraOpticsSchema.test.js.
//
// Run with: node frontend/tests/lightingSchema.test.js
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

function seedShot() {
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
  return state.shots[0];
}

// --- Case E: old project default ------------------------------------------
{
  // A shot whose direction predates the Lighting lane entirely (no key at
  // all, not even an empty array).
  const raw = { shots: [{ id: 1, startSeconds: 0, endSeconds: 10, direction: { camera: [], subjects: {}, props: {}, beatNotes: [] } }] };
  const normalized = project.normalizeProjectData(raw);
  assertEqual(normalized.shots[0].direction.lighting, [], 'Case E: direction without a lighting key normalizes to []');

  // A shot with no `direction` object at all.
  const rawBare = { shots: [{ id: 1, startSeconds: 0, endSeconds: 10 }] };
  const normalizedBare = project.normalizeProjectData(rawBare);
  assertEqual(normalizedBare.shots[0].direction.lighting, [], 'Case E: a shot missing `direction` entirely still gets direction.lighting = []');
}

// --- Case F: Lighting persistence -----------------------------------------
{
  const shot = seedShot();
  shots.addLightingSegment(shot.id, {
    startSeconds: 0,
    endSeconds: 4,
    keyLight: 'warm stage key from camera-left',
    fill: 'minimal',
    backlight: 'subtle amber rim',
    exposure: 'low_key',
    atmosphere: 'dark smoky club',
    notes: 'fog machine active',
  });
  const serialized = project.serializeProject();
  const roundTripped = project.normalizeProjectData(JSON.parse(JSON.stringify(serialized)));
  const seg = roundTripped.shots[0].direction.lighting[0];
  assertEqual(seg.keyLight, 'warm stage key from camera-left', 'Case F: keyLight survives save -> load');
  assertEqual(seg.fill, 'minimal', 'Case F: fill survives save -> load');
  assertEqual(seg.backlight, 'subtle amber rim', 'Case F: backlight survives save -> load');
  assertEqual(seg.exposure, 'low_key', 'Case F: exposure survives save -> load');
  assertEqual(seg.atmosphere, 'dark smoky club', 'Case F: atmosphere survives save -> load');
  assertEqual(seg.notes, 'fog machine active', 'Case F: notes survives save -> load');
}

// --- Case G: Lighting CRUD via canonical Direction behavior ---------------
{
  const shot = seedShot();

  // Create
  shots.addLightingSegment(shot.id, { startSeconds: 0, endSeconds: 3, exposure: 'low_key' });
  assertEqual(shot.direction.lighting.length, 1, 'Case G: addLightingSegment creates one segment');
  assertEqual(shot.direction.lighting[0].enabled, true, 'Case G: a new Lighting segment defaults to enabled');

  // Move (whole segment)
  shots.moveLightingSegment(shot.id, 0, 1);
  assertEqual(shot.direction.lighting[0].startSeconds, 1, 'Case G: moveLightingSegment shifts the whole segment');
  assertEqual(shot.direction.lighting[0].endSeconds, 4, 'Case G: moveLightingSegment preserves duration');

  // Resize (edge)
  shots.moveLightingSegmentEdge(shot.id, 0, 'end', 6);
  assertEqual(shot.direction.lighting[0].endSeconds, 6, 'Case G: moveLightingSegmentEdge resizes the end edge');

  // Split
  const splitOk = shots.splitLightingSegment(shot.id, 0, 3);
  assertEqual(splitOk, true, 'Case G: splitLightingSegment succeeds mid-segment');
  assertEqual(shot.direction.lighting.length, 2, 'Case G: split produces two segments');

  // Duplicate - the second (last) segment has room to grow into per
  // duplicateSegmentAfter's own contract (no "next" segment capping it);
  // the first segment has none (it's contiguous with the second).
  const beforeDuplicate = shot.direction.lighting.length;
  const lastIndex = shot.direction.lighting.length - 1;
  const duplicateOk = shots.duplicateLightingSegment(shot.id, lastIndex);
  assertEqual(duplicateOk, true, 'Case G: duplicateLightingSegment succeeds when there is room to grow into');
  assertEqual(shot.direction.lighting.length, beforeDuplicate + 1, 'Case G: duplicateLightingSegment adds a copy');

  // Toggle enabled
  shots.toggleLightingSegmentEnabled(shot.id, 0);
  assertEqual(shot.direction.lighting[0].enabled, false, 'Case G: toggleLightingSegmentEnabled flips enabled off');
  shots.toggleLightingSegmentEnabled(shot.id, 0);
  assertEqual(shot.direction.lighting[0].enabled, true, 'Case G: toggling again flips it back on');

  // Merge contiguous segments (rebuild a clean contiguous pair first)
  shot.direction.lighting = [
    { startSeconds: 0, endSeconds: 3, exposure: 'low_key', enabled: true },
    { startSeconds: 3, endSeconds: 6, exposure: 'bright', enabled: true },
  ];
  const mergeOk = shots.mergeLightingSegments(shot.id, 0);
  assertEqual(mergeOk, true, 'Case G: mergeLightingSegments succeeds on contiguous segments');
  assertEqual(shot.direction.lighting.length, 1, 'Case G: merge collapses to one segment');
  assertEqual(shot.direction.lighting[0].endSeconds, 6, 'Case G: the merged segment extends to the second segment\'s end');

  // Delete
  shots.removeLightingSegment(shot.id, 0);
  assertEqual(shot.direction.lighting.length, 0, 'Case G: removeLightingSegment deletes it');
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exitCode = 1;
} else {
  console.log('\nAll Lighting schema/CRUD checks passed.');
}
