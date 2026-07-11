import { PARTICLE_BYTES_PER_INSTANCE } from './device-geometry.js';

/**
 * Per-device pipeline handles. All GPURenderPipeline / GPUComputePipeline objects
 * are created once on visualizer.pipelineCache and shared across devices.
 */
export class DevicePipelineManager {
  constructor(device, id, visualizer) {
    this.device = device;
    this.id = id;
    this.visualizer = visualizer;

    this.rollerPipeline = null;
    this.particlePipeline = null;
    this.computePipeline = null;
    this.fluxSegmentPipeline = null;
    this.energyArcPipeline = null;
    this.segEnhancedPipeline = null;
    this.fieldLinePipeline = null;
    this.coilPipeline = null;
    this.ringPipeline = null;
    this.corePipeline = null;
  }

  /**
   * Attach shared pipelines from PipelineLayoutCache (no per-device compile).
   */
  async setupPipelines() {
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
    this.rollerPipeline = cache.getPipeline('roller');
    this.particlePipeline = cache.getPipeline('particle');
    this.computePipeline = cache.getParticleComputePipeline();
    this.coilPipeline = cache.getPipeline('coil');

    // SEG-only
    if (this.id === 'seg') {
      this.fluxSegmentPipeline = cache.getPipeline('fluxSegment');
      this.energyArcPipeline = cache.getPipeline('energyArc');
      this.segEnhancedPipeline = cache.getPipeline('segEnhanced');
      // core uses enhanced when present; ringPipeline remains unset until a
      // dedicated layout exists (renderPickupCoils guards on ringPipeline).
      this.corePipeline = this.segEnhancedPipeline || this.rollerPipeline;
      this.ringPipeline = null;
    }

    // Flow-path devices + SEG fallback field lines
    if (['seg', 'heron', 'kelvin', 'solar'].includes(this.id)) {
      this.fieldLinePipeline = cache.getPipeline('fieldLine');
    }

    if (!this.rollerPipeline || !this.particlePipeline || !this.computePipeline) {
      throw new Error(
        `[DevicePipelineManager] Shared pipelines not ready for device "${this.id}"`
      );
    }
  }

  /** @deprecated Prefer visualizer.pipelineCache.createBindGroup */
  getBindGroupLayout(pipelineKey) {
    const cache = this.visualizer.pipelineCache;
    const map = {
      roller: 'roller',
      particle: 'particle',
      segEnhanced: 'segEnhanced',
      fluxSegment: 'fluxSegment',
      fieldLine: 'fieldParticles',
      energyArc: 'fieldParticles',
      particleCompute: 'particleCompute',
      coil: 'coil'
    };
    return cache.getLayout(map[pipelineKey] || pipelineKey);
  }
}
