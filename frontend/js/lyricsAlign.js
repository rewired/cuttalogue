// Phase 3a of docs/h3-shot-direction-roadmap.md: local word-level lyrics-to-
// vocal alignment. This module owns the Lyrics tab (textarea persistence,
// the Align job, and the transient preview/apply flow) but does NOT own any
// cue state - alignment results are a preview only, converted into real
// Phase-2 vocal cues purely through MSE.vocalCues.add()/remove() when the
// user clicks Apply. Once applied, the main timeline/Direction editor pick
// them up through the existing vocal-cues-changed event, same as any
// manually authored cue - there is no second cue display path here.
(function (MSE) {
  'use strict';

  const { state, on, emit } = MSE.state;

  const el = {};
  let isVisible = false;
  // Last alignment result (array of { text, startSeconds, endSeconds,
  // confidence, lineIndex, wordIndex }, startSeconds/endSeconds null for a
  // word the aligner couldn't place) - null until an alignment has actually
  // completed. Transient by design (see file header); never written to
  // state/project.
  let previewWords = null;
  // The exact lyrics text that produced previewWords, snapshotted at
  // request time rather than re-read from state.lyrics.text later - phrase
  // derivation needs the original line text for lineIndex lookups, and the
  // user may keep editing the textarea while a job is in flight or after it
  // completes, which must never retroactively change what a *past* result's
  // phrases mean.
  let previewLyricsText = '';
  // Derived from previewWords/previewLyricsText via MSE.vocalRegions - see
  // deriveAndRenderRegions(). Transient, same lifecycle as previewWords;
  // never persisted, never a second cue system (Phase 2's vocalCues remains
  // the only persistent point-cue model - see the file header).
  let previewPhrases = [];
  let previewHolds = [];
  let holdThresholdSeconds = MSE.vocalRegions.DEFAULT_HOLD_THRESHOLD_SECONDS;

  function cacheElements() {
    el.textarea = document.getElementById('lyrics-text');
    el.alignBtn = document.getElementById('align-lyrics-btn');
    el.alignSpinner = document.getElementById('align-spinner');
    el.alignStatusText = document.getElementById('align-status-text');
    el.previewEmpty = document.getElementById('align-preview-empty');
    el.previewDetail = document.getElementById('align-preview-detail');
    el.previewList = document.getElementById('align-preview-list');
    el.regionViz = document.getElementById('lyrics-region-viz');
    el.phrasesList = document.getElementById('align-preview-phrases');
    el.phrasesEmpty = document.getElementById('align-preview-phrases-empty');
    el.holdsList = document.getElementById('align-preview-holds');
    el.holdsEmpty = document.getElementById('align-preview-holds-empty');
    el.holdThresholdInput = document.getElementById('hold-threshold-input');
    el.applyBtn = document.getElementById('apply-alignment-btn');
    el.applyStatusText = document.getElementById('apply-status-text');
    el.modeAdd = document.getElementById('align-apply-mode-add');
    el.modeReplace = document.getElementById('align-apply-mode-replace');
  }

  // Mirrors renderShotList's "don't clobber an active edit" guard - a full
  // resync (project load, tab switch) must never overwrite what's mid-typing.
  function syncTextareaFromState() {
    if (document.activeElement === el.textarea) return;
    el.textarea.value = (state.lyrics && state.lyrics.text) || '';
  }

  // Free text mutated directly on state, same convention as shot prompt/
  // notes (contextPanel.js) - draft autosave's poll-and-diff picks this up
  // without needing its own change event.
  function wireTextarea() {
    el.textarea.addEventListener('input', () => {
      state.lyrics.text = el.textarea.value;
    });
  }

  function renderPreview() {
    el.previewList.innerHTML = '';
    const hasWords = !!(previewWords && previewWords.length);
    el.previewEmpty.style.display = hasWords ? 'none' : '';
    el.previewDetail.style.display = hasWords ? '' : 'none';
    if (!hasWords) return;

    previewWords.forEach((word) => {
      const row = document.createElement('tr');
      const unaligned = word.startSeconds == null;
      row.className = `lyrics-preview-row${unaligned ? ' unaligned' : ''}`;

      const startCell = document.createElement('td');
      startCell.textContent = unaligned ? '—' : MSE.format.formatTime(word.startSeconds);
      row.appendChild(startCell);

      const endCell = document.createElement('td');
      endCell.textContent = unaligned || word.endSeconds == null ? '—' : MSE.format.formatTime(word.endSeconds);
      row.appendChild(endCell);

      const wordCell = document.createElement('td');
      wordCell.textContent = unaligned ? `${word.text} (unaligned)` : word.text;
      if (word.confidence != null) wordCell.title = `confidence ${word.confidence.toFixed(2)}`;
      row.appendChild(wordCell);

      el.previewList.appendChild(row);
    });
  }

  // Optional per Phase 3b (section 10) - a normal vocal cue at a region
  // boundary, created exclusively through MSE.vocalCues.add(), never a
  // direct state.vocalCues write and never a second "paired" cue. Regions
  // themselves stay analysis-only; this just gives the user a one-click way
  // to promote a boundary they find useful into the persistent Phase-2 cue
  // timeline, same as any other manually authored cue.
  function addCueAtRegionStart(region) {
    MSE.vocalCues.add(region.startSeconds, region.text);
    el.applyStatusText.textContent = `Added a vocal cue at ${MSE.format.formatTime(region.startSeconds)} ("${region.text}").`;
  }

  function buildRegionRow(region) {
    const row = document.createElement('tr');
    const startCell = document.createElement('td');
    startCell.textContent = MSE.format.formatTime(region.startSeconds);
    row.appendChild(startCell);

    const endCell = document.createElement('td');
    endCell.textContent = MSE.format.formatTime(region.endSeconds);
    row.appendChild(endCell);

    const textCell = document.createElement('td');
    textCell.textContent = region.text;
    if (region.type === 'hold' && MSE.vocalRegions.looksElongated(region.text)) {
      textCell.title = 'Elongated spelling - a supporting hint only, not the timing source';
      textCell.className = 'lyrics-elongated-hint';
    }
    row.appendChild(textCell);

    const actionCell = document.createElement('td');
    const cueBtn = document.createElement('button');
    cueBtn.type = 'button';
    cueBtn.className = 'lyrics-region-cue-btn';
    cueBtn.textContent = '+ Cue';
    cueBtn.title = `Create a vocal cue at this ${region.type}'s start`;
    cueBtn.addEventListener('click', () => addCueAtRegionStart(region));
    actionCell.appendChild(cueBtn);
    row.appendChild(actionCell);

    return row;
  }

  function renderPhrases() {
    el.phrasesList.innerHTML = '';
    el.phrasesEmpty.hidden = previewPhrases.length !== 0;
    previewPhrases.forEach((phrase) => el.phrasesList.appendChild(buildRegionRow(phrase)));
  }

  function renderHolds() {
    el.holdsList.innerHTML = '';
    el.holdsEmpty.hidden = previewHolds.length !== 0;
    previewHolds.forEach((hold) => el.holdsList.appendChild(buildRegionRow(hold)));
  }

  // Compact, self-contained proportional strip (word dots / phrase bars /
  // hold bars) scoped to the Lyrics tab preview only - deliberately not
  // wired into the main WaveSurfer timeline or the Direction editor, which
  // would mean a second timeline-overlay system for what's still a
  // transient analysis view (see the file header's three-concepts note).
  function renderRegionViz() {
    el.regionViz.innerHTML = '';
    const usable = (previewWords || []).filter((w) => w.startSeconds != null && w.endSeconds != null && w.endSeconds > w.startSeconds);
    if (!usable.length) {
      el.regionViz.hidden = true;
      return;
    }
    el.regionViz.hidden = false;
    const spanStart = Math.min(...usable.map((w) => w.startSeconds));
    const spanEnd = Math.max(...usable.map((w) => w.endSeconds));
    const span = Math.max(1e-6, spanEnd - spanStart);
    const pct = (t) => `${((t - spanStart) / span) * 100}%`;

    function buildTrack(label, className) {
      const row = document.createElement('div');
      row.className = 'lyrics-viz-row';
      const labelEl = document.createElement('div');
      labelEl.className = 'lyrics-viz-row-label';
      labelEl.textContent = label;
      row.appendChild(labelEl);
      const track = document.createElement('div');
      track.className = `lyrics-viz-track lyrics-viz-track-${className}`;
      row.appendChild(track);
      el.regionViz.appendChild(row);
      return track;
    }

    const wordsTrack = buildTrack('Words', 'words');
    usable.forEach((w) => {
      const dot = document.createElement('div');
      dot.className = 'lyrics-viz-dot';
      dot.style.left = pct(w.startSeconds);
      dot.title = w.text;
      wordsTrack.appendChild(dot);
    });

    const phrasesTrack = buildTrack('Phrases', 'phrases');
    previewPhrases.forEach((p) => {
      const bar = document.createElement('div');
      bar.className = 'lyrics-viz-bar lyrics-viz-bar-phrase';
      bar.style.left = pct(p.startSeconds);
      bar.style.width = `${((p.endSeconds - p.startSeconds) / span) * 100}%`;
      bar.title = p.text;
      phrasesTrack.appendChild(bar);
    });

    const holdsTrack = buildTrack('Holds', 'holds');
    previewHolds.forEach((h) => {
      const bar = document.createElement('div');
      bar.className = 'lyrics-viz-bar lyrics-viz-bar-hold';
      bar.style.left = pct(h.startSeconds);
      bar.style.width = `${((h.endSeconds - h.startSeconds) / span) * 100}%`;
      bar.title = h.text;
      holdsTrack.appendChild(bar);
    });
  }

  // Pure re-derivation over the already-fetched previewWords/
  // previewLyricsText - never re-runs alignment, never touches the backend
  // (see MSE.vocalRegions' own header on why this is safe/cheap to call on
  // every hold-threshold change).
  function deriveAndRenderRegions() {
    if (previewWords && previewWords.length) {
      const derived = MSE.vocalRegions.deriveRegions(previewWords, previewLyricsText, { holdThresholdSeconds });
      previewPhrases = derived.phrases;
      previewHolds = derived.holds;
    } else {
      previewPhrases = [];
      previewHolds = [];
    }
    renderPhrases();
    renderHolds();
    renderRegionViz();
    // Phase 4a: the Direction editor's read-only Vocal Phrases/Holds rows
    // and its region-boundary snap candidates both read the current result
    // fresh via getCurrentRegions() below (never a local copy) - this is
    // the one place that result actually changes, so it's the one place
    // that needs to say so.
    emit('vocal-regions-changed');
  }

  // Phase 4a: the Direction editor consumes the *current* transient
  // analysis result for authoring assistance (read-only reference rows,
  // region -> segment creation, region-boundary snapping) - this is the
  // one accessor for that, returning the same arrays renderPhrases/
  // renderHolds already render from. Never a second derivation: Direction
  // calls MSE.vocalRegions.regionsForShot() itself against whatever this
  // returns, exactly like it already does for MSE.vocalCues.forShot().
  function getCurrentRegions() {
    return { phrases: previewPhrases, holds: previewHolds };
  }

  function setAlignStatus(text, spinning) {
    el.alignStatusText.textContent = text;
    el.alignSpinner.hidden = !spinning;
  }

  async function runAlignment() {
    const lyricsText = (state.lyrics && state.lyrics.text) || '';
    if (!lyricsText.trim()) {
      setAlignStatus('Enter lyrics before alignment.', false);
      return;
    }
    const projectId = MSE.project.getProjectId();
    if (!projectId) {
      setAlignStatus('No project loaded.', false);
      return;
    }

    el.alignBtn.disabled = true;
    el.applyStatusText.textContent = '';
    setAlignStatus('Starting…', true);
    try {
      const { jobId } = await MSE.api.alignLyrics(projectId, lyricsText);
      const event = await MSE.api.watchJob(jobId, (progressEvent) => {
        if (progressEvent.message) setAlignStatus(progressEvent.message, true);
      });
      previewWords = (event.result && event.result.words) || [];
      previewLyricsText = lyricsText;
      renderPreview();
      deriveAndRenderRegions();
      const alignedCount = previewWords.filter((w) => w.startSeconds != null).length;
      setAlignStatus(`Aligned ${alignedCount} of ${previewWords.length} word(s).`, false);
    } catch (err) {
      console.error(err);
      previewWords = null;
      previewLyricsText = '';
      renderPreview();
      deriveAndRenderRegions();
      setAlignStatus(`Failed: ${err.message}`, false);
    } finally {
      el.alignBtn.disabled = false;
    }
  }

  // Pure: converts alignment words into real Phase-2 vocal cues exclusively
  // through MSE.vocalCues' own API (never a direct state.vocalCues write) -
  // see the file header. Words the aligner couldn't place (startSeconds ==
  // null) are skipped entirely, per Phase 3a's "never invent a timestamp"
  // rule; they simply don't become cues. No DOM here - kept separate from
  // applyAlignment() below so it's directly unit-testable (see
  // frontend/tests/lyricsAlign.test.js) the same way vocalCues.js's own
  // functions are. mode is 'add' or 'replace'.
  function applyAlignmentWords(words, mode) {
    if (mode === 'replace') {
      MSE.vocalCues.list().map((c) => c.id).forEach((id) => MSE.vocalCues.remove(id));
    }
    let created = 0;
    (words || []).forEach((word) => {
      if (word.startSeconds == null) return;
      MSE.vocalCues.add(word.startSeconds, word.text);
      created += 1;
    });
    return { created };
  }

  function applyAlignment() {
    if (!previewWords || !previewWords.length) return;
    const mode = el.modeReplace.checked ? 'replace' : 'add';
    const { created } = applyAlignmentWords(previewWords, mode);
    el.applyStatusText.textContent = mode === 'replace'
      ? `Replaced existing vocal cues with ${created} new one(s).`
      : `Added ${created} new vocal cue(s).`;
  }

  function wire() {
    wireTextarea();
    el.alignBtn.addEventListener('click', () => runAlignment());
    el.applyBtn.addEventListener('click', () => applyAlignment());
    // Re-derives locally from the already-fetched words - never re-runs
    // alignment (see deriveAndRenderRegions's own comment).
    el.holdThresholdInput.addEventListener('change', () => {
      const parsed = Number(el.holdThresholdInput.value);
      holdThresholdSeconds = Number.isFinite(parsed) && parsed >= 0 ? parsed : MSE.vocalRegions.DEFAULT_HOLD_THRESHOLD_SECONDS;
      el.holdThresholdInput.value = holdThresholdSeconds;
      deriveAndRenderRegions();
    });

    on('main-view-changed', ({ detail }) => {
      isVisible = detail.view === 'lyrics';
      if (isVisible) syncTextareaFromState();
    });
    on('project-loaded', () => {
      previewWords = null;
      previewLyricsText = '';
      renderPreview();
      deriveAndRenderRegions();
      setAlignStatus('', false);
      el.applyStatusText.textContent = '';
      if (isVisible) syncTextareaFromState();
    });
  }

  function init() {
    cacheElements();
    holdThresholdSeconds = MSE.vocalRegions.DEFAULT_HOLD_THRESHOLD_SECONDS;
    el.holdThresholdInput.value = holdThresholdSeconds;
    wire();
    renderPreview();
    deriveAndRenderRegions();
  }

  document.addEventListener('DOMContentLoaded', init);

  MSE.lyricsAlign = { applyAlignmentWords, getCurrentRegions };
})(window.MSE = window.MSE || {});
