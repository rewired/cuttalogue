// Pure scene-file parsing plus project-file loading. Adapted from Shot
// Visualizer's PLY/SPLAT/GLB loaders; no UI, theme, or WebGL state crosses
// this boundary.
(function (MSE) {
  'use strict';

  const MAX_VERTICES = 10_000_000;
  const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

  function findPlyHeaderEnd(bytes) {
    const preview = new TextDecoder().decode(bytes.slice(0, Math.min(bytes.length, 100000)));
    const marker = preview.indexOf('end_header');
    if (marker < 0) return -1;
    const newline = preview.indexOf('\n', marker);
    return newline < 0 ? marker + 10 : newline + 1;
  }

  function setPlyVertex(index, values, positions, colors) {
    positions.set([Number(values.x) || 0, Number(values.y) || 0, Number(values.z) || 0], index * 3);
    const sigmoid = (value) => 1 / (1 + Math.exp(-value));
    colors[index * 4] = values.red ?? values.r ?? (values.f_dc_0 != null ? clamp((0.5 + 0.282095 * values.f_dc_0) * 255, 0, 255) : 210);
    colors[index * 4 + 1] = values.green ?? values.g ?? (values.f_dc_1 != null ? clamp((0.5 + 0.282095 * values.f_dc_1) * 255, 0, 255) : 220);
    colors[index * 4 + 2] = values.blue ?? values.b ?? (values.f_dc_2 != null ? clamp((0.5 + 0.282095 * values.f_dc_2) * 255, 0, 255) : 230);
    colors[index * 4 + 3] = values.alpha ?? (values.opacity != null ? clamp(sigmoid(values.opacity) * 255, 10, 255) : 220);
  }

  function parsePly(buffer) {
    const bytes = new Uint8Array(buffer);
    const headerEnd = findPlyHeaderEnd(bytes);
    if (headerEnd < 0) throw new Error('Invalid PLY header.');
    const header = new TextDecoder().decode(bytes.slice(0, headerEnd));
    const format = (header.match(/^format\s+(\S+)/m) || [])[1];
    if (!['ascii', 'binary_little_endian'].includes(format)) throw new Error(`Unsupported PLY format: ${format || 'unknown'}.`);
    const vertexCount = Number((header.match(/element vertex (\d+)/) || [])[1]);
    if (!Number.isInteger(vertexCount) || vertexCount < 1 || vertexCount > MAX_VERTICES) throw new Error('Invalid PLY vertex count.');

    const properties = [];
    let readingVertices = false;
    for (const line of header.split(/\r?\n/)) {
      if (line.startsWith('element vertex')) readingVertices = true;
      else if (line.startsWith('element ') && readingVertices) readingVertices = false;
      else if (readingVertices && line.startsWith('property list')) throw new Error('PLY list properties are not supported for vertices.');
      else if (readingVertices && line.startsWith('property ')) {
        const [, type, name] = line.trim().split(/\s+/);
        properties.push({ type: type.toLowerCase(), name });
      }
    }
    const positions = new Float32Array(vertexCount * 3);
    const colors = new Uint8Array(vertexCount * 4);
    if (format === 'ascii') {
      const rows = new TextDecoder().decode(bytes.slice(headerEnd)).trim().split(/\r?\n/);
      if (rows.length < vertexCount) throw new Error('PLY vertex data is truncated.');
      for (let index = 0; index < vertexCount; index += 1) {
        const row = rows[index].trim().split(/\s+/).map(Number);
        if (row.length < properties.length || row.some((value) => !Number.isFinite(value))) throw new Error('Invalid ASCII PLY vertex.');
        setPlyVertex(index, Object.fromEntries(properties.map((property, column) => [property.name, row[column]])), positions, colors);
      }
      return { positions, colors };
    }

    const types = {
      char: [1, 'getInt8'], uchar: [1, 'getUint8'], int8: [1, 'getInt8'], uint8: [1, 'getUint8'],
      short: [2, 'getInt16'], ushort: [2, 'getUint16'], int16: [2, 'getInt16'], uint16: [2, 'getUint16'],
      int: [4, 'getInt32'], uint: [4, 'getUint32'], int32: [4, 'getInt32'], uint32: [4, 'getUint32'],
      float: [4, 'getFloat32'], float32: [4, 'getFloat32'], double: [8, 'getFloat64'], float64: [8, 'getFloat64'],
    };
    const stride = properties.reduce((sum, property) => sum + (types[property.type] || [0])[0], 0);
    if (!stride || headerEnd + stride * vertexCount > buffer.byteLength) throw new Error('Binary PLY vertex data is truncated.');
    const view = new DataView(buffer, headerEnd);
    let offset = 0;
    for (let index = 0; index < vertexCount; index += 1) {
      const values = {};
      for (const property of properties) {
        const spec = types[property.type];
        if (!spec) throw new Error(`Unsupported PLY property type: ${property.type}.`);
        values[property.name] = view[spec[1]](offset, true);
        offset += spec[0];
      }
      setPlyVertex(index, values, positions, colors);
    }
    return { positions, colors };
  }

  function parseSplat(buffer) {
    if (!buffer.byteLength || buffer.byteLength % 32 !== 0) throw new Error('Invalid SPLAT byte length.');
    const vertexCount = buffer.byteLength / 32;
    if (vertexCount > MAX_VERTICES) throw new Error('SPLAT vertex count exceeds the preview limit.');
    const view = new DataView(buffer);
    const positions = new Float32Array(vertexCount * 3);
    const colors = new Uint8Array(vertexCount * 4);
    for (let index = 0; index < vertexCount; index += 1) {
      const offset = index * 32;
      positions.set([view.getFloat32(offset, true), view.getFloat32(offset + 4, true), view.getFloat32(offset + 8, true)], index * 3);
      colors.set([view.getUint8(offset + 24), view.getUint8(offset + 25), view.getUint8(offset + 26), view.getUint8(offset + 27)], index * 4);
    }
    return { positions, colors };
  }

  function parseGlb(buffer) {
    const file = new DataView(buffer);
    if (buffer.byteLength < 20 || file.getUint32(0, true) !== 0x46546c67) throw new Error('Invalid GLB header.');
    if (file.getUint32(4, true) !== 2 || file.getUint32(8, true) > buffer.byteLength) throw new Error('Unsupported or truncated GLB.');
    let offset = 12;
    let json = null;
    let binary = null;
    while (offset + 8 <= buffer.byteLength) {
      const length = file.getUint32(offset, true);
      const type = file.getUint32(offset + 4, true);
      if (offset + 8 + length > buffer.byteLength) throw new Error('Truncated GLB chunk.');
      const data = buffer.slice(offset + 8, offset + 8 + length);
      if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(data).replace(/\u0000+$/g, '').trim());
      if (type === 0x004e4942) binary = data;
      offset += 8 + length;
    }
    if (!json || !binary) throw new Error('GLB requires JSON and binary chunks.');
    const componentTypes = { 5120: [1, 'getInt8'], 5121: [1, 'getUint8'], 5122: [2, 'getInt16'], 5123: [2, 'getUint16'], 5125: [4, 'getUint32'], 5126: [4, 'getFloat32'] };
    const componentCounts = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
    function readAccessor(accessorIndex) {
      const accessor = json.accessors && json.accessors[accessorIndex];
      const bufferView = accessor && json.bufferViews && json.bufferViews[accessor.bufferView];
      const spec = accessor && componentTypes[accessor.componentType];
      const componentCount = accessor && componentCounts[accessor.type];
      if (!accessor || !bufferView || !spec || !componentCount || accessor.sparse) throw new Error('Unsupported GLB accessor.');
      const view = new DataView(binary);
      const start = (bufferView.byteOffset || 0) + (accessor.byteOffset || 0);
      const stride = bufferView.byteStride || spec[0] * componentCount;
      if (start + Math.max(0, accessor.count - 1) * stride + spec[0] * componentCount > binary.byteLength) throw new Error('GLB accessor exceeds its buffer.');
      return Array.from({ length: accessor.count }, (_, index) => Array.from({ length: componentCount }, (_, component) => (
        view[spec[1]](start + index * stride + component * spec[0], true)
      )));
    }
    const vertices = [];
    for (const mesh of json.meshes || []) {
      for (const primitive of mesh.primitives || []) {
        if (primitive.mode != null && primitive.mode !== 4) continue;
        if (!primitive.attributes || primitive.attributes.POSITION == null) continue;
        const positions = readAccessor(primitive.attributes.POSITION);
        const indices = primitive.indices != null ? readAccessor(primitive.indices).flat() : positions.map((_, index) => index);
        for (let index = 0; index + 2 < indices.length; index += 3) {
          const a = positions[indices[index]];
          const b = positions[indices[index + 1]];
          const c = positions[indices[index + 2]];
          if (!a || !b || !c) throw new Error('GLB index is out of bounds.');
          vertices.push(...a, ...b, ...b, ...c, ...c, ...a);
        }
      }
    }
    return new Float32Array(vertices);
  }

  function projectFileUrl(projectId, relativePath) {
    const safePath = String(relativePath || '').split('/').map(encodeURIComponent).join('/');
    return `/project-files/${encodeURIComponent(projectId)}/${safePath}`;
  }

  async function loadAsset(asset, projectId, fetchImpl) {
    if (!asset) return null;
    const response = await fetchImpl(projectFileUrl(projectId, asset.relativePath));
    if (!response.ok) throw new Error(`Could not load ${asset.fileName}: HTTP ${response.status}.`);
    const buffer = await response.arrayBuffer();
    const extension = (asset.fileName.split('.').pop() || '').toLowerCase();
    if (extension === 'ply') return { kind: 'pointcloud', data: parsePly(buffer) };
    if (extension === 'splat') return { kind: 'pointcloud', data: parseSplat(buffer) };
    if (extension === 'glb') return { kind: 'blockout', data: parseGlb(buffer) };
    throw new Error(`Unsupported scene format: ${extension || 'unknown'}.`);
  }

  async function loadScene(scene, assets, projectId, fetchImpl = fetch) {
    if (!scene || !projectId) return { pointCloud: null, blockout: null };
    const byId = new Map(assets.map((asset) => [asset.id, asset]));
    const loaded = await Promise.all([
      loadAsset(byId.get(scene.splatAssetId), projectId, fetchImpl),
      loadAsset(byId.get(scene.blockoutAssetId), projectId, fetchImpl),
    ]);
    return {
      pointCloud: (loaded.find((entry) => entry && entry.kind === 'pointcloud') || {}).data || null,
      blockout: (loaded.find((entry) => entry && entry.kind === 'blockout') || {}).data || null,
    };
  }

  MSE.sceneGeometry = { parsePly, parseSplat, parseGlb, projectFileUrl, loadScene };
})(window.MSE = window.MSE || {});
