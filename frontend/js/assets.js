// Asset pool: the imported files themselves (state.assets) plus their
// click-based assignment to shots (shot.assetIds). Mirrors shots.js in shape -
// small, direct state mutations that emit events for the UI to react to.
(function (MSE) {
  'use strict';

  const { state, emit } = MSE.state;

  // What an asset actually IS, fixed once per asset (not per shot it's used
  // in) - a person can't be a character in one shot and a location in the
  // next. Keyed by asset.type so adding a new type or a new kind under an
  // existing type later is a one-line change here, nowhere else. Types with
  // no entry (e.g. "other") have nothing to classify, so isClassified()
  // treats them as always classified.
  const KIND_OPTIONS = {
    image: [
      { value: 'location', label: 'Location' },
      { value: 'character', label: 'Character' },
      { value: 'prop', label: 'Prop' },
    ],
    audio: [
      { value: 'fullmix', label: 'Full mix' },
      { value: 'lip-sync', label: 'Lip-sync' },
    ],
    video: [
      { value: 'motionguide', label: 'Motion guide' },
    ],
  };

  function kindOptionsFor(assetType) {
    return KIND_OPTIONS[assetType] || [];
  }

  function isClassified(asset) {
    return kindOptionsFor(asset.type).length === 0 || !!asset.kind;
  }

  function kindLabel(asset) {
    if (!asset.kind) return null;
    const match = kindOptionsFor(asset.type).find((o) => o.value === asset.kind);
    return match ? match.label : asset.kind;
  }

  // What H3 subject role an asset CAN play is fixed by its kind (above) - a
  // location can never become a character mid-project. What's still a
  // per-shot choice is whether a character is the lead or supporting in
  // THIS particular shot, which is genuinely variable from shot to shot -
  // returns null for kinds with nothing to cast (audio/video).
  function roleOptionsFor(kind) {
    if (kind === 'character') {
      return [
        ['', 'No role'],
        ['primary_character', 'Primary character'],
        ['supporting_character', 'Supporting character'],
      ];
    }
    if (kind === 'location') {
      return [
        ['', 'Not cast'],
        ['environment', 'Environment / location'],
      ];
    }
    if (kind === 'prop') {
      return [
        ['', 'Not cast'],
        ['prop', 'Prop'],
      ];
    }
    return null;
  }

  function setAssetKind(assetId, kind) {
    const asset = findAsset(assetId);
    if (!asset) return;
    asset.kind = kind;
    emit('assets-changed', { reason: 'kind' });
  }

  function addAssets(newAssets) {
    state.assets.push(...newAssets);
    emit('assets-changed', { reason: 'import' });
  }

  function findAsset(assetId) {
    return state.assets.find((a) => a.id === assetId) || null;
  }

  function setAssetTags(assetId, tags) {
    const asset = findAsset(assetId);
    if (!asset) return;
    asset.tags = tags;
    emit('assets-changed', { reason: 'tags' });
  }

  function setAssetDescription(assetId, description) {
    const asset = findAsset(assetId);
    if (!asset) return;
    asset.description = description;
    emit('assets-changed', { reason: 'description' });
  }

  function assignAssetToShot(shotId, assetId) {
    const shot = state.shots.find((s) => s.id === shotId);
    if (!shot) return;
    if (!shot.assetIds) shot.assetIds = [];
    if (!shot.assetIds.includes(assetId)) shot.assetIds.push(assetId);
    emit('shots-changed', { reason: 'assign-asset' });
  }

  function removeAssetFromShot(shotId, assetId) {
    const shot = state.shots.find((s) => s.id === shotId);
    if (!shot || !shot.assetIds) return;
    shot.assetIds = shot.assetIds.filter((id) => id !== assetId);
    emit('shots-changed', { reason: 'unassign-asset' });
  }

  function assetsForShot(shot) {
    const ids = (shot && shot.assetIds) || [];
    return ids.map((id) => findAsset(id)).filter(Boolean);
  }

  // Deleting an asset from the library also has to unwind every place its id
  // is referenced, or a shot would keep pointing at a cast role/action track
  // for an asset that no longer exists.
  function removeAsset(assetId) {
    state.assets = state.assets.filter((a) => a.id !== assetId);
    state.shots.forEach((shot) => {
      if (shot.assetIds) shot.assetIds = shot.assetIds.filter((id) => id !== assetId);
      if (shot.assetRoles) delete shot.assetRoles[assetId];
      if (shot.direction && shot.direction.subjects) delete shot.direction.subjects[assetId];
    });
    emit('assets-changed', { reason: 'delete' });
    emit('shots-changed', { reason: 'delete-asset' });
  }

  MSE.assets = {
    addAssets,
    findAsset,
    setAssetTags,
    setAssetDescription,
    assignAssetToShot,
    removeAssetFromShot,
    assetsForShot,
    removeAsset,
    kindOptionsFor,
    isClassified,
    setAssetKind,
    kindLabel,
    roleOptionsFor,
  };
})(window.MSE = window.MSE || {});
