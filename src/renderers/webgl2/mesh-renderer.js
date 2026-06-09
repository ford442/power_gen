import { linkProgram, getUniformLocations } from './shader-utils.js';
import { MESH_VERT, MESH_FRAG } from './shaders.js';
import { generateCylinder, generateDisc, uploadMesh } from '../shared/primitive-geometry.js';

/**
 * Instanced mesh renderer for rollers, stator rings, and simple device geometry.
 * WebGPU storage-buffer instancing → instanced vertex attributes (divisor=1).
 */
export class MeshRenderer {
  constructor(gl) {
    this.gl = gl;
    this.program = linkProgram(gl, MESH_VERT, MESH_FRAG);
    this.locs = getUniformLocations(gl, this.program, [
      'u_viewProj', 'u_model', 'u_devicePos', 'u_lightPos', 'u_lightColor',
      'u_cameraPos', 'u_emissive', 'u_metallic', 'u_roughness', 'u_wireframe', 'u_debugMode'
    ]);

    this.cylinder = uploadMesh(gl, generateCylinder(0.35, 0.9, 20));
    this.disc = uploadMesh(gl, generateDisc(2.0, 2.6, 0.15, 48));
    this.statorDisc = uploadMesh(gl, generateDisc(2.2, 2.5, 0.08, 48));
  }

  _bindInstanceAttribs(instanceBuffer, strideFloats) {
    const gl = this.gl;
    const stride = strideFloats * 4;
    gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
    // instance position
    gl.vertexAttribPointer(2, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribDivisor(2, 1);
    // instance color/emissive
    gl.vertexAttribPointer(3, 4, gl.FLOAT, false, stride, 12);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribDivisor(3, 1);
  }

  _drawInstanced(mesh, instanceBuffer, instanceCount, strideFloats) {
    const gl = this.gl;
    gl.bindVertexArray(mesh.vao);
    this._bindInstanceAttribs(instanceBuffer, strideFloats);
    gl.drawElementsInstanced(gl.TRIANGLES, mesh.indexCount, gl.UNSIGNED_SHORT, 0, instanceCount);
    gl.vertexAttribDivisor(2, 0);
    gl.vertexAttribDivisor(3, 0);
    gl.bindVertexArray(null);
  }

  drawRollers(viewProj, devicePos, rollerPositions, time, opts = {}) {
    const gl = this.gl;
    const count = rollerPositions.length / 2;
    const instanceData = new Float32Array(count * 4);
    const copper = [0.85, 0.48, 0.25];
    const glow = 0.3 + 0.7 * (opts.corona || 0);

    for (let i = 0; i < count; i++) {
      const base = i * 4;
      instanceData[base] = rollerPositions[i * 2];
      instanceData[base + 1] = 0;
      instanceData[base + 2] = rollerPositions[i * 2 + 1];
      instanceData[base + 3] = glow;
    }

    if (!this._rollerInstanceBuf || this._rollerInstanceBuf.length < instanceData.length) {
      this._rollerInstanceBuf = gl.createBuffer();
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this._rollerInstanceBuf);
    gl.bufferData(gl.ARRAY_BUFFER, instanceData, gl.DYNAMIC_DRAW);

    gl.useProgram(this.program);
    gl.uniformMatrix4fv(this.locs.u_viewProj, false, viewProj);
    gl.uniformMatrix4fv(this.locs.u_model, false, new Float32Array(16).fill(0).map((_, i) => (i % 5 === 0 ? 1 : 0)));
    gl.uniform3fv(this.locs.u_devicePos, devicePos);
    gl.uniform3f(this.locs.u_lightPos, 5, 8, 5);
    gl.uniform3f(this.locs.u_lightColor, 1, 0.98, 0.95);
    gl.uniform3fv(this.locs.u_cameraPos, opts.cameraPos || [0, 8, 18]);
    gl.uniform1f(this.locs.u_emissive, glow * 0.5);
    gl.uniform1f(this.locs.u_metallic, 0.85);
    gl.uniform1f(this.locs.u_roughness, 0.35);
    gl.uniform1f(this.locs.u_wireframe, opts.wireframe ? 1 : 0);
    gl.uniform1f(this.locs.u_debugMode, opts.debugMode || 0);

    this._drawInstanced(this.cylinder, this._rollerInstanceBuf, count, 4);
  }

  drawStatorRings(viewProj, devicePos, opts = {}) {
    const gl = this.gl;
    const radii = [2.4, 4.1, 5.8];
    const instanceData = new Float32Array(radii.length * 4);
    for (let i = 0; i < radii.length; i++) {
      instanceData[i * 4 + 1] = 0.12 * i;
      instanceData[i * 4 + 3] = 0.15;
    }
    if (!this._statorBuf) this._statorBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this._statorBuf);
    gl.bufferData(gl.ARRAY_BUFFER, instanceData, gl.STATIC_DRAW);

    gl.useProgram(this.program);
    gl.uniformMatrix4fv(this.locs.u_viewProj, false, viewProj);
    gl.uniformMatrix4fv(this.locs.u_model, false, new Float32Array(16).fill(0).map((_, i) => (i % 5 === 0 ? 1 : 0)));
    gl.uniform3fv(this.locs.u_devicePos, devicePos);
    gl.uniform3f(this.locs.u_lightPos, 5, 8, 5);
    gl.uniform3f(this.locs.u_lightColor, 1, 0.98, 0.95);
    gl.uniform3fv(this.locs.u_cameraPos, opts.cameraPos || [0, 8, 18]);
    gl.uniform1f(this.locs.u_emissive, 0.05);
    gl.uniform1f(this.locs.u_metallic, 0.9);
    gl.uniform1f(this.locs.u_roughness, 0.4);
    gl.uniform1f(this.locs.u_wireframe, opts.wireframe ? 1 : 0);
    gl.uniform1f(this.locs.u_debugMode, opts.debugMode || 0);

    for (let i = 0; i < radii.length; i++) {
      const scale = radii[i] / 2.35;
      const inst = new Float32Array([0, 0.12 * i, 0, 0.2]);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, inst, gl.STATIC_DRAW);
      gl.bindVertexArray(this.statorDisc.vao);
      this._bindInstanceAttribs(buf, 4);
      const model = new Float32Array(16);
      model[0] = scale; model[5] = 1; model[10] = scale; model[15] = 1;
      gl.uniformMatrix4fv(this.locs.u_model, false, model);
      gl.drawElementsInstanced(gl.TRIANGLES, this.statorDisc.indexCount, gl.UNSIGNED_SHORT, 0, 1);
      gl.deleteBuffer(buf);
      gl.vertexAttribDivisor(2, 0);
      gl.vertexAttribDivisor(3, 0);
      gl.bindVertexArray(null);
    }
  }

  drawSimpleBase(viewProj, devicePos, color, opts = {}) {
    const gl = this.gl;
    const instanceData = new Float32Array([0, -0.35, 0, 0.1]);
    if (!this._baseBuf) this._baseBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this._baseBuf);
    gl.bufferData(gl.ARRAY_BUFFER, instanceData, gl.STATIC_DRAW);

    gl.useProgram(this.program);
    gl.uniformMatrix4fv(this.locs.u_viewProj, false, viewProj);
    const model = new Float32Array(16);
    model[0] = 8; model[5] = 0.3; model[10] = 8; model[15] = 1;
    gl.uniformMatrix4fv(this.locs.u_model, false, model);
    gl.uniform3fv(this.locs.u_devicePos, devicePos);
    gl.uniform3f(this.locs.u_lightPos, 5, 8, 5);
    gl.uniform3fv(this.locs.u_cameraPos, opts.cameraPos || [0, 8, 18]);
    gl.uniform1f(this.locs.u_emissive, 0);
    gl.uniform1f(this.locs.u_metallic, 0.6);
    gl.uniform1f(this.locs.u_roughness, 0.5);
    gl.uniform1f(this.locs.u_wireframe, opts.wireframe ? 1 : 0);
    gl.uniform1f(this.locs.u_debugMode, opts.debugMode || 0);

    gl.bindVertexArray(this.disc.vao);
    this._bindInstanceAttribs(this._baseBuf, 4);
    gl.drawElementsInstanced(gl.TRIANGLES, this.disc.indexCount, gl.UNSIGNED_SHORT, 0, 1);
    gl.vertexAttribDivisor(2, 0);
    gl.vertexAttribDivisor(3, 0);
    gl.bindVertexArray(null);
  }
}
