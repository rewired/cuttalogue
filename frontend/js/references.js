// Canonical H3 reference binding: the single source of truth for
// <Subject N>/<Picture N> ordering AND the referenceAssetIds sent to
// generation (which the backend wires 1:1 into ComfyUI's ref_image_N
// inputs, see comfy_workflow_template.py). Before this module, h3Compiler's
// orderedSubjects() and contextPanel's Generate handler each independently
// derived "which assets, in what order" - a prompt could say <Picture 2>
// for one asset while ComfyUI received a different one as ref_image_1. Both
// call sites now consume this one function so that invariant can't drift:
// <Picture N>  <=>  referenceAssetIds[N - 1]  <=>  ComfyUI ref_image_(N - 1)
(function (MSE) {
  'use strict';

  const ROLE_ORDER = ['primary_character', 'supporting_character', 'environment', 'prop'];

  // Only assigned assets carrying a truthy H3 role participate as a
  // reference - an assigned-but-uncast asset (e.g. a mood reference) must
  // never shift <Picture N> numbering, so it's excluded here rather than
  // filtered separately by each consumer. Array.prototype.sort is spec-
  // guaranteed stable (ES2019+), so assets sharing a role keep their
  // shot.assetIds assignment order - determinism across repeated calls.
  function forShot(shot) {
    const roles = (shot && shot.assetRoles) || {};
    const roledIds = ((shot && shot.assetIds) || []).filter((id) => roles[id]);
    roledIds.sort((a, b) => ROLE_ORDER.indexOf(roles[a]) - ROLE_ORDER.indexOf(roles[b]));
    return roledIds.map((assetId, index) => ({
      assetId,
      role: roles[assetId],
      subjectIndex: index + 1,
      subjectLabel: `Subject ${index + 1}`,
      pictureIndex: index + 1,
      asset: MSE.assets.findAsset(assetId),
    }));
  }

  function referenceAssetIds(shot) {
    return forShot(shot).map((ref) => ref.assetId);
  }

  MSE.references = { forShot, referenceAssetIds, ROLE_ORDER };
})(window.MSE = window.MSE || {});
