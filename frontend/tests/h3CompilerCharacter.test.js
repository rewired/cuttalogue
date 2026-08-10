// Regression coverage for Phase 4a's h3Compiler.js Character phrase
// generation (vocalPerformance/eyes/gesture/bodyMotion). Same harness
// pattern as references.test.js - stubs MSE.shots down to just the one
// function h3Compiler.js actually needs (shotDuration), since compiler
// output only depends on what's already sitting in shot.direction, not on
// shots.js's own mutators.
//
// Run with: node frontend/tests/h3CompilerCharacter.test.js
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

function makeShot(subjectSegment) {
  return {
    id: 'shot-1',
    startSeconds: 0,
    endSeconds: 10,
    assetIds: ['heather'],
    assetRoles: { heather: 'primary_character' },
    constraints: [],
    direction: {
      camera: [],
      subjects: { heather: [{ startSeconds: 0, endSeconds: 10, enabled: true, ...subjectSegment }] },
      props: {},
      beatNotes: [],
    },
  };
}

assets.addAssets([{ id: 'heather', type: 'image', fileName: 'heather.png', relativePath: 'x', tags: [], metadata: {} }]);

// --- Case C: populated fields appear, no duplicated singing/lip-sync phrasing
{
  const shot = makeShot({
    actionType: 'sing',
    vocalPerformance: 'lip_sync',
    expression: 'emotionally intense',
    eyes: 'closed',
    gesture: 'both hands grip microphone',
    bodyMotion: 'restrained',
  });
  const sections = h3Compiler.compileH3Sections(shot);
  const text = sections.detailedDescription;
  assertIncludes(text, 'sings', 'Case C: actionType sing compiles to "sings"');
  assertIncludes(text, 'precise, natural lip sync', 'Case C: vocalPerformance lip_sync produces the lip-sync clause');
  assertIncludes(text, "expression is emotionally intense", 'Case C: expression sentence present');
  assertIncludes(text, 'eyes closed', 'Case C: eyes clause present');
  assertIncludes(text, 'Both hands grip microphone.', 'Case C: gesture appears as its own capitalized sentence, exact wording preserved');
  assertIncludes(text, 'restrained', 'Case C: bodyMotion appears');
  // No duplicated singing/lip-sync phrasing ("She sings. She is singing."
  // pattern from the spec's own anti-example) - the standalone 'singing'
  // clause must never appear alongside the actionType-driven "sings".
  assertNotIncludes(text, 'singing', 'Case C: no redundant standalone "singing" clause when actionType is already sing');
  const singCount = (text.match(/\bsings\b/g) || []).length;
  assertEqual(singCount, 1, 'Case C: "sings" appears exactly once, not repeated');
}

// --- Case C2: vocalPerformance independent of a different actionType ------
{
  const shot = makeShot({ actionType: 'stand', vocalPerformance: 'sing' });
  const text = h3Compiler.compileH3Sections(shot).detailedDescription;
  assertIncludes(text, 'stands', 'Case C2: actionType stand compiles to "stands"');
  assertIncludes(text, 'singing', 'Case C2: vocalPerformance sing (with a different actionType) adds its own "singing" clause');
}

// --- Case G (Phase 4b preflight): expression grammar, no naked "a X" bug --
{
  // Regression for the "with a emotionally intense expression" bug (missing
  // "n") - the fix uses a predicate-adjective sentence that never needs an
  // a/an article at all, so it must be correct for ANY expression text,
  // including ones starting with a vowel sound.
  const vowelShot = makeShot({ expression: 'emotionally intense' });
  const vowelText = h3Compiler.compileH3Sections(vowelShot).detailedDescription;
  assertIncludes(vowelText, "<Subject 1>'s expression is emotionally intense.", 'Case G: vowel-initial expression compiles without a dropped/wrong article');
  assertNotIncludes(vowelText, 'a emotionally intense', 'Case G: the old ungrammatical "a emotionally intense" phrasing never appears');
  assertNotIncludes(vowelText, 'an emotionally intense', 'Case G: no a/an article is used at all (article-free construction)');

  const consonantShot = makeShot({ expression: 'confident' });
  const consonantText = h3Compiler.compileH3Sections(consonantShot).detailedDescription;
  assertIncludes(consonantText, "<Subject 1>'s expression is confident.", 'Case G: consonant-initial expression is unaffected by the fix');
}

// --- Case D: existing compiler regression (no new fields set) -------------
{
  const shotOld = makeShot({ actionType: 'stand', manner: 'confident', gaze: 'camera', expression: 'determined', notes: 'holds a coffee cup' });
  const text = h3Compiler.compileH3Sections(shotOld).detailedDescription;
  assertIncludes(text, 'stands, confident', 'Case D: actionType + manner clause unchanged');
  assertIncludes(text, 'looking camera', 'Case D: gaze clause unchanged');
  assertIncludes(text, 'expression is determined', 'Case D: expression sentence present');
  assertIncludes(text, 'holds a coffee cup', 'Case D: notes still appended');
  assertNotIncludes(text, 'lip sync', 'Case D: no lip-sync phrasing when vocalPerformance is unset');
  assertNotIncludes(text, 'eyes ', 'Case D: no eyes clause when eyes is unset');
  assertNotIncludes(text, 'body movement', 'Case D: no bodyMotion sentence when bodyMotion is unset');
}

// --- Case D2: a segment entirely without the new keys (pre-Phase-4a shape) -
{
  const shotBare = makeShot({ actionType: 'walk', notes: 'crosses the room' });
  const text = h3Compiler.compileH3Sections(shotBare).detailedDescription;
  assertIncludes(text, '<Subject 1> walks.', 'Case D2: bare old-shape segment compiles the same simple sentence as before');
  assertIncludes(text, 'crosses the room', 'Case D2: notes sentence unchanged');
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exitCode = 1;
} else {
  console.log('\nAll h3Compiler Character-field checks passed.');
}
