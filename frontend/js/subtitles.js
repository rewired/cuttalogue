// Phase 5.2: pure SRT serialization from Phase-3b Phrase regions. No DOM, no
// state, no derivation of its own - lyricsAlign.js is the only caller,
// feeding it MSE.lyricsAlign.getCurrentRegions().phrases (already the one
// canonical, kept-current Phrase list) plus state.subtitleExport.
// offsetSeconds. This module never touches Hold regions, Shot boundaries,
// or alignment/timeline state - it only ever turns (phrases, offset) into
// SRT text, deterministically.
(function (MSE) {
  'use strict';

  // HH:MM:SS,mmm - same String(...).padStart(...) convention as format.js's
  // formatTime. Math.round on whole milliseconds (not the raw seconds
  // value) avoids the floating-point artifacts that a direct seconds-based
  // format would risk at various boundaries.
  function formatSrtTimestamp(seconds) {
    const totalMs = Math.max(0, Math.round(seconds * 1000));
    const ms = totalMs % 1000;
    const totalSec = Math.floor(totalMs / 1000);
    const s = totalSec % 60;
    const totalMin = Math.floor(totalSec / 60);
    const m = totalMin % 60;
    const h = Math.floor(totalMin / 60);
    const pad = (n, len) => String(n).padStart(len, '0');
    return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(ms, 3)}`;
  }

  // Pure and deterministic: same (phrases, offsetSeconds) in, same SRT text
  // out, every time - no current-date/random data, no mutation of the
  // phrase objects passed in.
  //
  // Offset is applied per cue, never to any persisted timing (see the file
  // header). A cue whose *effective* end is at or before zero is dropped
  // entirely (a negative offset can push it fully before the video starts);
  // a cue whose effective start is negative but end is positive has its
  // start clamped to 0 while its end stays as computed. After clamping, a
  // cue is also dropped if end <= start (covers the clamped-to-zero-length
  // edge case) - an SRT file must never contain a zero/negative-duration
  // cue. Surviving cues are renumbered consecutively from 1, so an omission
  // never leaves a gap in the sequence.
  function serializeSrt(phrases, offsetSeconds) {
    const offset = Number.isFinite(offsetSeconds) ? offsetSeconds : 0;

    const cues = [];
    (phrases || []).forEach((phrase) => {
      const end = phrase.endSeconds + offset;
      if (end <= 0) return;
      const start = Math.max(0, phrase.startSeconds + offset);
      if (end <= start) return;
      cues.push({ start, end, text: phrase.text });
    });

    return cues
      .map((cue, index) => `${index + 1}\n${formatSrtTimestamp(cue.start)} --> ${formatSrtTimestamp(cue.end)}\n${cue.text}`)
      .join('\n\n') + (cues.length ? '\n' : '');
  }

  MSE.subtitles = { formatSrtTimestamp, serializeSrt };
})(window.MSE = window.MSE || {});
