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

  function cameraForScene(scene, override) {
    const source = override || (scene && scene.defaultCamera) || {};
    const position = Array.isArray(source.position) ? source.position.map(Number) : [0, 1.6, 4];
    const target = Array.isArray(source.target) ? source.target.map(Number) : [0, 1.5, 0];
    const delta = target.map((value, index) => value - position[index]);
    const horizontal = Math.hypot(delta[0], delta[2]);
    return {
      position,
      yaw: Number.isFinite(Number(source.yaw)) ? Number(source.yaw) : Math.atan2(delta[0], -delta[2]),
      pitch: Number.isFinite(Number(source.pitch)) ? Number(source.pitch) : Math.atan2(delta[1], horizontal),
      roll: Number(source.roll) || 0,
      focalLengthMm: Number(source.focalLengthMm) || 35,
    };
  }

  function targetsForShot(scene, shot) {
    const anchors = (scene && scene.anchors) || {};
    const targets = {};
    Object.entries(anchors).forEach(([name, anchor]) => {
      if (anchor && Array.isArray(anchor.position)) targets[name] = anchor.position;
    });
    Object.entries((shot && shot.preview && shot.preview.targetBindings) || {}).forEach(([targetName, anchorName]) => {
      if (targets[anchorName]) targets[targetName] = targets[anchorName];
    });
    const fallback = scene && scene.defaultCamera && scene.defaultCamera.target;
    return { targets, defaultTarget: Array.isArray(fallback) ? fallback : null };
  }

  function profileForScene(scene) {
    const source = { ...MSE.cameraPath.DEFAULT_PROFILE, ...((scene && scene.motionProfile) || {}) };
    const scale = Math.max(0.0001, Number(scene && scene.unitsPerMeter) || 1);
    ['defaultDistanceMeters', 'smallDistanceMeters', 'largeDistanceMeters'].forEach((key) => {
      source[key] = (Number(source[key]) || MSE.cameraPath.DEFAULT_PROFILE[key]) * scale;
    });
    return source;
  }

  function updateSceneCalibration(sceneId, calibration) {
    const scene = state.scenes.find((candidate) => candidate.id === sceneId);
    if (!scene) return false;
    if (calibration.unitsPerMeter !== undefined) {
      const units = Number(calibration.unitsPerMeter);
      if (!Number.isFinite(units) || units <= 0) return false;
      scene.unitsPerMeter = units;
    }
    if (calibration.defaultCamera) {
      const next = { ...scene.defaultCamera };
      for (const key of ['position', 'target']) {
        if (calibration.defaultCamera[key] !== undefined) {
          const vector = calibration.defaultCamera[key];
          if (!Array.isArray(vector) || vector.length !== 3 || !vector.every((value) => Number.isFinite(Number(value)))) return false;
          next[key] = vector.map(Number);
        }
      }
      if (calibration.defaultCamera.focalLengthMm !== undefined) {
        const focalLength = Number(calibration.defaultCamera.focalLengthMm);
        if (!Number.isFinite(focalLength) || focalLength <= 0) return false;
        next.focalLengthMm = focalLength;
      }
      scene.defaultCamera = next;
    }
    if (calibration.motionProfile) {
      const next = { ...scene.motionProfile };
      for (const [key, rawValue] of Object.entries(calibration.motionProfile)) {
        if (!(key in MSE.cameraPath.DEFAULT_PROFILE)) continue;
        const value = Number(rawValue);
        if (!Number.isFinite(value) || value <= 0) return false;
        next[key] = value;
      }
      scene.motionProfile = next;
    }
    emit('scenes-changed', { reason: 'calibration', sceneId });
    return true;
  }

  function upsertAnchor(sceneId, previousName, name, position) {
    const scene = state.scenes.find((candidate) => candidate.id === sceneId);
    const nextName = String(name || '').trim();
    if (!scene || !nextName || !Array.isArray(position) || position.length !== 3 || !position.every((value) => Number.isFinite(Number(value)))) return false;
    if (!scene.anchors) scene.anchors = {};
    if (previousName !== nextName && scene.anchors[nextName]) return false;
    if (previousName && previousName !== nextName) {
      delete scene.anchors[previousName];
      state.shots.filter((shot) => shot.sceneId === sceneId).forEach((shot) => {
        Object.keys((shot.preview && shot.preview.targetBindings) || {}).forEach((targetName) => {
          if (shot.preview.targetBindings[targetName] === previousName) shot.preview.targetBindings[targetName] = nextName;
        });
      });
    }
    scene.anchors[nextName] = { position: position.map(Number) };
    emit('scenes-changed', { reason: 'anchor', sceneId });
    return true;
  }

  function removeAnchor(sceneId, name) {
    const scene = state.scenes.find((candidate) => candidate.id === sceneId);
    if (!scene || !scene.anchors || !scene.anchors[name]) return false;
    delete scene.anchors[name];
    state.shots.filter((shot) => shot.sceneId === sceneId).forEach((shot) => {
      Object.keys((shot.preview && shot.preview.targetBindings) || {}).forEach((targetName) => {
        if (shot.preview.targetBindings[targetName] === name) delete shot.preview.targetBindings[targetName];
      });
    });
    emit('scenes-changed', { reason: 'anchor', sceneId });
    return true;
  }

  function setTargetBinding(shotId, targetName, anchorName) {
    const shot = state.shots.find((candidate) => candidate.id === shotId);
    if (!shot || !String(targetName || '').trim()) return false;
    const scene = sceneForShot(shot);
    if (anchorName && (!scene || !scene.anchors || !scene.anchors[anchorName])) return false;
    if (!shot.preview) shot.preview = { initialCameraOverride: null, targetBindings: {}, interpreterProfile: 'cinematic-v1' };
    if (!shot.preview.targetBindings) shot.preview.targetBindings = {};
    if (anchorName) shot.preview.targetBindings[targetName] = anchorName;
    else delete shot.preview.targetBindings[targetName];
    emit('shots-changed', { reason: 'target-binding' });
    return true;
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
  MSE.scenes = {
    syncFromAssets, detachAsset, sceneForShot, cameraForScene, targetsForShot, profileForScene,
    updateSceneCalibration, upsertAnchor, removeAnchor, setTargetBinding, setShotScene,
  };
})(window.MSE = window.MSE || {});
