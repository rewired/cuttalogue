// Regression coverage for Phase 4a's snap-candidate union: grid + vocal
// cues + visible Phrase/Hold region boundaries, via direction.js's own
// snapToDirectionGrid (exported for exactly this purpose - see its own doc
// comment). Loads the real direction.js, stubbing only `document`/
// `localStorage` (direction.js's init()/DOM wiring never runs under the
// DOMContentLoaded no-op stub, same convention as lyricsAlign.test.js) and
// MSE.lyricsAlign.getCurrentRegions() (region data direction.js reads fresh
// on every call - see currentRegions() in direction.js).
//
// Run with: node frontend/tests/directionSnap.test.js
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
global.localStorage = { getItem: () => null, setItem: () => {} };

loadScript('state.js');
loadScript('musicalGrid.js');
loadScript('frameMath.js');
loadScript('format.js');
loadScript('assets.js');
loadScript('references.js');
loadScript('h3Compiler.js');
loadScript('shots.js');
loadScript('laneWidget.js');
loadScript('vocalCues.js');
loadScript('vocalRegions.js');
loadScript('contextMenu.js');
loadScript('lyricsAlign.js');
loadScript('direction.js');

const { state } = window.MSE.state;
const { vocalCues, direction } = window.MSE;

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

// bpm 120, numerator 4, gridDivision 'bar', gridOffsetSeconds 0 (state.js's
// own defaults) -> bar duration = 60/120*4 = 2.0s, so grid lines fall on
// 0, 2, 4, 6, ... exactly matching the "grid = 2.000" example in the spec.
const shot = { id: 1, startSeconds: 0, endSeconds: 10 };

function setRegions(holds) {
  window.MSE.lyricsAlign.getCurrentRegions = () => ({ phrases: [], holds });
}

// --- grid(2.000) / cue(2.100) / hold-start(2.137), pointer 2.130 ----------
// hold start wins (nearest of the three).
{
  state.vocalCues.length = 0;
  vocalCues.add(2.1, 'too');
  setRegions([{ id: 'hold-0', type: 'hold', startSeconds: 2.137, endSeconds: 2.5, text: 'clooooose' }]);
  assertEqual(direction.snapToDirectionGrid(2.13, shot), 2.137, 'hold start (2.137) wins when it is the nearest candidate to the pointer (2.130)');
}

// --- grid wins when it is closer ------------------------------------------
{
  assertEqual(direction.snapToDirectionGrid(2.01, shot), 2, 'grid (2.000) wins when it is the nearest candidate');
}

// --- vocal cue wins when it is closer --------------------------------------
{
  assertEqual(direction.snapToDirectionGrid(2.095, shot), 2.1, 'vocal cue (2.100) wins when it is the nearest candidate');
}

// --- a region's END boundary is also a valid snap target -------------------
{
  state.vocalCues.length = 0;
  setRegions([{ id: 'phrase-0', type: 'phrase', startSeconds: 0.5, endSeconds: 5.643, text: 'too close' }]);
  assertEqual(direction.snapToDirectionGrid(5.6, shot), 5.643, "a phrase's end boundary is a valid snap target, not just its start");
}

// --- no cues/regions at all -> falls back to the grid alone ---------------
{
  state.vocalCues.length = 0;
  setRegions([]);
  assertEqual(direction.snapToDirectionGrid(2.9, shot), 2, 'with no cues or regions, snapping falls back to the grid alone');
}

// Alt-bypass and the Snap on/off toggle are both a one-line gate around this
// same function at its only call site (direction.js's buildLaneRow snapTime
// option: `snapEnabled && !altKey ? snapToDirectionGrid(...) : currentValue`)
// - covered by manual Playwright verification (see the Phase 4a completion
// report) rather than duplicated here, since there is no additional branch
// inside snapToDirectionGrid itself to exercise.

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exitCode = 1;
} else {
  console.log('\nAll Direction snap-union checks passed.');
}
