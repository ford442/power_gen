import { PARTICLE_BYTES_PER_INSTANCE } from './device-geometry';
import type { VisualizerLike } from './devices/types';
import type { BindGroupLayoutName } from './pipeline-layout-cache';

/**
 * Per-device pipeline handles. All GPURenderPipeline / GPUComputePipeline objects
 * are created once on visualizer.pipelineCache and shared across devices.
 *
 * Each render pipeline also has a `_msaa4` variant (ADR-0005 WS2 showroom
 * MSAA — `high` tier + focus mode, see render-loop.ts `msaaActive`), created
 * eagerly alongside the base variant in `ensureDevicePipelines()`.
 * `applyMsaaState()` swaps the active `xPipeline` reference between the two
 * once per frame; device-render.ts / device-instance.ts never need to know
 * which one is active — they just read `this.rollerPipeline` etc as before.
 */
export class DevicePipelineManager {
  device: GPUDevice;
  id: string;
  visualizer: VisualizerLike;

  rollerPipeline: GPURenderPipeline | null = null;
  particlePipeline: GPURenderPipeline | null = null;
  computePipeline: GPUComputePipeline | GPURenderPipeline | null = null;
  fluxSegmentPipeline: GPURenderPipeline | null = null;
  energyArcPipeline: GPURenderPipeline | null = null;
  segEnhancedPipeline: GPURenderPipeline | null = null;
  fieldLinePipeline: GPURenderPipeline | null = null;
  coilPipeline: GPURenderPipeline | null = null;
  ringPipeline: GPURenderPipeline | null = null;
  corePipeline: GPURenderPipeline | null = null;

  // Base (sampleCount 1) / MSAA (sampleCount 4) pairs — populated by
  // setupPipelines(); applyMsaaState() picks between them.
  private _base: Record<string, GPURenderPipeline | GPUComputePipeline | null> = {};
  private _msaa4: Record<string, GPURenderPipeline | GPUComputePipeline | null> = {};
  private _msaaActive = false;

  constructor(device: GPUDevice, id: string, visualizer: VisualizerLike) {
    this.device = device;
    this.id = id;
    this.visualizer = visualizer;
  }

  /**
   * Attach shared pipelines from PipelineLayoutCache (no per-device compile).
   */
  async setupPipelines(): Promise<void> {
    const cache = this.visualizer.pipelineCache;
    if (!cache) {
      throw new Error(
        '[DevicePipelineManager] visualizer.pipelineCache missing — call ensureDevicePipelines first'
      );
    }

    if (PARTICLE_BYTES_PER_INSTANCE !== 16) {
      throw new Error(
        `[DevicePipelineManager] Particle stride must be 16 bytes (vec4f); got ${PARTICLE_BYTES_PER_INSTANCE}`
      );
    }

    // Shared across all devices
    this._base.roller = cache.getPipeline('roller');
    this._msaa4.roller = cache.getPipeline('roller_msaa4');
    this._base.particle = cache.getPipeline('particle');
    this._msaa4.particle = cache.getPipeline('particle_msaa4');
    this.computePipeline = cache.getParticleComputePipeline();
    this._base.coil = cache.getPipeline('coil');
    this._msaa4.coil = cache.getPipeline('coil_msaa4');

    // SEG-only
    if (this.id === 'seg') {
      this._base.fluxSegment = cache.getPipeline('fluxSegment');
      this._msaa4.fluxSegment = cache.getPipeline('fluxSegment_msaa4');
      this._base.energyArc = cache.getPipeline('energyArc');
      this._msaa4.energyArc = cache.getPipeline('energyArc_msaa4');
      this._base.segEnhanced = cache.getPipeline('segEnhanced');
      this._msaa4.segEnhanced = cache.getPipeline('segEnhanced_msaa4');
      // core uses enhanced when present; ringPipeline remains unset until a
      // dedicated layout exists (renderPickupCoils guards on ringPipeline).
      this.ringPipeline = null;
    }

    // Flow-path devices + SEG fallback field lines
    if (['seg', 'heron', 'kelvin', 'solar'].includes(this.id)) {
      this._base.fieldLine = cache.getPipeline('fieldLine');
      this._msaa4.fieldLine = cache.getPipeline('fieldLine_msaa4');
    }

    this.applyMsaaState(this._msaaActive);

    if (!this.rollerPipeline || !this.particlePipeline || !this.computePipeline) {
      throw new Error(
        `[DevicePipelineManager] Shared pipelines not ready for device "${this.id}"`
      );
    }
  }

  /**
   * Swap every render pipeline reference between its base (sampleCount 1)
   * and MSAA (sampleCount 4) variant. Cheap — reference assignment only, no
   * GPU work — call once per frame per device from render-loop.ts.
   */
  applyMsaaState(active: boolean): void {
    this._msaaActive = active;
    const table = active ? this._msaa4 : this._base;
    this.rollerPipeline = (table.roller as GPURenderPipeline | null) ?? null;
    this.particlePipeline = (table.particle as GPURenderPipeline | null) ?? null;
    this.coilPipeline = (table.coil as GPURenderPipeline | null) ?? null;
    if (this.id === 'seg') {
      this.fluxSegmentPipeline = (table.fluxSegment as GPURenderPipeline | null) ?? null;
      this.energyArcPipeline = (table.energyArc as GPURenderPipeline | null) ?? null;
      this.segEnhancedPipeline = (table.segEnhanced as GPURenderPipeline | null) ?? null;
      this.corePipeline = this.segEnhancedPipeline || this.rollerPipeline;
    }
    if (['seg', 'heron', 'kelvin', 'solar'].includes(this.id)) {
      this.fieldLinePipeline = (table.fieldLine as GPURenderPipeline | null) ?? null;
    }
  }

  /** @deprecated Prefer visualizer.pipelineCache.createBindGroup */
  getBindGroupLayout(pipelineKey: string): GPUBindGroupLayout | undefined {
    const cache = this.visualizer.pipelineCache;
    const map: Record<string, BindGroupLayoutName> = {
      roller: 'roller',
      particle: 'particle',
      segEnhanced: 'segEnhanced',
      fluxSegment: 'fluxSegment',
      fieldLine: 'fieldParticles',
      energyArc: 'fieldParticles',
      particleCompute: 'particleCompute',
      coil: 'coil'
    };
    return cache?.getLayout((map[pipelineKey] || pipelineKey) as BindGroupLayoutName);
  }
}
