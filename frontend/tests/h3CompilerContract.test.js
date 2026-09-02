// Contract coverage for H3 base/reference prompt dialects and audio semantics.
// Run with: node frontend/tests/h3CompilerContract.test.js
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
loadScript('assets.js');
loadScript('references.js');
window.MSE.shots = { shotDuration: (shot) => shot.endSeconds - shot.startSeconds };
loadScript('h3Compiler.js');

const { assets, h3Compiler } = window.MSE;

function check(condition, label) {
  if (!condition) throw new Error(label);
  console.log(`ok - ${label}`);
}

function makeShot(assetIds = [], assetRoles = {}) {
  return {
    id: 'shot-contract',
    startSeconds: 0,
    endSeconds: 6,
    assetIds,
    assetRoles,
    constraints: [],
    direction: {
      camera: [{ startSeconds: 0, endSeconds: 6, enabled: true, movement: 'static_shot' }],
      lighting: [],
      subjects: {},
      props: {},
      beatNotes: [],
    },
  };
}

assets.addAssets([
  { id: 'lead', type: 'image', fileName: 'lead.png', relativePath: 'lead.png', tags: [], metadata: {} },
]);

check(h3Compiler.H3_COMPILER_VERSION === '2.1', 'compiler contract version is 2.1');

const referenceShot = makeShot(['lead'], { lead: 'primary_character' });
const referenceSections = h3Compiler.compileH3Sections(referenceShot, {
  mode: h3Compiler.H3_PROMPT_MODES.REFERENCE,
  hasVocalReference: true,
});
const referencePrompt = h3Compiler.assembleH3Prompt(referenceSections);
[
  'subject_definitions:',
  'summary:',
  'retention_analysis:',
  'detailed_description:',
  'overall_soundscape:',
  'non_diegetic_music:',
].forEach((heading) => check(referencePrompt.includes(heading), `reference dialect includes ${heading}`));
check(referencePrompt.includes('<Picture 1>'), 'reference dialect keeps canonical Picture numbering');
check(referenceSections.overallSoundscape !== 'N/A', 'vocal reference is described instead of claiming silence');
check(referencePrompt.includes('do not replace or paraphrase the vocal'), 'vocal preservation instruction reaches the prompt');

const silentReference = h3Compiler.compileH3Sections(referenceShot, {
  mode: h3Compiler.H3_PROMPT_MODES.REFERENCE,
  hasVocalReference: false,
});
check(silentReference.overallSoundscape === 'N/A', 'reference mode can explicitly omit vocal audio');

const baseShot = makeShot();
const baseSections = h3Compiler.compileH3Sections(baseShot, {
  mode: h3Compiler.H3_PROMPT_MODES.BASE,
  hasVocalReference: false,
});
const basePrompt = h3Compiler.assembleH3Prompt(baseSections);
check(basePrompt.startsWith('integrated_multimodal_description:'), 'base dialect starts with integrated multimodal description');
check(basePrompt.includes('[base generation]'), 'base dialect does not claim reference generation');
check(!basePrompt.includes('\nsummary:'), 'base dialect has no separate summary field');
check(!basePrompt.includes('subject_definitions:'), 'base dialect has no subject definitions field');
check(!basePrompt.includes('retention_analysis:'), 'base dialect has no retention analysis field');
check(basePrompt.includes('overall_soundscape: N/A'), 'base dialect can explicitly request silence');

const expandedBase = h3Compiler.assembleH3Prompt({
  ...baseSections,
  detailedDescription: 'Expanded current description.',
});
check(expandedBase.includes('Expanded current description.'), 'base assembly uses the current detailed description');
check(!expandedBase.includes(baseSections.detailedDescription), 'base assembly never reuses stale integrated prose');

let rejectedPictureBoundBase = false;
try {
  h3Compiler.compileH3Prompt(referenceShot, { mode: h3Compiler.H3_PROMPT_MODES.BASE });
} catch (error) {
  rejectedPictureBoundBase = error.message.includes('picture-bound');
}
check(rejectedPictureBoundBase, 'base mode rejects picture-bound subjects');

console.log('\nAll H3 compiler contract checks passed.');
