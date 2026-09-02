// Scene registry for the embedded camera preview. Imported scene files are
// durable assets; scenes group those assets and shots reference the group by
// id. Camera animation itself remains derived exclusively from Direction.
(function (MSE) {
  'use strict';

  const { state, emit, on } = MSE.state;

  function sceneNameFor(asset) {
    return (asset.fileName || 'Untitled scene').replace(/\.[^.]+$/, '');
  }

  function sceneIdFor(asset) {
    return `scene-${asset.id}`;
  }

  function syncFromAssets() {
    if (!Array.isArray(state.scenes)) state.scenes = [];
    const assetsById = new Map(state.assets.map((asset) => [asset.id, asset]));
    let changed = false;
    state.scenes.forEach((scene) => {
      if (scene.splatAssetId) {
        const asset = assetsById.get(scene.splatAssetId);
        if (!asset || asset.type !== 'pointcloud') {
          const movedId = scene.splatAssetId;
          scene.splatAssetId = null;
          if (asset && asset.type === 'model3d' && !scene.blockoutAssetId) scene.blockoutAssetId = movedId;
          changed = true;
        }
      }
      if (scene.blockoutAssetId) {
        const asset = assetsById.get(scene.blockoutAssetId);
        if (!asset || asset.type !== 'model3d') {
          const movedId = scene.blockoutAssetId;
          scene.blockoutAssetId = null;
          if (asset && asset.type === 'pointcloud' && !scene.splatAssetId) scene.splatAssetId = movedId;
          changed = true;
        }
      }
    });
    state.assets.forEach((asset) => {
      if (asset.type !== 'pointcloud' && asset.type !== 'model3d') return;
      const alreadyLinked = state.scenes.some((scene) => scene.splatAssetId === asset.id || scene.blockoutAssetId === asset.id);
      if (alreadyLinked) return;
      state.scenes.push({
        id: sceneIdFor(asset),
        name: sceneNameFor(asset),
        splatAssetId: asset.type === 'pointcloud' ? asset.id : null,
        blockoutAssetId: asset.type === 'model3d' ? asset.id : null,
        unitsPerMeter: 1,
        defaultCamera: { position: [0, 1.6, 4], target: [0, 1.5, 0], focalLengthMm: 35 },
        anchors: {},
        motionProfile: {},
      });
      changed = true;
    });
    if (changed) emit('scenes-changed', { reason: 'asset-sync' });
  }

  function detachAsset(assetId) {
    if (!Array.isArray(state.scenes)) return;
    state.scenes.forEach((scene) => {
      if (scene.splatAssetId === assetId) scene.splatAssetId = null;
      if (scene.blockoutAssetId === assetId) scene.blockoutAssetId = null;
    });
    emit('scenes-changed', { reason: 'asset-delete' });
  }

  function sceneForShot(shot) {
    return shot && shot.sceneId ? state.scenes.find((scene) => scene.id === shot.sceneId) || null : null;
  }

  function setShotScene(shotId, sceneId) {
    const shot = state.shots.find((candidate) => candidate.id === shotId);
    if (!shot) return false;
    const nextId = sceneId && state.scenes.some((scene) => scene.id === sceneId) ? sceneId : null;
    if (shot.sceneId === nextId) return true;
    shot.sceneId = nextId;
    emit('shots-changed', { reason: 'scene' });
    return true;
  }

  on('project-loaded', syncFromAssets);
  MSE.scenes = { syncFromAssets, detachAsset, sceneForShot, setShotScene };
})(window.MSE = window.MSE || {});
