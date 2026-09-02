// Lifecycle-managed WebGL renderer for the native CUTTAlogue camera preview.
// It intentionally owns no project or playback state; callers provide the
// compiled path and current pose. Colors match CUTTAlogue's existing tokens.
(function (MSE) {
  'use strict';

  const VERTEX_SHADER = `
    attribute vec3 position;
    uniform mat4 viewProjection;
    void main() { gl_Position = viewProjection * vec4(position, 1.0); }
  `;
  const FRAGMENT_SHADER = `
    precision mediump float;
    uniform vec4 lineColor;
    void main() { gl_FragColor = lineColor; }
  `;
  const POINT_VERTEX_SHADER = `
    attribute vec3 position;
    attribute vec4 vertexColor;
    uniform mat4 viewProjection;
    uniform float pointScale;
    varying vec4 color;
    void main() {
      gl_Position = viewProjection * vec4(position, 1.0);
      gl_PointSize = max(1.0, pointScale / max(0.01, gl_Position.w));
      color = vertexColor;
    }
  `;
  const POINT_FRAGMENT_SHADER = `
    precision mediump float;
    varying vec4 color;
    void main() {
      vec2 offset = gl_PointCoord - 0.5;
      float distanceSquared = dot(offset, offset);
      if (distanceSquared > 0.25) discard;
      gl_FragColor = vec4(color.rgb, color.a * smoothstep(0.25, 0.08, distanceSquared));
    }
  `;

  function createShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const message = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(`Camera preview shader failed: ${message}`);
    }
    return shader;
  }

  function createProgram(gl, vertexSource = VERTEX_SHADER, fragmentSource = FRAGMENT_SHADER) {
    const program = gl.createProgram();
    const vertex = createShader(gl, gl.VERTEX_SHADER, vertexSource);
    const fragment = createShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const message = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error(`Camera preview program failed: ${message}`);
    }
    return program;
  }

  function perspectiveMatrix(fieldOfView, aspect, near, far) {
    const scale = 1 / Math.tan(fieldOfView / 2);
    const range = 1 / (near - far);
    return [
      scale / aspect, 0, 0, 0,
      0, scale, 0, 0,
      0, 0, (far + near) * range, -1,
      0, 0, 2 * far * near * range, 0,
    ];
  }

  function multiplyMatrices(a, b) {
    const result = new Array(16);
    for (let column = 0; column < 4; column += 1) {
      for (let row = 0; row < 4; row += 1) {
        result[column * 4 + row] =
          a[row] * b[column * 4] +
          a[4 + row] * b[column * 4 + 1] +
          a[8 + row] * b[column * 4 + 2] +
          a[12 + row] * b[column * 4 + 3];
      }
    }
    return result;
  }

  function dot(a, b) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  }

  function viewMatrix(camera) {
    const { forward, right, up } = MSE.cameraPath.cameraBasis(camera);
    const position = camera.position;
    return [
      right[0], up[0], -forward[0], 0,
      right[1], up[1], -forward[1], 0,
      right[2], up[2], -forward[2], 0,
      -dot(right, position), -dot(up, position), dot(forward, position), 1,
    ];
  }

  function fieldOfView(focalLengthMm) {
    return 2 * Math.atan(36 / (2 * Math.max(1, focalLengthMm)));
  }

  function groundGrid(size = 10, step = 1) {
    const vertices = [];
    for (let value = -size; value <= size; value += step) {
      vertices.push(-size, 0, value, size, 0, value);
      vertices.push(value, 0, -size, value, 0, size);
    }
    return vertices;
  }

  class CameraPreviewRenderer {
    constructor(canvas) {
      this.canvas = canvas;
      this.gl = canvas.getContext('webgl', { antialias: true, alpha: false });
      if (!this.gl) throw new Error('WebGL is required for camera preview.');
      this.program = createProgram(this.gl);
      this.positionLocation = this.gl.getAttribLocation(this.program, 'position');
      this.matrixLocation = this.gl.getUniformLocation(this.program, 'viewProjection');
      this.colorLocation = this.gl.getUniformLocation(this.program, 'lineColor');
      this.pointProgram = createProgram(this.gl, POINT_VERTEX_SHADER, POINT_FRAGMENT_SHADER);
      this.pointLocations = {
        position: this.gl.getAttribLocation(this.pointProgram, 'position'),
        color: this.gl.getAttribLocation(this.pointProgram, 'vertexColor'),
        matrix: this.gl.getUniformLocation(this.pointProgram, 'viewProjection'),
        scale: this.gl.getUniformLocation(this.pointProgram, 'pointScale'),
      };
      const gridVertices = groundGrid();
      this.gridBuffer = this.createBuffer(gridVertices);
      this.gridVertexCount = gridVertices.length / 3;
      this.pathBuffer = this.gl.createBuffer();
      this.pathVertexCount = 0;
      this.anchorBuffer = this.gl.createBuffer();
      this.anchorVertexCount = 0;
      this.pointCloud = null;
      this.blockoutBuffer = null;
      this.blockoutVertexCount = 0;
      this.disposed = false;
    }

    createBuffer(vertices) {
      const buffer = this.gl.createBuffer();
      this.gl.bindBuffer(this.gl.ARRAY_BUFFER, buffer);
      this.gl.bufferData(this.gl.ARRAY_BUFFER, new Float32Array(vertices), this.gl.STATIC_DRAW);
      return buffer;
    }

    setPlan(plan) {
      if (this.disposed) return;
      const duration = Number.isFinite(plan.durationSeconds) ? plan.durationSeconds : 0;
      const sampleCount = Math.max(2, Math.min(480, Math.ceil(duration * 24) + 1));
      const vertices = [];
      for (let index = 0; index < sampleCount; index += 1) {
        const time = sampleCount === 1 ? 0 : duration * index / (sampleCount - 1);
        vertices.push(...MSE.cameraPath.evaluate(plan, time).position);
      }
      this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.pathBuffer);
      this.gl.bufferData(this.gl.ARRAY_BUFFER, new Float32Array(vertices), this.gl.DYNAMIC_DRAW);
      this.pathVertexCount = vertices.length / 3;
    }

    setAnchors(anchors) {
      if (this.disposed) return;
      const vertices = [];
      const radius = 0.15;
      Object.values(anchors || {}).forEach((anchor) => {
        if (!anchor || !Array.isArray(anchor.position) || anchor.position.length !== 3) return;
        const [x, y, z] = anchor.position.map(Number);
        if (![x, y, z].every(Number.isFinite)) return;
        vertices.push(x - radius, y, z, x + radius, y, z);
        vertices.push(x, y - radius, z, x, y + radius, z);
        vertices.push(x, y, z - radius, x, y, z + radius);
      });
      this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.anchorBuffer);
      this.gl.bufferData(this.gl.ARRAY_BUFFER, new Float32Array(vertices), this.gl.DYNAMIC_DRAW);
      this.anchorVertexCount = vertices.length / 3;
    }

    clearScene() {
      if (this.pointCloud) {
        this.gl.deleteBuffer(this.pointCloud.positionBuffer);
        this.gl.deleteBuffer(this.pointCloud.colorBuffer);
      }
      if (this.blockoutBuffer) this.gl.deleteBuffer(this.blockoutBuffer);
      this.pointCloud = null;
      this.blockoutBuffer = null;
      this.blockoutVertexCount = 0;
    }

    setSceneGeometry(geometry) {
      if (this.disposed) return;
      this.clearScene();
      if (geometry && geometry.pointCloud) {
        const positions = geometry.pointCloud.positions;
        const colors = geometry.pointCloud.colors;
        const positionBuffer = this.gl.createBuffer();
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, positionBuffer);
        this.gl.bufferData(this.gl.ARRAY_BUFFER, positions, this.gl.STATIC_DRAW);
        const colorBuffer = this.gl.createBuffer();
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, colorBuffer);
        this.gl.bufferData(this.gl.ARRAY_BUFFER, colors, this.gl.STATIC_DRAW);
        const count = positions.length / 3;
        this.pointCloud = { positionBuffer, colorBuffer, count, pointScale: Math.max(12, 850 / Math.sqrt(count)) };
      }
      if (geometry && geometry.blockout && geometry.blockout.length) {
        this.blockoutBuffer = this.gl.createBuffer();
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.blockoutBuffer);
        this.gl.bufferData(this.gl.ARRAY_BUFFER, geometry.blockout, this.gl.STATIC_DRAW);
        this.blockoutVertexCount = geometry.blockout.length / 3;
      }
    }

    resize() {
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(1, Math.round(this.canvas.clientWidth * ratio));
      const height = Math.max(1, Math.round(this.canvas.clientHeight * ratio));
      if (this.canvas.width !== width || this.canvas.height !== height) {
        this.canvas.width = width;
        this.canvas.height = height;
      }
      this.gl.viewport(0, 0, width, height);
    }

    drawBuffer(buffer, vertexCount, color, mode) {
      if (!vertexCount) return;
      this.gl.bindBuffer(this.gl.ARRAY_BUFFER, buffer);
      this.gl.enableVertexAttribArray(this.positionLocation);
      this.gl.vertexAttribPointer(this.positionLocation, 3, this.gl.FLOAT, false, 0, 0);
      this.gl.uniform4fv(this.colorLocation, color);
      this.gl.drawArrays(mode, 0, vertexCount);
    }

    drawPointCloud(viewProjection) {
      if (!this.pointCloud) return;
      const gl = this.gl;
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      gl.useProgram(this.pointProgram);
      gl.uniformMatrix4fv(this.pointLocations.matrix, false, viewProjection);
      gl.uniform1f(this.pointLocations.scale, this.pointCloud.pointScale);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.pointCloud.positionBuffer);
      gl.enableVertexAttribArray(this.pointLocations.position);
      gl.vertexAttribPointer(this.pointLocations.position, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.pointCloud.colorBuffer);
      gl.enableVertexAttribArray(this.pointLocations.color);
      gl.vertexAttribPointer(this.pointLocations.color, 4, gl.UNSIGNED_BYTE, true, 0, 0);
      gl.drawArrays(gl.POINTS, 0, this.pointCloud.count);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
    }

    render(pose, viewMode) {
      if (this.disposed) return;
      this.resize();
      const gl = this.gl;
      gl.clearColor(0.078, 0.09, 0.102, 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST);
      gl.useProgram(this.program);

      const camera = viewMode === 'free'
        ? { position: [6, 5, 7], yaw: -0.7, pitch: -0.35, roll: 0, focalLengthMm: 45 }
        : pose;
      const aspect = this.canvas.width / Math.max(1, this.canvas.height);
      const projection = perspectiveMatrix(fieldOfView(camera.focalLengthMm), aspect, 0.05, 10000);
      const viewProjection = multiplyMatrices(projection, viewMatrix(camera));
      gl.uniformMatrix4fv(this.matrixLocation, false, viewProjection);
      this.drawBuffer(this.gridBuffer, this.gridVertexCount, [0.173, 0.196, 0.22, 1], gl.LINES);
      this.drawBuffer(this.blockoutBuffer, this.blockoutVertexCount, [0.36, 0.42, 0.47, 0.65], gl.LINES);
      this.drawPointCloud(viewProjection);
      this.gl.useProgram(this.program);
      this.gl.uniformMatrix4fv(this.matrixLocation, false, viewProjection);
      this.drawBuffer(this.anchorBuffer, this.anchorVertexCount, [0.298, 0.553, 1, 1], gl.LINES);
      if (viewMode === 'free') {
        gl.useProgram(this.program);
        gl.uniformMatrix4fv(this.matrixLocation, false, viewProjection);
        gl.disable(gl.DEPTH_TEST);
        this.drawBuffer(this.pathBuffer, this.pathVertexCount, [0.298, 0.553, 1, 1], gl.LINE_STRIP);
      }
    }

    dispose() {
      if (this.disposed) return;
      this.clearScene();
      this.gl.deleteBuffer(this.gridBuffer);
      this.gl.deleteBuffer(this.pathBuffer);
      this.gl.deleteBuffer(this.anchorBuffer);
      this.gl.deleteProgram(this.program);
      this.gl.deleteProgram(this.pointProgram);
      this.disposed = true;
    }
  }

  MSE.cameraPreviewRenderer = { CameraPreviewRenderer };
})(window.MSE = window.MSE || {});
