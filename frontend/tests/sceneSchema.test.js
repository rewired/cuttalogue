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

const roundTrip = MSE.project.normalizeProjectData(JSON.parse(JSON.stringify(MSE.project.serializeProject())));
equal(roundTrip.scenes.some((scene) => scene.blockoutAssetId === 'splat1'), true, 'scene asset linkage survives save and load');
equal(roundTrip.shots[0].sceneId, 'scene-splat1', 'shot scene assignment survives save and load');

MSE.assets.removeAsset('splat1');
equal(state.scenes.some((scene) => scene.splatAssetId === 'splat1' || scene.blockoutAssetId === 'splat1'), false, 'deleting an asset clears scene references without deleting scenes');

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exitCode = 1;
} else {
  console.log('\nAll scene schema checks passed.');
}
