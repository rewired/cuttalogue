// Regression coverage for Phase 3b vocal region derivation (vocalRegions.js).
// Same self-contained Node harness as references.test.js/vocalCues.test.js -
// vocalRegions.js has no dependencies (pure functions, no MSE.state, no
// DOM), so this is the simplest of the three: no MMS/CTC model, no torch,
// no network - see Case J below, which is really just "this whole file
// runs in well under a second."
//
// Run with: node frontend/tests/vocalRegions.test.js
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

loadScript('vocalRegions.js');

const { derivePhrases, deriveHolds, deriveRegions, regionsForShot, looksElongated, DEFAULT_HOLD_THRESHOLD_SECONDS } = window.MSE.vocalRegions;

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

// Builds a word result the way alignment.py would, from a lyrics string and
// a list of [startSeconds, endSeconds] tuples (or null for "unaligned") in
// original word order - lineIndex/wordIndex computed the same way the
// backend does (split by "\n", then by whitespace).
function buildWords(lyricsText, timings) {
  const words = [];
  let wordIndex = 0;
  lyricsText.split('\n').forEach((line, lineIndex) => {
    line.split(/\s+/).filter(Boolean).forEach((text) => {
      const t = timings[wordIndex];
      words.push({
        text,
        startSeconds: t ? t[0] : null,
        endSeconds: t ? t[1] : null,
        confidence: t ? 0.9 : null,
        lineIndex,
        wordIndex,
      });
      wordIndex += 1;
    });
  });
  return words;
}

// --- Case A: phrase from lyric line -----------------------------------------
{
  const lyrics = "I know you're too close";
  const words = buildWords(lyrics, [[1.0, 1.4], [1.4, 1.8], [1.8, 2.3], [2.3, 2.9], [2.9, 3.4]]);
  const phrases = derivePhrases(words, lyrics);
  assertEqual(phrases.length, 1, 'Case A: one phrase for one lyric line');
  assertEqual(phrases[0].startSeconds, 1.0, 'Case A: phrase start = first word start');
  assertEqual(phrases[0].endSeconds, 3.4, 'Case A: phrase end = last word end');
  assertEqual(phrases[0].text, lyrics, 'Case A: phrase text is the original lyric line');
}

// --- Case B: original spelling preserved (phrase + hold) --------------------
{
  const lyrics = "you're too clooooose";
  const words = buildWords(lyrics, [[0.0, 0.3], [0.3, 0.6], [0.6, 2.0]]);
  const phrases = derivePhrases(words, lyrics);
  const holds = deriveHolds(words, 0.6);
  assertEqual(phrases[0].text, "you're too clooooose", "Case B: phrase text preserves \"you're\"/\"clooooose\" verbatim");
  assertEqual(holds.length, 1, 'Case B: the long word is a hold candidate');
  assertEqual(holds[0].text, 'clooooose', 'Case B: hold text is the original spelling, not normalized to "close"');
}

// --- Case C: hold threshold (>=) ---------------------------------------------
{
  const threshold = 0.75;
  const epsilon = 0.01;
  const lyrics = 'A B C';
  const words = buildWords(lyrics, [
    [0.0, threshold - epsilon], // A: just under
    [1.0, 1.0 + threshold], // B: exactly at
    [2.0, 2.0 + threshold + epsilon], // C: just over
  ]);
  const holds = deriveHolds(words, threshold);
  assertEqual(holds.map((h) => h.text), ['B', 'C'], 'Case C: duration >= threshold qualifies (B at exactly threshold, C over) - A (just under) does not');
}

// --- Case D: partially unaligned phrase --------------------------------------
{
  const lyrics = 'one two three four';
  // "one" and "four" unaligned; "two"/"three" aligned.
  const words = buildWords(lyrics, [null, [5.0, 5.4], [5.4, 5.9], null]);
  const phrases = derivePhrases(words, lyrics);
  assertEqual(phrases.length, 1, 'Case D: a phrase is still derived from the aligned middle words');
  assertEqual(phrases[0].startSeconds, 5.0, 'Case D: phrase start = first ALIGNED word, not the unaligned first word');
  assertEqual(phrases[0].endSeconds, 5.9, 'Case D: phrase end = last ALIGNED word, not the unaligned last word - no guessed padding');
}

// --- Case E: completely unaligned line -> no phrase --------------------------
{
  const lyrics = 'nothing aligned here';
  const words = buildWords(lyrics, [null, null, null]);
  const phrases = derivePhrases(words, lyrics);
  assertEqual(phrases, [], 'Case E: zero aligned words in a line produces no phrase region at all');
}

// --- Case F: repeated text identity (distinct IDs) ---------------------------
{
  const lyrics = 'close close\nclose close';
  const words = buildWords(lyrics, [[0.0, 1.0], [1.0, 2.0], [2.0, 3.0], [3.0, 4.0]]);
  const phrases = derivePhrases(words, lyrics);
  const holds = deriveHolds(words, 0.6);
  assertEqual(phrases.length, 2, 'Case F: two identical lyric lines produce two phrase regions');
  assertEqual(new Set(phrases.map((p) => p.id)).size, 2, 'Case F: the two identical-text phrases have distinct IDs');
  assertEqual(holds.length, 4, 'Case F: four identical long words are four hold candidates');
  assertEqual(new Set(holds.map((h) => h.id)).size, 4, 'Case F: all four identical-text holds have distinct IDs');
}

// --- Case G: invalid word duration never creates a hold ----------------------
{
  const lyrics = 'bad word';
  const words = buildWords(lyrics, [[2.0, 2.0], [3.0, 5.0]]); // "bad": end == start
  const holds = deriveHolds(words, 0.6);
  assertEqual(holds.map((h) => h.text), ['word'], 'Case G: a word with endSeconds <= startSeconds never becomes a hold, even past threshold elsewhere');

  // Same guard applies to phrase boundary selection - the invalid-duration
  // word must not become the phrase's start.
  const phrases = derivePhrases(words, lyrics);
  assertEqual(phrases[0].startSeconds, 3.0, "Case G: phrase skips the invalid-duration word for its start too");
}

// --- Case H: shot projection (region crosses a shot boundary) ---------------
{
  const region = { id: 'hold-0', type: 'hold', startSeconds: 10, endSeconds: 12, text: 'ooh' };
  const shot = { startSeconds: 11, endSeconds: 15 };
  const [projected] = regionsForShot([region], shot);
  assertEqual(projected.startSeconds, 10, 'Case H: the canonical region start is untouched');
  assertEqual(projected.endSeconds, 12, 'Case H: the canonical region end is untouched');
  assertEqual(projected.visibleStartSeconds, 11, 'Case H: visible start is clipped to the shot start');
  assertEqual(projected.visibleEndSeconds, 12, 'Case H: visible end stays at the region end (inside the shot)');
  assertEqual(projected.relativeStartSeconds, 0, 'Case H: relative visible start is 0');
  assertEqual(projected.relativeEndSeconds, 1, 'Case H: relative visible end is 1');
}

// --- Case I: outside-shot region is absent -----------------------------------
{
  const region = { id: 'hold-0', type: 'hold', startSeconds: 1, endSeconds: 2, text: 'ooh' };
  const shot = { startSeconds: 11, endSeconds: 15 };
  assertEqual(regionsForShot([region], shot), [], 'Case I: a non-overlapping region is absent from regionsForShot()');

  // End-exclusive boundary: a region ending exactly at the shot's start
  // does not overlap (matches vocalCues.forShot's end-exclusive semantics).
  const touching = { id: 'hold-1', type: 'hold', startSeconds: 9, endSeconds: 11, text: 'ooh' };
  assertEqual(regionsForShot([touching], shot), [], 'Case I: a region ending exactly at the shot start does not overlap');
}

// --- Case J: no model required -----------------------------------------------
// Implicit in this whole file: vocalRegions.js imports nothing, needs no
// MSE.state/DOM, and every case above ran without touching torch/torchaudio
// or any network call.
console.log('ok - Case J: all derivation ran without loading any alignment model');

// --- Bonus: DEFAULT_HOLD_THRESHOLD_SECONDS / deriveRegions / looksElongated -
{
  assertEqual(typeof DEFAULT_HOLD_THRESHOLD_SECONDS, 'number', 'DEFAULT_HOLD_THRESHOLD_SECONDS is a named numeric constant');
  const lyrics = 'clooooose';
  const words = buildWords(lyrics, [[0.0, 2.0]]);
  const { phrases, holds } = deriveRegions(words, lyrics, {});
  assertEqual(phrases.length, 1, 'deriveRegions: derives phrases using the default threshold when none given');
  assertEqual(holds.length, 1, 'deriveRegions: derives holds using the default threshold when none given');
  assertEqual(looksElongated('clooooose'), true, 'looksElongated: detects repeated-letter elongation');
  assertEqual(looksElongated('close'), false, 'looksElongated: normal spelling is not flagged');
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exitCode = 1;
} else {
  console.log('\nAll vocal region derivation checks passed.');
}
