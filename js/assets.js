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

  MSE.assets = {
    addAssets,
    findAsset,
    setAssetTags,
    assignAssetToShot,
    removeAssetFromShot,
    assetsForShot,
  };
})(window.MSE = window.MSE || {});
