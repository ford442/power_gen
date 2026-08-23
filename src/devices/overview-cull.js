/**
 * GPU frustum cull → draw-indirect for the overview device ring (ADR-0005 WS4).
 *
 * Baseline: the CPU resolved a particle budget per device every frame and
 * encoded `draw(4, count)` with that number. At 8–12 devices with full budgets
 * that prefix math (plus the per-device uniform writes it implies) showed up in
 * the profiler's draw-prep scope.
 *
 * Here the CPU uploads one flat array of device bounding spheres plus a LOD
 * level, `passes/overview-cull-compute.wgsl` decides visibility, and the
 * particle billboards are encoded with `drawIndirect` at a *stable* per-device
 * byte offset — so no result ever has to come back to the CPU.
 *
 * Layouts: docs/BINDINGS.md → `overviewCull`.
 */

import { overviewLodLevel, overviewLodParticleCount } from '../renderers/shared/view-lod';
import { getDeviceParticleBudget } from './particle-budgets.js';

/** Bytes per `DeviceBounds` entry (common/overview-cull.wgsl). */
export const BOUNDS_STRIDE = 32;
/** Bytes per `DrawArgs` block — WebGPU indirect draw argument size. */
export const DRAW_ARGS_STRIDE = 16;
/** Bytes of the `CullOutput` header before `indices`. */
export const CULL_OUTPUT_HEADER_BYTES = 16;
/** `CullUniforms` size: mat4x4 + vec3+u32 + 4×u32. */
export const CULL_UNIFORM_BYTES = 96;
/** Particle billboards are triangle-strip quads. */
export const PARTICLE_VERTEX_COUNT = 4;
/** bit 0 of `DeviceBounds.flags`. */
export const CULL_FLAG_ENABLED = 1;

/** Slots allocated up front; the ring targets 8–12 devices. */
const DEFAULT_CAPACITY = 32;

/**
 * Per-device slot input for {@link packDeviceBounds}.
 * @typedef {object} CullSlotInput
 * @property {string} id
 * @property {number[]} position
 * @property {number} radius
 * @property {number} baseCount particle count before LOD (tier budget applied)
 * @property {number} lodLevel 0..3
 * @property {boolean} enabled
 */

/**
 * Pack slots into the flat `array<DeviceBounds>` upload.
 * Pure — exported for tests and for the WebGL2 parity path.
 *
 * @param {CullSlotInput[]} slots
 * @param {Float32Array} [out] reused scratch of at least slots.length*8 floats
 * @returns {Float32Array}
 */
export function packDeviceBounds(slots, out) {
  const floats = slots.length * (BOUNDS_STRIDE / 4);
  const data = out && out.length >= floats ? out : new Float32Array(floats);
  const u32 = new Uint32Array(data.buffer, data.byteOffset, data.length);

  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    const o = i * 8;
    const pos = s.position || [0, 0, 0];
    data[o + 0] = pos[0] || 0;
    data[o + 1] = pos[1] || 0;
    data[o + 2] = pos[2] || 0;
    data[o + 3] = Math.max(0, s.radius || 0);
    u32[o + 4] = Math.max(0, Math.floor(s.baseCount || 0));
    u32[o + 5] = Math.max(0, Math.min(3, Math.floor(s.lodLevel || 0)));
    u32[o + 6] = s.enabled ? CULL_FLAG_ENABLED : 0;
    u32[o + 7] = 0;
  }
  return data;
}

/**
 * Instance count the cull pass will write for a slot when it passes the
 * frustum test. Mirrors the shader so CPU fallbacks and diagnostics agree.
 * @param {CullSlotInput} slot
 * @returns {number}
 */
export function expectedInstanceCount(slot) {
  if (!slot || !slot.enabled) return 0;
  return overviewLodParticleCount(slot.baseCount, slot.lodLevel);
}

/**
 * Build the per-frame slot list for the visible device set.
 *
 * @param {object} opts
 * @param {Array<object>} opts.devices device instances (ordered, stable)
 * @param {number[]} opts.cameraPos
 * @param {string} opts.currentView
 * @param {number} opts.qualityLevel
 * @param {string} [opts.qualityTier='high']
 * @param {number} [opts.defaultRadius=16]
 * @param {(device: object) => boolean} [opts.isEnabled]
 * @returns {CullSlotInput[]}
 */
export function buildCullSlots({
  devices,
  cameraPos,
  currentView,
  qualityLevel,
  qualityTier = 'high',
  defaultRadius = 16,
  isEnabled
}) {
  const slots = [];
  for (const device of devices) {
    const focused = !!currentView && currentView === device.id;
    const lodLevel = overviewLodLevel({
      devicePos: device.position,
      cameraPos,
      qualityLevel,
      focused
    });
    const budget = getDeviceParticleBudget(device.id, qualityTier, {
      isPlugin: !!device.config?.plugin
    });
    slots.push({
      id: device.id,
      position: device.position,
      radius: device.config?.cullRadius ?? defaultRadius,
      baseCount: Math.min(device.particleCount || 0, budget),
      lodLevel,
      enabled: isEnabled ? !!isEnabled(device) : true
    });
  }
  return slots;
}

/**
 * Owns the cull pass GPU resources for one visualizer.
 */
export class OverviewCullPass {
  /**
   * @param {GPUDevice} device
   * @param {object} visualizer MultiDeviceVisualizer (pipelineCache, profiler)
   * @param {{ capacity?: number }} [opts]
   */
  constructor(device, visualizer, opts = {}) {
    this.device = device;
    this.visualizer = visualizer;
    this.capacity = Math.max(1, opts.capacity ?? DEFAULT_CAPACITY);

    this.pipeline = null;
    this.bindGroup = null;
    this.boundsBuffer = null;
    this.uniformBuffer = null;
    this.drawArgsBuffer = null;
    this.outputBuffer = null;

    /** Device id → stable slot index (byte offset = index × DRAW_ARGS_STRIDE). */
    this.slotIndex = new Map();
    /** Last packed slot list — diagnostics + CPU fallback draw counts. */
    this.slots = [];
    this.deviceCount = 0;
    this.ready = false;
    /** True only while the pass drove this frame's draw args (overview). */
    this.active = false;

    this._boundsScratch = new Float32Array(this.capacity * (BOUNDS_STRIDE / 4));
    this._uniformScratch = new Float32Array(CULL_UNIFORM_BYTES / 4);
    this._uniformU32 = new Uint32Array(
      this._uniformScratch.buffer,
      this._uniformScratch.byteOffset,
      this._uniformScratch.length
    );
    this._resetOutput = new Uint32Array(CULL_OUTPUT_HEADER_BYTES / 4);
  }

  /**
   * Allocate buffers and the bind group. Safe to call once pipelines exist.
   * @param {GPUComputePipeline} pipeline
   */
  init(pipeline) {
    if (!pipeline) return false;
    this.pipeline = pipeline;

    const cache = this.visualizer?.pipelineCache;
    if (!cache) return false;

    this.boundsBuffer = this.device.createBuffer({
      label: 'overview-cull-bounds',
      size: this.capacity * BOUNDS_STRIDE,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    this.uniformBuffer = this.device.createBuffer({
      label: 'overview-cull-uniforms',
      size: CULL_UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    this.drawArgsBuffer = this.device.createBuffer({
      label: 'overview-cull-draw-args',
      size: this.capacity * DRAW_ARGS_STRIDE,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST
    });
    this.outputBuffer = this.device.createBuffer({
      label: 'overview-cull-output',
      size: CULL_OUTPUT_HEADER_BYTES + this.capacity * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });

    const profiler = this.visualizer?.profiler;
    profiler?.trackBuffer?.('overview-cull-bounds', this.capacity * BOUNDS_STRIDE, GPUBufferUsage.STORAGE);
    profiler?.trackBuffer?.('overview-cull-draw-args', this.capacity * DRAW_ARGS_STRIDE, GPUBufferUsage.INDIRECT);

    this.bindGroup = cache.createBindGroup('overviewCull', [
      { binding: 0, resource: { buffer: this.boundsBuffer } },
      { binding: 1, resource: { buffer: this.uniformBuffer } },
      { binding: 2, resource: { buffer: this.drawArgsBuffer } },
      { binding: 3, resource: { buffer: this.outputBuffer } }
    ], 'overview-cull-bg');

    this.ready = true;
    return true;
  }

  /**
   * Stop consumers using stale draw args (focus views, fallback frames).
   * The buffer contents outlive the frame, so the flag — not `ready` — is
   * what gates `drawIndirect`.
   */
  setInactive() {
    this.active = false;
    this.slotIndex.clear();
    this.slots = [];
    this.deviceCount = 0;
  }

  /** Byte offset of a device's draw-indirect args, or -1 when unslotted. */
  drawArgsOffset(deviceId) {
    if (!this.active) return -1;
    const slot = this.slotIndex.get(deviceId);
    return slot === undefined ? -1 : slot * DRAW_ARGS_STRIDE;
  }

  /** LOD level assigned to a device this frame (0 when unslotted). */
  lodLevelFor(deviceId) {
    const slot = this.slotIndex.get(deviceId);
    return slot === undefined ? 0 : this.slots[slot].lodLevel;
  }

  /**
   * Upload bounds + camera for this frame.
   * @param {object} opts see {@link buildCullSlots}, plus `viewProj`.
   * @param {Float32Array} opts.viewProj column-major 4×4
   * @param {number} [opts.margin=1.35]
   */
  update(opts) {
    if (!this.ready) return 0;

    const slots = buildCullSlots(opts).slice(0, this.capacity);
    this.slots = slots;
    this.deviceCount = slots.length;

    this.slotIndex.clear();
    for (let i = 0; i < slots.length; i++) this.slotIndex.set(slots[i].id, i);

    const bounds = packDeviceBounds(slots, this._boundsScratch);
    this.device.queue.writeBuffer(
      this.boundsBuffer, 0,
      bounds.buffer, bounds.byteOffset, slots.length * BOUNDS_STRIDE
    );

    const u = this._uniformScratch;
    u.set(opts.viewProj, 0);
    const cam = opts.cameraPos || [0, 0, 0];
    u[16] = cam[0] || 0;
    u[17] = cam[1] || 0;
    u[18] = cam[2] || 0;
    this._uniformU32[19] = slots.length;
    u[20] = opts.margin ?? 1.35;
    this._uniformU32[21] = PARTICLE_VERTEX_COUNT;
    this._uniformU32[22] = 0;
    this._uniformU32[23] = 0;
    this.device.queue.writeBuffer(this.uniformBuffer, 0, u);

    // Counters are accumulated with atomicAdd — clear the header each frame.
    this.device.queue.writeBuffer(this.outputBuffer, 0, this._resetOutput);

    this.active = slots.length > 0;
    return slots.length;
  }

  /**
   * Encode the cull dispatch. Must run before the render pass that consumes
   * `drawArgsBuffer`.
   * @param {GPUComputePassEncoder} computePass
   */
  dispatch(computePass) {
    if (!this.ready || !this.pipeline || !this.bindGroup || this.deviceCount === 0) return false;
    computePass.setPipeline(this.pipeline);
    computePass.setBindGroup(0, this.bindGroup);
    computePass.dispatchWorkgroups(Math.ceil(this.deviceCount / 64));
    return true;
  }

  destroy() {
    for (const buf of [this.boundsBuffer, this.uniformBuffer, this.drawArgsBuffer, this.outputBuffer]) {
      buf?.destroy?.();
    }
    this.ready = false;
    this.active = false;
    this.bindGroup = null;
  }
}
