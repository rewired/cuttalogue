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

  function createProgram(gl) {
    const program = gl.createProgram();
    const vertex = createShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
    const fragment = createShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
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
      const gridVertices = groundGrid();
      this.gridBuffer = this.createBuffer(gridVertices);
      this.gridVertexCount = gridVertices.length / 3;
      this.pathBuffer = this.gl.createBuffer();
      this.pathVertexCount = 0;
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
      const projection = perspectiveMatrix(fieldOfView(camera.focalLengthMm), aspect, 0.05, 200);
      gl.uniformMatrix4fv(this.matrixLocation, false, multiplyMatrices(projection, viewMatrix(camera)));
      this.drawBuffer(this.gridBuffer, this.gridVertexCount, [0.173, 0.196, 0.22, 1], gl.LINES);
      if (viewMode === 'free') {
        gl.disable(gl.DEPTH_TEST);
        this.drawBuffer(this.pathBuffer, this.pathVertexCount, [0.298, 0.553, 1, 1], gl.LINE_STRIP);
      }
    }

    dispose() {
      if (this.disposed) return;
      this.gl.deleteBuffer(this.gridBuffer);
      this.gl.deleteBuffer(this.pathBuffer);
      this.gl.deleteProgram(this.program);
      this.disposed = true;
    }
  }

  MSE.cameraPreviewRenderer = { CameraPreviewRenderer };
})(window.MSE = window.MSE || {});
