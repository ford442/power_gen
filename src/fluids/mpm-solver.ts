/**
 * MLS-MPM liquid solver — the WebGPU host (ADR-0022). Owns the particle
 * buffer, the two grids and the bind groups, and encodes frames: emitters
 * and sinks, then substeps (a grid clear and the three passes of
 * passes/mpm-{p2g,grid,g2p}.wgsl), then the read-back profile and the export
 * the particle pipeline draws.
 *
 * Nothing here is allocated until `create` is called, and a bench that does
 * not own a liquid never calls it. Particle state lives only on the GPU: it
 * is not plant state and is not in a snapshot.
 */
import type { PipelineLayoutCache, MpmPipelines, MpmShaderSources } from '../pipeline-layout/pipeline-layout-cache.js';
import {
  MPM_BOUNDARY_FLOATS, MPM_COUNTER_WORDS, MPM_FLAG_BOUNDARY, MPM_GRID_CHANNELS, MPM_IO_PARAMS_BYTES, MPM_MAX_CONDUCTORS,
  MPM_MAX_SINKS, MPM_PARAMS_BYTES, MPM_PARTICLE_BYTES, MPM_PARTICLE_FLOATS, MPM_PROBE_EXTRA_WORDS, MPM_PROBE_MASS_SCALE,
  mpmDerived, mpmEmitCounts, mpmMemoryBytes, packMpmIoParams, packMpmParams, validateMpmConfig,
  type MpmConductor, type MpmConfig, type MpmEmitter, type MpmProfile, type MpmSink
} from './mpm-params.js';

/** Invocations per workgroup of the particle passes (mpm-p2g, mpm-g2p, mpm-emit, mpm-export). */
export const MPM_PARTICLE_WORKGROUP = 64;
/** Workgroup edge of the grid pass (mpm-grid.wgsl): 4 × 4 × 4. */
export const MPM_GRID_WORKGROUP = 4;
/** Bytes per record of the draw export: a `GpuParticle` (common/particle.wgsl). */
export const MPM_DRAW_BYTES = 16;

export interface MpmSolverOptions {
  /** Solids as a baked signed-distance field (`bakeMpmBoundary`). Omit for the bare box. */
  boundary?: Float32Array;
  /**
   * Allocate what emitters, sinks, the profile read-back and the draw export
   * need. The passes then visit every slot of the budget, since a new
   * particle may land in any empty one.
   */
  io?: boolean;
}

export class MpmSolver {
  readonly device: GPUDevice;
  /** MPM_PARTICLE_BYTES per record. */
  readonly particleBuffer: GPUBuffer;
  /** Mass + momentum per node, fixed point; valid between p2g and the next clear. */
  readonly gridFixedBuffer: GPUBuffer;
  /** Velocity (m/s) + mass (particle masses) per node, as of the last substep. */
  readonly gridVelBuffer: GPUBuffer;
  readonly paramsBuffer: GPUBuffer;
  /** Signed-distance field per node, or a one-node dummy when there are no solids. */
  readonly boundaryBuffer: GPUBuffer;
  /** One `GpuParticle` per slot for the particle pipeline; null without `io`. */
  readonly drawBuffer: GPUBuffer | null = null;
  private readonly ioParamsBuffer: GPUBuffer | null = null;
  private readonly counterBuffer: GPUBuffer | null = null;
  private readonly profileBuffer: GPUBuffer | null = null;
  private readonly profileReadBuffer: GPUBuffer | null = null;
  private readonly bindGroup: GPUBindGroup;
  private readonly ioBindGroup: GPUBindGroup | null = null;
  private readonly pipelines: MpmPipelines;
  private readonly hasBoundary: boolean;
  private cfg: MpmConfig;
  private live = 0;
  private paramsDirty = true;
  private readonly paramsScratch = new ArrayBuffer(MPM_PARAMS_BYTES);
  private readonly ioScratch = new ArrayBuffer(MPM_IO_PARAMS_BYTES);
  private readonly emitCarry: number[] = [];
  private nextId = 0;
  private profileCopied = false;
  private profilePending = false;
  /** Substeps encoded since creation. */
  substeps = 0;

  /** Round nozzles feeding the liquid (at most MPM_MAX_EMITTERS). Change freely between frames. */
  emitters: MpmEmitter[] = [];
  /** Boxes that remove liquid (at most MPM_MAX_SINKS). */
  sinks: MpmSink[] = [];
  /** Draw export: scene position = exportOrigin + metres · exportScale. */
  exportOrigin: [number, number, number] = [0, 0, 0];
  exportScale = 1;
  private conductorList: readonly MpmConductor[] = [];
  /** A surface pass draws the bulk liquid this frame (mpm-export.wgsl writes type 11 for it). */
  exportSurface = false;
  /** Density over rest density under which a particle is exported as spray; 0 = never. */
  sprayBelow = 0;
  /** The latest profile to come back, or null before the first. */
  profile: MpmProfile | null = null;

  /** Build the pipelines (cached per shader text) and allocate for `config`. */
  static async create(
    device: GPUDevice,
    cache: PipelineLayoutCache,
    shaders: MpmShaderSources,
    config: MpmConfig,
    options: MpmSolverOptions = {}
  ): Promise<MpmSolver> {
    const errors = validateMpmConfig(config);
    if (errors.length) throw new Error(`MpmSolver: ${errors.join('; ')}`);
    const pipelines = await cache.ensureMpmPipelines(shaders);
    return new MpmSolver(device, cache, pipelines, config, options);
  }

  /**
   * Allocate with pipelines already built (`cache.ensureMpmPipelines`):
   * synchronous, for a frame-graph lifetime's `ensure()`.
   */
  static build(device: GPUDevice, cache: PipelineLayoutCache, pipelines: MpmPipelines, config: MpmConfig, options: MpmSolverOptions = {}): MpmSolver {
    const errors = validateMpmConfig(config);
    if (errors.length) throw new Error(`MpmSolver: ${errors.join('; ')}`);
    return new MpmSolver(device, cache, pipelines, config, options);
  }

  private constructor(device: GPUDevice, cache: PipelineLayoutCache, pipelines: MpmPipelines, config: MpmConfig, options: MpmSolverOptions) {
    this.device = device;
    this.pipelines = pipelines;
    this.cfg = config;
    const nodes = mpmDerived(config).nodes;
    const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;
    this.particleBuffer = device.createBuffer({ label: 'mpm-particles', size: config.maxParticles * MPM_PARTICLE_BYTES, usage: storage });
    this.gridFixedBuffer = device.createBuffer({ label: 'mpm-grid-fixed', size: nodes * MPM_GRID_CHANNELS * 4, usage: storage });
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
    this.hasBoundary = !!options.boundary;
    if (options.boundary && options.boundary.length !== nodes * MPM_BOUNDARY_FLOATS) {
      throw new Error('MpmSolver: boundary field does not match the grid');
    }
    this.boundaryBuffer = device.createBuffer({
      label: 'mpm-boundary',
      size: (options.boundary ? nodes : 1) * MPM_BOUNDARY_FLOATS * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    if (options.boundary) {
      device.queue.writeBuffer(this.boundaryBuffer, 0, options.boundary.buffer, options.boundary.byteOffset, options.boundary.byteLength);
    }
    this.bindGroup = cache.createBindGroup('mpm', [
      { binding: 0, resource: { buffer: this.paramsBuffer } },
      { binding: 1, resource: { buffer: this.particleBuffer } },
      { binding: 2, resource: { buffer: this.gridFixedBuffer } },
      { binding: 3, resource: { buffer: this.gridVelBuffer } },
      { binding: 4, resource: { buffer: this.boundaryBuffer } }
    ]);

    if (options.io) {
      const profileBytes = (config.gridN[1] + MPM_PROBE_EXTRA_WORDS) * 4;
      this.ioParamsBuffer = device.createBuffer({
        label: 'mpm-io-params',
        size: MPM_IO_PARAMS_BYTES,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
      });
      this.counterBuffer = device.createBuffer({ label: 'mpm-counters', size: MPM_COUNTER_WORDS * 4, usage: storage });
      this.profileBuffer = device.createBuffer({
        label: 'mpm-profile',
        size: profileBytes,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
      });
      this.profileReadBuffer = device.createBuffer({
        label: 'mpm-profile-read',
        size: profileBytes,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
      });
      this.drawBuffer = device.createBuffer({
        label: 'mpm-draw',
        size: config.maxParticles * MPM_DRAW_BYTES,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
      });
      this.ioBindGroup = cache.createBindGroup('mpmIo', [
        { binding: 0, resource: { buffer: this.paramsBuffer } },
        { binding: 1, resource: { buffer: this.particleBuffer } },
        { binding: 2, resource: { buffer: this.ioParamsBuffer } },
        { binding: 3, resource: { buffer: this.counterBuffer } },
        { binding: 4, resource: { buffer: this.gridVelBuffer } },
        { binding: 5, resource: { buffer: this.profileBuffer } },
        { binding: 6, resource: { buffer: this.drawBuffer } }
      ]);
      // A new particle may land in any empty slot, so every slot is visited.
      this.live = config.maxParticles;
    }
  }

  get config(): MpmConfig {
    return this.cfg;
  }

  /** Records the passes visit (live or not — a record with state 0 is skipped). */
  get count(): number {
    return this.live;
  }

  /** True when the solver was created with `io`. */
  get hasIo(): boolean {
    return !!this.ioBindGroup;
  }

  /** Particles asked of the emitters since creation; also the next particle's id. */
  get emitRequested(): number {
    return this.nextId;
  }

  /** GPU bytes held. */
  get memoryBytes(): number {
    let bytes = mpmMemoryBytes(this.cfg.gridN, this.cfg.maxParticles) + MPM_PARAMS_BYTES + this.boundaryBuffer.size;
    for (const b of [this.ioParamsBuffer, this.counterBuffer, this.profileBuffer, this.profileReadBuffer, this.drawBuffer]) bytes += b?.size ?? 0;
    return bytes;
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

  /**
   * Replace the particle set with `records` (mpm-seed.ts). Without `io` the
   * passes visit these and no more; with it the rest of the budget must be
   * empty slots, so the whole buffer is rewritten.
   */
  writeParticles(records: Float32Array): void {
    const n = records.length / MPM_PARTICLE_FLOATS;
    if (!Number.isInteger(n) || n > this.cfg.maxParticles) throw new Error(`MpmSolver: ${n} particles exceed the budget ${this.cfg.maxParticles}`);
    if (this.ioBindGroup) {
      const all = new Float32Array(this.cfg.maxParticles * MPM_PARTICLE_FLOATS);
      new Uint8Array(all.buffer).set(new Uint8Array(records.buffer, records.byteOffset, records.byteLength));
      this.device.queue.writeBuffer(this.particleBuffer, 0, all.buffer);
    } else {
      this.device.queue.writeBuffer(this.particleBuffer, 0, records.buffer, records.byteOffset, records.byteLength);
      this.live = n;
    }
    this.paramsDirty = true;
  }

  /**
   * The conductors charged particles feel from the next encode on. Their
   * charges follow the bench's plant, so a bench sets them every frame.
   */
  setConductors(conductors: readonly MpmConductor[]): void {
    if (conductors.length > MPM_MAX_CONDUCTORS) throw new Error(`MpmSolver: ${conductors.length} conductors, the limit is ${MPM_MAX_CONDUCTORS}`);
    if (conductors.length === 0 && this.conductorList.length === 0) return;
    this.conductorList = conductors;
    this.paramsDirty = true;
  }

  get conductors(): readonly MpmConductor[] {
    return this.conductorList;
  }

  private uploadParams(): void {
    if (!this.paramsDirty) return;
    const flags = this.hasBoundary ? MPM_FLAG_BOUNDARY : 0;
    this.device.queue.writeBuffer(this.paramsBuffer, 0, packMpmParams(this.cfg, this.live, this.paramsScratch, flags, this.conductorList));
    this.paramsDirty = false;
  }

  /**
   * Encode `substeps` fixed steps of config.dt and nothing else. The uniform
   * is written once for all of them, so call `setConfig` before, not between.
   */
  encode(encoder: GPUCommandEncoder, substeps: number): void {
    if (substeps <= 0 || this.live === 0) return;
    this.uploadParams();
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

  /**
   * Encode one frame of an `io` solver: sinks and emitters (the emitters owe
   * `substeps · dt` seconds of flow), the substeps, the draw export, and —
   * when `probe` is set and no read-back is in flight — the profile and its
   * copy. Call `collectProfile()` after submitting.
   */
  encodeFrame(encoder: GPUCommandEncoder, substeps: number, opts: { probe?: boolean } = {}): void {
    if (!this.ioBindGroup || !this.ioParamsBuffer || !this.counterBuffer) throw new Error('MpmSolver: encodeFrame needs a solver created with io');
    if (substeps <= 0) return;
    const seconds = substeps * this.cfg.dt;
    const counts = mpmEmitCounts(this.cfg, this.emitters, seconds, this.emitCarry);
    this.device.queue.writeBuffer(this.ioParamsBuffer, 0, packMpmIoParams(this.cfg, {
      emitters: this.emitters,
      counts,
      seconds,
      baseId: this.nextId,
      sinks: this.sinks,
      exportOrigin: this.exportOrigin,
      exportScale: this.exportScale,
      surface: this.exportSurface,
      sprayBelow: this.sprayBelow
    }, this.ioScratch));
    this.nextId = (this.nextId + counts.reduce((a, n) => a + n, 0)) >>> 0;
    this.uploadParams();
    const slotGroups = Math.ceil(this.cfg.maxParticles / MPM_PARTICLE_WORKGROUP);

    // The ticket word only; the totals after it accumulate for the solver's life.
    encoder.clearBuffer(this.counterBuffer, 0, 4);
    const emit = encoder.beginComputePass({ label: 'mpm-emit' });
    emit.setBindGroup(0, this.ioBindGroup);
    emit.setPipeline(this.pipelines.emit);
    emit.dispatchWorkgroups(slotGroups);
    emit.end();

    this.encode(encoder, substeps);

    const out = encoder.beginComputePass({ label: 'mpm-export' });
    out.setBindGroup(0, this.ioBindGroup);
    const wantProbe = !!opts.probe && !this.profilePending && !this.profileCopied;
    if (wantProbe) {
      out.setPipeline(this.pipelines.probe);
      out.dispatchWorkgroups(this.cfg.gridN[1] + 1);
    }
    out.setPipeline(this.pipelines.exportDraw);
    out.dispatchWorkgroups(slotGroups);
    out.end();
    if (wantProbe && this.profileBuffer && this.profileReadBuffer) {
      encoder.copyBufferToBuffer(this.profileBuffer, 0, this.profileReadBuffer, 0, this.profileBuffer.size);
      this.profileCopied = true;
    }
  }

  /**
   * After submitting a frame encoded with `probe`: start mapping the copy.
   * Resolves with the profile (also kept as `this.profile`), or null when no
   * copy was encoded or one is already on its way. Never blocks a frame.
   */
  collectProfile(): Promise<MpmProfile | null> {
    const buf = this.profileReadBuffer;
    if (!buf || !this.profileCopied || this.profilePending) return Promise.resolve(null);
    this.profileCopied = false;
    this.profilePending = true;
    const ny = this.cfg.gridN[1];
    return buf.mapAsync(GPUMapMode.READ).then(() => {
      const words = new Uint32Array(buf.getMappedRange().slice(0));
      buf.unmap();
      this.profilePending = false;
      const layers = new Float32Array(ny);
      for (let j = 0; j < ny; j++) layers[j] = words[j] / MPM_PROBE_MASS_SCALE;
      this.profile = { layers, emitted: words[ny], sunk: words[ny + 1], sunkBy: Array.from(words.subarray(ny + 2, ny + 2 + MPM_MAX_SINKS)) };
      return this.profile;
    }, () => {
      // Destroyed or lost while mapping: there is no profile to report.
      this.profilePending = false;
      return null;
    });
  }

  destroy(): void {
    for (const b of [
      this.particleBuffer, this.gridFixedBuffer, this.gridVelBuffer, this.paramsBuffer, this.boundaryBuffer,
      this.ioParamsBuffer, this.counterBuffer, this.profileBuffer, this.profileReadBuffer, this.drawBuffer
    ]) b?.destroy();
  }
}
