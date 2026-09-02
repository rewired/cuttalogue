// Regression coverage for persistent scenes and per-shot scene assignment.
// Run with: node frontend/tests/sceneSchema.test.js
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const JS_DIR = path.join(__dirname, '..', 'js');
function loadScript(fileName) {
  const filePath = path.join(JS_DIR, fileName);
  vm.runInThisContext(fs.readFileSync(filePath, 'utf8'), { filename: filePath });
}

global.window = global;
global.MSE = undefined;
loadScript('state.js');
loadScript('cameraPath.js');
loadScript('musicalGrid.js');
loadScript('frameMath.js');
loadScript('shots.js');
loadScript('assets.js');
loadScript('scenes.js');
loadScript('project.js');

const { state } = MSE.state;
let failures = 0;
function equal(actual, expected, label) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) console.log(`ok - ${label}`);
  else {
    failures += 1;
    console.error(`FAIL: ${label}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  }
}

const oldProject = MSE.project.normalizeProjectData({
  shots: [{ id: 1, startSeconds: 0, endSeconds: 10, direction: { camera: [], subjects: {} } }],
});
equal(oldProject.scenes, [], 'old projects default to an empty scene registry');
equal(oldProject.shots[0].sceneId, null, 'old shots default to no assigned scene');
equal(oldProject.shots[0].preview.interpreterProfile, 'cinematic-v1', 'old shots receive the stable interpreter profile');
const partialScene = MSE.project.normalizeProjectData({
  scenes: [{ id: 'partial', defaultCamera: { focalLengthMm: 85 }, anchors: null }],
  shots: [],
}).scenes[0];
equal(partialScene.defaultCamera.position, [0, 1.6, 4], 'partial scene calibration receives the default camera position');
equal(partialScene.defaultCamera.target, [0, 1.5, 0], 'partial scene calibration receives the default camera target');
equal(partialScene.anchors, {}, 'malformed anchors normalize to an empty map');
const calibratedCamera = MSE.scenes.cameraForScene({
  defaultCamera: { position: [1, 2, 3], target: [1, 2, 2], focalLengthMm: 50 },
});
equal(calibratedCamera, { position: [1, 2, 3], yaw: 0, pitch: 0, roll: 0, focalLengthMm: 50 }, 'scene target calibration becomes a camera interpreter pose');

state.assets = [];
state.scenes = [];
state.shots = [{
  id: 1, startSeconds: 0, endSeconds: 10, name: '', prompt: '', notes: '', seed: null,
  takes: [], activeTakeId: null, assetIds: [], assetRoles: {}, videoRefs: {}, constraints: [],
  sceneId: null, preview: { initialCameraOverride: null, targetBindings: {}, interpreterProfile: 'cinematic-v1' },
  direction: { camera: [], lighting: [], subjects: {}, props: {}, beatNotes: [] },
}];

MSE.assets.addAssets([{
  id: 'splat1', type: 'pointcloud', fileName: 'warehouse.splat', relativePath: 'assets/splat1/warehouse.splat',
  thumbnailPath: null, tags: [], description: '', kind: 'scene_splat', metadata: {},
}]);
equal(state.scenes.length, 1, 'importing a point cloud creates one scene');
equal(state.scenes[0].splatAssetId, 'splat1', 'the generated scene references its source asset');
MSE.assets.replaceAssetFile('splat1', {
  type: 'model3d', fileName: 'warehouse.glb', relativePath: 'assets/splat1/warehouse.glb',
  thumbnailPath: null, metadata: { format: 'glb' },
});
equal(state.assets[0].kind, 'scene_blockout', 'replacing across scene formats updates the automatic kind');
equal(state.scenes.some((scene) => scene.blockoutAssetId === 'splat1'), true, 'replacing across scene formats relinks the scene asset');
equal(state.scenes.length, 1, 'replacing a scene file preserves the existing scene identity');
equal(MSE.scenes.setShotScene(1, state.scenes[0].id), true, 'a scene can be assigned to a shot');
equal(state.shots[0].sceneId, 'scene-splat1', 'the shot stores the stable scene id');
equal(MSE.scenes.upsertAnchor(state.scenes[0].id, null, 'performer', [1, 1.7, 0]), true, 'a calibrated anchor can be added');
equal(MSE.scenes.setTargetBinding(1, 'lead', 'performer'), true, 'an authored target can bind to a scene anchor');
const targetContext = MSE.scenes.targetsForShot(state.scenes[0], state.shots[0]);
equal(targetContext.targets.lead, [1, 1.7, 0], 'shot target binding resolves to the calibrated anchor position');
state.scenes[0].unitsPerMeter = 100;
state.scenes[0].motionProfile.defaultDistanceMeters = 2;
equal(MSE.scenes.profileForScene(state.scenes[0]).defaultDistanceMeters, 200, 'metre distances scale into calibrated scene units');
equal(MSE.scenes.upsertAnchor(state.scenes[0].id, 'performer', 'artist', [2, 1.8, 0]), true, 'an anchor can be renamed');
equal(state.shots[0].preview.targetBindings.lead, 'artist', 'renaming an anchor updates shot bindings');
equal(MSE.scenes.setTargetBinding(1, 'lead', 'missing'), false, 'a binding to a missing anchor is rejected');
MSE.scenes.upsertAnchor(state.scenes[0].id, null, 'camera', [0, 1.6, 4]);
equal(MSE.scenes.upsertAnchor(state.scenes[0].id, 'artist', 'camera', [3, 2, 0]), false, 'renaming over an existing anchor is rejected');

const roundTrip = MSE.project.normalizeProjectData(JSON.parse(JSON.stringify(MSE.project.serializeProject())));
equal(roundTrip.scenes.some((scene) => scene.blockoutAssetId === 'splat1'), true, 'scene asset linkage survives save and load');
equal(roundTrip.shots[0].sceneId, 'scene-splat1', 'shot scene assignment survives save and load');
equal(roundTrip.scenes[0].anchors.artist.position, [2, 1.8, 0], 'scene anchors survive save and load');
equal(roundTrip.shots[0].preview.targetBindings.lead, 'artist', 'target bindings survive save and load');

MSE.assets.removeAsset('splat1');
equal(state.scenes.some((scene) => scene.splatAssetId === 'splat1' || scene.blockoutAssetId === 'splat1'), false, 'deleting an asset clears scene references without deleting scenes');

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exitCode = 1;
} else {
  console.log('\nAll scene schema checks passed.');
}
