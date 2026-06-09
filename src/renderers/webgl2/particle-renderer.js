import { linkProgram, getUniformLocations } from './shader-utils.js';
import { PARTICLE_VERT, PARTICLE_FRAG } from './shaders.js';

/**
 * Billboard particle renderer.
 * Reads the same 8-float particle records as compute.wgsl / particles.wgsl.
 */
export class ParticleRenderer {
  constructor(gl) {
    this.gl = gl;
    this.program = linkProgram(gl, PARTICLE_VERT, PARTICLE_FRAG);
    this.locs = getUniformLocations(gl, this.program, [
      'u_viewProj', 'u_devicePos', 'u_mode', 'u_tint', 'u_debugParticles',
      'u_battery', 'u_particleScale'
    ]);
    this.particleVao = gl.createVertexArray();
    this._particleBuffer = null;
    this._capacity = 0;
  }

  _ensureBuffer(floatCount) {
    const gl = this.gl;
    if (this._capacity >= floatCount && this._particleBuffer) return;
    this._capacity = floatCount;
    this._particleBuffer = gl.createBuffer();
    gl.bindVertexArray(this.particleVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._particleBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, floatCount * 4, gl.DYNAMIC_DRAW);
    const stride = 32;
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(1, 1, gl.FLOAT, false, stride, 12);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(2, 3, gl.FLOAT, false, stride, 16);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(3, 1, gl.FLOAT, false, stride, 28);
    gl.enableVertexAttribArray(3);
    gl.bindVertexArray(null);
  }

  draw(particles, count, viewProj, devicePos, mode, tint, opts = {}) {
    const gl = this.gl;
    const floatCount = count * 8;
    this._ensureBuffer(floatCount);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._particleBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, particles.subarray(0, floatCount));

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.useProgram(this.program);
    gl.uniformMatrix4fv(this.locs.u_viewProj, false, viewProj);
    gl.uniform3fv(this.locs.u_devicePos, devicePos);
    gl.uniform1f(this.locs.u_mode, mode);
    gl.uniform3fv(this.locs.u_tint, tint);
    gl.uniform1f(this.locs.u_debugParticles, opts.debugParticles || 0);
    gl.uniform1f(this.locs.u_battery, opts.battery || 0);
    gl.uniform1f(this.locs.u_particleScale, opts.particleScale || 1);

    gl.bindVertexArray(this.particleVao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
    gl.bindVertexArray(null);
    gl.depthMask(true);
  }
}
