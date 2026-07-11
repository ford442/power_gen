/**
 * Simplified energy-pipe visualization for WebGL2 overview mode.
 * WebGPU uses billboard particles; here we draw animated Bézier line-strips.
 */

import { linkProgram, getUniformLocations } from './shader-utils.js';

const PIPE_COLORS = {
  'seg-heron': [0.15, 0.92, 0.75],
  'heron-kelvin': [0.25, 0.65, 1.0],
  'kelvin-seg': [0.72, 0.45, 1.0],
  'kelvin-peltier': [0.55, 0.35, 0.95],
  'peltier-solar': [1.0, 0.82, 0.25],
  'seg-mhd': [0.35, 0.88, 1.0],
  'mhd-peltier': [0.45, 0.75, 1.0],
  'solar-maglev': [0.25, 0.92, 1.0],
  'maglev-seg': [0.15, 0.85, 0.95]
};

const PIPE_CONFIGS = [
  { from: 'seg', to: 'heron' },
  { from: 'heron', to: 'kelvin' },
  { from: 'kelvin', to: 'seg' },
  { from: 'kelvin', to: 'peltier' },
  { from: 'peltier', to: 'solar' },
  { from: 'seg', to: 'mhd' },
  { from: 'mhd', to: 'peltier' },
  { from: 'solar', to: 'maglev' },
  { from: 'maglev', to: 'seg' }
];

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

function deviceAnchor(dev) {
  if (!dev) return [0, 2, 0];
  const pos = dev.config?.position || dev.position || [0, 0, 0];
  const id = dev.id || '';
  const yBoost = id === 'solar' ? 1.5 : id === 'heron' ? 3.0 : 2.2;
  return [pos[0], pos[1] + yBoost, pos[2]];
}

export class EnergyPipeRenderer {
  constructor(gl) {
    this.gl = gl;
    this.program = linkProgram(gl, VERT, FRAG);
    this.locs = getUniformLocations(gl, this.program, ['u_viewProj', 'u_color', 'u_alpha']);
    this.vao = gl.createVertexArray();
    this.vbo = gl.createBuffer();
    this.segments = 32;
    this.pipes = PIPE_CONFIGS.map((c) => ({
      ...c,
      key: `${c.from}-${c.to}`,
      color: PIPE_COLORS[`${c.from}-${c.to}`] || [0.4, 0.9, 1.0],
      flowLevel: 0.35
    }));
    this._scratch = new Float32Array((this.segments + 1) * 3);
  }

  /**
   * @param {Float32Array} viewProj
   * @param {Record<string, { config?: { position: number[] }, id?: string, physics?: object, energyLevel?: number }>} devices
   * @param {number} time
   */
  draw(viewProj, devices, time = 0) {
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

      const p0 = deviceAnchor(a);
      const p3 = deviceAnchor(b);
      const mid = [
        (p0[0] + p3[0]) * 0.5,
        Math.max(p0[1], p3[1]) + 3.5,
        (p0[2] + p3[2]) * 0.5
      ];
      // Control points for a high arc
      const p1 = [
        p0[0] * 0.65 + mid[0] * 0.35,
        mid[1],
        p0[2] * 0.65 + mid[2] * 0.35
      ];
      const p2 = [
        p3[0] * 0.65 + mid[0] * 0.35,
        mid[1] * 0.95,
        p3[2] * 0.65 + mid[2] * 0.35
      ];

      const eA = a.physics?.energyLevel ?? a.energyLevel ?? 0.3;
      const eB = b.physics?.energyLevel ?? b.energyLevel ?? 0.3;
      pipe.flowLevel = 0.25 + 0.75 * Math.min(1, (eA + eB) * 0.5);

      for (let i = 0; i <= this.segments; i++) {
        const t = i / this.segments;
        // Animated dash phase along the curve
        const phase = (t + time * 0.15 * pipe.flowLevel) % 1;
        const pt = bezier3(p0, p1, p2, p3, t);
        const o = i * 3;
        this._scratch[o] = pt[0];
        this._scratch[o + 1] = pt[1];
        this._scratch[o + 2] = pt[2];
        void phase;
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
