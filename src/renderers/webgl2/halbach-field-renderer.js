/**
 * WebGL2 field-line and |B| heatmap overlay for Halbach visualizer.
 */

import { linkProgram, getUniformLocations } from './shader-utils.js';

const LINE_VERT = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec3 a_pos;
uniform mat4 u_viewProj;
uniform vec3 u_devicePos;
void main() {
  gl_Position = u_viewProj * vec4(a_pos + u_devicePos, 1.0);
}
`;

const LINE_FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform vec3 u_color;
uniform float u_alpha;
out vec4 outColor;
void main() {
  outColor = vec4(u_color, u_alpha);
}
`;

const HEAT_VERT = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec3 a_pos;
layout(location = 1) in vec4 a_color;
uniform mat4 u_viewProj;
uniform vec3 u_devicePos;
out vec4 v_color;
void main() {
  v_color = a_color;
  gl_Position = u_viewProj * vec4(a_pos + u_devicePos, 1.0);
}
`;

const HEAT_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec4 v_color;
out vec4 outColor;
void main() {
  outColor = v_color;
}
`;

export class HalbachFieldRenderer {
  /** @param {WebGL2RenderingContext} gl */
  constructor(gl) {
    this.gl = gl;
    this.lineProgram = linkProgram(gl, LINE_VERT, LINE_FRAG);
    this.lineLocs = getUniformLocations(gl, this.lineProgram, [
      'u_viewProj', 'u_devicePos', 'u_color', 'u_alpha'
    ]);
    this.heatProgram = linkProgram(gl, HEAT_VERT, HEAT_FRAG);
    this.heatLocs = getUniformLocations(gl, this.heatProgram, ['u_viewProj', 'u_devicePos']);
    this.lineVao = gl.createVertexArray();
    this.lineVbo = gl.createBuffer();
    this.heatVao = gl.createVertexArray();
    this.heatVbo = gl.createBuffer();
    this._heatScratch = null;
  }

  /**
   * @param {Float32Array} viewProj
   * @param {number[]} devicePos
   * @param {Float32Array[]} fieldLines
   * @param {Float32Array|null} heatmap  RGBA grid (gridSize²)
   * @param {object} [opts]
   */
  draw(viewProj, devicePos, fieldLines, heatmap, opts = {}) {
    const gl = this.gl;
    const extent = opts.extent ?? 3.1;
    const gridSize = opts.gridSize ?? 24;

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);

    if (heatmap && heatmap.length >= gridSize * gridSize * 4) {
      this._drawHeatmap(viewProj, devicePos, heatmap, extent, gridSize);
    }

    if (fieldLines?.length) {
      gl.useProgram(this.lineProgram);
      gl.uniformMatrix4fv(this.lineLocs.u_viewProj, false, viewProj);
      gl.uniform3fv(this.lineLocs.u_devicePos, devicePos);
      gl.uniform3fv(this.lineLocs.u_color, opts.lineColor || [0.55, 0.82, 1.0]);
      gl.uniform1f(this.lineLocs.u_alpha, opts.lineAlpha ?? 0.72);

      gl.bindVertexArray(this.lineVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.lineVbo);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

      for (const line of fieldLines) {
        if (!line || line.length < 6) continue;
        gl.bufferData(gl.ARRAY_BUFFER, line, gl.DYNAMIC_DRAW);
        gl.drawArrays(gl.LINE_STRIP, 0, line.length / 3);
      }
    }

    gl.depthMask(true);
    gl.bindVertexArray(null);
  }

  _drawHeatmap(viewProj, devicePos, heatmap, extent, gridSize) {
    const gl = this.gl;
    const vertCount = gridSize * gridSize * 6;
    if (!this._heatScratch || this._heatScratch.length < vertCount * 7) {
      this._heatScratch = new Float32Array(vertCount * 7);
    }
    const scratch = this._heatScratch;
    let offset = 0;

    for (let iz = 0; iz < gridSize - 1; iz++) {
      for (let ix = 0; ix < gridSize - 1; ix++) {
        const x0 = (ix / (gridSize - 1) - 0.5) * extent * 2;
        const x1 = ((ix + 1) / (gridSize - 1) - 0.5) * extent * 2;
        const z0 = (iz / (gridSize - 1) - 0.5) * extent * 2;
        const z1 = ((iz + 1) / (gridSize - 1) - 0.5) * extent * 2;
        const y = 0.18;

        const corners = [
          [x0, y, z0, ix + iz * gridSize],
          [x1, y, z0, ix + 1 + iz * gridSize],
          [x1, y, z1, ix + 1 + (iz + 1) * gridSize],
          [x0, y, z0, ix + iz * gridSize],
          [x1, y, z1, ix + 1 + (iz + 1) * gridSize],
          [x0, y, z1, ix + (iz + 1) * gridSize]
        ];

        for (const c of corners) {
          const ci = c[3] * 4;
          scratch[offset++] = c[0];
          scratch[offset++] = c[1];
          scratch[offset++] = c[2];
          scratch[offset++] = heatmap[ci];
          scratch[offset++] = heatmap[ci + 1];
          scratch[offset++] = heatmap[ci + 2];
          scratch[offset++] = heatmap[ci + 3];
        }
      }
    }

    gl.useProgram(this.heatProgram);
    gl.uniformMatrix4fv(this.heatLocs.u_viewProj, false, viewProj);
    gl.uniform3fv(this.heatLocs.u_devicePos, devicePos);

    gl.bindVertexArray(this.heatVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.heatVbo);
    gl.bufferData(gl.ARRAY_BUFFER, scratch.subarray(0, offset), gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 7 * 4, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 7 * 4, 3 * 4);
    gl.drawArrays(gl.TRIANGLES, 0, offset / 7);
  }
}
