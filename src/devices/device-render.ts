import { BindGroupCache } from '../renderers/shared/bind-group-cache';
import { runDrawWebgpu, runDrawWebgpuOverlay } from './device-registry.js';
import {
  cullSegRollerInstances,
  getMeshDrawDetail,
  isCameraInsideSegRing,
  meshLodInstanceCount
} from '../renderers/shared/view-lod.js';
import { UniformRing } from '../visualizer/uniform-ring';
import type { BindGroupLayoutName, DeviceInstanceLike, MeshBuffers, RenderEncoder } from './types';

/**
 * Per-draw device uniforms (#225 §3, generalising the #221 SEG fix).
 *
 * Every scene layout's `@group(1) @binding(1)` is `DeviceUniforms` with a
 * dynamic offset into the visualizer's {@link UniformRing}. Each device owns
 * one stable 256 B slot per *part* below — the part fixes `renderMode` and a
 * y offset; the rest is the device's live pose / energy. Slots are refreshed
 * once per frame (`_refreshDeviceUniforms`, render-loop.ts) and uploaded with
 * the ring's single `writeBuffer`, so a later part can no longer clobber an
 * earlier one, whichever pipeline draws it.
 *
 * The frame data (camera, lighting, material table, IBL, shadow map) is the
 * scene pass's `@group(0)`, bound once per pass — draws here only set group 1.
 */
export const DEVICE_PART = {
  /** renderMode 0 — rollers, frame, core, glTF CAD, particles, coils, lines */
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
export type DevicePart = (typeof DEVICE_PART)[keyof typeof DEVICE_PART];

/** [renderMode, yOffset] per part, indexed by DEVICE_PART. */
const DEVICE_PART_UNIFORMS: ReadonlyArray<readonly [number, number]> = [
  [0, 0], [1, 0], [2, 0], [3, 0], [0, 2.0], [0, -2.0]
];
export const DEVICE_PART_COUNT = DEVICE_PART_UNIFORMS.length;
/** sizeof(DeviceUniforms) — src/shaders/common/device-uniforms.wgsl */
export const DEVICE_UNIFORM_BYTES = 48;

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

  _uniformRing: function (this: DeviceInstanceLike): UniformRing {
    const ring = this.visualizer.uniformRing;
    if (!ring) throw new Error('[DeviceRender] visualizer.uniformRing missing');
    return ring;
  },

  /** `@group(1) @binding(1)` resource: the ring, one DeviceUniforms wide (offset per draw). */
  _deviceUniformResource: function (this: DeviceInstanceLike): GPUBufferBinding {
    return { buffer: this._uniformRing().buffer, size: DEVICE_UNIFORM_BYTES };
  },

  /**
   * Dynamic offset of this device's `part` slot. The first call allocates and
   * fills it; afterwards `_refreshDeviceUniforms` keeps it current, so a
   * render bundle may record the offset once. `label` names the draw for
   * getRendererInfo().segPartModes.
   */
  _deviceUniformOffset: function (this: DeviceInstanceLike, part: DevicePart, label?: string): number {
    const ring = this._uniformRing();
    let offset = ring.offsetOf(this, part);
    if (offset < 0) {
      offset = ring.slot(this, part, DEVICE_PART_COUNT);
      const [renderMode, yOffset] = DEVICE_PART_UNIFORMS[part];
      this._packDeviceUniforms(ring.f32, UniformRing.base(offset), renderMode, yOffset);
    }
    if (label !== undefined) (this._partLabels ??= {})[label] = part;
    return offset;
  },

  /** Rewrite every slot this device owns from its current state (once per frame, before encode). */
  _refreshDeviceUniforms: function (this: DeviceInstanceLike): void {
    const ring = this.visualizer.uniformRing;
    const parts = ring?.partsOf(this);
    if (!ring || !parts) return;
    for (let part = 0; part < parts.length; part++) {
      if (parts[part] < 0) continue;
      const [renderMode, yOffset] = DEVICE_PART_UNIFORMS[part];
      this._packDeviceUniforms(ring.f32, UniformRing.base(ring.offsetOf(this, part)), renderMode, yOffset);
    }
  },

  /** renderMode each named part was drawn with, read back from the slot it bound. */
  segPartModes: function (this: DeviceInstanceLike): Record<string, number> {
    const ring = this.visualizer.uniformRing;
    if (!ring || !this._partLabels) return {};
    const out: Record<string, number> = {};
    for (const [label, part] of Object.entries(this._partLabels)) {
      const offset = ring.offsetOf(this, part);
      if (offset >= 0) out[label] = ring.f32[UniformRing.base(offset)];
    }
    return out;
  },

  _enhancedBindGroup: function (
    this: DeviceInstanceLike,
    instanceBuffer: GPUBuffer,
    keySuffix = 'default'
  ): GPUBindGroup {
    return this._cacheBg(`enh:${this.id}:${keySuffix}`, 'segEnhanced', [
      { binding: 1, resource: this._deviceUniformResource() },
      { binding: 2, resource: { buffer: instanceBuffer } },
      { binding: 3, resource: { buffer: this.materialUniformBuffer } }
    ], `seg-enhanced-${this.id}-${keySuffix}`);
  },

  _rollerBindGroup: function (
    this: DeviceInstanceLike,
    instanceBuffer: GPUBuffer,
    keySuffix = 'default'
  ): GPUBindGroup {
    return this._cacheBg(`roller:${this.id}:${keySuffix}`, 'roller', [
      { binding: 1, resource: this._deviceUniformResource() },
      { binding: 2, resource: { buffer: instanceBuffer } },
      { binding: 3, resource: { buffer: this.materialUniformBuffer } }
    ], `roller-${this.id}-${keySuffix}`);
  },

  renderDeviceMesh: function (this: DeviceInstanceLike, renderPass: RenderEncoder): void {
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
    const offset = [this._deviceUniformOffset(DEVICE_PART.rollers, 'mesh')];

    const cyl = v.cylinderBuffer;
    // Prefer hot LOD count on the instance; fall back to geometry full count.
    const fullCount =
      this.meshCylinderCount ||
      this.geometry.meshCylinderCount ||
      0;
    const count = meshLodInstanceCount(fullCount, detail);
    let draws = 0;
    renderPass.setPipeline(this.rollerPipeline);
    if (count > 0) {
      renderPass.setBindGroup(1, this._rollerBindGroup(this.rollerInstances, 'mesh'), offset);
      renderPass.setVertexBuffer(0, cyl.vertexBuffer);
      renderPass.setIndexBuffer(cyl.indexBuffer, 'uint16');
      renderPass.drawIndexed(cyl.indexCount, count);
      draws += 1;
    }

    if (detail !== 'proxy' && this.id === 'kelvin' && this.geometry.ringInstances && v.kelvinRingBuffer) {
      const ring = v.kelvinRingBuffer;
      const ringCount = meshLodInstanceCount(this.geometry.meshRingCount || 0, detail);
      if (ringCount > 0) {
        renderPass.setBindGroup(1, this._rollerBindGroup(this.geometry.ringInstances, 'ring'), offset);
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
        renderPass.setBindGroup(1, this._rollerBindGroup(this.geometry.tubeInstances, 'tube'), offset);
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
        renderPass.setBindGroup(1, this._rollerBindGroup(this.geometry.panelInstances, 'panel'), offset);
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

    runDrawWebgpu(this, renderPass, skipEffects);

    if (this.id !== 'seg') {
      // CAD props first, so the procedural mesh draws over them where they
      // overlap — the GLB is the backdrop, not a replacement. Focus-only, and
      // static: replayed from a render bundle when the pass shape is known.
      const v = this.visualizer;
      const ownsProps = v.currentView === this.id && v.gltfHousingEnabled
        && !!v.gltfHousingDrawables?.some((d) => d.deviceId === this.id);
      if (ownsProps && !v.staticBundles?.drawDeviceStatic(renderPass, this)) {
        this.renderGltfDeviceProps(renderPass);
      }
      if (this.rollerInstances && this.rollerPipeline) {
        this.renderDeviceMesh(renderPass);
      }
    }

    runDrawWebgpuOverlay(this, renderPass, skipEffects);

    const offset = [this._deviceUniformOffset(DEVICE_PART.rollers)];

    if (this.geometry.flowPathParticles && this.fieldLinePipeline && !skipEffects) {
      const flowBindGroup = this._cacheBg(`flow:${this.id}`, 'fieldParticles', [
        { binding: 1, resource: this._deviceUniformResource() },
        { binding: 4, resource: { buffer: this.geometry.flowPathParticles } }
      ], 'flow-path-bg');
      renderPass.setPipeline(this.fieldLinePipeline);
      renderPass.setBindGroup(1, flowBindGroup, offset);
      renderPass.draw(4, this.geometry.flowPathCount);
    }

    const particleBindGroup = this._cacheBg(`part:${this.id}`, 'particle', [
      { binding: 1, resource: this._deviceUniformResource() },
      { binding: 3, resource: { buffer: this.materialUniformBuffer } },
      { binding: 4, resource: { buffer: this.particles } }
    ], 'particle-bg');

    renderPass.setPipeline(this.particlePipeline);
    renderPass.setBindGroup(1, particleBindGroup, offset);

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
        { binding: 1, resource: this._deviceUniformResource() },
        { binding: 3, resource: { buffer: this.materialUniformBuffer } },
        { binding: 4, resource: { buffer: this.effectsParticles } }
      ], 'effects-particle-bg');
      renderPass.setPipeline(this.particlePipeline);
      renderPass.setBindGroup(1, effectsBindGroup, offset);
      renderPass.draw(4, this.effectParticleCount);
    }
  },

  renderBase: function (this: DeviceInstanceLike, renderPass: RenderEncoder): void {
    const v = this.visualizer;
    if (!v.basePlateBuffer || !v.baseInstanceBuffer || !this.segEnhancedPipeline) return;
    const bindGroup = this._enhancedBindGroup(v.baseInstanceBuffer, 'base');
    renderPass.setPipeline(this.segEnhancedPipeline);
    renderPass.setBindGroup(1, bindGroup, [this._deviceUniformOffset(DEVICE_PART.bench, 'base')]);
    renderPass.setVertexBuffer(0, v.basePlateBuffer.vertexBuffer);
    renderPass.setIndexBuffer(v.basePlateBuffer.indexBuffer, 'uint16');
    renderPass.drawIndexed(v.basePlateBuffer.indexCount, 1);
  },

  renderGltfHousing: function (this: DeviceInstanceLike, renderPass: RenderEncoder): void {
    if (this.id !== 'seg') return;
    if (this.visualizer.currentView && this.visualizer.currentView !== 'seg') return;
    this._drawGltfPropsForDevice(renderPass, 'seg');
  },

  /**
   * Draw this device's own glTF CAD props (ADR-0005 WS1).
   *
   * Called from the shared `render()` for every non-SEG bench; SEG keeps
   * `renderGltfHousing` because its draw order is explicit in `seg-render.ts`.
   * Props are baked in device-local metres, so the device uniform's position and
   * rotation place them exactly as it places the procedural cylinders.
   */
  renderGltfDeviceProps: function (this: DeviceInstanceLike, renderPass: RenderEncoder): void {
    if (this.id === 'seg') return;
    // Focus-only: overview never pays for a bench's CAD.
    if (this.visualizer.currentView !== this.id) return;
    this._drawGltfPropsForDevice(renderPass, this.id);
  },

  /** @private Shared body of the two prop draw entry points (also recorded into bundles). */
  _drawGltfPropsForDevice: function (
    this: DeviceInstanceLike,
    renderPass: RenderEncoder,
    deviceId: string
  ): void {
    const v = this.visualizer;
    if (!v.gltfHousingEnabled || !v.gltfHousingDrawables?.length) return;
    if (!this.segEnhancedPipeline) return;

    // Drawables from other benches may still be resident (SEG's housing is).
    let drawn = 0;
    const offset = [this._deviceUniformOffset(DEVICE_PART.rollers, 'gltf')];
    renderPass.setPipeline(this.segEnhancedPipeline);
    for (const drawable of v.gltfHousingDrawables) {
      if ((drawable.deviceId ?? 'seg') !== deviceId) continue;
      renderPass.setBindGroup(1, this._enhancedBindGroup(drawable.instanceBuffer, `gltf:${drawable.name}`), offset);
      renderPass.setVertexBuffer(0, drawable.gpu.vertexBuffer);
      renderPass.setIndexBuffer(drawable.gpu.indexBuffer, 'uint16');
      renderPass.drawIndexed(drawable.gpu.indexCount, 1);
      drawn++;
    }
    if (drawn > 0) v.profiler?.recordDraw?.(drawn);
  },

  /** SEG frame: bench, stand, structural members, control box, cage (all segEnhanced, all static). */
  renderFrame: function (this: DeviceInstanceLike, renderPass: RenderEncoder): void {
    const v = this.visualizer;
    if (v.segFrameLevel === 'off' || !this.segEnhancedPipeline || !v.segFrameBuffers) return;
    renderPass.setPipeline(this.segEnhancedPipeline);

    const drawPart = (
      geom: MeshBuffers | null | undefined,
      instanceBuffer: GPUBuffer | null | undefined,
      part: DevicePart,
      keySuffix: string
    ) => {
      if (!geom || !instanceBuffer) return;
      renderPass.setBindGroup(1, this._enhancedBindGroup(instanceBuffer, keySuffix),
        [this._deviceUniformOffset(part, keySuffix)]);
      renderPass.setVertexBuffer(0, geom.vertexBuffer);
      renderPass.setIndexBuffer(geom.indexBuffer, 'uint16');
      renderPass.drawIndexed(geom.indexCount, 1);
    };

    const fb = v.segFrameBuffers;
    const inst = v.frameStructuralInstanceBuffer;
    const benchInst = v.frameLabBenchInstanceBuffer || inst;
    const skipLabBench = v.gltfHousingEnabled && v.gltfHousingDrawables?.length;

    if (!skipLabBench) {
      drawPart(fb.labBench, benchInst, DEVICE_PART.bench, 'labBench');
    }
    this.renderStand(renderPass);
    drawPart(fb.structural, inst, DEVICE_PART.rollers, 'structural');
    if (v.segFrameLevel === 'full') {
      drawPart(fb.controlBox, v.frameControlInstanceBuffer, DEVICE_PART.rollers, 'controlBox');
      drawPart(fb.safetyCage, v.frameCageInstanceBuffer, DEVICE_PART.rollers, 'safetyCage');
    }
  },

  renderStatorRings: function (this: DeviceInstanceLike, renderPass: RenderEncoder): void {
    if (!this.geometry.statorRingBuffer) return;
    const v = this.visualizer;
    const offset = [this._deviceUniformOffset(DEVICE_PART.stator, 'stator')];

    if (this.segEnhancedPipeline && v.statorRingUVBuffer) {
      const bindGroup = this._enhancedBindGroup(this.geometry.statorRingBuffer, 'stator');
      renderPass.setPipeline(this.segEnhancedPipeline);
      renderPass.setBindGroup(1, bindGroup, offset);
      renderPass.setVertexBuffer(0, v.statorRingUVBuffer.vertexBuffer);
      renderPass.setIndexBuffer(v.statorRingUVBuffer.indexBuffer, 'uint16');
      renderPass.drawIndexed(v.statorRingUVBuffer.indexCount, 3);
    } else if (this.rollerPipeline && v.cylinderBuffer) {
      // Fallback `roller` layout: same ring slot, so mode 2 survives the rollers' mode 0.
      const bindGroup = this._rollerBindGroup(this.geometry.statorRingBuffer, 'stator-fb');
      renderPass.setPipeline(this.rollerPipeline);
      renderPass.setBindGroup(1, bindGroup, offset);
      renderPass.setVertexBuffer(0, v.cylinderBuffer.vertexBuffer);
      renderPass.setIndexBuffer(v.cylinderBuffer.indexBuffer, 'uint16');
      renderPass.drawIndexed(v.cylinderBuffer.indexCount, 3);
    }
  },

  renderWiring: function (this: DeviceInstanceLike, renderPass: RenderEncoder): void {
    if (!this.geometry.wiringBuffer) return;
    const v = this.visualizer;
    const offset = [this._deviceUniformOffset(DEVICE_PART.wiring, 'wiring')];

    if (this.segEnhancedPipeline && v.wiringUVBuffer) {
      const bindGroup = this._enhancedBindGroup(this.geometry.wiringBuffer, 'wiring');
      renderPass.setPipeline(this.segEnhancedPipeline);
      renderPass.setBindGroup(1, bindGroup, offset);
      renderPass.setVertexBuffer(0, v.wiringUVBuffer.vertexBuffer);
      renderPass.setIndexBuffer(v.wiringUVBuffer.indexBuffer, 'uint16');
      renderPass.drawIndexed(v.wiringUVBuffer.indexCount, 8);
    } else if (this.rollerPipeline && v.cylinderBuffer) {
      const bindGroup = this._rollerBindGroup(this.geometry.wiringBuffer, 'wiring-fb');
      renderPass.setPipeline(this.rollerPipeline);
      renderPass.setBindGroup(1, bindGroup, offset);
      renderPass.setVertexBuffer(0, v.cylinderBuffer.vertexBuffer);
      renderPass.setIndexBuffer(v.cylinderBuffer.indexBuffer, 'uint16');
      renderPass.drawIndexed(v.cylinderBuffer.indexCount, 8);
    }
  },

  /** Shaft, magnet, top / bottom plates, bolts. */
  renderCore: function (this: DeviceInstanceLike, renderPass: RenderEncoder): void {
    if (!this.segEnhancedPipeline || !this.config.core) return;
    const v = this.visualizer;
    if (!v.coreShaftBuffer) return;
    renderPass.setPipeline(this.segEnhancedPipeline);

    const drawComponent = (
      geomBuffer: MeshBuffers,
      instanceBuffer: GPUBuffer,
      keySuffix: string,
      instanceCount = 1
    ) => {
      renderPass.setBindGroup(1, this._enhancedBindGroup(instanceBuffer, keySuffix),
        [this._deviceUniformOffset(DEVICE_PART.rollers, keySuffix)]);
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

  renderPickupCoils: function (this: DeviceInstanceLike, renderPass: RenderEncoder): void {
    if (!this.coilInstances || !this.coilPipeline || !this.ringPipeline) return;
    if (!this.visualizer.connectionRingBuffer || !this.visualizer.coilBuffer) return;
    if (!this.coilMaterialBuffer || !this.ringMaterialBuffer || !this.visualizer.connectionRingInstances) return;

    this.renderMode = 0;
    const numCoils = 24;

    // Top / bottom rings: same bind group, ±2 y offsets live in their own slots.
    const ringBindGroup = this._cacheBg(`ring:${this.id}`, 'segEnhanced', [
      { binding: 1, resource: this._deviceUniformResource() },
      { binding: 2, resource: { buffer: this.visualizer.connectionRingInstances } },
      { binding: 3, resource: { buffer: this.ringMaterialBuffer } }
    ], 'connection-ring-bg');

    renderPass.setPipeline(this.ringPipeline);
    renderPass.setBindGroup(1, ringBindGroup, [this._deviceUniformOffset(DEVICE_PART.ringTop, 'ringTop')]);
    renderPass.setVertexBuffer(0, this.visualizer.connectionRingBuffer.vertexBuffer);
    renderPass.setIndexBuffer(this.visualizer.connectionRingBuffer.indexBuffer, 'uint16');
    renderPass.drawIndexed(this.visualizer.connectionRingBuffer.indexCount);

    renderPass.setBindGroup(1, ringBindGroup, [this._deviceUniformOffset(DEVICE_PART.ringBottom, 'ringBottom')]);
    renderPass.drawIndexed(this.visualizer.connectionRingBuffer.indexCount);

    const coilBindGroup = this._cacheBg(`coil-pickup:${this.id}`, 'coil', [
      { binding: 1, resource: this._deviceUniformResource() },
      { binding: 2, resource: { buffer: this.coilInstances } },
      { binding: 3, resource: { buffer: this.coilMaterialBuffer } }
    ], 'pickup-coil-bg');

    renderPass.setPipeline(this.coilPipeline);
    renderPass.setBindGroup(1, coilBindGroup, [this._deviceUniformOffset(DEVICE_PART.rollers)]);
    renderPass.setVertexBuffer(0, this.visualizer.coilBuffer.vertexBuffer);
    renderPass.draw(this.visualizer.coilBuffer.vertexCount, numCoils);
  },

  /** SEG rollers (segEnhanced, instanced, inside-ring cull) — scene pass and shadow casters. */
  renderSegRollers: function (this: DeviceInstanceLike, renderPass: RenderEncoder): void {
    const v = this.visualizer;
    if (!this.rollerInstances || !this.segEnhancedPipeline || !v.enhancedRollerBuffer) return;
    const layoutRollers = v.segLayout?.totalRollers ?? 36;
    const segPos = this.position || [0, 0, 0];
    const rings = v.segLayout?.rings;
    const outerR = ((rings && rings[rings.length - 1]?.orbitRadiusM)
      ?? 5.5) * (v.segLayout?.worldScale ?? 1);
    const cam = v.camera?.camera;
    const inside = cam?.position
      ? isCameraInsideSegRing(cam.position, segPos as number[], outerR)
      : false;
    const activeRollers = cullSegRollerInstances(
      layoutRollers,
      inside,
      v.rollerInstanceCullEnabled !== false
    );
    renderPass.setPipeline(this.segEnhancedPipeline);
    renderPass.setBindGroup(1, this._enhancedBindGroup(this.rollerInstances, 'rollers'),
      [this._deviceUniformOffset(DEVICE_PART.rollers, 'rollers')]);
    renderPass.setVertexBuffer(0, v.enhancedRollerBuffer.vertexBuffer);
    renderPass.setIndexBuffer(v.enhancedRollerBuffer.indexBuffer, 'uint16');
    renderPass.drawIndexed(v.enhancedRollerBuffer.indexCount, activeRollers);
    v.profiler?.recordDraw?.(1);
  },

  /**
   * Opaque key-light casters of this bench (#225 §4), drawn into the shadow
   * map with the pipeline manager on its `shadow` variant: SEG's CAD housing,
   * frame, base, stator rings, core plates and rollers; any other bench's CAD
   * props and procedural mesh (e.g. the Thomson ring). No particles, lines,
   * arcs or coils — those have no `_shadow` pipeline and read as null.
   */
  renderShadowCasters: function (this: DeviceInstanceLike, renderPass: GPURenderPassEncoder): void {
    if (this.id === 'seg') {
      this.renderGltfHousing(renderPass);
      this.renderFrame(renderPass);
      if (this.geometry.baseBuffer) this.renderBase(renderPass);
      if (this.geometry.statorRingBuffer) this.renderStatorRings(renderPass);
      this.renderCore(renderPass);
      this.renderSegRollers(renderPass);
      return;
    }
    this.renderGltfDeviceProps(renderPass);
    if (this.rollerInstances && this.rollerPipeline) this.renderDeviceMesh(renderPass);
  },

  renderStand: function (this: DeviceInstanceLike, renderPass: RenderEncoder): void {
    if (!this.segEnhancedPipeline || !this.visualizer.standBuffer) return;
    const v = this.visualizer;
    const inst = v.frameStructuralInstanceBuffer || this.shaftInstanceBuffer;
    const standBuffer = v.standBuffer;
    if (!inst || !standBuffer) return;

    renderPass.setPipeline(this.segEnhancedPipeline);
    renderPass.setBindGroup(1, this._enhancedBindGroup(inst, 'stand'),
      [this._deviceUniformOffset(DEVICE_PART.rollers, 'stand')]);
    renderPass.setVertexBuffer(0, standBuffer.vertexBuffer);
    renderPass.setIndexBuffer(standBuffer.indexBuffer, 'uint16');
    renderPass.drawIndexed(standBuffer.indexCount, 1);
  },

  renderWires: function (this: DeviceInstanceLike, renderPass: RenderEncoder): void {
    const wireBuffers = this.visualizer.wireBuffers;
    const shaftInstances = this.shaftInstanceBuffer;
    if (!this.segEnhancedPipeline || !wireBuffers || !shaftInstances) return;

    // Mode 0, as before: these never wrote a mode of their own (they inherited
    // the rollers' write), and the wiring branch assumes the instanced cylinders.
    renderPass.setPipeline(this.segEnhancedPipeline);
    renderPass.setBindGroup(1, this._enhancedBindGroup(shaftInstances, 'wires'),
      [this._deviceUniformOffset(DEVICE_PART.rollers, 'wires')]);
    for (let i = 0; i < wireBuffers.length; i++) {
      const wire = wireBuffers[i];
      renderPass.setVertexBuffer(0, wire.vertexBuffer);
      renderPass.setIndexBuffer(wire.indexBuffer, 'uint16');
      renderPass.drawIndexed(wire.indexCount, 1);
    }
  }
};
