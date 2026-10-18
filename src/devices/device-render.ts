import { BindGroupCache } from '../renderers/shared/bind-group-cache';
import { runDrawWebgpu, runDrawWebgpuOverlay } from './device-registry.js';
import { getMeshDrawDetail, meshLodInstanceCount } from '../renderers/shared/view-lod.js';
import type { BindGroupLayoutName, DeviceInstanceLike, MeshBuffers } from './types';

/**
 * Per-part device uniforms for the `segEnhanced` pipeline.
 *
 * `queue.writeBuffer` lands on the queue timeline before the frame's single
 * submit, so SEG parts that each wrote their `renderMode` into offset 0 of the
 * one 48 B `deviceUniformBuffer` were all shaded with the *last* write (the
 * rollers' 0): no bench material, no aluminum stator. Each distinct part
 * uniform now has its own 256 B slot (the largest legal
 * minUniformBufferOffsetAlignment) in one buffer, picked per draw with the
 * dynamic offset on `segEnhanced` @binding(1). The general per-draw uniform
 * ring is #223.
 */
export const SEG_PART_SLOT = {
  /** renderMode 0 — rollers, frame, core, glTF CAD */
  rollers: 0,
  /** renderMode 1 — lab bench, base plate */
  bench: 1,
  /** renderMode 2 — aluminum stator rings */
  stator: 2,
  /** renderMode 3 — wiring */
  wiring: 3,
  ringTop: 4,
  ringBottom: 5
} as const;
export type SegPartSlot = (typeof SEG_PART_SLOT)[keyof typeof SEG_PART_SLOT];

/** [renderMode, yOffset] per slot, indexed by SEG_PART_SLOT. */
const SEG_PART_UNIFORMS: ReadonlyArray<readonly [number, number]> = [
  [0, 0], [1, 0], [2, 0], [3, 0], [0, 2.0], [0, -2.0]
];
const SEG_PART_SLOT_BYTES = 256;
const SEG_PART_SLOT_FLOATS = SEG_PART_SLOT_BYTES / 4;
/** sizeof(DeviceUniforms) — src/shaders/common/device-uniforms.wgsl */
const DEVICE_UNIFORM_BYTES = 48;

/** Scene-level buffers are created before any device draws; fail loudly if one is missing. */
function requireBuffer(buffer: GPUBuffer | null | undefined, name: string): GPUBuffer {
  if (!buffer) throw new Error(`[DeviceRender] visualizer.${name} missing`);
  return buffer;
}

export const DeviceRenderMixin = {
  _ensureBgCache: function (this: DeviceInstanceLike): BindGroupCache {
    if (!this._bindGroupCache) this._bindGroupCache = new BindGroupCache();
    return this._bindGroupCache;
  },

  _cacheBg: function (
    this: DeviceInstanceLike,
    key: string,
    layoutName: BindGroupLayoutName,
    entries: GPUBindGroupEntry[],
    label?: string
  ): GPUBindGroup {
    const cache = this.visualizer.pipelineCache;
    if (!cache) {
      throw new Error(`[DeviceRender] pipelineCache missing for layout "${layoutName}"`);
    }
    return this._ensureBgCache().get(key, () =>
      cache.createBindGroup(layoutName, entries, label || key)
    );
  },

  _ensureSegPartUniformBuffer: function (this: DeviceInstanceLike): GPUBuffer {
    if (!this._segPartUniformBuffer) {
      this._segPartUniformBuffer = this.device.createBuffer({
        label: `${this.id}-seg-part-uniforms`,
        size: SEG_PART_UNIFORMS.length * SEG_PART_SLOT_BYTES,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
      });
      this._segPartMirror = new Float32Array(SEG_PART_UNIFORMS.length * SEG_PART_SLOT_FLOATS);
    }
    return this._segPartUniformBuffer;
  },

  /** Fill every part slot for this frame (one write; contents are frame-constant). */
  _writeSegPartUniforms: function (this: DeviceInstanceLike): void {
    const buffer = this._ensureSegPartUniformBuffer();
    const mirror = this._segPartMirror!;
    SEG_PART_UNIFORMS.forEach(([renderMode, yOffset], slot) => {
      mirror.set(this._buildDeviceUniformData(renderMode, yOffset), slot * SEG_PART_SLOT_FLOATS);
    });
    this.device.queue.writeBuffer(buffer, 0, mirror);
  },

  /** Dynamic offset for `slot`; `part` names the draw for getRendererInfo().segPartModes. */
  _segPartOffset: function (this: DeviceInstanceLike, slot: SegPartSlot, part: string): number {
    (this._segPartSlots ??= {})[part] = slot;
    return slot * SEG_PART_SLOT_BYTES;
  },

  /** renderMode each named part was drawn with, read from the slot it bound. */
  segPartModes: function (this: DeviceInstanceLike): Record<string, number> {
    const mirror = this._segPartMirror;
    if (!mirror || !this._segPartSlots) return {};
    return Object.fromEntries(
      Object.entries(this._segPartSlots).map(([part, slot]) => [part, mirror[slot * SEG_PART_SLOT_FLOATS]])
    );
  },

  _enhancedBindGroup: function (
    this: DeviceInstanceLike,
    globalUniformBuffer: GPUBuffer,
    instanceBuffer: GPUBuffer,
    keySuffix = 'default'
  ): GPUBindGroup {
    const v = this.visualizer;
    const key = `enh:${this.id}:${keySuffix}`;
    const segLayout = requireBuffer(v.segLayoutUniformBuffer, 'segLayoutUniformBuffer');
    const lighting = requireBuffer(v.lightingUniformBuffer, 'lightingUniformBuffer');
    const materialTable = requireBuffer(v.materialTableBuffer, 'materialTableBuffer');
    const ibl = v.iblResources;
    if (!ibl) throw new Error('[DeviceRender] visualizer.iblResources missing');
    const partUniforms = this._ensureSegPartUniformBuffer();
    return this._cacheBg(key, 'segEnhanced', [
      { binding: 0, resource: { buffer: globalUniformBuffer } },
      { binding: 1, resource: { buffer: partUniforms, size: DEVICE_UNIFORM_BYTES } },
      { binding: 2, resource: { buffer: instanceBuffer } },
      { binding: 3, resource: { buffer: this.materialUniformBuffer } },
      { binding: 4, resource: { buffer: segLayout } },
      { binding: 5, resource: { buffer: lighting } },
      { binding: 6, resource: { buffer: materialTable } },
      { binding: 7, resource: ibl.view },
      { binding: 8, resource: ibl.sampler }
    ], `seg-enhanced-${this.id}-${keySuffix}`);
  },

  _rollerBindGroup: function (
    this: DeviceInstanceLike,
    globalUniformBuffer: GPUBuffer,
    instanceBuffer: GPUBuffer,
    keySuffix = 'default'
  ): GPUBindGroup {
    return this._cacheBg(`roller:${this.id}:${keySuffix}`, 'roller', [
      { binding: 0, resource: { buffer: globalUniformBuffer } },
      { binding: 1, resource: { buffer: this.deviceUniformBuffer } },
      { binding: 2, resource: { buffer: instanceBuffer } },
      { binding: 3, resource: { buffer: this.materialUniformBuffer } },
      {
        binding: 5,
        resource: { buffer: requireBuffer(this.visualizer.materialTableBuffer, 'materialTableBuffer') }
      }
    ], `roller-${this.id}-${keySuffix}`);
  },

  renderDeviceMesh: function (
    this: DeviceInstanceLike,
    renderPass: GPURenderPassEncoder,
    globalUniformBuffer: GPUBuffer
  ): void {
    const v = this.visualizer;
    if (!v.cylinderBuffer || !this.rollerPipeline || !this.rollerInstances) return;

    const detail =
      this._meshDrawDetail ||
      (v as { _overviewMeshDetail?: string })._overviewMeshDetail ||
      getMeshDrawDetail(1);
    if (detail === 'skip') {
      v.profiler?.recordDraw?.(0);
      return;
    }

    this.renderMode = 0;
    const deviceData = this._buildDeviceUniformData(this.renderMode);
    this.device.queue.writeBuffer(this.deviceUniformBuffer, 0, deviceData);

    const cyl = v.cylinderBuffer;
    // Prefer hot LOD count on the instance; fall back to geometry full count.
    const fullCount =
      this.meshCylinderCount ||
      this.geometry.meshCylinderCount ||
      0;
    const count = meshLodInstanceCount(fullCount, detail);
    let draws = 0;
    if (count > 0) {
      renderPass.setPipeline(this.rollerPipeline);
      renderPass.setBindGroup(0, this._rollerBindGroup(globalUniformBuffer, this.rollerInstances, 'mesh'));
      renderPass.setVertexBuffer(0, cyl.vertexBuffer);
      renderPass.setIndexBuffer(cyl.indexBuffer, 'uint16');
      renderPass.drawIndexed(cyl.indexCount, count);
      draws += 1;
    }

    if (detail !== 'proxy' && this.id === 'kelvin' && this.geometry.ringInstances && v.kelvinRingBuffer) {
      const ring = v.kelvinRingBuffer;
      const ringCount = meshLodInstanceCount(this.geometry.meshRingCount || 0, detail);
      if (ringCount > 0) {
        renderPass.setBindGroup(0, this._rollerBindGroup(globalUniformBuffer, this.geometry.ringInstances, 'ring'));
        renderPass.setVertexBuffer(0, ring.vertexBuffer);
        renderPass.setIndexBuffer(ring.indexBuffer, 'uint16');
        renderPass.drawIndexed(ring.indexCount, ringCount);
        draws += 1;
      }
    }

    if (detail !== 'proxy' && this.geometry.tubeInstances && v.deviceTubeBuffer) {
      const tube = v.deviceTubeBuffer;
      const tubeCount = meshLodInstanceCount(this.geometry.meshTubeCount || 0, detail);
      if (tubeCount > 0) {
        renderPass.setBindGroup(0, this._rollerBindGroup(globalUniformBuffer, this.geometry.tubeInstances, 'tube'));
        renderPass.setVertexBuffer(0, tube.vertexBuffer);
        renderPass.setIndexBuffer(tube.indexBuffer, 'uint16');
        renderPass.drawIndexed(tube.indexCount, tubeCount);
        draws += 1;
      }
    }

    if (detail !== 'proxy' && this.id === 'solar' && this.geometry.panelInstances && v.solarPanelBuffer) {
      const panel = v.solarPanelBuffer;
      const panelCount = meshLodInstanceCount(this.geometry.meshPanelCount || 0, detail);
      if (panelCount > 0) {
        renderPass.setBindGroup(0, this._rollerBindGroup(globalUniformBuffer, this.geometry.panelInstances, 'panel'));
        renderPass.setVertexBuffer(0, panel.vertexBuffer);
        renderPass.setIndexBuffer(panel.indexBuffer, 'uint16');
        renderPass.drawIndexed(panel.indexCount, panelCount);
        draws += 1;
      }
    }

    v.profiler?.recordDraw?.(draws);
  },

  render: function (
    this: DeviceInstanceLike,
    renderPass: GPURenderPassEncoder,
    globalUniformBuffer: GPUBuffer,
    skipEffects = false
  ): void {
    const scaledCount = Math.max(
      0,
      Math.floor(
        this.scaledParticleCount
          ?? (this.particleCount * (this.visualizer.profiler?.qualityLevel ?? 1)
            * (this.visualizer.isOverviewMode?.() ? 0.48 : 1))
      )
    );

    runDrawWebgpu(this, renderPass, globalUniformBuffer, skipEffects);

    if (this.id !== 'seg') {
      // CAD props first, so the procedural mesh draws over them where they
      // overlap — the GLB is the backdrop, not a replacement.
      this.renderGltfDeviceProps(renderPass, globalUniformBuffer);
      if (this.rollerInstances && this.rollerPipeline) {
        this.renderDeviceMesh(renderPass, globalUniformBuffer);
      }
    }

    runDrawWebgpuOverlay(this, renderPass, globalUniformBuffer, skipEffects);

    if (this.geometry.flowPathParticles && this.fieldLinePipeline && !skipEffects) {
      const flowBindGroup = this._cacheBg(`flow:${this.id}`, 'fieldParticles', [
        { binding: 0, resource: { buffer: globalUniformBuffer } },
        { binding: 1, resource: { buffer: this.deviceUniformBuffer } },
        { binding: 4, resource: { buffer: this.geometry.flowPathParticles } }
      ], 'flow-path-bg');
      renderPass.setPipeline(this.fieldLinePipeline);
      renderPass.setBindGroup(0, flowBindGroup);
      renderPass.draw(4, this.geometry.flowPathCount);
    }

    const particleBindGroup = this._cacheBg(`part:${this.id}`, 'particle', [
      { binding: 0, resource: { buffer: globalUniformBuffer } },
      { binding: 1, resource: { buffer: this.deviceUniformBuffer } },
      { binding: 3, resource: { buffer: this.materialUniformBuffer } },
      { binding: 4, resource: { buffer: this.particles } }
    ], 'particle-bg');

    renderPass.setPipeline(this.particlePipeline);
    renderPass.setBindGroup(0, particleBindGroup);

    // Overview: instance count comes from the GPU cull pass (ADR-0005 WS4) —
    // culled devices resolve to instanceCount 0 without a CPU round trip.
    const cull = this.visualizer.overviewCull;
    const argsOffset = cull?.active ? cull.drawArgsOffset(this.id) : -1;
    if (cull?.drawArgsBuffer && argsOffset >= 0) {
      renderPass.drawIndirect(cull.drawArgsBuffer, argsOffset);
    } else {
      renderPass.draw(4, scaledCount);
    }
    this.visualizer.profiler?.recordDraw?.(1);

    if (this.effectParticleCount > 0 && this.effectsParticles && !skipEffects) {
      const effectsBindGroup = this._cacheBg(`fx:${this.id}`, 'particle', [
        { binding: 0, resource: { buffer: globalUniformBuffer } },
        { binding: 1, resource: { buffer: this.deviceUniformBuffer } },
        { binding: 3, resource: { buffer: this.materialUniformBuffer } },
        { binding: 4, resource: { buffer: this.effectsParticles } }
      ], 'effects-particle-bg');
      renderPass.setPipeline(this.particlePipeline);
      renderPass.setBindGroup(0, effectsBindGroup);
      renderPass.draw(4, this.effectParticleCount);
    }
  },

  renderBase: function (
    this: DeviceInstanceLike,
    renderPass: GPURenderPassEncoder,
    globalUniformBuffer: GPUBuffer
  ): void {
    const v = this.visualizer;
    if (!v.basePlateBuffer || !v.baseInstanceBuffer) return;

    if (this.segEnhancedPipeline && v.lightingUniformBuffer) {
      const bindGroup = this._enhancedBindGroup(globalUniformBuffer, v.baseInstanceBuffer, 'base');
      renderPass.setPipeline(this.segEnhancedPipeline);
      renderPass.setBindGroup(0, bindGroup, [this._segPartOffset(SEG_PART_SLOT.bench, 'base')]);
      renderPass.setVertexBuffer(0, v.basePlateBuffer.vertexBuffer);
      renderPass.setIndexBuffer(v.basePlateBuffer.indexBuffer, 'uint16');
      renderPass.drawIndexed(v.basePlateBuffer.indexCount, 1);
    }
  },

  renderGltfHousing: function (
    this: DeviceInstanceLike,
    renderPass: GPURenderPassEncoder,
    globalUniformBuffer: GPUBuffer
  ): void {
    if (this.id !== 'seg') return;
    if (this.visualizer.currentView && this.visualizer.currentView !== 'seg') return;
    this._drawGltfPropsForDevice(renderPass, globalUniformBuffer, 'seg');
  },

  /**
   * Draw this device's own glTF CAD props (ADR-0005 WS1).
   *
   * Called from the shared `render()` for every non-SEG bench; SEG keeps
   * `renderGltfHousing` because its draw order is explicit in `seg-render.ts`.
   * Props are baked in device-local metres, so the device uniform's position and
   * rotation place them exactly as it places the procedural cylinders.
   */
  renderGltfDeviceProps: function (
    this: DeviceInstanceLike,
    renderPass: GPURenderPassEncoder,
    globalUniformBuffer: GPUBuffer
  ): void {
    if (this.id === 'seg') return;
    // Focus-only: overview never pays for a bench's CAD.
    if (this.visualizer.currentView !== this.id) return;
    this._drawGltfPropsForDevice(renderPass, globalUniformBuffer, this.id);
  },

  /** @private Shared body of the two prop draw entry points. */
  _drawGltfPropsForDevice: function (
    this: DeviceInstanceLike,
    renderPass: GPURenderPassEncoder,
    globalUniformBuffer: GPUBuffer,
    deviceId: string
  ): void {
    const v = this.visualizer;
    if (!v.gltfHousingEnabled || !v.gltfHousingDrawables?.length) return;
    if (!this.segEnhancedPipeline || !v.lightingUniformBuffer) return;

    // Drawables from other benches may still be resident (SEG's housing is).
    const mine = v.gltfHousingDrawables.filter(
      (d) => (d.deviceId ?? 'seg') === deviceId
    );
    if (mine.length === 0) return;

    // Non-SEG benches reach segEnhanced only here (SEG wrote its slots already).
    if (deviceId !== 'seg') this._writeSegPartUniforms();
    const offset = this._segPartOffset(SEG_PART_SLOT.rollers, 'gltf');

    for (const drawable of mine) {
      const bindGroup = this._enhancedBindGroup(
        globalUniformBuffer,
        drawable.instanceBuffer,
        `gltf:${drawable.name}`
      );
      renderPass.setPipeline(this.segEnhancedPipeline);
      renderPass.setBindGroup(0, bindGroup, [offset]);
      renderPass.setVertexBuffer(0, drawable.gpu.vertexBuffer);
      renderPass.setIndexBuffer(drawable.gpu.indexBuffer, 'uint16');
      renderPass.drawIndexed(drawable.gpu.indexCount, 1);
    }
    v.profiler?.recordDraw?.(mine.length);
  },

  renderFrame: function (
    this: DeviceInstanceLike,
    renderPass: GPURenderPassEncoder,
    globalUniformBuffer: GPUBuffer
  ): void {
    const v = this.visualizer;
    if (v.segFrameLevel === 'off' || !this.segEnhancedPipeline || !v.segFrameBuffers) return;
    const pipeline = this.segEnhancedPipeline;

    const drawPart = (
      geom: MeshBuffers | null | undefined,
      instanceBuffer: GPUBuffer | null | undefined,
      slot: SegPartSlot = SEG_PART_SLOT.rollers,
      keySuffix = 'frame'
    ) => {
      if (!geom || !instanceBuffer) return;
      const bindGroup = this._enhancedBindGroup(globalUniformBuffer, instanceBuffer, keySuffix);
      renderPass.setPipeline(pipeline);
      renderPass.setBindGroup(0, bindGroup, [this._segPartOffset(slot, keySuffix)]);
      renderPass.setVertexBuffer(0, geom.vertexBuffer);
      renderPass.setIndexBuffer(geom.indexBuffer, 'uint16');
      renderPass.drawIndexed(geom.indexCount, 1);
    };

    const fb = v.segFrameBuffers;
    const inst = v.frameStructuralInstanceBuffer;
    const benchInst = v.frameLabBenchInstanceBuffer || inst;
    const skipLabBench = v.gltfHousingEnabled && v.gltfHousingDrawables?.length;

    if (!skipLabBench) {
      drawPart(fb.labBench, benchInst, SEG_PART_SLOT.bench, 'labBench');
    }
    this.renderStand(renderPass, globalUniformBuffer);
    drawPart(fb.structural, inst, SEG_PART_SLOT.rollers, 'structural');
    if (v.segFrameLevel === 'full') {
      drawPart(fb.controlBox, v.frameControlInstanceBuffer, SEG_PART_SLOT.rollers, 'controlBox');
      drawPart(fb.safetyCage, v.frameCageInstanceBuffer, SEG_PART_SLOT.rollers, 'safetyCage');
    }
  },

  renderStatorRings: function (
    this: DeviceInstanceLike,
    renderPass: GPURenderPassEncoder,
    globalUniformBuffer: GPUBuffer
  ): void {
    if (!this.geometry.statorRingBuffer) return;
    const v = this.visualizer;

    if (this.segEnhancedPipeline && v.statorRingUVBuffer && v.lightingUniformBuffer) {
      const bindGroup = this._enhancedBindGroup(globalUniformBuffer, this.geometry.statorRingBuffer, 'stator');
      renderPass.setPipeline(this.segEnhancedPipeline);
      renderPass.setBindGroup(0, bindGroup, [this._segPartOffset(SEG_PART_SLOT.stator, 'stator')]);
      renderPass.setVertexBuffer(0, v.statorRingUVBuffer.vertexBuffer);
      renderPass.setIndexBuffer(v.statorRingUVBuffer.indexBuffer, 'uint16');
      renderPass.drawIndexed(v.statorRingUVBuffer.indexCount, 3);
    } else if (this.rollerPipeline && v.cylinderBuffer) {
      // Fallback `roller` layout has no per-part slot: shares deviceUniformBuffer.
      this.renderMode = 2;
      this.device.queue.writeBuffer(this.deviceUniformBuffer, 0, this._buildDeviceUniformData(this.renderMode));
      const bindGroup = this._rollerBindGroup(globalUniformBuffer, this.geometry.statorRingBuffer, 'stator-fb');
      renderPass.setPipeline(this.rollerPipeline);
      renderPass.setBindGroup(0, bindGroup);
      renderPass.setVertexBuffer(0, v.cylinderBuffer.vertexBuffer);
      renderPass.setIndexBuffer(v.cylinderBuffer.indexBuffer, 'uint16');
      renderPass.drawIndexed(v.cylinderBuffer.indexCount, 3);
    }
  },

  renderWiring: function (
    this: DeviceInstanceLike,
    renderPass: GPURenderPassEncoder,
    globalUniformBuffer: GPUBuffer
  ): void {
    if (!this.geometry.wiringBuffer) return;
    const v = this.visualizer;

    if (this.segEnhancedPipeline && v.wiringUVBuffer && v.lightingUniformBuffer) {
      const bindGroup = this._enhancedBindGroup(globalUniformBuffer, this.geometry.wiringBuffer, 'wiring');
      renderPass.setPipeline(this.segEnhancedPipeline);
      renderPass.setBindGroup(0, bindGroup, [this._segPartOffset(SEG_PART_SLOT.wiring, 'wiring')]);
      renderPass.setVertexBuffer(0, v.wiringUVBuffer.vertexBuffer);
      renderPass.setIndexBuffer(v.wiringUVBuffer.indexBuffer, 'uint16');
      renderPass.drawIndexed(v.wiringUVBuffer.indexCount, 8);
    } else if (this.rollerPipeline && v.cylinderBuffer) {
      this.renderMode = 3;
      this.device.queue.writeBuffer(this.deviceUniformBuffer, 0, this._buildDeviceUniformData(this.renderMode));
      const bindGroup = this._rollerBindGroup(globalUniformBuffer, this.geometry.wiringBuffer, 'wiring-fb');
      renderPass.setPipeline(this.rollerPipeline);
      renderPass.setBindGroup(0, bindGroup);
      renderPass.setVertexBuffer(0, v.cylinderBuffer.vertexBuffer);
      renderPass.setIndexBuffer(v.cylinderBuffer.indexBuffer, 'uint16');
      renderPass.drawIndexed(v.cylinderBuffer.indexCount, 8);
    }
  },

  renderCore: function (
    this: DeviceInstanceLike,
    renderPass: GPURenderPassEncoder,
    globalUniformBuffer: GPUBuffer
  ): void {
    if (!this.segEnhancedPipeline || !this.config.core) return;
    const pipeline = this.segEnhancedPipeline;
    const v = this.visualizer;
    if (!v.coreShaftBuffer) return;

    const drawComponent = (
      geomBuffer: MeshBuffers,
      instanceBuffer: GPUBuffer,
      keySuffix: string,
      instanceCount = 1
    ) => {
      const bindGroup = this._enhancedBindGroup(globalUniformBuffer, instanceBuffer, keySuffix);
      renderPass.setPipeline(pipeline);
      renderPass.setBindGroup(0, bindGroup, [this._segPartOffset(SEG_PART_SLOT.rollers, keySuffix)]);
      renderPass.setVertexBuffer(0, geomBuffer.vertexBuffer);
      renderPass.setIndexBuffer(geomBuffer.indexBuffer, 'uint16');
      renderPass.drawIndexed(geomBuffer.indexCount, instanceCount);
    };

    if (v.coreShaftBuffer && this.shaftInstanceBuffer) {
      drawComponent(v.coreShaftBuffer, this.shaftInstanceBuffer, 'shaft', 1);
    }
    if (v.coreMagnetBuffer && this.magnetInstanceBuffer) {
      drawComponent(v.coreMagnetBuffer, this.magnetInstanceBuffer, 'magnet', 1);
    }
    if (v.corePlateBuffer && this.topPlateInstanceBuffer) {
      drawComponent(v.corePlateBuffer, this.topPlateInstanceBuffer, 'topPlate', 1);
    }
    if (v.corePlateBuffer && this.bottomPlateInstanceBuffer) {
      drawComponent(v.corePlateBuffer, this.bottomPlateInstanceBuffer, 'bottomPlate', 1);
    }
    if (v.coreBoltBuffer && v.coreBoltInstanceBuffer && v.coreBoltPositions) {
      drawComponent(v.coreBoltBuffer, v.coreBoltInstanceBuffer, 'bolts', v.coreBoltPositions.length / 3);
    }
  },

  renderPickupCoils: function (
    this: DeviceInstanceLike,
    renderPass: GPURenderPassEncoder,
    globalUniformBuffer: GPUBuffer
  ): void {
    if (!this.coilInstances || !this.coilPipeline || !this.ringPipeline) return;
    if (!this.visualizer.connectionRingBuffer || !this.visualizer.coilBuffer) return;
    if (!this.coilMaterialBuffer || !this.ringMaterialBuffer) return;

    this.renderMode = 0;
    const numCoils = 24;

    // Top / bottom rings: same bind group, ±2 y offsets live in their own slots.
    const ringBindGroup = this._cacheBg(`ring:${this.id}`, 'segEnhanced', [
      { binding: 0, resource: { buffer: globalUniformBuffer } },
      { binding: 1, resource: { buffer: this._ensureSegPartUniformBuffer(), size: DEVICE_UNIFORM_BYTES } },
      { binding: 3, resource: { buffer: this.ringMaterialBuffer } }
    ], 'connection-ring-bg');

    renderPass.setPipeline(this.ringPipeline);
    renderPass.setBindGroup(0, ringBindGroup, [this._segPartOffset(SEG_PART_SLOT.ringTop, 'ringTop')]);
    renderPass.setVertexBuffer(0, this.visualizer.connectionRingBuffer.vertexBuffer);
    renderPass.setIndexBuffer(this.visualizer.connectionRingBuffer.indexBuffer, 'uint16');
    renderPass.drawIndexed(this.visualizer.connectionRingBuffer.indexCount);

    renderPass.setBindGroup(0, ringBindGroup, [this._segPartOffset(SEG_PART_SLOT.ringBottom, 'ringBottom')]);
    renderPass.drawIndexed(this.visualizer.connectionRingBuffer.indexCount);

    const coilBindGroup = this._cacheBg(`coil-pickup:${this.id}`, 'coil', [
      { binding: 0, resource: { buffer: globalUniformBuffer } },
      { binding: 1, resource: { buffer: this.deviceUniformBuffer } },
      { binding: 2, resource: { buffer: this.coilInstances } },
      { binding: 3, resource: { buffer: this.coilMaterialBuffer } }
    ], 'pickup-coil-bg');

    renderPass.setPipeline(this.coilPipeline);
    renderPass.setBindGroup(0, coilBindGroup);
    renderPass.setVertexBuffer(0, this.visualizer.coilBuffer.vertexBuffer);
    renderPass.draw(this.visualizer.coilBuffer.vertexCount, numCoils);
  },

  renderStand: function (
    this: DeviceInstanceLike,
    renderPass: GPURenderPassEncoder,
    globalUniformBuffer: GPUBuffer
  ): void {
    if (!this.segEnhancedPipeline || !this.visualizer.standBuffer) return;
    const v = this.visualizer;
    const inst = v.frameStructuralInstanceBuffer || this.shaftInstanceBuffer;
    const standBuffer = v.standBuffer;
    if (!inst || !standBuffer) return;

    const bindGroup = this._enhancedBindGroup(globalUniformBuffer, inst, 'stand');
    renderPass.setPipeline(this.segEnhancedPipeline);
    renderPass.setBindGroup(0, bindGroup, [this._segPartOffset(SEG_PART_SLOT.rollers, 'stand')]);
    renderPass.setVertexBuffer(0, standBuffer.vertexBuffer);
    renderPass.setIndexBuffer(standBuffer.indexBuffer, 'uint16');
    renderPass.drawIndexed(standBuffer.indexCount, 1);
  },

  renderWires: function (
    this: DeviceInstanceLike,
    renderPass: GPURenderPassEncoder,
    globalUniformBuffer: GPUBuffer
  ): void {
    const wireBuffers = this.visualizer.wireBuffers;
    const shaftInstances = this.shaftInstanceBuffer;
    if (!this.segEnhancedPipeline || !wireBuffers || !shaftInstances) return;

    // Mode 0, as before: these never wrote a mode of their own (they inherited
    // the rollers' write), and the wiring branch assumes the instanced cylinders.
    const bindGroup = this._enhancedBindGroup(globalUniformBuffer, shaftInstances, 'wires');
    renderPass.setPipeline(this.segEnhancedPipeline);
    renderPass.setBindGroup(0, bindGroup, [this._segPartOffset(SEG_PART_SLOT.rollers, 'wires')]);
    for (let i = 0; i < wireBuffers.length; i++) {
      const wire = wireBuffers[i];
      renderPass.setVertexBuffer(0, wire.vertexBuffer);
      renderPass.setIndexBuffer(wire.indexBuffer, 'uint16');
      renderPass.drawIndexed(wire.indexCount, 1);
    }
  }
};
