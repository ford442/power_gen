/**
 * WebGPU host of the MHD duct slice (docs/FLUIDS.md → MHD duct → The slice):
 * owns the buffers and encodes the passes. The numbers come from
 * mhd-slice.ts; the CPU twin it is tested against is mhd-slice-cpu.ts.
 *
 * Two bind groups on one layout — the distribution buffers swapped — so a
 * step is: `step` on the current group, then (mid-plane only) the potential's
 * red and black sweeps and the two reductions.
 */
import type { PipelineLayoutCache } from '../pipeline-layout/pipeline-layout-cache.js';
import { ensureMhdSlicePipelines, type MhdSlicePipelines, type MhdSliceShaderSources } from '../pipeline-layout/factories/mhd-slice-pipelines.js';
import { equilibrium } from './mhd-slice-cpu.js';
import {
  MHD_SLICE_COLUMN_FLOATS, MHD_SLICE_FLAG_POTENTIAL, MHD_SLICE_MAX_SEGMENTS, MHD_SLICE_PARAMS_BYTES,
  MHD_SLICE_REDUCE_WORKGROUP, MHD_SLICE_STATE_EXTRA, MHD_SLICE_WORKGROUP,
  mhdSliceBytes, packMhdSliceParams, type MhdSliceConfig
} from './mhd-slice.js';

export interface MhdSliceReadout {
  /** Voltage between each electrode pair, lattice units. */
  voltages: number[];
  /** Current through each pair, in the solver's sum. */
  currents: number[];
}

export class MhdSliceSolver {
  readonly device: GPUDevice;
  readonly nx: number;
  readonly ny: number;
  /** Lattice steps encoded since creation or the last reset. */
  steps = 0;
  /** The latest electrode read-back, or null before the first. */
  readout: MhdSliceReadout | null = null;

  private cfg: MhdSliceConfig;
  private readonly pipelines: MhdSlicePipelines;
  private readonly paramsBuffer: GPUBuffer;
  private readonly columnBuffer: GPUBuffer;
  private readonly fBuffers: [GPUBuffer, GPUBuffer];
  private readonly momentBuffer: GPUBuffer;
  private readonly phiBuffer: GPUBuffer;
  private readonly stateBuffer: GPUBuffer;
  private readonly readBuffer: GPUBuffer;
  private readonly bindGroups: [GPUBindGroup, GPUBindGroup];
  /** Which distribution buffer holds the current state. */
  private current = 0;
  private reading = false;
  private destroyed = false;

  static async create(device: GPUDevice, cache: PipelineLayoutCache, shaders: MhdSliceShaderSources, config: MhdSliceConfig): Promise<MhdSliceSolver> {
    return new MhdSliceSolver(device, cache, await ensureMhdSlicePipelines(cache, shaders), config);
  }

  /** Allocate with pipelines already built: synchronous, for a frame-graph lifetime's `ensure()`. */
  static build(device: GPUDevice, cache: PipelineLayoutCache, pipelines: MhdSlicePipelines, config: MhdSliceConfig): MhdSliceSolver {
    return new MhdSliceSolver(device, cache, pipelines, config);
  }

  private constructor(device: GPUDevice, cache: PipelineLayoutCache, pipelines: MhdSlicePipelines, config: MhdSliceConfig) {
    this.device = device;
    this.pipelines = pipelines;
    this.cfg = config;
    this.nx = config.nx;
    this.ny = config.ny;
    const cells = this.nx * this.ny;
    const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;
    const stateBytes = (this.nx + MHD_SLICE_STATE_EXTRA) * 4;
    this.paramsBuffer = device.createBuffer({ label: 'mhd-slice-params', size: MHD_SLICE_PARAMS_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.columnBuffer = device.createBuffer({ label: 'mhd-slice-columns', size: this.nx * MHD_SLICE_COLUMN_FLOATS * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.fBuffers = [
      device.createBuffer({ label: 'mhd-slice-f0', size: cells * 9 * 4, usage: storage }),
      device.createBuffer({ label: 'mhd-slice-f1', size: cells * 9 * 4, usage: storage })
    ];
    this.momentBuffer = device.createBuffer({ label: 'mhd-slice-moments', size: cells * 16, usage: storage });
    this.phiBuffer = device.createBuffer({ label: 'mhd-slice-phi', size: cells * 4, usage: storage });
    this.stateBuffer = device.createBuffer({ label: 'mhd-slice-state', size: stateBytes, usage: storage });
    this.readBuffer = device.createBuffer({ label: 'mhd-slice-read', size: MHD_SLICE_STATE_EXTRA * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const group = (from: number): GPUBindGroup => cache.createBindGroup('mhdSlice', [
      { binding: 0, resource: { buffer: this.paramsBuffer } },
      { binding: 1, resource: { buffer: this.columnBuffer } },
      { binding: 2, resource: { buffer: this.fBuffers[from] } },
      { binding: 3, resource: { buffer: this.fBuffers[1 - from] } },
      { binding: 4, resource: { buffer: this.momentBuffer } },
      { binding: 5, resource: { buffer: this.phiBuffer } },
      { binding: 6, resource: { buffer: this.stateBuffer } }
    ], `mhd-slice-bg-${from}`);
    this.bindGroups = [group(0), group(1)];
    this.configure(config);
    this.reset();
  }

  get config(): MhdSliceConfig {
    return this.cfg;
  }

  /** Bytes held on the GPU. */
  get bytes(): number {
    return mhdSliceBytes(this.cfg) + MHD_SLICE_STATE_EXTRA * 4 + MHD_SLICE_PARAMS_BYTES;
  }

  /** Per-cell moments (ux, uy, ρ, 0), the potential, and the column / electrode state — for the picture. */
  get moments(): GPUBuffer {
    return this.momentBuffer;
  }

  get potential(): GPUBuffer {
    return this.phiBuffer;
  }

  get state(): GPUBuffer {
    return this.stateBuffer;
  }

  get columns(): GPUBuffer {
    return this.columnBuffer;
  }

  get params(): GPUBuffer {
    return this.paramsBuffer;
  }

  /** New parameters on the same grid: the plant's field and flow change every frame. */
  configure(config: MhdSliceConfig): void {
    if (config.nx !== this.nx || config.ny !== this.ny) throw new Error('MhdSliceSolver.configure: grid size changed');
    this.cfg = config;
    this.device.queue.writeBuffer(this.paramsBuffer, 0, packMhdSliceParams(config));
    this.device.queue.writeBuffer(this.columnBuffer, 0, config.columns.buffer, config.columns.byteOffset, config.columns.byteLength);
  }

  /** Fluid at rest density moving at the inlet speed; no potential, no voltages. */
  reset(): void {
    const cells = this.nx * this.ny;
    const f = new Float32Array(cells * 9);
    const m = new Float32Array(cells * 4);
    const u0 = this.cfg.inletU;
    const eq = new Float32Array(9);
    for (let q = 0; q < 9; q++) eq[q] = equilibrium(q, 1, u0, 0);
    for (let c = 0; c < cells; c++) {
      f.set(eq, c * 9);
      m[c * 4] = u0;
      m[c * 4 + 2] = 1;
    }
    this.device.queue.writeBuffer(this.fBuffers[0], 0, f);
    this.device.queue.writeBuffer(this.fBuffers[1], 0, f);
    this.device.queue.writeBuffer(this.momentBuffer, 0, m);
    this.device.queue.writeBuffer(this.phiBuffer, 0, new Float32Array(cells));
    this.device.queue.writeBuffer(this.stateBuffer, 0, new Float32Array(this.nx + MHD_SLICE_STATE_EXTRA));
    this.current = 0;
    this.steps = 0;
  }

  /** Encode `n` lattice steps into a compute pass. */
  encode(pass: GPUComputePassEncoder, n = 1): void {
    const gx = Math.ceil(this.nx / MHD_SLICE_WORKGROUP);
    const gy = Math.ceil(this.ny / MHD_SLICE_WORKGROUP);
    // A colour of the potential's sweep visits every other column.
    const gxHalf = Math.ceil(Math.ceil(this.nx / 2) / MHD_SLICE_WORKGROUP);
    const potential = (this.cfg.flags & MHD_SLICE_FLAG_POTENTIAL) !== 0;
    for (let s = 0; s < n; s++) {
      pass.setBindGroup(0, this.bindGroups[this.current]);
      pass.setPipeline(this.pipelines.step);
      pass.dispatchWorkgroups(gx, gy);
      this.current = 1 - this.current;
      if (potential) {
        for (let k = 0; k < this.cfg.sorSweeps; k++) {
          pass.setPipeline(this.pipelines.sorRed);
          pass.dispatchWorkgroups(gxHalf, gy);
          pass.setPipeline(this.pipelines.sorBlack);
          pass.dispatchWorkgroups(gxHalf, gy);
        }
        pass.setPipeline(this.pipelines.reduceColumns);
        pass.dispatchWorkgroups(Math.ceil(this.nx / MHD_SLICE_REDUCE_WORKGROUP));
        pass.setPipeline(this.pipelines.reduceElectrodes);
        pass.dispatchWorkgroups(1);
      }
      this.steps++;
    }
  }

  /** Encode `n` steps in a compute pass of their own. */
  encodeSteps(encoder: GPUCommandEncoder, n = 1): void {
    const pass = encoder.beginComputePass({ label: 'mhd-slice' });
    this.encode(pass, n);
    pass.end();
  }

  /**
   * Ask for the electrodes' voltages and currents. Encodes the copy; call
   * {@link resolveReadout} after the encoder is submitted. One at a time: a
   * request while the last is still mapped is skipped.
   */
  requestReadout(encoder: GPUCommandEncoder): boolean {
    if (this.reading || this.destroyed) return false;
    encoder.copyBufferToBuffer(this.stateBuffer, this.nx * 4, this.readBuffer, 0, MHD_SLICE_STATE_EXTRA * 4);
    this.reading = true;
    return true;
  }

  async resolveReadout(): Promise<MhdSliceReadout | null> {
    if (!this.reading) return this.readout;
    try {
      await this.readBuffer.mapAsync(GPUMapMode.READ);
      const data = new Float32Array(this.readBuffer.getMappedRange().slice(0));
      this.readBuffer.unmap();
      const n = this.cfg.segments;
      this.readout = {
        voltages: Array.from(data.subarray(0, n)),
        currents: Array.from(data.subarray(MHD_SLICE_MAX_SEGMENTS, MHD_SLICE_MAX_SEGMENTS + n))
      };
    } catch {
      // Destroyed or the device was lost while the copy was pending: keep the last read-back.
    } finally {
      this.reading = false;
    }
    return this.readout;
  }

  /** The distributions as they stand (tests). */
  get distributions(): GPUBuffer {
    return this.fBuffers[this.current];
  }

  destroy(): void {
    this.destroyed = true;
    for (const b of [this.paramsBuffer, this.columnBuffer, ...this.fBuffers, this.momentBuffer, this.phiBuffer, this.stateBuffer, this.readBuffer]) b.destroy();
  }
}
