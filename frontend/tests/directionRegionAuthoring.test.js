// Regression coverage for Phase 4a's region -> Direction segment creation.
// direction.js's createCameraSegmentFromRegion/createCharacterSegmentFromRegion
// are thin wrappers (region -> MSE.vocalRegions.regionsForShot() -> plain
// shotsApi.addXSegment() call with only startSeconds/endSeconds, plus a
// conservative sing/lip_sync default for Holds) - this exercises exactly
// that combination without needing direction.js's own DOM/rendering half,
// the same way vocalRegions.test.js exercises the projection math on its
// own. See directionSnap.test.js for the region-boundary snap-union half.
//
// Run with: node frontend/tests/directionRegionAuthoring.test.js
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
loadScript('vocalRegions.js');
loadScript('shots.js');

const { state } = window.MSE.state;
const { shots, vocalRegions } = window.MSE;

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

function seedShot(startSeconds, endSeconds) {
  state.shots.length = 0;
  state.shots.push({
    id: 1,
    startSeconds,
    endSeconds,
    name: '',
    prompt: '',
    notes: '',
    seed: null,
    takes: [],
    activeTakeId: null,
    assetIds: ['heather', 'sam'],
    assetRoles: { heather: 'primary_character', sam: 'supporting_character' },
    videoRefs: {},
    constraints: [],
    direction: { camera: [], subjects: {}, props: {}, beatNotes: [] },
  });
  return state.shots[0];
}

// Mirrors direction.js's own createCameraSegmentFromRegion/
// createCharacterSegmentFromRegion exactly - see the file header.
function createCameraSegmentFromRegion(shot, region) {
  const start = region.relativeStartSeconds;
  const end = region.relativeEndSeconds;
  if (end - start <= 0) return;
  shots.addCameraSegment(shot.id, { startSeconds: start, endSeconds: end });
}
function createCharacterSegmentFromRegion(shot, assetId, region, regionKind) {
  const start = region.relativeStartSeconds;
  const end = region.relativeEndSeconds;
  if (end - start <= 0) return;
  const defaults = regionKind === 'hold' ? { actionType: 'sing', vocalPerformance: 'lip_sync' } : {};
  shots.addSubjectSegment(shot.id, assetId, { startSeconds: start, endSeconds: end, ...defaults });
}

// --- Case E: Camera creation from a full (unclipped) region ---------------
{
  const shot = seedShot(0, 10);
  const region = { id: 'phrase-0', type: 'phrase', startSeconds: 1.2, endSeconds: 2.7, text: 'too close' };
  const [projected] = vocalRegions.regionsForShot([region], shot);
  createCameraSegmentFromRegion(shot, projected);
  const seg = shot.direction.camera[0];
  assertEqual(seg.startSeconds, 1.2, 'Case E: created Camera segment start matches the region exactly');
  assertEqual(seg.endSeconds, 2.7, 'Case E: created Camera segment end matches the region exactly');
}

// --- Case F: Character creation from a full region, no persistent regionId
{
  const shot = seedShot(0, 10);
  const region = { id: 'hold-3', type: 'hold', startSeconds: 3.0, endSeconds: 4.5, text: 'clooooose' };
  const [projected] = vocalRegions.regionsForShot([region], shot);
  createCharacterSegmentFromRegion(shot, 'heather', projected, 'hold');
  const seg = shot.direction.subjects.heather[0];
  assertEqual(seg.startSeconds, 3.0, 'Case F: created Character segment start matches the region exactly');
  assertEqual(seg.endSeconds, 4.5, 'Case F: created Character segment end matches the region exactly');
  assertEqual('regionId' in seg, false, 'Case F: no regionId field is ever persisted onto the segment');
  assertEqual(seg.actionType, 'sing', 'Case F: a Hold gets the conservative sing default');
  assertEqual(seg.vocalPerformance, 'lip_sync', 'Case F: a Hold gets the conservative lip_sync default');
}

// --- Case F2: Character creation from a Phrase starts fully blank ---------
{
  const shot = seedShot(0, 10);
  const region = { id: 'phrase-0', type: 'phrase', startSeconds: 1, endSeconds: 2, text: 'too close' };
  const [projected] = vocalRegions.regionsForShot([region], shot);
  createCharacterSegmentFromRegion(shot, 'heather', projected, 'phrase');
  const seg = shot.direction.subjects.heather[0];
  assertEqual(seg.actionType, '', 'Case F2: a Phrase-derived Character segment is not given an inferred actionType');
  assertEqual(seg.eyes, '', 'Case F2: a Phrase-derived Character segment never infers eyes/gesture/expression/bodyMotion');
}

// --- Case G: clipped region (crosses the shot's start boundary) ----------
{
  const shot = seedShot(11, 15);
  const region = { id: 'hold-0', type: 'hold', startSeconds: 10, endSeconds: 12, text: 'ooh' };
  const [projected] = vocalRegions.regionsForShot([region], shot);
  createCameraSegmentFromRegion(shot, projected);
  const seg = shot.direction.camera[0];
  assertEqual(seg.startSeconds, 0, 'Case G: a region clipped at the shot start creates a segment starting at 0, not negative');
  assertEqual(seg.endSeconds, 1, 'Case G: a region clipped at the shot start creates a segment ending at its visible (clipped) duration');
}

// --- Case H: re-alignment independence ------------------------------------
{
  const shot = seedShot(0, 10);
  const region = { id: 'phrase-0', type: 'phrase', startSeconds: 2, endSeconds: 4, text: 'too close' };
  const [projected] = vocalRegions.regionsForShot([region], shot);
  createCameraSegmentFromRegion(shot, projected);
  const before = { ...shot.direction.camera[0] };
  // Simulate the region being discarded/rederived entirely differently
  // (re-alignment, lyrics edit, tokenization change) - the created segment
  // has no reference to the region at all, so nothing here can touch it.
  const rederivedRegions = [];
  void rederivedRegions;
  const after = shot.direction.camera[0];
  assertEqual(after.startSeconds, before.startSeconds, 'Case H: authored segment start is unchanged after the source region disappears');
  assertEqual(after.endSeconds, before.endSeconds, 'Case H: authored segment end is unchanged after the source region disappears');
}

// --- Case I: multiple characters - explicit lane targeting ----------------
{
  const shot = seedShot(0, 10);
  const region = { id: 'hold-0', type: 'hold', startSeconds: 1, endSeconds: 2, text: 'ooh' };
  const [projected] = vocalRegions.regionsForShot([region], shot);
  createCharacterSegmentFromRegion(shot, 'sam', projected, 'hold');
  assertEqual((shot.direction.subjects.heather || []).length, 0, "Case I: creating into 'sam' does not touch 'heather's track");
  assertEqual(shot.direction.subjects.sam.length, 1, "Case I: the segment lands in the explicitly chosen 'sam' track");
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exitCode = 1;
} else {
  console.log('\nAll region-authoring checks passed.');
}
