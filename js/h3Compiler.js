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
    tracking_shot: 'tracks alongside the subject',
    arc_shot: 'arcs around the subject',
    static_shot: 'remains static',
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

  function phraseCamera(segment) {
    if (!segment) return '';
    const verb = MOVEMENT_PHRASES[segment.movement] || segment.movement;
    let sentence = `The camera ${verb}`;
    if (segment.speed) sentence += ` at ${segment.speed} speed`;
    if (segment.framing) sentence += `, maintaining a ${segment.framing} composition`;
    return `${sentence}.`;
  }

  function segmentActiveAt(segment, beatStart, beatEnd) {
    return segment.startSeconds <= beatStart + 1e-6 && segment.endSeconds >= beatEnd - 1e-6;
  }

  function collectBeatBoundaries(shot, subjects) {
    const points = new Set([0, shotsApi.shotDuration(shot)]);
    (shot.direction.camera || []).forEach((seg) => {
      points.add(seg.startSeconds);
      points.add(seg.endSeconds);
    });
    subjects.filter((s) => isActingRole(s.role)).forEach((s) => {
      const track = (shot.direction.subjects || {})[s.assetId] || [];
      track.forEach((seg) => {
        points.add(seg.startSeconds);
        points.add(seg.endSeconds);
      });
    });
    return Array.from(points)
      .filter((t) => t >= 0 && t <= shotsApi.shotDuration(shot) + 1e-6)
      .sort((a, b) => a - b);
  }

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
          if (active && active.action) sentences.push(`${s.label} ${active.action}.`);
        });

      if (sentences.length > 0) {
        paragraphs.push(`${formatSeconds(start)}–${formatSeconds(end)}s: ${sentences.join(' ')}`);
      }
    }
    return paragraphs;
  }

  function buildLimits(subjects) {
    const actingSubjects = subjects.filter((s) => isActingRole(s.role));
    const limits = [];
    if (actingSubjects.length >= 2) {
      limits.push('Do not exchange identities, faces, or wardrobes between subjects.');
      limits.push('No additional people enter the shot.');
    }
    limits.push('No cut or scene transition - this is a single continuous shot.');
    return limits;
  }

  function compileH3Prompt(shot) {
    const subjects = orderedSubjects(shot);

    // <Picture N> is the official H3-IR marker for "the Nth attached
    // reference image" (see docs/deep-research-report-h3-prompting.md,
    // lines ~551-559) - it's a different level from the `Image N` numbering
    // used in the provider-level hosted prompt when attaching the images
    // themselves. Subject N and Picture N align 1:1 here since v1 casts
    // exactly one reference image per subject role.
    const subjectDefinitions = subjects
      .map((s, i) => `<${s.label}> is ${ROLE_DESCRIPTION[s.role]}, referenced by <Picture ${i + 1}>. Preserve ${ROLE_PRESERVE[s.role]} throughout.`)
      .join('\n');

    const retentionAnalysis = subjects
      .map((s) => `<${s.label}>: fully_preserved - ${ROLE_PRESERVE[s.role]}.`)
      .join('\n');

    const characterLabels = subjects.filter((s) => isActingRole(s.role)).map((s) => `<${s.label}>`);
    const summary =
      characterLabels.length > 0
        ? `[reference generation] A single continuous shot featuring ${characterLabels.join(' and ')}.`
        : '[reference generation] A single continuous shot.';

    const beatParagraphs = buildBeatParagraphs(shot, subjects);
    const detailedDescription = [
      'A single continuous shot, no cuts.',
      ...beatParagraphs,
      buildLimits(subjects).join(' '),
    ].join('\n\n');

    const sections = [
      subjects.length > 0 ? `subject_definitions:\n${subjectDefinitions}` : null,
      `summary:\n${summary}`,
      subjects.length > 0 ? `retention_analysis:\n${retentionAnalysis}` : null,
      `detailed_description:\n${detailedDescription}`,
      'overall_soundscape: N/A',
      'non_diegetic_music: N/A',
    ].filter(Boolean);

    return sections.join('\n\n');
  }

  MSE.h3Compiler = { compileH3Prompt };
})(window.MSE = window.MSE || {});
