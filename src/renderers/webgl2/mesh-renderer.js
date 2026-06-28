import { linkProgram, getUniformLocations } from './shader-utils.js';
import { MESH_VERT, MESH_FRAG, ROLLER_VERT, ROLLER_FRAG } from './shaders.js';
import { generateCylinder, generateDisc, uploadMesh, uploadMeshWithUV } from '../shared/primitive-geometry.js';
import { buildDetailedRollerMesh, poleTintColor, isNorthPole } from '../../seg-roller-model.js';
import { computeSEGLayout, SEG_LAYOUT_PRESETS } from '../../seg-layout.js';
import { computeFrameDimensions, parseSegFrameLevel } from '../../seg-frame-model.js';

/** Instance record: vec3 position + vec4 rgba — 28 bytes (matches MESH_VERT a_instanceColor). */
const INSTANCE_STRIDE_FLOATS = 7;

/**
 * Instanced mesh renderer for rollers, stator rings, and simple device geometry.
 * WebGPU storage-buffer instancing → instanced vertex attributes (divisor=1).
 */
export class MeshRenderer {
  constructor(gl) {
    this.gl = gl;
    this.program = linkProgram(gl, MESH_VERT, MESH_FRAG);
    this.rollerProgram = linkProgram(gl, ROLLER_VERT, ROLLER_FRAG);
    this.locs = getUniformLocations(gl, this.program, [
      'u_viewProj', 'u_model', 'u_devicePos', 'u_lightPos', 'u_lightColor',
      'u_fillDir', 'u_fillColor', 'u_rimColor',
      'u_cameraPos', 'u_emissive', 'u_metallic', 'u_roughness', 'u_wireframe', 'u_debugMode'
    ]);
    this.rollerLocs = getUniformLocations(gl, this.rollerProgram, [
      'u_viewProj', 'u_devicePos', 'u_lightPos', 'u_cameraPos',
      'u_fillDir', 'u_fillColor', 'u_rimColor',
      'u_emissive', 'u_metallic', 'u_roughness', 'u_scaleXZ', 'u_scaleY'
    ]);

    this.cylinder = uploadMesh(gl, generateCylinder(0.35, 0.9, 20));
    this.disc = uploadMesh(gl, generateDisc(2.0, 2.6, 0.15, 48));
    this.statorDisc = uploadMesh(gl, generateDisc(2.2, 2.5, 0.08, 48));
    this.detailedRoller = uploadMeshWithUV(gl, buildDetailedRollerMesh());
    this.lighting = null;
  }

  /** @param {import('../../seg-lighting-presets.js').ReturnType<typeof import('../../seg-lighting-presets.js').getLightingPreset>} preset */
  setLightingPreset(preset) {
    if (!preset) return;
    const k = preset.lighting.key;
    const f = preset.lighting.fill;
    const r = preset.lighting.rim;
    this.lighting = {
      keyPos: k.position,
      keyColor: k.color.map((c, i) => c * k.intensity),
      fillDir: f.position,
      fillColor: f.color.map((c) => c * f.intensity * 0.42),
      rimColor: r.color.map((c) => c * r.intensity * 0.42)
    };
  }

  _applyLighting(locs, program) {
    const L = this.lighting ?? {
      keyPos: [5, 8, 5],
      keyColor: [1.0, 0.97, 0.92],
      fillDir: [-5, 4, -2],
      fillColor: [0.33, 0.37, 0.42],
      rimColor: [0.23, 0.34, 0.42]
    };
    const gl = this.gl;
    gl.useProgram(program);
    gl.uniform3f(locs.u_lightPos, L.keyPos[0], L.keyPos[1], L.keyPos[2]);
    if (locs.u_lightColor) gl.uniform3fv(locs.u_lightColor, L.keyColor);
    if (locs.u_fillDir) gl.uniform3f(locs.u_fillDir, L.fillDir[0], L.fillDir[1], L.fillDir[2]);
    if (locs.u_fillColor) gl.uniform3fv(locs.u_fillColor, L.fillColor);
    if (locs.u_rimColor) gl.uniform3fv(locs.u_rimColor, L.rimColor);
  }

  _bindInstanceAttribs(instanceBuffer) {
    const gl = this.gl;
    const stride = INSTANCE_STRIDE_FLOATS * 4;
    gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
    gl.vertexAttribPointer(2, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribDivisor(2, 1);
    gl.vertexAttribPointer(3, 4, gl.FLOAT, false, stride, 12);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribDivisor(3, 1);
  }

  _packInstance(out, index, pos, rgb, emissive) {
    const base = index * INSTANCE_STRIDE_FLOATS;
    out[base] = pos[0];
    out[base + 1] = pos[1];
    out[base + 2] = pos[2];
    out[base + 3] = rgb[0];
    out[base + 4] = rgb[1];
    out[base + 5] = rgb[2];
    out[base + 6] = emissive;
  }

  _drawInstanced(mesh, instanceBuffer, instanceCount, program = this.program, locs = this.locs) {
    const gl = this.gl;
    gl.bindVertexArray(mesh.vao);
    this._bindInstanceAttribs(instanceBuffer);
    gl.useProgram(program);
    gl.drawElementsInstanced(gl.TRIANGLES, mesh.indexCount, gl.UNSIGNED_SHORT, 0, instanceCount);
    gl.vertexAttribDivisor(2, 0);
    gl.vertexAttribDivisor(3, 0);
    gl.bindVertexArray(null);
  }

  drawRollers(viewProj, devicePos, rollerPositions, time, opts = {}) {
    const gl = this.gl;
    const count = rollerPositions.length / 2;
    const instanceData = new Float32Array(count * INSTANCE_STRIDE_FLOATS);
    const glow = 0.3 + 0.7 * (opts.corona || 0);
    const rings = opts.rings || [
      { count: 8, index: 0, rollerRadius: 0.75, scale: 0.75 },
      { count: 12, index: 1, rollerRadius: 0.75, scale: 0.75 },
      { count: 16, index: 2, rollerRadius: 0.75, scale: 0.75 }
    ];

    let flat = 0;
    for (const ring of rings) {
      for (let i = 0; i < ring.count && flat < count; i++) {
        const pole = poleTintColor(ring.index, i, opts.prototypePreset || 'showroom');
        this._packInstance(
          instanceData, flat,
          [rollerPositions[flat * 2], 0, rollerPositions[flat * 2 + 1]],
          pole,
          glow * (isNorthPole(ring.index, i) ? 0.6 : 0.35)
        );
        flat++;
      }
    }

    if (!this._rollerInstanceBuf || this._rollerInstanceBuf.length < instanceData.length) {
      this._rollerInstanceBuf = gl.createBuffer();
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this._rollerInstanceBuf);
    gl.bufferData(gl.ARRAY_BUFFER, instanceData, gl.DYNAMIC_DRAW);

    gl.useProgram(this.rollerProgram);
    gl.uniformMatrix4fv(this.rollerLocs.u_viewProj, false, viewProj);
    gl.uniform3fv(this.rollerLocs.u_devicePos, devicePos);
    this._applyLighting(this.rollerLocs, this.rollerProgram);
    gl.uniform3fv(this.rollerLocs.u_cameraPos, opts.cameraPos || [0, 8, 18]);
    gl.uniform1f(this.rollerLocs.u_emissive, glow * 0.5);
    gl.uniform1f(this.rollerLocs.u_metallic, 0.90);
    gl.uniform1f(this.rollerLocs.u_roughness, 0.28);
    gl.uniform1f(this.rollerLocs.u_scaleXZ, opts.scaleXZ ?? 1.0);
    gl.uniform1f(this.rollerLocs.u_scaleY, opts.scaleY ?? 1.0);

    gl.bindVertexArray(this.detailedRoller.vao);
    this._bindInstanceAttribs(this._rollerInstanceBuf);
    gl.drawElementsInstanced(gl.TRIANGLES, this.detailedRoller.indexCount, gl.UNSIGNED_SHORT, 0, count);
    gl.vertexAttribDivisor(2, 0);
    gl.vertexAttribDivisor(3, 0);
    gl.bindVertexArray(null);
  }

  drawStatorRings(viewProj, devicePos, opts = {}) {
    const gl = this.gl;
    const radii = [2.4, 4.1, 5.8];
    const copper = [0.85, 0.48, 0.25];
    const instanceData = new Float32Array(radii.length * INSTANCE_STRIDE_FLOATS);
    for (let i = 0; i < radii.length; i++) {
      this._packInstance(instanceData, i, [0, 0.12 * i, 0], copper, 0.15);
    }
    if (!this._statorBuf) this._statorBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this._statorBuf);
    gl.bufferData(gl.ARRAY_BUFFER, instanceData, gl.STATIC_DRAW);

    gl.useProgram(this.program);
    gl.uniformMatrix4fv(this.locs.u_viewProj, false, viewProj);
    gl.uniformMatrix4fv(this.locs.u_model, false, new Float32Array(16).fill(0).map((_, i) => (i % 5 === 0 ? 1 : 0)));
    gl.uniform3fv(this.locs.u_devicePos, devicePos);
    this._applyLighting(this.locs, this.program);
    gl.uniform3fv(this.locs.u_cameraPos, opts.cameraPos || [0, 8, 18]);
    gl.uniform1f(this.locs.u_emissive, 0.05);
    gl.uniform1f(this.locs.u_metallic, 0.9);
    gl.uniform1f(this.locs.u_roughness, 0.4);
    gl.uniform1f(this.locs.u_wireframe, opts.wireframe ? 1 : 0);
    gl.uniform1f(this.locs.u_debugMode, opts.debugMode || 0);

    for (let i = 0; i < radii.length; i++) {
      const scale = radii[i] / 2.35;
      const inst = new Float32Array(INSTANCE_STRIDE_FLOATS);
      this._packInstance(inst, 0, [0, 0.12 * i, 0], copper, 0.2);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, inst, gl.STATIC_DRAW);
      gl.bindVertexArray(this.statorDisc.vao);
      this._bindInstanceAttribs(buf);
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
    const instanceData = new Float32Array(INSTANCE_STRIDE_FLOATS);
    this._packInstance(instanceData, 0, [0, -0.35, 0], [0.08, 0.08, 0.12], 0.1);
    if (!this._baseBuf) this._baseBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this._baseBuf);
    gl.bufferData(gl.ARRAY_BUFFER, instanceData, gl.DYNAMIC_DRAW);

    gl.useProgram(this.program);
    gl.uniformMatrix4fv(this.locs.u_viewProj, false, viewProj);
    const model = new Float32Array(16);
    model[0] = 8; model[5] = 0.3; model[10] = 8; model[15] = 1;
    gl.uniformMatrix4fv(this.locs.u_model, false, model);
    gl.uniform3fv(this.locs.u_devicePos, devicePos);
    this._applyLighting(this.locs, this.program);
    gl.uniform3fv(this.locs.u_cameraPos, opts.cameraPos || [0, 8, 18]);
    gl.uniform1f(this.locs.u_emissive, 0);
    gl.uniform1f(this.locs.u_metallic, 0.6);
    gl.uniform1f(this.locs.u_roughness, 0.5);
    gl.uniform1f(this.locs.u_wireframe, opts.wireframe ? 1 : 0);
    gl.uniform1f(this.locs.u_debugMode, opts.debugMode || 0);

    gl.bindVertexArray(this.disc.vao);
    this._bindInstanceAttribs(this._baseBuf);
    gl.drawElementsInstanced(gl.TRIANGLES, this.disc.indexCount, gl.UNSIGNED_SHORT, 0, 1);
    gl.vertexAttribDivisor(2, 0);
    gl.vertexAttribDivisor(3, 0);
    gl.bindVertexArray(null);
  }

  /**
   * Lab bench, base platform, radial columns, and optional cage (WebGL2 fallback).
   */
  drawSegStructure(viewProj, devicePos, opts = {}) {
    const level = opts.frameLevel ?? parseSegFrameLevel();
    if (level === 'off') return;

    const layout = computeSEGLayout(SEG_LAYOUT_PRESETS.searl, 1.0);
    const dims = computeFrameDimensions(layout);
    const gl = this.gl;

    const drawBox = (pos, scale, color, metallic = 0.65, roughness = 0.45) => {
      const instanceData = new Float32Array(INSTANCE_STRIDE_FLOATS);
      this._packInstance(instanceData, 0, pos, color, 0);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, instanceData, gl.DYNAMIC_DRAW);
      gl.useProgram(this.program);
      gl.uniformMatrix4fv(this.locs.u_viewProj, false, viewProj);
      const model = new Float32Array(16);
      model[0] = scale[0]; model[5] = scale[1]; model[10] = scale[2]; model[15] = 1;
      gl.uniformMatrix4fv(this.locs.u_model, false, model);
      gl.uniform3fv(this.locs.u_devicePos, devicePos);
      this._applyLighting(this.locs, this.program);
      gl.uniform3fv(this.locs.u_cameraPos, opts.cameraPos || [0, 8, 18]);
      gl.uniform1f(this.locs.u_emissive, 0);
      gl.uniform1f(this.locs.u_metallic, metallic);
      gl.uniform1f(this.locs.u_roughness, roughness);
      gl.uniform1f(this.locs.u_wireframe, opts.wireframe ? 1 : 0);
      gl.uniform1f(this.locs.u_debugMode, opts.debugMode || 0);
      gl.bindVertexArray(this.disc.vao);
      this._bindInstanceAttribs(buf);
      gl.drawElementsInstanced(gl.TRIANGLES, this.disc.indexCount, gl.UNSIGNED_SHORT, 0, 1);
      gl.vertexAttribDivisor(2, 0);
      gl.vertexAttribDivisor(3, 0);
      gl.bindVertexArray(null);
      gl.deleteBuffer(buf);
    };

    const pad = dims.basePlateRadius * 1.15;
    drawBox(
      [0, dims.benchTopY - dims.benchThickness * 0.5, 0],
      [pad * 2, dims.benchThickness, pad * 1.35],
      [0.42, 0.40, 0.38], 0.08, 0.82
    );

    drawBox(
      [0, dims.baseCenterY, 0],
      [dims.basePlateRadius * 2, dims.baseHeight, dims.basePlateRadius * 2],
      [0.08, 0.08, 0.12], 0.72, 0.38
    );

    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * Math.PI * 2;
      const c = Math.cos(angle);
      const s = Math.sin(angle);
      const r = dims.outerR * 1.04;
      drawBox(
        [c * r * 0.78, (dims.baseTopY + dims.statorY) * 0.5, s * r * 0.78],
        [dims.statorH * 0.28, dims.statorY - dims.baseTopY + dims.statorH * 0.5, dims.statorH * 0.28],
        [0.74, 0.76, 0.80], 0.88, 0.28
      );
    }

    if (level === 'full') {
      drawBox(
        [dims.outerR * 1.12, dims.baseCenterY + dims.baseHeight * 0.35, dims.basePlateRadius * 0.35],
        [dims.statorH * 2.8, dims.statorH * 2.2, dims.statorH * 1.9],
        [0.62, 0.64, 0.68], 0.55, 0.42
      );
      for (let i = 0; i < 12; i++) {
        const angle = (i / 12) * Math.PI * 2;
        const c = Math.cos(angle);
        const s = Math.sin(angle);
        const cageR = dims.outerR * 1.14;
        drawBox(
          [c * cageR, (dims.baseTopY + dims.plateY) * 0.5, s * cageR],
          [dims.statorH * 0.09, dims.plateY - dims.baseTopY + dims.statorH, dims.statorH * 0.09],
          [0.50, 0.54, 0.60], 0.82, 0.35
        );
      }
    }
  }
}
