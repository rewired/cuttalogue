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

  const ROLE_PRESERVE = {
    primary_character: 'identity, face, hair, wardrobe, and body proportions',
    supporting_character: 'identity, face, hair, wardrobe, and body proportions',
    environment: 'architecture, lighting, and spatial layout',
    prop: 'shape, material, color, and design',
  };

  // Phase 4b: once the shot has its own authored Lighting Direction, the
  // generic environment-retention wording above must stop claiming lighting
  // stays fixed - that would directly contradict an authored lighting
  // change (see docs/h3-shot-direction-roadmap.md Phase 4b, "Environment
  // retention vs Lighting Direction"). Only "lighting" is dropped; spatial/
  // architectural retention still applies regardless of Lighting Direction.
  // A shot with no Lighting segments keeps the original wording unchanged.
  const ROLE_PRESERVE_NO_LIGHTING = { ...ROLE_PRESERVE, environment: 'architecture and spatial layout' };

  function rolePreserveText(role, hasLightingDirection) {
    return hasLightingDirection ? ROLE_PRESERVE_NO_LIGHTING[role] : ROLE_PRESERVE[role];
  }

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

  // Hard-cut phrasing for a beat marked isCut (see shots.js's
  // upsertBeatNote/applyBurstBeats) - modeled directly on the real
  // R2V_H3_V1.json workflow's node 166 "BURST TEST 1" example
  // (docs/deep-research-report-h3-prompting.md), which proves this exact
  // "[Shot N]\nAt T seconds, hard cut to..." convention works for H3.
  function hardCutIntro(shotNumber, start, body) {
    return `[Shot ${shotNumber}]\nAt ${formatSeconds(start)} seconds, hard cut to a new composition: ${lowercaseFirst(body)}`;
  }

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
    sing: 'sings',
  };

  // Phase 4a: vocal-performance sync requirement (see shots.js's
  // VOCAL_PERFORMANCES) - a clause distinct from actionType's own verb.
  // 'lip_sync' is folded into the action clause itself (see
  // phraseSubjectAction) rather than used standalone here, except when no
  // actionType is set at all.
  const VOCAL_PERFORMANCE_CLAUSE = 'with precise, natural lip sync';
  const VOCAL_PERFORMANCE_STANDALONE_CLAUSES = {
    lip_sync: `performing ${VOCAL_PERFORMANCE_CLAUSE}`,
    sing: 'singing',
    speak: 'speaking',
  };
  const VOCAL_PERFORMANCE_CLAUSES = {
    sing: 'singing',
    speak: 'speaking',
  };

  // Physical eye state (see shots.js's EYE_STATES) - deliberately distinct
  // wording from `gaze` (a directional clause, "looking at...") so the two
  // never read as duplicates of each other.
  const EYES_PHRASES = {
    open: 'open',
    closed: 'closed',
    half_closed: 'half-closed',
  };

  // Phase 4b: depth-of-field wording, centralized here (not scattered across
  // phraseCamera or duplicated elsewhere) so "shallow" always reads the same
  // way everywhere it's used.
  const DEPTH_OF_FIELD_PHRASES = {
    deep: 'deep depth of field',
    medium: 'moderate depth of field',
    shallow: 'shallow depth of field',
    very_shallow: 'very shallow depth of field',
  };

  // Phase 4b: exposure wording (see shots.js's LIGHTING_EXPOSURES), also
  // centralized for the same reason.
  const EXPOSURE_PHRASES = {
    low_key: 'low-key',
    dark: 'dark',
    balanced: 'balanced',
    slightly_underexposed: 'slightly underexposed',
    bright: 'bright',
    high_key: 'high-key',
  };

  function formatSeconds(value) {
    return value.toFixed(2);
  }

  // Subject N / Picture N ordering now comes from the canonical reference
  // binding (references.js) - the same binding Generate uses for
  // referenceAssetIds - so the two can never diverge. See references.js for
  // the role-order/stability rules.
  function orderedSubjects(shot) {
    return MSE.references.forShot(shot).map((ref) => ({
      assetId: ref.assetId,
      role: ref.role,
      label: ref.subjectLabel,
      asset: ref.asset,
    }));
  }

  function isActingRole(role) {
    return role === 'primary_character' || role === 'supporting_character';
  }

  // Guide section 6.4: movement + amplitude + speed, as one natural
  // sentence rather than a tag list - "The camera pushes in with small
  // amplitude at slow speed toward her hand on the railing", amplitude/
  // speed clauses only appear when actually set.
  // Optics (Phase 4b) are appended as further comma clauses on the same
  // sentence, same convention as framing/target above - `focalLength` is
  // interpolated as a bare compound modifier ("using 85mm framing", not
  // "using an 85mm framing") specifically to avoid needing an a/an-article
  // decision for an arbitrary string (see the Phase 4b preflight fix for
  // why that's brittle). `depthOfField` goes through the centralized
  // DEPTH_OF_FIELD_PHRASES map; `focusTarget` is optical focus, distinct
  // from `target` (movement/composition) above.
  function phraseCamera(segment) {
    if (!segment) return '';
    const verb = MOVEMENT_PHRASES[segment.movement] || segment.movement;
    let sentence = `The camera ${verb}`;
    if (segment.direction) sentence += ` to the ${segment.direction}`;
    if (segment.amplitude) sentence += ` with ${segment.amplitude} amplitude`;
    if (segment.speed) sentence += ` at ${segment.speed} speed`;
    if (segment.framing) sentence += `, maintaining a ${segment.framing} composition`;
    if (segment.target) sentence += `, targeting ${segment.target}`;
    if (segment.focalLength) sentence += `, using ${segment.focalLength} framing`;
    if (segment.depthOfField) sentence += `, with ${DEPTH_OF_FIELD_PHRASES[segment.depthOfField] || segment.depthOfField}`;
    if (segment.focusTarget) sentence += `, maintaining focus on ${segment.focusTarget}`;
    sentence += '.';
    if (segment.transitionToNext) sentence += ` ${segment.transitionToNext}.`;
    return sentence;
  }

  // Phase 4b: Lighting is independent authored Direction (unlike Vocal
  // Regions), so its boundaries ARE semantic beat boundaries (see
  // collectBeatBoundaries) and its active segment contributes its own
  // sentence per beat, same call shape as phraseCamera/phraseSubjectAction.
  // Verb-led clauses ("is X", "sits in Y", "keyed by Z") rather than raw
  // noun interpolation, so no a/an decision is ever needed and a value that
  // happens to already contain a category word (e.g. fill: "soft neutral
  // fill") never literally duplicates it. No hidden state: called fresh per
  // beat, so a Lighting segment spanning several beats legitimately repeats
  // its own description each time (matches the compiler's existing
  // self-contained-beat style, e.g. phraseCamera does the same).
  function phraseLighting(segment) {
    if (!segment) return '';
    const clauses = [];
    if (segment.exposure) clauses.push(`is ${EXPOSURE_PHRASES[segment.exposure] || segment.exposure}`);
    if (segment.atmosphere) clauses.push(`sits in ${segment.atmosphere}`);
    if (segment.keyLight) clauses.push(`keyed by ${segment.keyLight}`);
    if (segment.fill) clauses.push(`filled by ${segment.fill}`);
    if (segment.backlight) clauses.push(`backlit by ${segment.backlight}`);
    const sentences = [];
    if (clauses.length > 0) sentences.push(`Lighting ${clauses.join(', ')}.`);
    if (segment.notes) sentences.push(sentences.length > 0 ? segment.notes : `Lighting: ${segment.notes}.`);
    return sentences.join(' ');
  }

  // Composes a character segment's structured fields into a sentence, then
  // appends gesture/bodyMotion/notes as their own trailing sentences -
  // append-if-present throughout, so a segment carrying only a subset of
  // fields (including the pre-Phase-4a shape with none of vocalPerformance/
  // eyes/gesture/bodyMotion set) still compiles exactly as before. Field
  // ownership (see docs/h3-shot-direction-roadmap.md Phase 4a):
  //   actionType        -> core action verb
  //   vocalPerformance  -> sync/performance requirement (folded into the
  //                        action clause for lip_sync, its own clause
  //                        otherwise - never repeated if it would just
  //                        restate actionType, e.g. actionType: 'sing' +
  //                        vocalPerformance: 'sing')
  //   manner            -> how the action is performed
  //   expression        -> facial emotion
  //   eyes              -> physical eye state (distinct from gaze)
  //   gaze              -> looking direction/target
  //   gesture           -> specific hand/arm gesture, own sentence (already
  //                        a full free-text clause, not comma-joined)
  //   bodyMotion        -> overall movement quality, own sentence
  //   notes             -> fallback exceptional instruction, never repeats
  //                        the structured fields above
  function phraseSubjectAction(label, segment) {
    if (!segment) return '';
    const clauses = [];
    if (segment.actionType) {
      let clause = ACTION_TYPE_PHRASES[segment.actionType] || segment.actionType;
      if (segment.manner) clause += `, ${segment.manner}`;
      if (segment.vocalPerformance === 'lip_sync') clause += `, ${VOCAL_PERFORMANCE_CLAUSE}`;
      clauses.push(clause);
    }
    if (segment.vocalPerformance && segment.vocalPerformance !== segment.actionType) {
      if (segment.vocalPerformance === 'lip_sync') {
        if (!segment.actionType) clauses.push(VOCAL_PERFORMANCE_STANDALONE_CLAUSES.lip_sync);
        // else already folded into the action clause above.
      } else {
        clauses.push(VOCAL_PERFORMANCE_CLAUSES[segment.vocalPerformance]);
      }
    }
    if (segment.eyes) clauses.push(`eyes ${EYES_PHRASES[segment.eyes] || segment.eyes}`);
    if (segment.gaze) clauses.push(`looking ${segment.gaze}`);

    const sentences = [];
    if (clauses.length > 0) sentences.push(`<${label}> ${clauses.join(', ')}.`);
    // A predicate-adjective sentence ("X's expression is Y") rather than
    // "with a/an Y expression" - sidesteps needing a brittle a/an-selection
    // helper for an arbitrary free-text adjective (was: "with a emotionally
    // intense expression", wrongly missing the "n"; see the Phase 4b
    // preflight fix).
    if (segment.expression) sentences.push(`<${label}>'s expression is ${segment.expression}.`);
    if (segment.gesture) sentences.push(ensureSentence(capitalizeFirst(segment.gesture)));
    if (segment.bodyMotion) sentences.push(`<${label}>'s overall body movement is ${segment.bodyMotion.replace(/\.$/, '')}.`);
    if (segment.notes) sentences.push(sentences.length > 0 ? segment.notes : `<${label}> ${segment.notes}.`);
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
    // Lighting is authored Direction (unlike transient Vocal Regions - see
    // Phase 4a/4b's own architecture note), so its boundaries are genuine
    // semantic beat boundaries, same as Camera/Character/Prop above. A
    // region boundary with no authored segment at it never reaches this
    // function at all, so that invariant stays intact untouched.
    (shot.direction.lighting || []).filter((seg) => seg.enabled !== false).forEach((seg) => {
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

  function capitalizeFirst(text) {
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  // Guide section 6.3: "[Shot 1] bekommt keinen Zeitstempel" - the shot's
  // first beat gets the [Shot 1] marker instead of a time range. Every beat
  // after that is either a continuation of the current [Shot N] ("From X to
  // Y seconds," - lowercased into the sentence that follows, since it's
  // mid-sentence there) or, if the beat's own note has isCut set (see
  // shots.js's upsertBeatNote/applyBurstBeats - individually via the beat
  // detail panel, or in bulk via Burst Mode), the start of a brand new
  // [Shot N] hard cut. With no isCut beats at all, this produces exactly
  // today's single-[Shot 1]-plus-continuations output - the branch below is
  // additive, never a behavior change for existing shots.
  function buildBeatParagraphs(shot, subjects) {
    const boundaries = collectBeatBoundaries(shot, subjects);
    const paragraphs = [];
    let shotNumber = 0;
    // Whenever this shot has any cut at all, [Shot 1] needs its own end
    // boundary stated too - a single continuous shot doesn't (its [Shot 1]
    // IS the whole duration, redundant to restate), but once there's a
    // second [Shot N] coming, H3 needs to know how long the first one holds
    // before the cut. Matches the real proven R2V_H3_V1.json workflow's
    // node 166 "BURST TEST 1" example, whose own [Shot 1] reads "From 0.00
    // to 1.00 seconds: ..." rather than a bare marker.
    const hasAnyCutMarked = (shot.direction.beatNotes || []).some((n) => n.isCut);
    for (let i = 0; i < boundaries.length - 1; i++) {
      const start = boundaries[i];
      const end = boundaries[i + 1];
      if (end - start < 1e-6) continue;

      const sentences = [];
      const camera = (shot.direction.camera || []).find((seg) => segmentActiveAt(seg, start, end));
      const cameraPhrase = phraseCamera(camera);
      if (cameraPhrase) sentences.push(cameraPhrase);

      const lighting = (shot.direction.lighting || []).find((seg) => segmentActiveAt(seg, start, end));
      const lightingPhrase = phraseLighting(lighting);
      if (lightingPhrase) sentences.push(lightingPhrase);

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

      const isCut = shotNumber === 0 || !!(note && note.isCut);
      if (isCut) {
        shotNumber += 1;
        if (shotNumber > 1) {
          paragraphs.push(hardCutIntro(shotNumber, start, body));
        } else if (hasAnyCutMarked) {
          paragraphs.push(`[Shot 1]\nFrom ${formatSeconds(start)} to ${formatSeconds(end)} seconds: ${body}`);
        } else {
          paragraphs.push(`[Shot 1] ${body}`);
        }
      } else {
        paragraphs.push(`From ${formatSeconds(start)} to ${formatSeconds(end)} seconds, ${lowercaseFirst(body)}`);
      }
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
  function buildLimits(shot, subjects, hasCuts) {
    const actingSubjects = subjects.filter((s) => isActingRole(s.role));
    const limits = [];
    if (actingSubjects.length >= 2) {
      limits.push('Do not exchange identities, faces, or wardrobes between subjects.');
      limits.push('No additional people enter the shot.');
    }
    // Bounded-reference discipline: each <Subject N> is defined from its own
    // <Picture N> (see subjectDefinitions/retentionAnalysis above) - without
    // this line nothing stops H3 from letting one subject's reference bleed
    // into another subject/prop/the environment. Any two references can
    // bleed into each other, not just two acting roles, so this checks
    // subjects.length rather than actingSubjects.length.
    if (subjects.length >= 2) {
      limits.push(
        'Do not let one subject’s reference attributes (wardrobe, color, style, or identity) bleed into another subject, prop, or the environment.'
      );
    }
    // hasCuts (>=1 beat marked isCut, see shots.js) means the shot compiles
    // to more than one [Shot N] block - the literal opposite of "single
    // continuous shot", so the limit line has to flip with it.
    if (hasCuts) {
      limits.push('Hard cuts only between marked shots. No morphing or visual blending across a cut.');
      limits.push('Each new shot must already look finished from its first frame.');
    } else {
      limits.push('No cut or scene transition - this is a single continuous shot.');
    }
    limits.push(...(shot.constraints || []).map(ensureSentence));
    return limits;
  }

  function buildDetailedDescription(beatParagraphs, limitsText) {
    return [STYLE_OPENER, ...beatParagraphs, limitsText].join('\n\n');
  }

  // Raw section content (no "sectionName:\n" prefixing, no empty-section
  // filtering) - compileH3Prompt just assembles these as before, but
  // "Expand with AI" (see direction.js) needs the deterministic
  // detailedDescription on its own to send for LLM expansion, then
  // reassembles the final prompt via assembleH3Prompt with only that one
  // field swapped out. The other five sections never go through the LLM.
  function compileH3Sections(shot) {
    const subjects = orderedSubjects(shot);

    // Once the shot has its own authored Lighting Direction, generic
    // environment-retention wording must stop insisting lighting stays the
    // same (see rolePreserveText's own comment). Any enabled Lighting
    // segment counts, regardless of which fields it has populated - the
    // user has started directing lighting explicitly the moment one exists.
    const hasLightingDirection = (shot.direction.lighting || []).some((seg) => seg.enabled !== false);

    // <Picture N> is the official H3-IR marker for "the Nth attached
    // reference image" (see docs/deep-research-report-h3-prompting.md,
    // lines ~551-559) - it's a different level from the `Image N` numbering
    // used in the provider-level hosted prompt when attaching the images
    // themselves. Subject N and Picture N align 1:1 here since v1 casts
    // exactly one reference image per subject role.
    const subjectDefinitions = subjects
      .map((s, i) => `<${s.label}> is ${ROLE_DESCRIPTION[s.role]} whose ${rolePreserveText(s.role, hasLightingDirection)} come from <Picture ${i + 1}>.`)
      .join('\n');

    // beatParagraphs is computed once here and threaded into
    // buildDetailedDescription below, rather than each recomputing its own
    // copy - shotCount (how many [Shot N] markers actually got emitted,
    // see buildBeatParagraphs) is what the rest of this function branches
    // on, and it's only knowable after walking the beats once.
    const beatParagraphs = buildBeatParagraphs(shot, subjects);
    const shotCount = beatParagraphs.filter((p) => p.startsWith('[Shot ')).length;
    const hasCuts = shotCount > 1;

    // "(appears throughout [Shot 1])" was always literal before Burst/cut
    // support existed, because every shot compiled to exactly one [Shot 1]
    // block. A shot with hard cuts spans multiple [Shot N] blocks, so the
    // scope has to say "every shot" instead (matches the real R2V_H3_V1.json
    // workflow's node 166 example: "<Subject 1> is fully preserved in every
    // shot.").
    const scopeLabel = hasCuts ? 'every shot' : '[Shot 1]';
    const retentionAnalysis = subjects
      .map((s) => `<${s.label}> (appears throughout ${scopeLabel}): fully_preserved - preserve ${rolePreserveText(s.role, hasLightingDirection)}.`)
      .join('\n');

    const characterLabels = subjects.filter((s) => isActingRole(s.role)).map((s) => `<${s.label}>`);
    const summary = hasCuts
      ? characterLabels.length > 0
        ? `[reference generation] A hard-cut sequence of ${shotCount} shots featuring ${characterLabels.join(' and ')}.`
        : `[reference generation] A hard-cut sequence of ${shotCount} shots.`
      : characterLabels.length > 0
      ? `[reference generation] A single continuous shot featuring ${characterLabels.join(' and ')}.`
      : '[reference generation] A single continuous shot.';

    return {
      subjectDefinitions: subjects.length > 0 ? subjectDefinitions : '',
      summary,
      retentionAnalysis: subjects.length > 0 ? retentionAnalysis : '',
      detailedDescription: buildDetailedDescription(beatParagraphs, buildLimits(shot, subjects, hasCuts).join(' ')),
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
