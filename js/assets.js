// Asset pool: the imported files themselves (state.assets) plus their
// click-based assignment to shots (shot.assetIds). Mirrors shots.js in shape -
// small, direct state mutations that emit events for the UI to react to.
(function (MSE) {
  'use strict';

  const { state, emit } = MSE.state;

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
  };
})(window.MSE = window.MSE || {});
