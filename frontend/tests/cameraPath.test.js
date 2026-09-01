// Unit coverage for the pure CUTTAlogue Camera-lane spatial interpreter.
// Run with: node frontend/tests/cameraPath.test.js
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

global.window = global;
global.MSE = undefined;

const scriptPath = path.join(__dirname, '..', 'js', 'cameraPath.js');
vm.runInThisContext(fs.readFileSync(scriptPath, 'utf8'), { filename: scriptPath });

const { cameraPath } = window.MSE;
let failures = 0;

function assert(condition, label, detail = '') {
  if (condition) console.log(`ok - ${label}`);
  else {
    failures += 1;
    console.error(`FAIL: ${label}${detail ? `\n  ${detail}` : ''}`);
  }
}

function close(actual, expected, epsilon = 1e-9) {
  return Math.abs(actual - expected) <= epsilon;
}

function vectorClose(actual, expected, epsilon = 1e-9) {
  return actual.length === expected.length && actual.every((value, index) => close(value, expected[index], epsilon));
}

// Empty Direction data yields the stable CUTTAlogue Plus default camera.
{
  const plan = cameraPath.compile([], { durationSeconds: 10 });
  const pose = cameraPath.evaluate(plan, 5);
  assert(vectorClose(pose.position, [0, 1.6, 4]), 'empty path uses the stable default position');
  assert(close(pose.focalLengthMm, 35), 'empty path uses the stable default lens');
  assert(plan.warnings.length === 0, 'empty path has no warnings');
}

// yaw 0 looks down -Z, so a one-metre push ends at z=3.
{
  const plan = cameraPath.compile([
    { startSeconds: 0, endSeconds: 2, movement: 'push_in', speed: 'linear' },
  ], { durationSeconds: 2 });
  assert(vectorClose(cameraPath.evaluate(plan, 1).position, [0, 1.6, 3.5]), 'push-in interpolates along camera forward');
  assert(vectorClose(cameraPath.evaluate(plan, 2).position, [0, 1.6, 3]), 'push-in reaches its deterministic endpoint');
}

// Sequential segments inherit the previous endpoint rather than restarting.
{
  const plan = cameraPath.compile([
    { startSeconds: 0, endSeconds: 1, movement: 'push_in', speed: 'linear' },
    { startSeconds: 1, endSeconds: 2, movement: 'truck', direction: 'right', speed: 'linear' },
  ], { durationSeconds: 2 });
  assert(vectorClose(plan.segments[1].startPose.position, [0, 1.6, 3]), 'second segment inherits the first endpoint');
  assert(cameraPath.evaluate(plan, 1).segmentIndex === 1, 'shared segment boundary is owned by the new segment');
  assert(vectorClose(cameraPath.evaluate(plan, 2).position, [1, 1.6, 3]), 'truck-right continues from inherited pose');
}

// Amplitude, pan direction and authored focal length are interpreted.
{
  const plan = cameraPath.compile([
    { startSeconds: 0, endSeconds: 1, movement: 'pan', direction: 'left', amplitude: 'large', focalLength: '85mm', speed: 'linear' },
  ], { durationSeconds: 1 });
  const pose = cameraPath.evaluate(plan, 1);
  assert(close(pose.yaw, -Math.PI / 4), 'large pan-left maps to calibrated negative yaw');
  assert(close(pose.focalLengthMm, 85), 'authored focal length survives interpretation');
}

// Zoom changes optics only; disabled segments do not participate.
{
  const plan = cameraPath.compile([
    { startSeconds: 0, endSeconds: 1, movement: 'pull_out', enabled: false },
    { startSeconds: 0, endSeconds: 1, movement: 'zoom_in', speed: 'linear' },
  ], { durationSeconds: 1 });
  const pose = cameraPath.evaluate(plan, 1);
  assert(vectorClose(pose.position, [0, 1.6, 4]), 'zoom-in does not translate the camera');
  assert(close(pose.focalLengthMm, 50), 'zoom-in uses the deterministic default factor');
  assert(plan.segments.length === 1, 'disabled camera segment is ignored');
}

// Invalid authoring remains inspectable through warnings instead of crashing.
{
  const plan = cameraPath.compile([
    { startSeconds: 0, endSeconds: 2, movement: 'truck', focalLength: 'wide' },
    { startSeconds: 1, endSeconds: 3, movement: 'tracking_shot' },
  ], { durationSeconds: 3 });
  const warningCodes = plan.warnings.map((warning) => warning.code);
  assert(warningCodes.includes('missing_direction'), 'missing truck direction emits a warning');
  assert(warningCodes.includes('invalid_focal_length'), 'invalid lens value emits a warning');
  assert(warningCodes.includes('overlapping_segments'), 'overlapping segments emit a warning');
  assert(warningCodes.includes('movement_not_implemented'), 'deferred movement emits a warning');
}

if (failures) {
  console.error(`\n${failures} camera path test(s) failed.`);
  process.exitCode = 1;
} else {
  console.log('\nAll camera path tests passed.');
}
