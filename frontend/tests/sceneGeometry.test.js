// Unit coverage for the pure donor-derived scene parsers.
// Run with: node frontend/tests/sceneGeometry.test.js
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

global.window = global;
global.MSE = {};
const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'sceneGeometry.js'), 'utf8');
vm.runInThisContext(source, { filename: 'sceneGeometry.js' });

const geometry = MSE.sceneGeometry;
let failures = 0;
function check(condition, label) {
  if (condition) console.log(`ok - ${label}`);
  else { failures += 1; console.error(`FAIL: ${label}`); }
}

const ply = [
  'ply', 'format ascii 1.0', 'element vertex 2',
  'property float x', 'property float y', 'property float z',
  'property uchar red', 'property uchar green', 'property uchar blue',
  'end_header', '1 2 3 255 0 10', '-1 0 4 5 6 7', '',
].join('\n');
const parsedPly = geometry.parsePly(new TextEncoder().encode(ply).buffer);
check(parsedPly.positions.length === 6 && parsedPly.positions[0] === 1 && parsedPly.positions[3] === -1, 'ASCII PLY positions parse');
check(parsedPly.colors[0] === 255 && parsedPly.colors[2] === 10 && parsedPly.colors[7] === 220, 'ASCII PLY colors and default alpha parse');

const splat = new ArrayBuffer(32);
const splatView = new DataView(splat);
splatView.setFloat32(0, 1.25, true);
splatView.setFloat32(4, -2.5, true);
splatView.setFloat32(8, 3.75, true);
[9, 8, 7, 6].forEach((value, index) => splatView.setUint8(24 + index, value));
const parsedSplat = geometry.parseSplat(splat);
check(parsedSplat.positions[1] === -2.5, 'SPLAT position records parse');
check(parsedSplat.colors.join(',') === '9,8,7,6', 'SPLAT color records parse');

function paddedBytes(text) {
  const raw = new TextEncoder().encode(text);
  const bytes = new Uint8Array(Math.ceil(raw.length / 4) * 4);
  bytes.fill(0x20);
  bytes.set(raw);
  return bytes;
}
const binary = new ArrayBuffer(44);
const binaryView = new DataView(binary);
[[0, 0, 0], [1, 0, 0], [0, 1, 0]].flat().forEach((value, index) => binaryView.setFloat32(index * 4, value, true));
[0, 1, 2].forEach((value, index) => binaryView.setUint16(36 + index * 2, value, true));
const json = paddedBytes(JSON.stringify({
  asset: { version: '2.0' },
  buffers: [{ byteLength: 42 }],
  bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 6 }],
  accessors: [
    { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
    { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' },
  ],
  meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
}));
const total = 12 + 8 + json.length + 8 + binary.byteLength;
const glb = new ArrayBuffer(total);
const glbView = new DataView(glb);
glbView.setUint32(0, 0x46546c67, true);
glbView.setUint32(4, 2, true);
glbView.setUint32(8, total, true);
glbView.setUint32(12, json.length, true);
glbView.setUint32(16, 0x4e4f534a, true);
new Uint8Array(glb, 20, json.length).set(json);
const binOffset = 20 + json.length;
glbView.setUint32(binOffset, binary.byteLength, true);
glbView.setUint32(binOffset + 4, 0x004e4942, true);
new Uint8Array(glb, binOffset + 8).set(new Uint8Array(binary));
const parsedGlb = geometry.parseGlb(glb);
check(parsedGlb.length === 18, 'one GLB triangle becomes three wireframe edges');
check(parsedGlb[3] === 1 && parsedGlb[10] === 1, 'GLB edge vertices preserve accessor data');

check(
  geometry.projectFileUrl('project one', 'assets/a b/set.splat') === '/project-files/project%20one/assets/a%20b/set.splat',
  'project file URLs encode ids and path segments'
);

for (const [fn, input, label] of [
  [geometry.parsePly, new ArrayBuffer(4), 'invalid PLY is rejected'],
  [geometry.parseSplat, new ArrayBuffer(31), 'invalid SPLAT is rejected'],
  [geometry.parseGlb, new ArrayBuffer(20), 'invalid GLB is rejected'],
]) {
  try { fn(input); check(false, label); } catch (_error) { check(true, label); }
}

if (failures) { console.error(`\n${failures} failure(s)`); process.exitCode = 1; }
else console.log('\nAll scene geometry checks passed.');
