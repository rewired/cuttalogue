// Fixed-process bridge to CUTTAlogue's canonical browser H3 compiler.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const repoRoot = path.resolve(__dirname, '..', '..');
const jsRoot = path.join(repoRoot, 'frontend', 'js');

function load(fileName) {
  const filePath = path.join(jsRoot, fileName);
  vm.runInThisContext(fs.readFileSync(filePath, 'utf8'), { filename: filePath });
}

function normalizeShot(source) {
  const shot = { ...(source || {}) };
  shot.assetIds = Array.isArray(shot.assetIds) ? shot.assetIds : [];
  shot.assetRoles = shot.assetRoles && typeof shot.assetRoles === 'object' ? shot.assetRoles : {};
  shot.constraints = Array.isArray(shot.constraints) ? shot.constraints : [];
  const direction = shot.direction && typeof shot.direction === 'object' ? shot.direction : {};
  shot.direction = {
    ...direction,
    camera: Array.isArray(direction.camera) ? direction.camera : [],
    lighting: Array.isArray(direction.lighting) ? direction.lighting : [],
    subjects: direction.subjects && typeof direction.subjects === 'object' ? direction.subjects : {},
    props: direction.props && typeof direction.props === 'object' ? direction.props : {},
    beatNotes: Array.isArray(direction.beatNotes) ? direction.beatNotes : [],
  };
  return shot;
}

global.window = global;
global.MSE = undefined;
load('state.js');
load('assets.js');
load('references.js');
window.MSE.shots = { shotDuration: (shot) => Number(shot.endSeconds) - Number(shot.startSeconds) };
load('h3Compiler.js');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const payload = JSON.parse(input);
    const shot = normalizeShot(payload.shot);
    const sections = window.MSE.h3Compiler.compileH3Sections(shot);
    process.stdout.write(JSON.stringify({
      compilerVersion: window.MSE.h3Compiler.H3_COMPILER_VERSION,
      authoritativeSource: 'shot.direction',
      referenceAssetIds: window.MSE.references.referenceAssetIds(shot),
      sections,
      prompt: window.MSE.h3Compiler.assembleH3Prompt(sections),
    }));
  } catch (error) {
    process.stderr.write(error && error.stack ? error.stack : String(error));
    process.exitCode = 1;
  }
});
