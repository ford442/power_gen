/**
 * MLS-MPM liquid solver — the WebGPU host (ADR-0022). Owns the particle
 * buffer, the two grids and one bind group, and encodes substeps: a grid
 * clear and the three passes of passes/mpm-*.wgsl.
 *
 * Nothing here is allocated until `create` is called, and a bench that does
 * not own a liquid never calls it. Particle state lives only on the GPU: it
 * is not plant state and is not in a snapshot.
 */
import type { PipelineLayoutCache, MpmPipelines, MpmShaderSources } from '../pipeline-layout/pipeline-layout-cache.js';
import {
  MPM_GRID_CHANNELS, MPM_PARAMS_BYTES, MPM_PARTICLE_BYTES, MPM_PARTICLE_FLOATS,
  mpmDerived, mpmMemoryBytes, packMpmParams, validateMpmConfig, type MpmConfig
} from './mpm-params.js';

/** Invocations per workgroup of the particle passes (mpm-p2g.wgsl, mpm-g2p.wgsl). */
export const MPM_PARTICLE_WORKGROUP = 64;
/** Workgroup edge of the grid pass (mpm-grid.wgsl): 4 × 4 × 4. */
export const MPM_GRID_WORKGROUP = 4;

export class MpmSolver {
  readonly device: GPUDevice;
  /** MPM_PARTICLE_BYTES per record. */
  readonly particleBuffer: GPUBuffer;
  /** Mass + momentum per node, fixed point; valid between p2g and the next clear. */
  readonly gridFixedBuffer: GPUBuffer;
  /** Velocity (m/s) + mass (particle masses) per node, as of the last substep. */
  readonly gridVelBuffer: GPUBuffer;
  readonly paramsBuffer: GPUBuffer;
  private readonly bindGroup: GPUBindGroup;
  private readonly pipelines: MpmPipelines;
  private cfg: MpmConfig;
  private live = 0;
  private paramsDirty = true;
  private readonly paramsScratch = new ArrayBuffer(MPM_PARAMS_BYTES);
  /** Substeps encoded since creation. */
  substeps = 0;

  /** Build the pipelines (cached per shader text) and allocate for `config`. */
  static async create(device: GPUDevice, cache: PipelineLayoutCache, shaders: MpmShaderSources, config: MpmConfig): Promise<MpmSolver> {
    const errors = validateMpmConfig(config);
    if (errors.length) throw new Error(`MpmSolver: ${errors.join('; ')}`);
    const pipelines = await cache.ensureMpmPipelines(shaders);
    return new MpmSolver(device, cache, pipelines, config);
  }

  private constructor(device: GPUDevice, cache: PipelineLayoutCache, pipelines: MpmPipelines, config: MpmConfig) {
    this.device = device;
    this.pipelines = pipelines;
    this.cfg = config;
    const nodes = mpmDerived(config).nodes;
    this.particleBuffer = device.createBuffer({
      label: 'mpm-particles',
      size: config.maxParticles * MPM_PARTICLE_BYTES,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
    });
    this.gridFixedBuffer = device.createBuffer({
      label: 'mpm-grid-fixed',
      size: nodes * MPM_GRID_CHANNELS * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
    });
    this.gridVelBuffer = device.createBuffer({
      label: 'mpm-grid-velocity',
      size: nodes * 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
    });
    this.paramsBuffer = device.createBuffer({
      label: 'mpm-params',
      size: MPM_PARAMS_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    this.bindGroup = cache.createBindGroup('mpm', [
      { binding: 0, resource: { buffer: this.paramsBuffer } },
      { binding: 1, resource: { buffer: this.particleBuffer } },
      { binding: 2, resource: { buffer: this.gridFixedBuffer } },
      { binding: 3, resource: { buffer: this.gridVelBuffer } }
    ]);
  }

  get config(): MpmConfig {
    return this.cfg;
  }

  /** Records the passes visit (live or not — a record with state 0 is skipped). */
  get count(): number {
    return this.live;
  }

  /** GPU bytes held. */
  get memoryBytes(): number {
    return mpmMemoryBytes(this.cfg.gridN, this.cfg.maxParticles) + MPM_PARAMS_BYTES;
  }

  /**
   * Change the material or the step. The grid and the particle budget are
   * what the buffers and the fixed-point scales were sized for, so they
   * cannot change: build a new solver instead.
   */
  setConfig(config: MpmConfig): void {
    const errors = validateMpmConfig(config);
    if (errors.length) throw new Error(`MpmSolver: ${errors.join('; ')}`);
    const same = config.maxParticles === this.cfg.maxParticles && config.gridN.every((n, i) => n === this.cfg.gridN[i]);
    if (!same) throw new Error('MpmSolver: gridN and maxParticles are fixed for the life of a solver');
    this.cfg = config;
    this.paramsDirty = true;
  }

  /** Replace the particle set with `records` (mpm-seed.ts). The passes visit these and no more. */
  writeParticles(records: Float32Array): void {
    const n = records.length / MPM_PARTICLE_FLOATS;
    if (!Number.isInteger(n) || n > this.cfg.maxParticles) throw new Error(`MpmSolver: ${n} particles exceed the budget ${this.cfg.maxParticles}`);
    this.device.queue.writeBuffer(this.particleBuffer, 0, records.buffer, records.byteOffset, records.byteLength);
    this.live = n;
    this.paramsDirty = true;
  }

  /**
   * Encode `substeps` fixed steps of config.dt. The uniform is written once
   * for all of them, so call `setConfig` before, not between.
   */
  encode(encoder: GPUCommandEncoder, substeps: number): void {
    if (substeps <= 0 || this.live === 0) return;
    if (this.paramsDirty) {
      this.device.queue.writeBuffer(this.paramsBuffer, 0, packMpmParams(this.cfg, this.live, this.paramsScratch));
      this.paramsDirty = false;
    }
    const particleGroups = Math.ceil(this.live / MPM_PARTICLE_WORKGROUP);
    const [gx, gy, gz] = this.cfg.gridN.map((n) => Math.ceil(n / MPM_GRID_WORKGROUP));
    for (let s = 0; s < substeps; s++) {
      encoder.clearBuffer(this.gridFixedBuffer);
      const pass = encoder.beginComputePass({ label: 'mpm-substep' });
      pass.setBindGroup(0, this.bindGroup);
      pass.setPipeline(this.pipelines.p2g);
      pass.dispatchWorkgroups(particleGroups);
      pass.setPipeline(this.pipelines.gridUpdate);
      pass.dispatchWorkgroups(gx, gy, gz);
      pass.setPipeline(this.pipelines.g2p);
      pass.dispatchWorkgroups(particleGroups);
      pass.end();
    }
    this.substeps += substeps;
  }

  destroy(): void {
    this.particleBuffer.destroy();
    this.gridFixedBuffer.destroy();
    this.gridVelBuffer.destroy();
    this.paramsBuffer.destroy();
  }
}
