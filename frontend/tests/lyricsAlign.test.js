// Regression coverage for Phase 3a's frontend half (lyrics persistence +
// the Apply Add/Replace flow in lyricsAlign.js). Same self-contained Node
// harness as references.test.js/vocalCues.test.js - loads the actual
// browser sources into the current global scope. lyricsAlign.js touches
// `document` at module load time (document.addEventListener('DOMContentLoaded',
// ...)), so a minimal no-op `document` stub is installed first - init() never
// actually runs under it, which is fine: this file only exercises the pure
// applyAlignmentWords() export, never the DOM-wiring half (see that file's
// own separation of the two).
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

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exitCode = 1;
} else {
  console.log('\nAll lyrics/alignment checks passed.');
}
