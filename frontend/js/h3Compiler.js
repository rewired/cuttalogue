// Phase C of docs/h3-shot-direction-roadmap.md: a pure, deterministic
// function that serializes a shot's cast roles + camera/subject direction
// tracks into MiniMax H3's official reference-generation prompt format
// (subject_definitions / summary / retention_analysis / detailed_description /
// overall_soundscape / non_diegetic_music). No LLM call in this version -
// that's a deferred second "access" per the roadmap doc; this one only
// serializes what was explicitly authored, never inventing detail.
//
// The compiler deliberately does NOT merge short segments into larger beats
// itself - the Direction modal's own hint to keep segments coarse stands in
// for that. It only takes the union of segment boundaries as-authored.
(function (MSE) {
  'use strict';

  const shotsApi = MSE.shots;

  const ROLE_ORDER = ['primary_character', 'supporting_character', 'environment', 'prop'];

  const ROLE_PRESERVE = {
    primary_character: 'identity, face, hair, wardrobe, and body proportions',
    supporting_character: 'identity, face, hair, wardrobe, and body proportions',
    environment: 'architecture, lighting, and spatial layout',
    prop: 'shape, material, color, and design',
  };

  const ROLE_DESCRIPTION = {
    primary_character: 'the primary character',
    supporting_character: 'a supporting character',
    environment: 'the environment',
    prop: 'a prop',
  };

  const MOVEMENT_PHRASES = {
    zoom_in: 'zooms in',
    zoom_out: 'zooms out',
    push_in: 'pushes in',
    pull_out: 'pulls back',
    pan: 'pans',
    truck: 'trucks sideways',
    tilt_up: 'tilts up',
    tilt_down: 'tilts down',
    pedestal_up: 'pedestals up',
    pedestal_down: 'pedestals down',
    tracking_shot: 'tracks alongside the subject',
    arc_shot: 'arcs around the subject',
    static_shot: 'remains static',
    shake_slightly: 'shakes slightly',
    shake_strongly: 'shakes strongly',
    pov: 'shows the subject’s point of view',
    roll_cw: 'rolls clockwise',
    roll_ccw: 'rolls counterclockwise',
  };

  // Guide section 1: "The target video is..." - a fixed style sentence
  // ahead of the shot content itself (Full-Reference mode puts style
  // *before* [Shot 1], unlike Base mode). A per-project style field is
  // future scope; this generic default at least gets the required
  // structural element right.
  const STYLE_OPENER = 'The target video is live-action and cinematic with natural human motion and realistic body mechanics.';

  const ACTION_TYPE_PHRASES = {
    walk: 'walks',
    run: 'runs',
    stop: 'stops',
    sit: 'sits',
    stand: 'stands',
    turn: 'turns',
    reach: 'reaches',
    pick_up: 'picks something up',
    put_down: 'puts something down',
    drink: 'drinks',
    check_phone: 'checks their phone',
    look: 'looks',
    speak: 'speaks',
    interact: 'interacts',
  };

  function formatSeconds(value) {
    return value.toFixed(2);
  }

  // Stable Subject N ordering: character roles before environment, otherwise
  // the order assets were assigned to the shot in - this order must stay
  // identical across repeated compiles of the same input (determinism).
  function orderedSubjects(shot) {
    const roles = shot.assetRoles || {};
    const roledIds = (shot.assetIds || []).filter((id) => roles[id]);
    roledIds.sort((a, b) => ROLE_ORDER.indexOf(roles[a]) - ROLE_ORDER.indexOf(roles[b]));
    return roledIds.map((assetId, index) => ({
      assetId,
      role: roles[assetId],
      label: `Subject ${index + 1}`,
      asset: MSE.assets.findAsset(assetId),
    }));
  }

  function isActingRole(role) {
    return role === 'primary_character' || role === 'supporting_character';
  }

  // Guide section 6.4: movement + amplitude + speed, as one natural
  // sentence rather than a tag list - "The camera pushes in with small
  // amplitude at slow speed toward her hand on the railing", amplitude/
  // speed clauses only appear when actually set.
  function phraseCamera(segment) {
    if (!segment) return '';
    const verb = MOVEMENT_PHRASES[segment.movement] || segment.movement;
    let sentence = `The camera ${verb}`;
    if (segment.direction) sentence += ` to the ${segment.direction}`;
    if (segment.amplitude) sentence += ` with ${segment.amplitude} amplitude`;
    if (segment.speed) sentence += ` at ${segment.speed} speed`;
    if (segment.framing) sentence += `, maintaining a ${segment.framing} composition`;
    if (segment.target) sentence += `, targeting ${segment.target}`;
    sentence += '.';
    if (segment.transitionToNext) sentence += ` ${segment.transitionToNext}.`;
    return sentence;
  }

  // Composes a character segment's structured fields (actionType/manner/
  // gaze/expression) into a sentence, then appends the free-text `notes` as
  // its own trailing sentence - append-if-present throughout, so a segment
  // carrying only `notes` (the common case right after the actionType/
  // manner/gaze/expression fields were introduced) still compiles exactly
  // as the old single-field `action` string used to.
  function phraseSubjectAction(label, segment) {
    if (!segment) return '';
    const clauses = [];
    if (segment.actionType) {
      let clause = ACTION_TYPE_PHRASES[segment.actionType] || segment.actionType;
      if (segment.manner) clause += `, ${segment.manner}`;
      clauses.push(clause);
    }
    if (segment.gaze) clauses.push(`looking ${segment.gaze}`);
    if (segment.expression) clauses.push(`with a ${segment.expression} expression`);
    const sentences = [];
    if (clauses.length > 0) sentences.push(`<${label}> ${clauses.join(', ')}.`);
    if (segment.notes) sentences.push(clauses.length > 0 ? segment.notes : `<${label}> ${segment.notes}.`);
    return sentences.join(' ');
  }

  // A prop's state (or, if it's explicitly held, the character holding it)
  // over time IS its before/after object state - adjacent prop segments
  // ("on saucer" -> "held by Heather" -> "on saucer") already express the
  // transition, no separate before/after schema needed. `ownerAssetId` wins
  // over free-text `state` when both are set, since it lets the compiler
  // reference the holder by its own <Subject N> label instead of prose.
  function phrasePropState(label, segment, subjects) {
    if (!segment) return '';
    if (segment.ownerAssetId) {
      const owner = subjects.find((s) => s.assetId === segment.ownerAssetId);
      if (owner) return `<${label}> is held by <${owner.label}>.`;
    }
    if (segment.state) return `<${label}> is ${segment.state}.`;
    return '';
  }

  function segmentActiveAt(segment, beatStart, beatEnd) {
    return segment.enabled !== false && segment.startSeconds <= beatStart + 1e-6 && segment.endSeconds >= beatEnd - 1e-6;
  }

  // Beat boundaries come straight from untouched segment edges (never
  // recomputed), so an exact match (float epsilon) is the right bar for
  // matching a beat to its optional note - not a loose time window.
  const BEAT_NOTE_EPSILON = 1e-6;

  // Finds the BeatNote (see shots.js's upsertBeatNote/removeBeatNote)
  // attached to the beat spanning [start, end], or null. Single source of
  // truth for "does this beat have a note" - used by this file's own
  // paragraph builder, by shots.js's upsertBeatNote (to find-or-create), and
  // by direction.js's beat UI (marker dot, detail panel, orphan detection).
  function findBeatNote(shot, start, end) {
    return (
      (shot.direction.beatNotes || []).find(
        (n) => Math.abs(n.startSeconds - start) <= BEAT_NOTE_EPSILON && Math.abs(n.endSeconds - end) <= BEAT_NOTE_EPSILON
      ) || null
    );
  }

  function collectBeatBoundaries(shot, subjects) {
    const points = new Set([0, shotsApi.shotDuration(shot)]);
    (shot.direction.camera || []).filter((seg) => seg.enabled !== false).forEach((seg) => {
      points.add(seg.startSeconds);
      points.add(seg.endSeconds);
    });
    subjects.filter((s) => isActingRole(s.role)).forEach((s) => {
      const track = (shot.direction.subjects || {})[s.assetId] || [];
      track.filter((seg) => seg.enabled !== false).forEach((seg) => {
        points.add(seg.startSeconds);
        points.add(seg.endSeconds);
      });
    });
    subjects.filter((s) => s.role === 'prop').forEach((s) => {
      const track = (shot.direction.props || {})[s.assetId] || [];
      track.filter((seg) => seg.enabled !== false).forEach((seg) => {
        points.add(seg.startSeconds);
        points.add(seg.endSeconds);
      });
    });
    return Array.from(points)
      .filter((t) => t >= 0 && t <= shotsApi.shotDuration(shot) + 1e-6)
      .sort((a, b) => a - b);
  }

  function lowercaseFirst(text) {
    return text.charAt(0).toLowerCase() + text.slice(1);
  }

  // Guide section 6.3: "[Shot 1] bekommt keinen Zeitstempel" - the shot's
  // first beat gets the [Shot 1] marker instead of a time range; every beat
  // after that is introduced with "From X to Y seconds," (lowercased into
  // the sentence that follows, since it's mid-sentence there, not after
  // "[Shot 1]" where a capital start reads correctly).
  function buildBeatParagraphs(shot, subjects) {
    const boundaries = collectBeatBoundaries(shot, subjects);
    const paragraphs = [];
    for (let i = 0; i < boundaries.length - 1; i++) {
      const start = boundaries[i];
      const end = boundaries[i + 1];
      if (end - start < 1e-6) continue;

      const sentences = [];
      const camera = (shot.direction.camera || []).find((seg) => segmentActiveAt(seg, start, end));
      const cameraPhrase = phraseCamera(camera);
      if (cameraPhrase) sentences.push(cameraPhrase);

      subjects
        .filter((s) => isActingRole(s.role))
        .forEach((s) => {
          const track = (shot.direction.subjects || {})[s.assetId] || [];
          const active = track.find((seg) => segmentActiveAt(seg, start, end));
          const actionPhrase = phraseSubjectAction(s.label, active);
          if (actionPhrase) sentences.push(actionPhrase);
        });

      subjects
        .filter((s) => s.role === 'prop')
        .forEach((s) => {
          const track = (shot.direction.props || {})[s.assetId] || [];
          const active = track.find((seg) => segmentActiveAt(seg, start, end));
          const statePhrase = phrasePropState(s.label, active, subjects);
          if (statePhrase) sentences.push(statePhrase);
        });

      // Priority is intentionally not compiled - it has no consumer until
      // the (deferred) conflict/priority engine exists; stored and editable
      // now, compiled later.
      const note = findBeatNote(shot, start, end);
      if (note && note.intent) sentences.push(`Intent: ${note.intent}.`);
      if (note && note.endState) sentences.push(`By the end of this beat: ${note.endState}.`);

      if (sentences.length === 0) continue;
      const body = sentences.join(' ');
      paragraphs.push(
        paragraphs.length === 0
          ? `[Shot 1] ${body}`
          : `From ${formatSeconds(start)} to ${formatSeconds(end)} seconds, ${lowercaseFirst(body)}`
      );
    }
    return paragraphs;
  }

  // Constraints are authored as short chip-style phrases ("No people"), not
  // full sentences - joining them with just a space (as buildLimits' caller
  // does for the whole limits list) would run them together with no
  // separator. Give each one a trailing period if it doesn't already end in
  // sentence punctuation.
  function ensureSentence(text) {
    const trimmed = text.trim();
    return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
  }

  // Auto-derived limits (multi-subject identity/no-cut) plus the shot's own
  // hand-authored Constraints (see the Direction tab's Constraints row) -
  // those apply to the whole shot, not any one segment, so they're appended
  // here rather than threaded through buildBeatParagraphs.
  function buildLimits(shot, subjects) {
    const actingSubjects = subjects.filter((s) => isActingRole(s.role));
    const limits = [];
    if (actingSubjects.length >= 2) {
      limits.push('Do not exchange identities, faces, or wardrobes between subjects.');
      limits.push('No additional people enter the shot.');
    }
    limits.push('No cut or scene transition - this is a single continuous shot.');
    limits.push(...(shot.constraints || []).map(ensureSentence));
    return limits;
  }

  function buildDetailedDescription(shot, subjects) {
    const beatParagraphs = buildBeatParagraphs(shot, subjects);
    return [STYLE_OPENER, ...beatParagraphs, buildLimits(shot, subjects).join(' ')].join('\n\n');
  }

  // Raw section content (no "sectionName:\n" prefixing, no empty-section
  // filtering) - compileH3Prompt just assembles these as before, but
  // "Expand with AI" (see direction.js) needs the deterministic
  // detailedDescription on its own to send for LLM expansion, then
  // reassembles the final prompt via assembleH3Prompt with only that one
  // field swapped out. The other five sections never go through the LLM.
  function compileH3Sections(shot) {
    const subjects = orderedSubjects(shot);

    // <Picture N> is the official H3-IR marker for "the Nth attached
    // reference image" (see docs/deep-research-report-h3-prompting.md,
    // lines ~551-559) - it's a different level from the `Image N` numbering
    // used in the provider-level hosted prompt when attaching the images
    // themselves. Subject N and Picture N align 1:1 here since v1 casts
    // exactly one reference image per subject role.
    const subjectDefinitions = subjects
      .map((s, i) => `<${s.label}> is ${ROLE_DESCRIPTION[s.role]} whose ${ROLE_PRESERVE[s.role]} come from <Picture ${i + 1}>.`)
      .join('\n');

    // "(appears throughout [Shot 1])" is always literal - H3's own shot
    // numbering is internal to one generation, and every one of our shots
    // compiles to its own separate generation (same "single continuous
    // shot" reasoning already in buildLimits).
    const retentionAnalysis = subjects
      .map((s) => `<${s.label}> (appears throughout [Shot 1]): fully_preserved - preserve ${ROLE_PRESERVE[s.role]}.`)
      .join('\n');

    const characterLabels = subjects.filter((s) => isActingRole(s.role)).map((s) => `<${s.label}>`);
    const summary =
      characterLabels.length > 0
        ? `[reference generation] A single continuous shot featuring ${characterLabels.join(' and ')}.`
        : '[reference generation] A single continuous shot.';

    return {
      subjectDefinitions: subjects.length > 0 ? subjectDefinitions : '',
      summary,
      retentionAnalysis: subjects.length > 0 ? retentionAnalysis : '',
      detailedDescription: buildDetailedDescription(shot, subjects),
      overallSoundscape: 'N/A',
      nonDiegeticMusic: 'N/A',
    };
  }

  function assembleH3Prompt(sections) {
    return [
      sections.subjectDefinitions ? `subject_definitions:\n${sections.subjectDefinitions}` : null,
      `summary:\n${sections.summary}`,
      sections.retentionAnalysis ? `retention_analysis:\n${sections.retentionAnalysis}` : null,
      `detailed_description:\n${sections.detailedDescription}`,
      `overall_soundscape: ${sections.overallSoundscape}`,
      `non_diegetic_music: ${sections.nonDiegeticMusic}`,
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  function compileH3Prompt(shot) {
    return assembleH3Prompt(compileH3Sections(shot));
  }

  MSE.h3Compiler = {
    compileH3Prompt,
    compileH3Sections,
    assembleH3Prompt,
    collectBeatBoundaries,
    orderedSubjects,
    isActingRole,
    findBeatNote,
  };
})(window.MSE = window.MSE || {});
