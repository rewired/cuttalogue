// Regression coverage for Phase 5.2's pure SRT serializer (subtitles.js).
// Same self-contained Node harness as vocalRegions.test.js - subtitles.js
// has no dependencies (pure functions, no MSE.state, no DOM), so no stubs
// are needed beyond the window/MSE globals every one of these test files
// sets up.
//
// Run with: node frontend/tests/subtitles.test.js
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

loadScript('subtitles.js');

const { formatSrtTimestamp, serializeSrt } = window.MSE.subtitles;

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

// --- Case A: formatSrtTimestamp -----------------------------------------
{
  assertEqual(formatSrtTimestamp(0), '00:00:00,000', 'Case A: 0 -> 00:00:00,000');
  assertEqual(formatSrtTimestamp(1.234), '00:00:01,234', 'Case A: 1.234 -> 00:00:01,234');
  assertEqual(formatSrtTimestamp(61.005), '00:01:01,005', 'Case A: 61.005 -> 00:01:01,005');
  assertEqual(formatSrtTimestamp(3661.999), '01:01:01,999', 'Case A: 3661.999 -> 01:01:01,999');
  // 1.2345*1000 = 1234.4999999999998 in IEEE754 - Math.round must still
  // land on the intended millisecond, not one off from float error.
  assertEqual(formatSrtTimestamp(1.2345), '00:00:01,235', 'Case A: near-millisecond-boundary float value rounds correctly (1.2345 -> ,235)');
  assertEqual(formatSrtTimestamp(0.9995), '00:00:01,000', 'Case A: 0.9995 rounds up across a whole-second boundary');
}

// --- Case B: basic Phrase export at offset 0 ------------------------------
{
  const phrases = [
    { startSeconds: 12.34, endSeconds: 14.82, text: 'The room goes thin' },
    { startSeconds: 15.12, endSeconds: 17.55, text: 'when you say my name;' },
  ];
  const expected = [
    '1',
    '00:00:12,340 --> 00:00:14,820',
    'The room goes thin',
    '',
    '2',
    '00:00:15,120 --> 00:00:17,550',
    'when you say my name;',
    '',
  ].join('\n');
  assertEqual(serializeSrt(phrases, 0), expected, 'Case B: basic two-phrase export at offset 0 matches expected SRT text exactly');
}

// --- Case C: positive offset ----------------------------------------------
{
  const phrases = [{ startSeconds: 12.34, endSeconds: 14.82, text: 'x' }];
  const srt = serializeSrt(phrases, 5.0);
  assertEqual(srt.split('\n')[1], '00:00:17,340 --> 00:00:19,820', 'Case C: +5.000s offset shifts both timestamps');
}

// --- Case D: negative offset partial clamp --------------------------------
{
  const phrases = [{ startSeconds: 1.0, endSeconds: 3.0, text: 'x' }];
  const srt = serializeSrt(phrases, -2.0);
  assertEqual(srt.split('\n')[1], '00:00:00,000 --> 00:00:01,000', 'Case D: partially-negative cue clamps start to 0, keeps effective end');
}

// --- Case E: fully negative cue omitted -----------------------------------
{
  const phrases = [{ startSeconds: 0.5, endSeconds: 1.5, text: 'x' }];
  assertEqual(serializeSrt(phrases, -2.0), '', 'Case E: a cue whose effective end is <= 0 is omitted entirely');
}

// --- Case F: renumbering after omission -----------------------------------
{
  const phrases = [
    { startSeconds: 0.5, endSeconds: 1.5, text: 'omitted' }, // end -0.5 after offset -> dropped
    { startSeconds: 10.0, endSeconds: 11.0, text: 'second' },
    { startSeconds: 12.0, endSeconds: 13.0, text: 'third' },
  ];
  const srt = serializeSrt(phrases, -2.0);
  const lines = srt.split('\n');
  assertEqual(lines[0], '1', 'Case F: first surviving cue is numbered 1, not 2');
  assertEqual(lines[2], 'second', 'Case F: first surviving cue is the second phrase');
  // Find the second cue's own number line (after the blank separator).
  const secondCueIndex = lines.indexOf('');
  assertEqual(lines[secondCueIndex + 1], '2', 'Case F: second surviving cue is numbered 2, not 3');
}

// --- Case G: exact text preservation ---------------------------------------
{
  const text = 'You don’t have to ask,\nI don’t have to lie—';
  const phrases = [{ startSeconds: 0, endSeconds: 1, text }, { startSeconds: 2, endSeconds: 3, text: 'I’ll come back.' }];
  const srt = serializeSrt(phrases, 0);
  assertEqual(srt.includes(text), true, 'Case G: curly apostrophes/em dash survive unchanged, no punctuation normalization');
  assertEqual(srt.includes('I’ll come back.'), true, 'Case G: second phrase text also survives unchanged');
}

// --- Case H: determinism ----------------------------------------------------
{
  const phrases = [
    { startSeconds: 1.111, endSeconds: 2.222, text: 'a' },
    { startSeconds: 3.333, endSeconds: 4.444, text: 'b' },
  ];
  assertEqual(serializeSrt(phrases, 1.5), serializeSrt(phrases, 1.5), 'Case H: serializing identical input twice is byte-identical');
}

// --- Case I: Hold/Shot independence - the serializer's signature is -------
// (phrases, offsetSeconds) only; it never receives or inspects holds/shots,
// so a Phrase crossing a shot boundary is just two numbers to it, and a
// different Hold threshold (never even passed in) cannot affect output.
{
  const phraseAcrossShotBoundary = [{ startSeconds: 40.8, endSeconds: 43.1, text: 'crosses a shot cut at 42.0s' }];
  const srt = serializeSrt(phraseAcrossShotBoundary, 0);
  assertEqual(srt.split('\n')[0], '1', 'Case I: a Phrase spanning a shot boundary still produces exactly one cue, never split');
  assertEqual(serializeSrt.length, 2, 'Case I: serializeSrt only ever takes (phrases, offsetSeconds) - no shot/hold parameter exists to accidentally wire up');
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exitCode = 1;
} else {
  console.log('\nAll SRT export checks passed.');
}
