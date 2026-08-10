// Regression coverage for Phase 5 ("H3 Prompt Compiler 2.0"): the Semantic
// Beat IR (buildSemanticBeats), beat-diff/continuity suppression, hard-cut
// reset, Camera/Character/Prop/Lighting composition ordering, narrow
// field-aware deduplication, retention wording, and determinism. Same
// harness pattern as h3CompilerLighting.test.js - stubs MSE.shots down to
// just shotDuration, since compiler output only depends on shot.direction.
//
// Run with: node frontend/tests/h3SemanticBeats.test.js
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

function assertTrue(value, label) {
  assertEqual(!!value, true, label);
}

assets.addAssets([
  { id: 'heather', type: 'image', fileName: 'heather.png', relativePath: 'x', tags: [], metadata: {} },
  { id: 'club', type: 'image', fileName: 'club.png', relativePath: 'x', tags: [], metadata: {} },
  { id: 'mic', type: 'image', fileName: 'mic.png', relativePath: 'x', tags: [], metadata: {} },
]);

function makeShot(overrides) {
  return {
    id: 'shot-1',
    startSeconds: 0,
    endSeconds: 10,
    assetIds: ['heather'],
    assetRoles: { heather: 'primary_character' },
    constraints: [],
    direction: { camera: [], lighting: [], subjects: {}, props: {}, beatNotes: [] },
    ...overrides,
  };
}

// --- Case A: active segment collection -------------------------------------
{
  const cam1 = { startSeconds: 0, endSeconds: 5, enabled: true, movement: 'static_shot' };
  const cam2 = { startSeconds: 5, endSeconds: 10, enabled: true, movement: 'zoom_in' };
  const light1 = { startSeconds: 0, endSeconds: 10, enabled: true, exposure: 'low_key' };
  const char1 = { startSeconds: 0, endSeconds: 5, enabled: true, actionType: 'stand' };
  const char2 = { startSeconds: 5, endSeconds: 10, enabled: true, actionType: 'sing' };
  const shot = makeShot({
    direction: {
      camera: [cam1, cam2],
      lighting: [light1],
      subjects: { heather: [char1, char2] },
      props: {},
      beatNotes: [],
    },
  });
  const beats = h3Compiler.buildSemanticBeats(shot);
  assertEqual(beats.length, 2, 'Case A: two beats from the camera/character split at 5s');
  assertEqual(beats[0].camera, cam1, 'Case A: beat 0 active camera is cam1 (same object reference)');
  assertEqual(beats[1].camera, cam2, 'Case A: beat 1 active camera is cam2');
  assertEqual(beats[0].lighting, light1, 'Case A: beat 0 active lighting is light1');
  assertEqual(beats[1].lighting, light1, 'Case A: beat 1 active lighting is still light1 (same object, unchanged)');
  assertEqual(beats[0].subjects[0].segment, char1, 'Case A: beat 0 active character segment is char1');
  assertEqual(beats[1].subjects[0].segment, char2, 'Case A: beat 1 active character segment is char2');
}

// --- Case B: boundary collection unchanged (vocal data never a boundary) --
{
  const shot = makeShot({
    direction: {
      camera: [{ startSeconds: 0, endSeconds: 10, enabled: true, movement: 'static_shot' }],
      lighting: [],
      subjects: {},
      props: {},
      beatNotes: [],
    },
  });
  // collectBeatBoundaries has no parameter for vocal cue/region/word-
  // alignment data at all - there is no code path by which one could leak
  // in. This just confirms the ordinary authored-only boundary set.
  const boundaries = h3Compiler.collectBeatBoundaries(shot, h3Compiler.orderedSubjects(shot));
  assertEqual(boundaries, [0, 10], 'Case B: only shot bounds when the one Camera segment spans the whole shot');
}

// --- Case C: reference binding drives Semantic Beat subject identity ------
{
  assets.addAssets([{ id: 'support1', type: 'image', fileName: 'support1.png', relativePath: 'x', tags: [], metadata: {} }]);
  const shot = makeShot({
    assetIds: ['support1', 'heather'],
    assetRoles: { support1: 'supporting_character', heather: 'primary_character' },
  });
  const beats = h3Compiler.buildSemanticBeats(shot);
  assertEqual(beats[0].subjects.map((s) => s.label), ['Subject 1', 'Subject 2'], 'Case C: beat subject order/labels come from canonical role ordering (primary before supporting), not assetIds order');
  assertEqual(beats[0].subjects.map((s) => s.assetId), ['heather', 'support1'], 'Case C: beat subject assetIds match the canonical binding, not assignment order');
}

// --- Case D: unchanged Camera is not restated when Character changes -----
{
  const cam = { startSeconds: 0, endSeconds: 10, enabled: true, movement: 'arc_shot' };
  const char1 = { startSeconds: 0, endSeconds: 5, enabled: true, eyes: 'open' };
  const char2 = { startSeconds: 5, endSeconds: 10, enabled: true, eyes: 'closed' };
  const shot = makeShot({
    direction: { camera: [cam], lighting: [], subjects: { heather: [char1, char2] }, props: {}, beatNotes: [] },
  });
  const text = h3Compiler.compileH3Sections(shot).detailedDescription;
  const arcCount = (text.match(/arcs around the subject/g) || []).length;
  assertEqual(arcCount, 1, 'Case D: the continuous Camera arc is described exactly once, not restated at the Character-only boundary');
  assertIncludes(text, 'eyes closed', 'Case D: the second beat still describes the Character change that caused the boundary');
}

// --- Case E: Camera changes are clearly described -------------------------
{
  const cam1 = { startSeconds: 0, endSeconds: 5, enabled: true, movement: 'static_shot' };
  const cam2 = { startSeconds: 5, endSeconds: 10, enabled: true, movement: 'zoom_in' };
  const shot = makeShot({ direction: { camera: [cam1, cam2], lighting: [], subjects: {}, props: {}, beatNotes: [] } });
  const text = h3Compiler.compileH3Sections(shot).detailedDescription;
  assertIncludes(text, 'remains static', 'Case E: beat 1 describes the static camera');
  assertIncludes(text, 'zooms in', 'Case E: beat 2 clearly describes the new zoom action, not a silent continuation');
}

// --- Case F: a hard cut resets continuity ----------------------------------
{
  const cam1 = { startSeconds: 0, endSeconds: 5, enabled: true, movement: 'static_shot', framing: 'close portrait' };
  const cam2 = { startSeconds: 5, endSeconds: 10, enabled: true, movement: 'static_shot', framing: 'close portrait' };
  const shot = makeShot({
    direction: {
      camera: [cam1, cam2],
      lighting: [],
      subjects: {},
      props: {},
      beatNotes: [{ startSeconds: 5, endSeconds: 10, intent: '', priority: '', endState: '', isCut: true }],
    },
  });
  const text = h3Compiler.compileH3Sections(shot).detailedDescription;
  // Even though cam2 has identical fields to cam1, the hard cut is a
  // distinct authored segment (a different object) AND resetContinuity
  // forces a full restatement regardless - either way, the second [Shot N]
  // block must fully describe the camera again, not rely on "continuing"
  // language from beat 1.
  const staticCount = (text.match(/remains static/g) || []).length;
  assertEqual(staticCount, 2, 'Case F: the camera is fully re-described after the hard cut, not silently continued');
  assertIncludes(text, '[Shot 2]', 'Case F: the hard cut starts a new [Shot N] block');
  assertIncludes(text, 'hard cut to a new composition', 'Case F: hard-cut phrasing is used at the cut boundary');
}

// --- Case G: unchanged Lighting is not falsely described as changing -----
{
  const light = { startSeconds: 0, endSeconds: 10, enabled: true, exposure: 'low_key' };
  const char1 = { startSeconds: 0, endSeconds: 5, enabled: true, actionType: 'stand' };
  const char2 = { startSeconds: 5, endSeconds: 10, enabled: true, actionType: 'sing' };
  const shot = makeShot({
    direction: { camera: [], lighting: [light], subjects: { heather: [char1, char2] }, props: {}, beatNotes: [] },
  });
  const text = h3Compiler.compileH3Sections(shot).detailedDescription;
  const lightingCount = (text.match(/The lighting/g) || []).length;
  assertEqual(lightingCount, 1, 'Case G: the continuous Lighting segment is described exactly once, not restated at the Character-only boundary');
  assertNotIncludes(text, 'shifts to', 'Case G: no false "shifts to" language when Lighting never actually changed');
}

// --- Case H: a real Lighting change is described as a change -------------
{
  const light1 = { startSeconds: 0, endSeconds: 5, enabled: true, exposure: 'dark' };
  const light2 = { startSeconds: 5, endSeconds: 10, enabled: true, exposure: 'bright' };
  const shot = makeShot({ direction: { camera: [], lighting: [light1, light2], subjects: {}, props: {}, beatNotes: [] } });
  const text = h3Compiler.compileH3Sections(shot).detailedDescription;
  assertIncludes(text, 'remains dark', 'Case H: the first Lighting beat establishes the state');
  assertIncludes(text, 'shifts to bright', 'Case H: the second Lighting beat is described as an actual change');
}

// --- Case I: Camera optics composition (no field-list phrasing) ----------
{
  const shot = makeShot({
    direction: {
      camera: [{ startSeconds: 0, endSeconds: 10, enabled: true, movement: 'arc_shot', framing: 'close portrait', focalLength: '85mm', depthOfField: 'shallow', focusTarget: 'face' }],
      lighting: [],
      subjects: {},
      props: {},
      beatNotes: [],
    },
  });
  const text = h3Compiler.compileH3Sections(shot).detailedDescription;
  assertIncludes(text, 'arcs around the subject', 'Case I: movement clause present');
  assertIncludes(text, 'close portrait', 'Case I: framing present');
  assertIncludes(text, '85mm', 'Case I: focal length present');
  assertIncludes(text, 'shallow depth of field', 'Case I: depth of field present');
  assertIncludes(text, 'maintaining focus on face', 'Case I: focus target present');
  const cameraMentions = (text.match(/\bcamera\b/gi) || []).length;
  assertEqual(cameraMentions, 1, 'Case I: "camera" is not repeated - one clause, one mention');
}

// --- Case J: Character/performance composition -----------------------------
{
  const shot = makeShot({
    direction: {
      camera: [],
      lighting: [],
      subjects: {
        heather: [{
          startSeconds: 0,
          endSeconds: 10,
          enabled: true,
          actionType: 'sing',
          vocalPerformance: 'lip_sync',
          eyes: 'closed',
          expression: 'emotionally intense',
          gesture: 'both hands grip microphone',
          bodyMotion: 'restrained',
        }],
      },
      props: {},
      beatNotes: [],
    },
  });
  const text = h3Compiler.compileH3Sections(shot).detailedDescription;
  const singCount = (text.match(/\bsings\b/g) || []).length;
  assertEqual(singCount, 1, 'Case J: exactly one singing statement');
  assertIncludes(text, 'precise, natural lip sync', 'Case J: one lip-sync requirement clause');
  assertNotIncludes(text, 'singing', 'Case J: no duplicated standalone "singing" clause alongside actionType sing');
  assertIncludes(text, "expression is emotionally intense", 'Case J: natural expression grammar (predicate-adjective, no a/an)');
  assertIncludes(text, 'Both hands grip microphone.', 'Case J: gesture included as its own sentence');
  assertIncludes(text, 'restrained', 'Case J: body motion included');
}

// --- Case K: Lighting grammar never regresses to the old broken forms ----
{
  const shot = makeShot({
    direction: {
      camera: [],
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
      subjects: {},
      props: {},
      beatNotes: [],
    },
  });
  const text = h3Compiler.compileH3Sections(shot).detailedDescription;
  assertNotIncludes(text, 'filled by minimal', 'Case K: never "filled by minimal"');
  assertNotIncludes(text, 'sits in', 'Case K: never "sits in"');
}

// --- Case L: no invention of missing optics/performance/Lighting fields --
{
  const shot = makeShot({
    direction: {
      camera: [{ startSeconds: 0, endSeconds: 10, enabled: true, movement: 'static_shot' }],
      lighting: [{ startSeconds: 0, endSeconds: 10, enabled: true, exposure: 'low_key' }],
      subjects: { heather: [{ startSeconds: 0, endSeconds: 10, enabled: true, actionType: 'stand' }] },
      props: {},
      beatNotes: [],
    },
  });
  const text = h3Compiler.compileH3Sections(shot).detailedDescription;
  assertNotIncludes(text, 'mm', 'Case L: no invented focal length');
  assertNotIncludes(text, 'depth of field', 'Case L: no invented depth of field');
  assertNotIncludes(text, 'lip sync', 'Case L: no invented vocal performance');
  assertNotIncludes(text, 'atmosphere', 'Case L: no invented atmosphere');
  // Not "no substring 'key' at all" - EXPOSURE_PHRASES itself legitimately
  // renders "low-key"/"high-key". This checks no *keyLight* text (which
  // would read as "the ... key", e.g. "the warm stage key...") was invented.
  assertNotIncludes(text, 'the ', 'Case L: no invented keyLight/backlight clause (both use "the X" phrasing - see phraseLighting)');
}

// --- Case M: sing + vocalPerformance dedup (already Phase 4a, reconfirmed) -
{
  const shot = makeShot({
    direction: {
      camera: [],
      lighting: [],
      subjects: { heather: [{ startSeconds: 0, endSeconds: 10, enabled: true, actionType: 'sing', vocalPerformance: 'sing' }] },
      props: {},
      beatNotes: [],
    },
  });
  const text = h3Compiler.compileH3Sections(shot).detailedDescription;
  const singCount = (text.match(/\bsings\b/g) || []).length;
  assertEqual(singCount, 1, 'Case M: actionType sing + vocalPerformance sing never produces a duplicate singing phrase');
}

// --- Case N: microphone gesture + prop ownership dedup ---------------------
{
  assets.addAssets([{ id: 'mic', type: 'image', fileName: 'mic.png', relativePath: 'x', tags: [], metadata: {} }]);
  const shot = makeShot({
    assetIds: ['heather', 'mic'],
    assetRoles: { heather: 'primary_character', mic: 'prop' },
    direction: {
      camera: [],
      lighting: [],
      subjects: { heather: [{ startSeconds: 0, endSeconds: 10, enabled: true, gesture: 'both hands grip microphone' }] },
      props: { mic: [{ startSeconds: 0, endSeconds: 10, enabled: true, ownerAssetId: 'heather' }] },
      beatNotes: [],
    },
  });
  const text = h3Compiler.compileH3Sections(shot).detailedDescription;
  assertIncludes(text, 'Both hands grip microphone.', 'Case N: the Character gesture sentence is present');
  assertNotIncludes(text, 'is held by', 'Case N: the redundant Prop "is held by" sentence is suppressed once the owner\'s own gesture already covers it');
}

// --- Case N2: without a gesture, the Prop ownership sentence still appears
{
  const shot = makeShot({
    assetIds: ['heather', 'mic'],
    assetRoles: { heather: 'primary_character', mic: 'prop' },
    direction: {
      camera: [],
      lighting: [],
      subjects: { heather: [{ startSeconds: 0, endSeconds: 10, enabled: true, actionType: 'stand' }] },
      props: { mic: [{ startSeconds: 0, endSeconds: 10, enabled: true, ownerAssetId: 'heather' }] },
      beatNotes: [],
    },
  });
  const text = h3Compiler.compileH3Sections(shot).detailedDescription;
  assertIncludes(text, 'is held by', 'Case N2: with no competing gesture text, the Prop ownership sentence is not suppressed');
}

// --- Case O: Camera target + focusTarget are NOT incorrectly deduplicated -
{
  const shot = makeShot({
    direction: {
      camera: [{ startSeconds: 0, endSeconds: 10, enabled: true, movement: 'arc_shot', target: 'face', focusTarget: 'face' }],
      lighting: [],
      subjects: {},
      props: {},
      beatNotes: [],
    },
  });
  const text = h3Compiler.compileH3Sections(shot).detailedDescription;
  assertIncludes(text, 'targeting face', 'Case O: movement/composition target is present');
  assertIncludes(text, 'maintaining focus on face', 'Case O: optical focus target is present too - distinct semantics from movement target, not deduplicated away');
}

// --- Case P/Q/R: retention wording ------------------------------------------
{
  // Case P: explicit Lighting -> retention must not say lighting unchanged.
  assets.addAssets([{ id: 'clubP', type: 'image', fileName: 'clubP.png', relativePath: 'x', tags: [], metadata: {} }]);
  const shotP = makeShot({
    assetIds: ['clubP'],
    assetRoles: { clubP: 'environment' },
    direction: { camera: [], lighting: [{ startSeconds: 0, endSeconds: 10, enabled: true, exposure: 'low_key' }], subjects: {}, props: {}, beatNotes: [] },
  });
  const sectionsP = h3Compiler.compileH3Sections(shotP);
  assertNotIncludes(sectionsP.retentionAnalysis, 'lighting', 'Case P: retention drops "lighting" once Lighting Direction exists');

  // Case Q: no Lighting Direction -> legacy retention wording may remain.
  assets.addAssets([{ id: 'clubQ', type: 'image', fileName: 'clubQ.png', relativePath: 'x', tags: [], metadata: {} }]);
  const shotQ = makeShot({ assetIds: ['clubQ'], assetRoles: { clubQ: 'environment' } });
  const sectionsQ = h3Compiler.compileH3Sections(shotQ);
  assertIncludes(sectionsQ.retentionAnalysis, 'architecture, lighting, and spatial layout', 'Case Q: with no Lighting segments, legacy retention wording is preserved');

  // Case R: retention must not forbid authored pose/action change.
  const shotR = makeShot({
    direction: {
      camera: [],
      lighting: [],
      subjects: { heather: [{ startSeconds: 0, endSeconds: 5, enabled: true, actionType: 'sit' }, { startSeconds: 5, endSeconds: 10, enabled: true, actionType: 'stand' }] },
      props: {},
      beatNotes: [],
    },
  });
  const sectionsR = h3Compiler.compileH3Sections(shotR);
  assertNotIncludes(sectionsR.retentionAnalysis, 'pose', 'Case R: retention never mentions "pose"');
  assertNotIncludes(sectionsR.retentionAnalysis, 'position', 'Case R: retention never mentions "position"');
  assertIncludes(h3Compiler.compileH3Sections(shotR).detailedDescription, 'stands', 'Case R: the authored action change still compiles freely');
}

// --- Determinism: identical input compiles to byte-identical output -------
{
  const shot = makeShot({
    direction: {
      camera: [{ startSeconds: 0, endSeconds: 5, enabled: true, movement: 'arc_shot', target: 'face' }, { startSeconds: 5, endSeconds: 10, enabled: true, movement: 'zoom_in' }],
      lighting: [{ startSeconds: 0, endSeconds: 10, enabled: true, exposure: 'low_key', atmosphere: 'dark smoky club' }],
      subjects: { heather: [{ startSeconds: 0, endSeconds: 10, enabled: true, actionType: 'sing', vocalPerformance: 'lip_sync' }] },
      props: {},
      beatNotes: [{ startSeconds: 5, endSeconds: 10, intent: 'a sudden shift', priority: '', endState: 'facing camera', isCut: false }],
    },
  });
  const first = h3Compiler.compileH3Prompt(shot);
  const second = h3Compiler.compileH3Prompt(shot);
  const third = h3Compiler.compileH3Prompt(JSON.parse(JSON.stringify({ direction: shot.direction })).direction && shot);
  assertEqual(first, second, 'Determinism: compiling the same shot twice yields byte-identical output');
  assertEqual(first, third, 'Determinism: repeated compilation (again) yields byte-identical output');
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exitCode = 1;
} else {
  console.log('\nAll Phase 5 Semantic Beat compiler checks passed.');
}
