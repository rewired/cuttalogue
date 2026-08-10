// Regression coverage for the canonical reference binding (references.js,
// Phase 0 of docs/h3-shot-direction-roadmap.md). The repo has no test
// framework/runner installed, so this is a small self-contained Node script
// (no dependencies) that loads the actual browser sources - the same files
// index.html serves - into the current global scope and asserts against
// them directly. Run with: node frontend/tests/references.test.js
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

// The real app boots these via <script> tags (index.html); window.MSE is
// the shared namespace every module attaches to. EventTarget/CustomEvent
// (used by state.js's event bus) are Node globals already, so the real
// source files load unmodified.
global.window = global;
global.MSE = undefined;

loadScript('state.js');
loadScript('assets.js');
loadScript('references.js');
// h3Compiler.js only needs MSE.shots.shotDuration - stub it rather than
// pull in shots.js's own MSE.grid/MSE.frames dependencies, which are
// irrelevant to reference-order behavior.
window.MSE.shots = { shotDuration: (shot) => shot.endSeconds - shot.startSeconds };
loadScript('h3Compiler.js');

const { assets, references, h3Compiler } = window.MSE;

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

function makeAsset(id, type) {
  return { id, type, fileName: `${id}.png`, relativePath: `assets/${id}/file.png`, tags: [], metadata: {} };
}

function makeShot(assetIds, assetRoles) {
  return {
    id: 'shot-1',
    startSeconds: 0,
    endSeconds: 10,
    assetIds,
    assetRoles,
    constraints: [],
    direction: { camera: [], subjects: {}, props: {}, beatNotes: [] },
  };
}

// --- Case A: assignment order differs from role order ---------------------
{
  assets.addAssets([makeAsset('location', 'image'), makeAsset('character', 'image')]);
  const shot = makeShot(
    ['location', 'character'],
    { location: 'environment', character: 'primary_character' }
  );
  const binding = references.forShot(shot);
  assertEqual(binding.map((r) => r.assetId), ['character', 'location'], 'Case A: binding order follows role, not assignment order');
  assertEqual(references.referenceAssetIds(shot), ['character', 'location'], 'Case A: referenceAssetIds matches binding order');
  assertEqual(binding[0].pictureIndex, 1, 'Case A: Picture 1 is the primary character');
}

// --- Case B: unroled image between references -----------------------------
{
  assets.addAssets([makeAsset('moodImage', 'image')]);
  const shot = makeShot(
    ['location', 'moodImage', 'character'],
    { location: 'environment', character: 'primary_character' } // moodImage: no role
  );
  const binding = references.forShot(shot);
  assertEqual(binding.map((r) => r.assetId), ['character', 'location'], 'Case B: unroled moodImage excluded from binding');
  assertEqual(references.referenceAssetIds(shot), ['character', 'location'], 'Case B: unroled moodImage excluded from referenceAssetIds');
}

// --- Case C: same-role stability -------------------------------------------
{
  assets.addAssets([makeAsset('supA', 'image'), makeAsset('supB', 'image')]);
  const shot = makeShot(
    ['supB', 'supA'],
    { supB: 'supporting_character', supA: 'supporting_character' }
  );
  const binding = references.forShot(shot);
  assertEqual(binding.map((r) => r.assetId), ['supB', 'supA'], 'Case C: equal-role assets keep assignment order');
}

// --- Case D: prop ordering (primary, supporting, environment, prop) -------
{
  assets.addAssets([
    makeAsset('prop1', 'image'),
    makeAsset('env1', 'image'),
    makeAsset('primary1', 'image'),
    makeAsset('support1', 'image'),
  ]);
  const shot = makeShot(
    ['prop1', 'env1', 'primary1', 'support1'],
    { prop1: 'prop', env1: 'environment', primary1: 'primary_character', support1: 'supporting_character' }
  );
  const binding = references.forShot(shot);
  assertEqual(
    binding.map((r) => r.assetId),
    ['primary1', 'support1', 'env1', 'prop1'],
    'Case D: primary > supporting > environment > prop'
  );
}

// --- Case E: compiler/generation invariant ---------------------------------
{
  const shot = makeShot(
    ['location', 'moodImage', 'character'],
    { location: 'environment', character: 'primary_character' }
  );
  const binding = references.forShot(shot);
  const referenceAssetIdsForGenerate = references.referenceAssetIds(shot); // what contextPanel.js's Generate handler now sends
  const sections = h3Compiler.compileH3Sections(shot);

  binding.forEach((ref) => {
    const pictureTag = `<Picture ${ref.pictureIndex}>`;
    assertEqual(
      sections.subjectDefinitions.includes(pictureTag) && sections.subjectDefinitions.includes(`<${ref.subjectLabel}>`),
      true,
      `Case E: compiler emits ${pictureTag} for ${ref.subjectLabel} (${ref.assetId})`
    );
    assertEqual(
      referenceAssetIdsForGenerate[ref.pictureIndex - 1],
      ref.assetId,
      `Case E: referenceAssetIds[${ref.pictureIndex - 1}] (ref_image_${ref.pictureIndex - 1}) === ${ref.assetId}, matching ${pictureTag}`
    );
  });
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exitCode = 1;
} else {
  console.log('\nAll reference-binding checks passed.');
}
