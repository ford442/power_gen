/**
 * Simplified energy-pipe visualization for WebGL2 overview mode.
 * WebGPU uses billboard particles; here we draw animated Bézier line-strips.
 */

import { linkProgram, getUniformLocations } from './shader-utils.js';
import {
  ENERGY_PIPE_EDGES,
  bezierControlPoints,
  deviceAnchor,
  getPipeColor,
  isPipeEndpointEnabled
} from '../shared/energy-network.ts';

const VERT = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec3 a_pos;
uniform mat4 u_viewProj;
void main() {
  gl_Position = u_viewProj * vec4(a_pos, 1.0);
}
`;

const FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform vec3 u_color;
uniform float u_alpha;
out vec4 outColor;
void main() {
  outColor = vec4(u_color, u_alpha);
}
`;

function bezier3(p0, p1, p2, p3, t) {
  const u = 1 - t;
  const uu = u * u;
  const tt = t * t;
  const uuu = uu * u;
  const ttt = tt * t;
  return [
    uuu * p0[0] + 3 * uu * t * p1[0] + 3 * u * tt * p2[0] + ttt * p3[0],
    uuu * p0[1] + 3 * uu * t * p1[1] + 3 * u * tt * p2[1] + ttt * p3[1],
    uuu * p0[2] + 3 * uu * t * p1[2] + 3 * u * tt * p2[2] + ttt * p3[2]
  ];
}

export class EnergyPipeRenderer {
  /**
   * @param {WebGL2RenderingContext} gl
   * @param {{ energyNetwork?: import('../shared/energy-network.ts').EnergyNetwork }} [opts]
   */
  constructor(gl, opts = {}) {
    this.gl = gl;
    this.energyNetwork = opts.energyNetwork ?? null;
    this.program = linkProgram(gl, VERT, FRAG);
    this.locs = getUniformLocations(gl, this.program, ['u_viewProj', 'u_color', 'u_alpha']);
    this.vao = gl.createVertexArray();
    this.vbo = gl.createBuffer();
    this.segments = 32;
    this.pipes = ENERGY_PIPE_EDGES.map((c) => ({
      ...c,
      key: `${c.from}-${c.to}`,
      color: getPipeColor(c.from, c.to),
      flowLevel: 0
    }));
    this._scratch = new Float32Array((this.segments + 1) * 3);
  }

  /**
   * @param {Float32Array} viewProj
   * @param {Record<string, object>} devices
   * @param {number} time
   * @param {{ devicesEnabled?: Record<string, boolean> }} [opts]
   */
  draw(viewProj, devices, time = 0, opts = {}) {
    const gl = this.gl;
    gl.useProgram(this.program);
    gl.uniformMatrix4fv(this.locs.u_viewProj, false, viewProj);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    gl.depthMask(false);

    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

    for (const pipe of this.pipes) {
      const a = devices[pipe.from];
      const b = devices[pipe.to];
      if (!a || !b) continue;

      const enabled = isPipeEndpointEnabled(pipe.from, pipe.to, opts.devicesEnabled);
      pipe.flowLevel = this.energyNetwork
        ? this.energyNetwork.getPipeFlow(pipe.from, pipe.to)
        : pipe.flowLevel;

      if (!enabled && pipe.flowLevel < 0.02) continue;
      if (pipe.flowLevel < 0.02) continue;

      const p0 = deviceAnchor(a);
      const p3 = deviceAnchor(b);
      const { p1, p2 } = bezierControlPoints(p0, p3);

      for (let i = 0; i <= this.segments; i++) {
        const t = i / this.segments;
        const pt = bezier3(p0, p1, p2, p3, t);
        const o = i * 3;
        this._scratch[o] = pt[0];
        this._scratch[o + 1] = pt[1];
        this._scratch[o + 2] = pt[2];
      }

      gl.bufferData(gl.ARRAY_BUFFER, this._scratch, gl.DYNAMIC_DRAW);
      gl.uniform3fv(this.locs.u_color, pipe.color);
      gl.uniform1f(this.locs.u_alpha, 0.25 + 0.55 * pipe.flowLevel);
      gl.drawArrays(gl.LINE_STRIP, 0, this.segments + 1);
    }

    gl.depthMask(true);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindVertexArray(null);
  }

  get totalFlowLevel() {
    if (!this.pipes.length) return 0;
    return this.pipes.reduce((s, p) => s + p.flowLevel, 0) / this.pipes.length;
  }
}
