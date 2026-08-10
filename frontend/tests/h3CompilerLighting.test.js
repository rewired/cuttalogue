// Regression coverage for Phase 4b's h3Compiler.js extensions: Camera
// optics prose, the Lighting lane's own beat contribution, Lighting
// boundaries participating in semantic beats, the Phase-4a "region alone
// never creates a beat" invariant staying intact, and environment-retention
// wording backing off "lighting" once a shot has authored Lighting
// Direction. Same harness pattern as h3CompilerCharacter.test.js/
// references.test.js - stubs MSE.shots down to just shotDuration.
//
// Run with: node frontend/tests/h3CompilerLighting.test.js
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
loadScript('assets.js');
loadScript('references.js');
window.MSE.shots = { shotDuration: (shot) => shot.endSeconds - shot.startSeconds };
loadScript('h3Compiler.js');

const { assets, h3Compiler } = window.MSE;

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

function assertIncludes(haystack, needle, label) {
  if (!haystack.includes(needle)) {
    failures += 1;
    console.error(`FAIL: ${label}\n  expected to find: ${JSON.stringify(needle)}\n  in: ${JSON.stringify(haystack)}`);
  } else {
    console.log(`ok - ${label}`);
  }
}

function assertNotIncludes(haystack, needle, label) {
  if (haystack.includes(needle)) {
    failures += 1;
    console.error(`FAIL: ${label}\n  did not expect to find: ${JSON.stringify(needle)}\n  in: ${JSON.stringify(haystack)}`);
  } else {
    console.log(`ok - ${label}`);
  }
}

function makeShot({ camera = [], lighting = [], assetIds = [], assetRoles = {}, endSeconds = 10 } = {}) {
  return {
    id: 'shot-1',
    startSeconds: 0,
    endSeconds,
    assetIds,
    assetRoles,
    constraints: [],
    direction: { camera, lighting, subjects: {}, props: {}, beatNotes: [] },
  };
}

// --- Case C: populated optics appear in compiled Camera prose -------------
{
  const shot = makeShot({
    camera: [{ startSeconds: 0, endSeconds: 10, enabled: true, movement: 'arc_shot', framing: 'close portrait', focalLength: '85mm', depthOfField: 'shallow', focusTarget: 'face' }],
  });
  const text = h3Compiler.compileH3Sections(shot).detailedDescription;
  assertIncludes(text, 'arcs around the subject', 'Case C: movement clause present');
  assertIncludes(text, 'using 85mm framing', 'Case C: focalLength clause present');
  assertIncludes(text, 'shallow depth of field', 'Case C: depthOfField maps through the centralized wording');
  assertIncludes(text, 'maintaining focus on face', 'Case C: focusTarget clause present');
}

// --- Case C2: empty optics produce no new wording (regression) ------------
{
  const shot = makeShot({ camera: [{ startSeconds: 0, endSeconds: 10, enabled: true, movement: 'static_shot' }] });
  const text = h3Compiler.compileH3Sections(shot).detailedDescription;
  assertEqual(text.includes('using'), false, 'Case C2: no focalLength clause when unset');
  assertEqual(text.includes('depth of field'), false, 'Case C2: no depthOfField clause when unset');
  assertEqual(text.includes('maintaining focus'), false, 'Case C2: no focusTarget clause when unset');
  assertIncludes(text, '[Shot 1] The camera remains static.', 'Case C2: old bare Camera segment compiles exactly as before');
}

// --- Case D: no invention of lens/aperture/brand/DOF from focalLength alone
{
  const shot = makeShot({ camera: [{ startSeconds: 0, endSeconds: 10, enabled: true, movement: 'static_shot', focalLength: '85mm' }] });
  const text = h3Compiler.compileH3Sections(shot).detailedDescription;
  assertIncludes(text, 'using 85mm framing', 'Case D: the authored focalLength itself is present');
  assertNotIncludes(text, 'f/1.4', 'Case D: no invented aperture');
  assertNotIncludes(text, 'anamorphic', 'Case D: no invented lens type');
  assertNotIncludes(text, 'Zeiss', 'Case D: no invented lens brand');
  assertNotIncludes(text, 'shallow', 'Case D: no invented depth of field when depthOfField itself is unset');
}

// --- Case I: an authored Lighting segment creates real beat boundaries ----
{
  const shot = makeShot({ lighting: [{ startSeconds: 2, endSeconds: 4, enabled: true, exposure: 'low_key' }], endSeconds: 10 });
  const boundaries = h3Compiler.collectBeatBoundaries(shot, []);
  assertEqual(boundaries, [0, 2, 4, 10], 'Case I: Lighting segment start/end (2, 4) become semantic beat boundaries, like any other authored lane');
}

// --- Case J: no authored Direction at all -> only the shot's own bounds ---
// (the Phase-4a invariant that a Phrase/Hold region boundary alone never
// becomes an H3 beat is structural, not just tested here: collectBeatBoundaries
// has no parameter for region data at all - there is no code path by which
// one could leak in.)
{
  const shot = makeShot({ endSeconds: 10 });
  const boundaries = h3Compiler.collectBeatBoundaries(shot, []);
  assertEqual(boundaries, [0, 10], 'Case J: with zero authored Camera/Lighting/Character/Prop segments, only the shot bounds are beat boundaries');
}

// --- Case K: Lighting compiler output - populated vs. empty fields --------
{
  const shot = makeShot({
    lighting: [{
      startSeconds: 0,
      endSeconds: 10,
      enabled: true,
      keyLight: 'warm stage key from camera-left',
      fill: 'minimal',
      backlight: 'subtle amber rim',
      exposure: 'low_key',
      atmosphere: 'dark smoky club',
    }],
  });
  const text = h3Compiler.compileH3Sections(shot).detailedDescription;
  assertIncludes(text, 'Lighting is low-key', 'Case K: exposure clause present');
  assertIncludes(text, 'sits in dark smoky club', 'Case K: atmosphere clause present');
  assertIncludes(text, 'keyed by warm stage key from camera-left', 'Case K: keyLight clause present');
  assertIncludes(text, 'filled by minimal', 'Case K: fill clause present');
  assertIncludes(text, 'backlit by subtle amber rim', 'Case K: backlight clause present');

  const blankShot = makeShot({ lighting: [{ startSeconds: 0, endSeconds: 10, enabled: true }] });
  const blankText = h3Compiler.compileH3Sections(blankShot).detailedDescription;
  assertEqual(blankText.includes('Lighting'), false, 'Case K: an all-empty Lighting segment contributes no sentence at all');
}

// --- Case L: a real lighting CHANGE compiles as two distinct beats, and ---
// --- environment retention no longer claims lighting stays the same ------
{
  assets.addAssets([{ id: 'club', type: 'image', fileName: 'club.png', relativePath: 'x', tags: [], metadata: {} }]);
  const shot = makeShot({
    assetIds: ['club'],
    assetRoles: { club: 'environment' },
    lighting: [
      { startSeconds: 0, endSeconds: 3, enabled: true, keyLight: 'cold blue side light' },
      { startSeconds: 3, endSeconds: 6, enabled: true, keyLight: 'warm amber frontal light' },
    ],
    endSeconds: 6,
  });
  const sections = h3Compiler.compileH3Sections(shot);
  assertIncludes(sections.detailedDescription, 'keyed by cold blue side light', 'Case L: the first Lighting beat is described');
  assertIncludes(sections.detailedDescription, 'keyed by warm amber frontal light', 'Case L: the second Lighting beat is described as an actual change, not suppressed');

  assertIncludes(sections.subjectDefinitions, 'architecture and spatial layout', 'Case L: environment retention drops "lighting" once Lighting Direction exists');
  assertNotIncludes(sections.subjectDefinitions, 'architecture, lighting, and spatial layout', 'Case L: the un-adjusted (lighting-inclusive) retention wording must not also appear');
  assertIncludes(sections.retentionAnalysis, 'architecture and spatial layout', 'Case L: retention_analysis section also drops "lighting"');
}

// --- Case L2: no Lighting Direction -> retention wording is unchanged -----
{
  assets.addAssets([{ id: 'house', type: 'image', fileName: 'house.png', relativePath: 'x', tags: [], metadata: {} }]);
  const shot = makeShot({ assetIds: ['house'], assetRoles: { house: 'environment' } });
  const sections = h3Compiler.compileH3Sections(shot);
  assertIncludes(sections.subjectDefinitions, 'architecture, lighting, and spatial layout', 'Case L2: with no Lighting segments at all, the original retention wording is preserved unchanged');
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exitCode = 1;
} else {
  console.log('\nAll h3Compiler Camera-optics/Lighting checks passed.');
}
