import { PARTICLE_BYTES_PER_INSTANCE } from './device-geometry';
import type { VisualizerLike } from './devices/types';
import type { BindGroupLayoutName } from './pipeline-layout-cache';

/** Which variant of the shared pipelines a pass draws with. */
export type PassVariant = 'base' | 'msaa4' | 'shadow';

const VARIANT_SUFFIX: Record<PassVariant, string> = { base: '', msaa4: '_msaa4', shadow: '_shadow' };

/**
 * Per-device pipeline handles. All GPURenderPipeline / GPUComputePipeline
 * objects live once on visualizer.pipelineCache and are shared across devices.
 *
 * Each render pipeline has variants keyed by suffix: the 1× base (built at
 * boot), `_msaa4` (ADR-0005 WS2 showroom MSAA — `high` tier + focus) and, for
 * the key-light casters, `_shadow` (depth-only). The non-base ones compile on
 * first use (visualizer/pipeline-tiers.ts), so `applyPassVariant()` looks
 * them up in the cache each time it runs instead of capturing them at setup:
 * a reference swap per pipeline, no GPU work. device-render.ts /
 * device-instance.ts just read `this.rollerPipeline` etc. A pipeline with no
 * variant for the pass (every non-caster under `shadow`) reads as null, and
 * the draw that needs it is skipped.
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

  private _variant: PassVariant = 'base';

  constructor(device: GPUDevice, id: string, visualizer: VisualizerLike) {
    this.device = device;
    this.id = id;
    this.visualizer = visualizer;
  }

  /** Current pass variant (diagnostics). */
  get variant(): PassVariant {
    return this._variant;
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

    this.computePipeline = cache.getParticleComputePipeline();
    // core uses enhanced when present; ringPipeline remains unset until a
    // dedicated layout exists (renderPickupCoils guards on ringPipeline).
    this.ringPipeline = null;
    this.applyPassVariant('base');

    if (!this.rollerPipeline || !this.particlePipeline || !this.computePipeline) {
      throw new Error(
        `[DevicePipelineManager] Shared pipelines not ready for device "${this.id}"`
      );
    }
  }

  /** Point every render pipeline reference at `variant`'s pipeline (or null). */
  applyPassVariant(variant: PassVariant): void {
    this._variant = variant;
    const cache = this.visualizer.pipelineCache;
    const suffix = VARIANT_SUFFIX[variant];
    const get = (name: string) =>
      (cache?.getPipeline(`${name}${suffix}`) as GPURenderPipeline | null | undefined) ?? null;
    this.rollerPipeline = get('roller');
    this.particlePipeline = get('particle');
    this.coilPipeline = get('coil');
    if (this.id === 'seg') {
      this.fluxSegmentPipeline = get('fluxSegment');
      this.energyArcPipeline = get('energyArc');
      this.segEnhancedPipeline = get('segEnhanced');
      this.corePipeline = this.segEnhancedPipeline || this.rollerPipeline;
    } else {
      // Non-SEG benches draw their CAD props with segEnhanced too
      // (_drawGltfPropsForDevice). Before #225 this was SEG-only, so those
      // props never drew on WebGPU.
      this.segEnhancedPipeline = get('segEnhanced');
    }
    if (['seg', 'heron', 'kelvin', 'solar'].includes(this.id)) {
      this.fieldLinePipeline = get('fieldLine');
    }
  }

  /** 1× or 4× scene variant — once per frame per device from render-passes.ts. */
  applyMsaaState(active: boolean): void {
    this.applyPassVariant(active ? 'msaa4' : 'base');
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
