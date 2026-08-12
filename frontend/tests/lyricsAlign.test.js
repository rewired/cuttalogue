// Regression coverage for Phase 3a's frontend half (lyrics persistence +
// the Apply Add/Replace flow in lyricsAlign.js) and Phase 5.1's persisted-
// alignment half (round-trip through project.js's serialize/normalize, and
// getStoredAlignmentStatus - see that function's own doc comment for why
// it's the one authoritative validity decision). Same self-contained Node
// harness as references.test.js/vocalCues.test.js - loads the actual
// browser sources into the current global scope. lyricsAlign.js touches
// `document` at module load time (document.addEventListener('DOMContentLoaded',
// ...)), so a minimal no-op `document` stub is installed first - init() never
// actually runs under it, which is fine: this file only exercises pure/DOM-
// free exports (applyAlignmentWords, getStoredAlignmentStatus), never the
// DOM-wiring half (see that file's own separation of the two) - runAlignment
// and the project-loaded/vocal-ready handlers are covered by the manual
// acceptance pass in the Phase 5.1 plan instead.
//
// Run with: node frontend/tests/lyricsAlign.test.js
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
global.document = { addEventListener: () => {}, getElementById: () => null };
// getStoredAlignmentStatus reads MSE.project.getProjectId() (localStorage-
// backed) - a fixed non-null id, same convention as directionSnap.test.js's
// localStorage stub.
global.localStorage = { getItem: () => 'test-project-id', setItem: () => {} };

loadScript('state.js');
loadScript('musicalGrid.js');
loadScript('frameMath.js');
loadScript('vocalCues.js');
loadScript('vocalRegions.js');
loadScript('shots.js');
loadScript('project.js');
loadScript('lyricsAlign.js');

const { state } = window.MSE.state;
const { vocalCues, project, lyricsAlign } = window.MSE;

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

// --- Case A: lyrics persistence ---------------------------------------------
{
  const normalizedEmpty = project.normalizeProjectData({});
  assertEqual(normalizedEmpty.lyrics, { text: '' }, 'Case A: a project with no lyrics field normalizes to { text: "" }');

  const lyricsText = 'I know you\'re getting too close\nclooooose';
  state.lyrics.text = lyricsText;
  const serialized = project.serializeProject();
  assertEqual(serialized.lyrics, { text: lyricsText }, 'Case A: serializeProject emits the lyrics text verbatim, including line breaks');

  const roundTripped = project.normalizeProjectData(JSON.parse(JSON.stringify(serialized)));
  assertEqual(roundTripped.lyrics, { text: lyricsText }, 'Case A: lyrics survive a serialize -> reload round-trip unchanged');
}

// --- Case E: Apply Add -------------------------------------------------------
{
  resetCues();
  vocalCues.add(10, 'existing-cue');
  const words = [
    { text: 'hello', startSeconds: 1.0, endSeconds: 1.2 },
    { text: 'world', startSeconds: 1.3, endSeconds: 1.6 },
  ];
  const { created } = lyricsAlign.applyAlignmentWords(words, 'add');
  assertEqual(created, 2, 'Case E: two new cues created');
  // Sorted ascending by timeSeconds (Phase 2's own ordering invariant) - the
  // pre-existing cue at t=10 sorts after both newly aligned words, not
  // wherever it happened to be inserted.
  assertEqual(
    vocalCues.list().map((c) => c.label),
    ['hello', 'world', 'existing-cue'],
    'Case E: the pre-existing cue remains alongside the newly aligned ones'
  );
}

// --- Case F: Apply Replace ---------------------------------------------------
{
  resetCues();
  vocalCues.add(5, 'stale-cue-1');
  vocalCues.add(6, 'stale-cue-2');
  const words = [{ text: 'fresh', startSeconds: 2.0, endSeconds: 2.3 }];
  const { created } = lyricsAlign.applyAlignmentWords(words, 'replace');
  assertEqual(created, 1, 'Case F: one new cue created');
  assertEqual(vocalCues.list().map((c) => c.label), ['fresh'], 'Case F: prior cues are gone, replaced by the aligned word(s)');
}

// --- Case G: unaligned words never become cues ------------------------------
{
  resetCues();
  const words = [
    { text: 'hello', startSeconds: 1.0, endSeconds: 1.2 },
    { text: '---', startSeconds: null, endSeconds: null },
  ];
  const { created } = lyricsAlign.applyAlignmentWords(words, 'add');
  assertEqual(created, 1, 'Case G: only the aligned word counts as created');
  assertEqual(vocalCues.list().map((c) => c.label), ['hello'], 'Case G: no cue is created for the unaligned word');
}

// --- Phase 5.1: persisted lyricsAlignment -----------------------------------

function makeWord(overrides) {
  return { text: 'hi', startSeconds: 1.0, endSeconds: 1.2, confidence: 0.9, lineIndex: 0, wordIndex: 0, ...(overrides || {}) };
}

function makeAlignment(overrides) {
  return {
    schemaVersion: 1,
    engine: 'torchaudio-mms-fa',
    lyricsSnapshot: 'hi there',
    vocalSource: { relativePath: 'audio/vocal.wav', sizeBytes: 1000, mtimeMs: 123456 },
    words: [makeWord()],
    ...(overrides || {}),
  };
}

// --- Case H: old project compatibility --------------------------------------
{
  const normalized = project.normalizeProjectData({});
  assertEqual(normalized.lyricsAlignment, null, 'Case H: a project with no lyricsAlignment field normalizes to null');
}

// --- Case I: round-trip persistence ------------------------------------------
{
  state.lyricsAlignment = makeAlignment();
  const serialized = project.serializeProject();
  assertEqual(serialized.lyricsAlignment, makeAlignment(), 'Case I: serializeProject emits lyricsAlignment verbatim');

  const roundTripped = project.normalizeProjectData(JSON.parse(JSON.stringify(serialized)));
  assertEqual(roundTripped.lyricsAlignment, makeAlignment(), 'Case I: lyricsAlignment survives a serialize -> reload round-trip unchanged');

  const keys = Object.keys(serialized);
  assertEqual(
    keys.some((k) => k === 'phrases' || k === 'holds' || k === 'vocalRegions'),
    false,
    'Case I: no phrases/holds/vocalRegions field is introduced by persisting lyricsAlignment'
  );
  state.lyricsAlignment = null;
}

// --- Case J: direction/vocalCues independence --------------------------------
{
  resetCues();
  vocalCues.add(3, 'independent-cue');
  state.shots = [
    {
      id: 'shot-1',
      startSeconds: 0,
      endSeconds: 5,
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
      direction: { camera: [{ direction: 'push in', target: '', transitionToNext: '', amplitude: '', focalLength: '', depthOfField: '', focusTarget: '', enabled: true, startSeconds: 0, endSeconds: 5 }], lighting: [], subjects: {}, props: {}, beatNotes: [] },
    },
  ];
  state.lyricsAlignment = makeAlignment();

  const serialized = project.serializeProject();
  const roundTripped = project.normalizeProjectData(JSON.parse(JSON.stringify(serialized)));

  assertEqual(roundTripped.shots[0].direction.camera[0].direction, 'push in', 'Case J: Direction segment data survives alongside a persisted lyricsAlignment');
  assertEqual(roundTripped.vocalCues.map((c) => c.label), ['independent-cue'], 'Case J: vocalCues survive alongside a persisted lyricsAlignment');

  state.shots = [];
  state.lyricsAlignment = null;
  resetCues();
}

// --- Case K: malformed word entries are dropped, empty result -> null -------
{
  const malformed = project.normalizeProjectData({
    lyricsAlignment: {
      schemaVersion: 1,
      engine: 'torchaudio-mms-fa',
      lyricsSnapshot: 'x',
      vocalSource: null,
      words: [
        { text: 'ok', lineIndex: 0, wordIndex: 0, startSeconds: 1, endSeconds: 1.5 },
        { text: 'no-indices' },
        { lineIndex: 1, wordIndex: 1 },
      ],
    },
  }).lyricsAlignment;
  assertEqual(malformed.words.length, 1, 'Case K: malformed word entries (missing text/lineIndex/wordIndex) are dropped');
  assertEqual(malformed.words[0].text, 'ok', 'Case K: the one well-formed word survives');

  const allMalformed = project.normalizeProjectData({
    lyricsAlignment: { schemaVersion: 1, engine: 'x', lyricsSnapshot: '', vocalSource: null, words: [{ text: 'bad' }] },
  }).lyricsAlignment;
  assertEqual(allMalformed, null, 'Case K: a record with zero usable words after filtering normalizes to null, not an empty-but-present record');
}

// --- Cases L-P: getStoredAlignmentStatus (Phase 5.1's one authoritative check)
async function runAsyncCases() {
  const fingerprint = { relativePath: 'audio/vocal.wav', sizeBytes: 1000, mtimeMs: 123456 };

  // Case L: valid - matching lyrics + matching fingerprint.
  {
    state.lyrics.text = 'hi there';
    state.lyricsAlignment = makeAlignment();
    window.MSE.api = { getVocalFingerprint: async () => fingerprint };
    const result = await lyricsAlign.getStoredAlignmentStatus();
    assertEqual(result, { status: 'valid', reason: null }, 'Case L: matching lyrics/vocal fingerprint is valid');
  }

  // Case M: stale - lyrics changed by one character.
  {
    state.lyrics.text = 'hi therf';
    state.lyricsAlignment = makeAlignment();
    window.MSE.api = { getVocalFingerprint: async () => fingerprint };
    const result = await lyricsAlign.getStoredAlignmentStatus();
    assertEqual(result, { status: 'stale', reason: 'lyrics_changed' }, 'Case M: a one-character lyrics change is stale/lyrics_changed');
  }

  // Case N: stale - vocal fingerprint differs (sizeBytes and mtimeMs).
  {
    state.lyrics.text = 'hi there';
    state.lyricsAlignment = makeAlignment();
    window.MSE.api = { getVocalFingerprint: async () => ({ ...fingerprint, sizeBytes: 999 }) };
    const resultSize = await lyricsAlign.getStoredAlignmentStatus();
    assertEqual(resultSize, { status: 'stale', reason: 'vocal_changed' }, 'Case N: a differing sizeBytes is stale/vocal_changed');

    window.MSE.api = { getVocalFingerprint: async () => ({ ...fingerprint, mtimeMs: 999 }) };
    const resultMtime = await lyricsAlign.getStoredAlignmentStatus();
    assertEqual(resultMtime, { status: 'stale', reason: 'vocal_changed' }, 'Case N: a differing mtimeMs is stale/vocal_changed');
  }

  // Case O: stale - vocal source no longer resolvable (missing).
  {
    state.lyrics.text = 'hi there';
    state.lyricsAlignment = makeAlignment();
    window.MSE.api = { getVocalFingerprint: async () => null };
    const result = await lyricsAlign.getStoredAlignmentStatus();
    assertEqual(result, { status: 'stale', reason: 'vocal_changed' }, 'Case O: a missing vocal source is stale/vocal_changed, not a crash');
  }

  // Case P: missing - no stored alignment at all.
  {
    state.lyrics.text = 'hi there';
    state.lyricsAlignment = null;
    window.MSE.api = { getVocalFingerprint: async () => fingerprint };
    const result = await lyricsAlign.getStoredAlignmentStatus();
    assertEqual(result, { status: 'missing', reason: null }, 'Case P: no stored alignment is status missing');
  }

  state.lyricsAlignment = null;
  state.lyrics.text = '';

  if (failures > 0) {
    console.error(`\n${failures} failure(s)`);
    process.exitCode = 1;
  } else {
    console.log('\nAll lyrics/alignment checks passed.');
  }
}

runAsyncCases();
