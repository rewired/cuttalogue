// Phase 3b of docs/h3-shot-direction-roadmap.md: derives higher-level vocal
// regions (phrases, sustained-word "holds") from Phase 3a's word-level
// alignment result. Pure and MMS/CTC-independent - everything here operates
// only on CUTTAlogue's own normalized word shape ({ text, startSeconds,
// endSeconds, lineIndex, wordIndex }), never on raw engine output, so
// swapping the alignment engine later doesn't touch this file.
//
// Three distinct concepts, kept as three distinct data shapes (see the
// roadmap doc's "architectural principle" for Phase 3b):
//   WORD ALIGNMENT - what was sung when (Phase 3a's words[])
//   VOCAL REGION   - what interval of the performance is meaningful (this file)
//   VOCAL CUE      - a persistent point marker (MSE.vocalCues, Phase 2)
// Regions are transient analysis output, same lifecycle as the word
// alignment they're derived from - never persisted, never a second point-
// cue system. lyricsAlign.js is the only caller; it re-derives locally
// whenever the hold threshold changes, without re-running alignment.
(function (MSE) {
  'use strict';

  // A word significantly longer than an ordinary sung syllable (Phase 3a's
  // own smoke-test data: fast, spoken words land in the 0.02s-0.4s range) is
  // a hold candidate. Chosen with headroom above that range so normal words
  // in a brisk verse don't qualify, while a genuinely sustained note - the
  // roadmap's own "clooooose" example runs ~1.3s - clears it comfortably.
  // A single named constant, not a magic number scattered through the UI;
  // easy to retune once real sung (not spoken) alignment data is available.
  const DEFAULT_HOLD_THRESHOLD_SECONDS = 0.6;

  function makeRegionId(kind, index) {
    return `${kind}-${index}`;
  }

  // A word counts as usable for region derivation only with a real,
  // positive-duration interval - never fabricated, and explicitly excludes
  // the endSeconds <= startSeconds edge case (Phase 3b Case G) from both
  // phrase boundaries and hold candidates alike.
  function isUsable(word) {
    return !!word && word.startSeconds != null && word.endSeconds != null && word.endSeconds > word.startSeconds;
  }

  // Repeated-letter elongation ("clooooose", "yeeeeah") - an OPTIONAL
  // supporting signal only. Never used to fabricate or extend a region's
  // duration; deriveHolds below relies solely on the actual aligned
  // interval. Exposed for a caller that wants to hint "this spelling
  // suggests a hold" even when the aligned duration didn't clear the
  // threshold (e.g. a rushed take), never the other way around.
  const ELONGATION_PATTERN = /([a-z])\1{2,}/i;
  function looksElongated(word) {
    return ELONGATION_PATTERN.test(word || '');
  }

  // Groups words by their originating lyric line (lineIndex, from Phase 3a)
  // and, for each line with at least one usable word, creates one phrase
  // region spanning its first usable word's start to its last usable word's
  // end. Phrase text is the ORIGINAL lyric line text (lyricsText.split('\n')
  // [lineIndex], trimmed) - never reconstructed by joining normalized
  // tokens - so spelling like "you're"/"clooooose" is preserved exactly.
  // A line with zero usable words (fully unaligned, blank, or punctuation-
  // only) produces no region at all, per Phase 3b's "never fabricate a
  // region" rule.
  function derivePhrases(words, lyricsText) {
    const lines = (lyricsText || '').split('\n');
    const byLine = new Map();
    (words || []).forEach((word) => {
      if (word.lineIndex == null) return;
      if (!byLine.has(word.lineIndex)) byLine.set(word.lineIndex, []);
      byLine.get(word.lineIndex).push(word);
    });

    const phrases = [];
    // Map iteration order follows insertion order, which follows the words
    // array's own (already line-ascending) order - but sort explicitly by
    // lineIndex anyway so this doesn't depend on that incidental ordering.
    Array.from(byLine.keys())
      .sort((a, b) => a - b)
      .forEach((lineIndex) => {
        const lineWords = byLine.get(lineIndex).filter(isUsable);
        if (!lineWords.length) return;
        const text = (lines[lineIndex] || '').trim();
        if (!text) return;
        const first = lineWords[0];
        const last = lineWords[lineWords.length - 1];
        phrases.push({
          id: makeRegionId('phrase', lineIndex),
          type: 'phrase',
          startSeconds: first.startSeconds,
          endSeconds: last.endSeconds,
          text,
        });
      });
    return phrases;
  }

  // One hold candidate per individual word whose own aligned duration meets
  // or exceeds thresholdSeconds - deterministic, no pitch/spectral/ML
  // analysis (see the module header). Uses the ORIGINAL word text
  // ("clooooose", never normalized to "close"). ID is keyed on wordIndex
  // (this word's position in the overall alignment result), not its text,
  // so repeated words each get their own stable, distinct identity.
  function deriveHolds(words, thresholdSeconds) {
    const threshold = thresholdSeconds == null ? DEFAULT_HOLD_THRESHOLD_SECONDS : thresholdSeconds;
    const holds = [];
    (words || []).forEach((word, index) => {
      if (!isUsable(word)) return;
      const duration = word.endSeconds - word.startSeconds;
      if (duration < threshold) return;
      holds.push({
        id: makeRegionId('hold', word.wordIndex == null ? index : word.wordIndex),
        type: 'hold',
        startSeconds: word.startSeconds,
        endSeconds: word.endSeconds,
        text: word.text,
      });
    });
    return holds;
  }

  // Convenience: both derivations in one call, sharing one threshold. Pure
  // and cheap - safe to call on every hold-threshold UI change without
  // touching the backend or re-running forced alignment (see module header).
  function deriveRegions(words, lyricsText, options) {
    const thresholdSeconds = options && options.holdThresholdSeconds;
    return {
      phrases: derivePhrases(words, lyricsText),
      holds: deriveHolds(words, thresholdSeconds),
    };
  }

  // Projects a region onto a shot without mutating it - analogous to
  // MSE.vocalCues.forShot(shot), but for intervals rather than points. A
  // region can extend beyond either edge of the shot; only the visible/
  // relative fields describe the clipped, shot-relative portion. Overlap
  // test is end-exclusive on the shot's own end, matching shots.js's
  // shotAtTime/MSE.vocalCues.forShot convention.
  function regionsForShot(regions, shot) {
    if (!shot) return [];
    return (regions || [])
      .filter((region) => region.endSeconds > shot.startSeconds && region.startSeconds < shot.endSeconds)
      .map((region) => {
        const visibleStartSeconds = Math.max(region.startSeconds, shot.startSeconds);
        const visibleEndSeconds = Math.min(region.endSeconds, shot.endSeconds);
        return Object.assign({}, region, {
          visibleStartSeconds,
          visibleEndSeconds,
          relativeStartSeconds: visibleStartSeconds - shot.startSeconds,
          relativeEndSeconds: visibleEndSeconds - shot.startSeconds,
        });
      });
  }

  MSE.vocalRegions = {
    DEFAULT_HOLD_THRESHOLD_SECONDS,
    derivePhrases,
    deriveHolds,
    deriveRegions,
    regionsForShot,
    looksElongated,
  };
})(window.MSE = window.MSE || {});
