// Phase C of docs/h3-shot-direction-roadmap.md: a pure, deterministic
// function that serializes a shot's cast roles + camera/subject direction
// tracks into MiniMax H3's prompt dialects: six-section reference generation
// (subject_definitions / summary / retention_analysis / detailed_description /
// overall_soundscape / non_diegetic_music) or three-section base generation
// (integrated_multimodal_description / overall_soundscape /
// non_diegetic_music). No LLM call in this version -
// that's a deferred second "access" per the roadmap doc; this one only
// serializes what was explicitly authored, never inventing detail.
//
// The compiler deliberately does NOT merge short segments into larger beats
// itself - the Direction modal's own hint to keep segments coarse stands in
// for that. It only takes the union of segment boundaries as-authored.
//
// Phase 5 ("H3 Prompt Compiler 2.0"): beat construction and prose rendering
// are now two separate stages. buildSemanticBeats() walks the authored
// Direction once per shot and produces a normalized, compiler-only
// Semantic Beat IR (never persisted) carrying the active Camera/Lighting/
// per-subject/per-prop segment for every beat interval, plus its BeatNote
// and hard-cut flag. renderSemanticBeat() then composes ONE beat's prose,
// diffing against the immediately preceding beat (by object identity - see
// its own comment) so a lane that's simply continuing unchanged is not
// restated every beat, while a hard cut resets that continuity outright.
// Canonical reference binding (Phase 0) and the "vocal regions never create
// a beat boundary by themselves" invariant (Phase 4a) are both untouched by
// this refactor - buildSemanticBeats still reads subject identity only from
// orderedSubjects()/MSE.references, and collectBeatBoundaries still has no
// parameter for region data at all.
(function (MSE) {
  'use strict';

  const shotsApi = MSE.shots;

  // Phase 5: bumped whenever this file's compiled WORDING changes for
  // already-populated Direction fields (schemas/semantics are unchanged -
  // see section 34 of the Phase 5 spec). Not persisted anywhere yet; no
  // take/generation record currently stores a compiler version, and adding
  // one is out of scope for a compiler-internals-only phase.
  const H3_COMPILER_VERSION = '2.1';

  const H3_PROMPT_MODES = {
    REFERENCE: 'reference',
    BASE: 'base',
  };

  const VOCAL_REFERENCE_SOUNDSCAPE = [
    'Use the supplied vocal reference as the exact vocal performance and timing source.',
    'Preserve its audible words, delivery, and synchronization; do not replace or paraphrase the vocal.',
  ].join(' ');

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
  // Phase 5 note (section 31): retention already never mentions pose/action
  // for character roles, so no further narrowing was needed there.
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

  // Movement vocabulary is centralized here (section 8) and never renamed -
  // each entry keeps its own distinct verb so optical zoom, physical push/
  // pull, and traveling/tracking language never collapse into one generic
  // "moves closer" (section 9).
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
  // structural element right. Untouched by Phase 5 (spec section: "keep
  // STYLE_OPENER untouched").
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
  // the role-order/stability rules. Phase 5's Semantic Beat IR reads subject
  // identity exclusively through this function too - no independent
  // ordering exists anywhere in this file.
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

  // Joins 1+ already-composed noun phrases with a natural "and" (no Oxford
  // comma - the compact style already used throughout this file). Used by
  // phraseLighting's key/fill/backlight list; deliberately generic so it can
  // serve any future comma-list without a bespoke join per caller.
  function joinWithAnd(parts) {
    if (parts.length === 0) return '';
    if (parts.length === 1) return parts[0];
    if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
    return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;
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
  // from `target` (movement/composition) above - Phase 5 keeps both as
  // independent clauses on purpose (section 27/Case O: they're different
  // concepts even when the authored value happens to be the same string).
  //
  // Phase 5 deliberately does NOT restructure this sentence's own internal
  // grammar further (e.g. weaving speed/direction into the verb as
  // adjectives) - `speed`/`direction` are free text with no closed
  // vocabulary, and guessing adverb morphology for arbitrary strings is
  // exactly the kind of brittle mini-NLP the spec warns against elsewhere.
  // What Phase 5 changes about Camera is at the beat-composition level
  // (see renderSemanticBeat): an unchanged Camera segment is no longer
  // restated every beat, and hard cuts force a full restatement. This
  // sentence itself is unchanged from Phase 4b, so it stays byte-identical
  // for the same segment.
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

  // Phase 5 Lighting grammar rewrite (preflight fix + spec section 15):
  // replaces the Phase 4b mechanical "is X, sits in Y, keyed by Z, filled by
  // W, backlit by V" clause list - "sits in dark smoky club" (missing
  // article) and "filled by minimal" (a verb bolted onto a bare adjective)
  // both read as broken English - with one natural sentence.
  //
  // keyLight/backlight are authored as complete descriptive phrases already
  // ("warm stage key from camera-left", "subtle amber rim" - see their
  // datalist placeholders in direction.js), so they're introduced with "the"
  // rather than "a/an": same anti-brittleness reasoning as the Phase 4b
  // expression-grammar fix (an arbitrary free-text phrase can start with any
  // letter, and "the" is grammatical either way, unlike "a/an"). `fill` is
  // authored as a bare adjective ("minimal", "soft") and is instead composed
  // as a compound modifier ("minimal fill"), the same technique already used
  // for Camera's focalLength ("85mm framing") - never "filled by minimal".
  // `atmosphere` is folded into the same main clause ("in the X atmosphere")
  // rather than its own "sits in" sentence.
  //
  // `isChange` (Phase 5 section 16) is true only when this Lighting segment
  // is a genuine change from a different, non-null previous segment (see
  // renderSemanticBeat) - it swaps the leading verb to "shifts to"/"shifts
  // into" so a real Lighting change reads as a change, not a restatement.
  // Deliberately a single boolean, not a full previous-vs-current field
  // diff - the spec explicitly warns against a "complex temporal-diff
  // engine" here.
  function phraseLighting(segment, isChange) {
    if (!segment) return '';
    const withParts = [];
    if (segment.keyLight) withParts.push(`the ${segment.keyLight}`);
    if (segment.fill) withParts.push(`${segment.fill} fill`);
    if (segment.backlight) withParts.push(`the ${segment.backlight}`);
    const withClause = withParts.length > 0 ? `, with ${joinWithAnd(withParts)}` : '';

    let main = '';
    if (segment.exposure) {
      const verb = isChange ? 'shifts to' : 'remains';
      main = `The lighting ${verb} ${EXPOSURE_PHRASES[segment.exposure] || segment.exposure}`;
      if (segment.atmosphere) main += ` in the ${segment.atmosphere} atmosphere`;
      main += withClause;
    } else if (segment.atmosphere) {
      main = isChange ? `The lighting shifts into the ${segment.atmosphere} atmosphere` : `The lighting carries the ${segment.atmosphere} atmosphere`;
      main += withClause;
    } else if (withParts.length > 0) {
      main = isChange ? `The lighting shifts to ${joinWithAnd(withParts)}` : `The lighting is shaped by ${joinWithAnd(withParts)}`;
    }

    const sentences = [];
    if (main) sentences.push(`${main}.`);
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
  // Phase 5 leaves this sentence's own grammar unchanged (it already matched
  // the spec's suggested semantic-ownership table field-for-field); what
  // changed is when it gets called at all - see renderSemanticBeat.
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
  //
  // Phase 5 (section 26/Case N): if the owner's OWN active Character segment
  // this beat already carries an explicit `gesture` (e.g. "both hands grip
  // microphone"), the owner-based prop sentence would just restate the same
  // fact in different words - see ownerGestureAlreadyCoversProp, checked by
  // the caller before this function runs at all. That's a narrow,
  // field-aware rule (does the owner's gesture field exist at all this
  // beat?), not fuzzy text similarity between the two authored strings.
  function phrasePropState(label, segment, subjects) {
    if (!segment) return '';
    if (segment.ownerAssetId) {
      const owner = subjects.find((s) => s.assetId === segment.ownerAssetId);
      if (owner) return `<${label}> is held by <${owner.label}>.`;
    }
    if (segment.state) return `<${label}> is ${segment.state}.`;
    return '';
  }

  // Phase 5 Case N: a prop's "is held by <Subject>" sentence is redundant
  // once that subject's own active Character segment this beat already
  // states the physical gesture holding it - the two would say the same
  // thing in two different vocabularies. Deliberately checks only "does the
  // owner have a non-empty `gesture` field right now", not the CONTENT of
  // that gesture text against the prop's own fields - see the module
  // comment above for why this stays a field-aware rule, not fuzzy NLP.
  function ownerGestureAlreadyCoversProp(beat, propSegment) {
    if (!propSegment || !propSegment.ownerAssetId) return false;
    const owner = beat.subjects.find((s) => s.assetId === propSegment.ownerAssetId);
    return !!(owner && owner.segment && owner.segment.gesture);
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
  // truth for "does this beat have a note" - used by this file's own beat
  // IR builder, by shots.js's upsertBeatNote (to find-or-create), and by
  // direction.js's beat UI (marker dot, detail panel, orphan detection).
  function findBeatNote(shot, start, end) {
    return (
      (shot.direction.beatNotes || []).find(
        (n) => Math.abs(n.startSeconds - start) <= BEAT_NOTE_EPSILON && Math.abs(n.endSeconds - end) <= BEAT_NOTE_EPSILON
      ) || null
    );
  }

  // Beat boundaries are the union of authored Direction segment edges only
  // (Camera/Lighting/Character/Prop) plus the shot's own start/end - never
  // vocal cue/region/word-alignment timing (Phase 4a/4b invariant: vocal
  // analysis alone is never an H3 semantic beat). This function has no
  // parameter for region data at all, which is the structural proof that a
  // region boundary can never leak in here.
  function collectBeatBoundaries(shot, subjects) {
    const points = new Set([0, shotsApi.shotDuration(shot)]);
    (shot.direction.camera || []).filter((seg) => seg.enabled !== false).forEach((seg) => {
      points.add(seg.startSeconds);
      points.add(seg.endSeconds);
    });
    // Lighting is authored Direction (unlike transient Vocal Regions - see
    // Phase 4a/4b's own architecture note), so its boundaries are genuine
    // semantic beat boundaries, same as Camera/Character/Prop above.
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

  // --- Phase 5: Semantic Beat IR ---------------------------------------
  //
  // buildSemanticBeats() walks collectBeatBoundaries() once and resolves,
  // for every resulting interval, which authored segment is active in every
  // lane (Camera/Lighting/each acting subject/each cast prop) plus its
  // BeatNote - all BEFORE any prose is generated. This is compiler-only IR:
  // it is never persisted, never round-tripped, and carries the original
  // segment object references (not copies), which is exactly what lets
  // renderSemanticBeat() detect "same segment, still active" via a plain
  // `===` identity check instead of a value-by-value diff.
  //
  // Shape (see the Phase 5 spec's own "possible shape" - this is a close
  // match, not a forced rename):
  //   {
  //     startSeconds, endSeconds,
  //     camera: CameraSegment|null,
  //     lighting: LightingSegment|null,
  //     subjects: [{ assetId, label, segment: CharacterSegment|null }],
  //     props:    [{ assetId, label, segment: PropSegment|null }],
  //     beatNote: BeatNote|null,
  //     isHardCut: boolean,
  //   }
  function buildSemanticBeats(shot, subjects) {
    const orderedSubjectsList = subjects || orderedSubjects(shot);
    const boundaries = collectBeatBoundaries(shot, orderedSubjectsList);
    const beats = [];
    for (let i = 0; i < boundaries.length - 1; i++) {
      const startSeconds = boundaries[i];
      const endSeconds = boundaries[i + 1];
      if (endSeconds - startSeconds < 1e-6) continue;

      const camera = (shot.direction.camera || []).find((seg) => segmentActiveAt(seg, startSeconds, endSeconds)) || null;
      const lighting = (shot.direction.lighting || []).find((seg) => segmentActiveAt(seg, startSeconds, endSeconds)) || null;

      const subjectStates = orderedSubjectsList
        .filter((s) => isActingRole(s.role))
        .map((s) => ({
          assetId: s.assetId,
          label: s.label,
          segment: ((shot.direction.subjects || {})[s.assetId] || []).find((seg) => segmentActiveAt(seg, startSeconds, endSeconds)) || null,
        }));

      const propStates = orderedSubjectsList
        .filter((s) => s.role === 'prop')
        .map((s) => ({
          assetId: s.assetId,
          label: s.label,
          segment: ((shot.direction.props || {})[s.assetId] || []).find((seg) => segmentActiveAt(seg, startSeconds, endSeconds)) || null,
        }));

      const beatNote = findBeatNote(shot, startSeconds, endSeconds);
      beats.push({
        startSeconds,
        endSeconds,
        camera,
        lighting,
        subjects: subjectStates,
        props: propStates,
        beatNote,
        isHardCut: !!(beatNote && beatNote.isCut),
      });
    }
    return beats;
  }

  function findByAssetId(list, assetId) {
    const found = list.find((entry) => entry.assetId === assetId);
    return found ? found.segment : undefined;
  }

  // Renders ONE semantic beat's prose. `previousBeat` is the immediately
  // preceding beat in time (or null for the shot's very first beat) - see
  // buildBeatParagraphs, which always advances it beat-by-beat regardless of
  // whether the previous beat actually produced any text.
  //
  // Continuity rule (spec sections 18-22): a lane whose active segment is
  // the SAME object as in the previous beat is "continuing unchanged" and is
  // not restated; a lane that's different (including null -> segment, or
  // segment -> a different segment) is "changed" and gets its sentence.
  // `resetContinuity` (the shot's first beat, or a beat whose own BeatNote
  // marks it as a hard cut) forces every active lane to render in full,
  // regardless of identity - "camera continuity from the previous beat
  // resets" on a hard cut (section 19), and there is no previous beat at all
  // for the very first one.
  //
  // Fallback (section 40): if continuity suppression empties the beat out
  // entirely, but at least one lane IS active (just unchanged), the beat is
  // re-rendered without suppression rather than silently dropped - a beat
  // boundary only exists because *something* changed at that instant (see
  // collectBeatBoundaries), so an empty result here would mean "some lane
  // ended with nothing else to say", which still deserves output if other
  // lanes are quietly continuing.
  function renderSemanticBeat(beat, previousBeat, subjectsAll) {
    const resetContinuity = !previousBeat || beat.isHardCut;

    function cameraLine() {
      return phraseCamera(beat.camera);
    }
    function subjectLine(s) {
      return phraseSubjectAction(s.label, s.segment);
    }
    function propLine(pr) {
      if (ownerGestureAlreadyCoversProp(beat, pr.segment)) return '';
      return phrasePropState(pr.label, pr.segment, subjectsAll);
    }
    function lightingLine(isChange) {
      return phraseLighting(beat.lighting, isChange);
    }

    const cameraChanged = resetContinuity || beat.camera !== previousBeat.camera;
    const lightingChanged = resetContinuity || beat.lighting !== previousBeat.lighting;
    const lightingIsShift = !resetContinuity && !!previousBeat.lighting && lightingChanged;

    const lines = [];
    if (beat.camera && cameraChanged) {
      const l = cameraLine();
      if (l) lines.push(l);
    }
    beat.subjects.forEach((s) => {
      const changed = resetContinuity || s.segment !== findByAssetId(previousBeat.subjects, s.assetId);
      if (s.segment && changed) {
        const l = subjectLine(s);
        if (l) lines.push(l);
      }
    });
    beat.props.forEach((pr) => {
      const changed = resetContinuity || pr.segment !== findByAssetId(previousBeat.props, pr.assetId);
      if (pr.segment && changed) {
        const l = propLine(pr);
        if (l) lines.push(l);
      }
    });
    if (beat.lighting && lightingChanged) {
      const l = lightingLine(lightingIsShift);
      if (l) lines.push(l);
    }
    // Beat Note intent/endState (sections 23/25) are per-beat, exact-match
    // facts, never carried over from a previous beat - always included,
    // never subject to continuity suppression. Priority (section 24) stays
    // uncompiled, same as before Phase 5: it has no consumer yet.
    if (beat.beatNote && beat.beatNote.intent) lines.push(`Intent: ${beat.beatNote.intent}.`);
    if (beat.beatNote && beat.beatNote.endState) lines.push(`By the end of this beat: ${beat.beatNote.endState}.`);

    if (lines.length > 0 || resetContinuity) return lines.join(' ');

    const fallback = [];
    const camFallback = cameraLine();
    if (camFallback) fallback.push(camFallback);
    beat.subjects.forEach((s) => {
      const l = subjectLine(s);
      if (l) fallback.push(l);
    });
    beat.props.forEach((pr) => {
      const l = propLine(pr);
      if (l) fallback.push(l);
    });
    const lightFallback = lightingLine(false);
    if (lightFallback) fallback.push(lightFallback);
    return fallback.join(' ');
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
  //
  // Phase 5: the per-beat prose itself now comes from renderSemanticBeat()
  // over the Semantic Beat IR (buildSemanticBeats) instead of directly
  // reading segments per beat - the [Shot N]/"From X to Y seconds," wrapping
  // convention below (and the shotNumber counting that decides it) is
  // otherwise unchanged from Phase 4b.
  function buildBeatParagraphs(shot, subjects) {
    const beats = buildSemanticBeats(shot, subjects);
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
    let previousBeat = null;
    beats.forEach((beat) => {
      const body = renderSemanticBeat(beat, previousBeat, subjects);
      if (body) {
        const isCut = shotNumber === 0 || beat.isHardCut;
        if (isCut) {
          shotNumber += 1;
          if (shotNumber > 1) {
            paragraphs.push(hardCutIntro(shotNumber, beat.startSeconds, body));
          } else if (hasAnyCutMarked) {
            paragraphs.push(`[Shot 1]\nFrom ${formatSeconds(beat.startSeconds)} to ${formatSeconds(beat.endSeconds)} seconds: ${body}`);
          } else {
            paragraphs.push(`[Shot 1] ${body}`);
          }
        } else {
          paragraphs.push(`From ${formatSeconds(beat.startSeconds)} to ${formatSeconds(beat.endSeconds)} seconds, ${lowercaseFirst(body)}`);
        }
      }
      // Continuity is diffed against the immediately preceding beat in
      // time, regardless of whether it rendered any text - an empty beat
      // still represents "nothing changed here", which is exactly the
      // state the next beat needs to compare against.
      previousBeat = beat;
    });
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
  function compileH3Sections(shot, options = {}) {
    const subjects = orderedSubjects(shot);
    const mode = options.mode || H3_PROMPT_MODES.REFERENCE;
    if (!Object.values(H3_PROMPT_MODES).includes(mode)) {
      throw new Error(`Unsupported H3 prompt mode: ${mode}`);
    }
    if (mode === H3_PROMPT_MODES.BASE && subjects.length > 0) {
      throw new Error('Base H3 prompts cannot contain picture-bound subjects');
    }

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

    const generationLabel = mode === H3_PROMPT_MODES.BASE ? '[base generation]' : '[reference generation]';
    const characterLabels = subjects.filter((s) => isActingRole(s.role)).map((s) => `<${s.label}>`);
    const summary = hasCuts
      ? characterLabels.length > 0
        ? `${generationLabel} A hard-cut sequence of ${shotCount} shots featuring ${characterLabels.join(' and ')}.`
        : `${generationLabel} A hard-cut sequence of ${shotCount} shots.`
      : characterLabels.length > 0
      ? `${generationLabel} A single continuous shot featuring ${characterLabels.join(' and ')}.`
      : `${generationLabel} A single continuous shot.`;

    const detailedDescription = buildDetailedDescription(beatParagraphs, buildLimits(shot, subjects, hasCuts).join(' '));
    const hasVocalReference = options.hasVocalReference !== undefined
      ? Boolean(options.hasVocalReference)
      : mode === H3_PROMPT_MODES.REFERENCE;

    return {
      mode,
      subjectDefinitions: subjects.length > 0 ? subjectDefinitions : '',
      summary,
      retentionAnalysis: subjects.length > 0 ? retentionAnalysis : '',
      detailedDescription,
      integratedMultimodalDescription: `${summary}\n\n${detailedDescription}`,
      overallSoundscape: hasVocalReference ? VOCAL_REFERENCE_SOUNDSCAPE : 'N/A',
      nonDiegeticMusic: 'N/A',
    };
  }

  function assembleH3Prompt(sections) {
    if (sections.mode === H3_PROMPT_MODES.BASE) {
      const integratedDescription = [sections.summary, sections.detailedDescription].filter(Boolean).join('\n\n');
      return [
        `integrated_multimodal_description:\n${integratedDescription}`,
        `overall_soundscape: ${sections.overallSoundscape}`,
        `non_diegetic_music: ${sections.nonDiegeticMusic}`,
      ].join('\n\n');
    }

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

  function compileH3Prompt(shot, options = {}) {
    return assembleH3Prompt(compileH3Sections(shot, options));
  }

  MSE.h3Compiler = {
    H3_COMPILER_VERSION,
    H3_PROMPT_MODES,
    compileH3Prompt,
    compileH3Sections,
    assembleH3Prompt,
    collectBeatBoundaries,
    buildSemanticBeats,
    orderedSubjects,
    isActingRole,
    findBeatNote,
  };
})(window.MSE = window.MSE || {});
