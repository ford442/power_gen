/**
 * The MHD duct slice in the app — the pass (docs/FLUIDS.md → MHD duct → The
 * slice). WebGPU only, MHD in focus; built by mhd-slice-pass.ts the first
 * frame its gate opens, in the lazily loaded liquid chunk.
 *
 * The plant is the authority: each frame its field and mean speed configure
 * the solver (the field's strength, the inflow), the solver steps as many
 * lattice steps as the displayed time owes at the picture's slow-down, and
 * the panel is drawn in the scene pass. What comes back is for the reader,
 * not the plant: the voltage of each electrode pair and the current that
 * reaches the loads.
 */
import type { MultiDeviceVisualizer } from '../multi-device-visualizer.js';
import type { ResourceLifetime } from './frame-graph';
import { ensureMhdSliceDrawPipeline, ensureMhdSlicePipelines, type MhdSlicePipelines } from '../pipeline-layout/factories/mhd-slice-pipelines';
import {
  MHD_SLICE_DRAW_BYTES, mhdSliceConfig, mhdSliceStepsPerSecond, mhdSliceUnits, packMhdSliceDraw, type MhdSliceConfig
} from '../fluids/mhd-slice';
import { MHD_SLICE_SHADERS } from '../fluids/mhd-slice-shaders';
import { MhdSliceSolver } from '../fluids/mhd-slice-solver';

type Host = MultiDeviceVisualizer;

/** Most lattice steps encoded in one frame: a slow frame shows a slower picture, not a longer frame. */
const MAX_STEPS_PER_FRAME = 32;
/** Frames between two read-backs of the electrodes. */
const READ_EVERY = 12;

export interface MhdSliceFrame {
  /** The plant's field under the poles, T, and its mean speed, m/s. */
  bFieldT: number;
  flowU: number;
  /** Displayed seconds since the last frame. */
  frameDt: number;
  devicePos: ArrayLike<number>;
}

export interface MhdSliceElectrodes {
  /** Volts between each electrode pair, and amperes through its load. */
  volts: number[];
  amps: number[];
  totalAmps: number;
}

export class MhdSlicePass {
  ready = false;
  /** True on a frame `update` asked for work. */
  active = false;
  solver: MhdSliceSolver | null = null;
  /** The latest electrode read-back in SI, or null before the first. */
  electrodes: MhdSliceElectrodes | null = null;
  private pipelines: MhdSlicePipelines | null = null;
  private drawBase: GPURenderPipeline | null = null;
  private drawMsaa4: GPURenderPipeline | null = null;
  private drawBuffer: GPUBuffer | null = null;
  private drawBindGroup: GPUBindGroup | null = null;
  private readonly drawScratch = new Float32Array(MHD_SLICE_DRAW_BYTES / 4);
  private config: MhdSliceConfig | null = null;
  private fieldT = 0;
  private stepDebt = 0;
  private stepsNow = 0;
  private frame = 0;

  constructor(private readonly device: GPUDevice, private readonly host: Host) {}

  async init(): Promise<boolean> {
    const cache = this.host.pipelineCache;
    if (!cache) return false;
    [this.pipelines, this.drawBase, this.drawMsaa4] = await Promise.all([
      ensureMhdSlicePipelines(cache, MHD_SLICE_SHADERS),
      ensureMhdSliceDrawPipeline(cache, MHD_SLICE_SHADERS.draw),
      ensureMhdSliceDrawPipeline(cache, MHD_SLICE_SHADERS.draw, { sampleCount: 4 })
    ]);
    this.ready = true;
    return true;
  }

  lifetime(): ResourceLifetime {
    return {
      name: 'mhd-slice',
      isAllocated: () => !!this.solver,
      ensure: () => this.allocate(),
      release: () => this.release()
    };
  }

  private allocate(): void {
    const cache = this.host.pipelineCache;
    if (this.solver || !this.pipelines || !cache || !this.config) return;
    const solver = MhdSliceSolver.build(this.device, cache, this.pipelines, this.config);
    this.drawBuffer = this.device.createBuffer({ label: 'mhd-slice-draw', size: MHD_SLICE_DRAW_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.drawBindGroup = cache.createBindGroup('mhdSliceDraw', [
      { binding: 1, resource: { buffer: this.drawBuffer } },
      { binding: 2, resource: { buffer: solver.params } },
      { binding: 3, resource: { buffer: solver.columns } },
      { binding: 4, resource: { buffer: solver.moments } },
      { binding: 6, resource: { buffer: solver.state } }
    ], 'mhd-slice-draw-bg');
    this.solver = solver;
    this.stepDebt = 0;
    this.electrodes = null;
  }

  private release(): void {
    this.solver?.destroy();
    this.solver = null;
    this.drawBuffer?.destroy();
    this.drawBuffer = null;
    this.drawBindGroup = null;
    this.electrodes = null;
  }

  /** Not wanted this frame: nothing is stepped or drawn, and the graph may release. */
  idle(): void {
    this.active = false;
    this.stepsNow = 0;
  }

  /** Per frame, in focus. */
  update(o: MhdSliceFrame): void {
    this.active = true;
    this.config = mhdSliceConfig({ bFieldT: o.bFieldT, flowU: o.flowU });
    const solver = this.solver;
    if (!solver) {
      this.stepsNow = 0;
      return; // the graph allocates before the next encode
    }
    // The read-back of an earlier frame, if its copy has been submitted, in the field it was taken at.
    const units = mhdSliceUnits(this.fieldT);
    void solver.resolveReadout().then((r) => {
      if (!r || this.solver !== solver) return;
      const volts = r.voltages.map((v) => v * units.volts);
      const amps = r.currents.map((c) => c * units.amps);
      this.electrodes = { volts, amps, totalAmps: amps.reduce((a, x) => a + x, 0) };
    });
    this.fieldT = Number.isFinite(o.bFieldT) ? o.bFieldT : 0;
    solver.configure(this.config);
    this.device.queue.writeBuffer(this.drawBuffer!, 0, packMhdSliceDraw(this.config, o, this.drawScratch));

    this.stepDebt = Math.min(this.stepDebt + Math.max(0, o.frameDt) * mhdSliceStepsPerSecond(), MAX_STEPS_PER_FRAME);
    this.stepsNow = Math.floor(this.stepDebt);
    this.stepDebt -= this.stepsNow;
  }

  /** The frame-graph pass body: true whenever the solver exists and is wanted. */
  encode(encoder: GPUCommandEncoder): boolean {
    const solver = this.solver;
    if (!this.active || !solver) return false;
    if (this.stepsNow > 0) solver.encodeSteps(encoder, this.stepsNow, { streamFunction: true });
    if (this.frame++ % READ_EVERY === 0) solver.requestReadout(encoder);
    return true;
  }

  /** Draw the panel inside the scene pass, after the opaque meshes. */
  draw(pass: GPURenderPassEncoder, msaaActive: boolean): void {
    const pipeline = msaaActive ? this.drawMsaa4 : this.drawBase;
    if (!this.active || !this.solver || !pipeline || !this.drawBindGroup || this.solver.steps === 0) return;
    pass.setPipeline(pipeline);
    // @group(0) is the scene's frame group, bound once by the scene pass.
    pass.setBindGroup(1, this.drawBindGroup);
    pass.draw(6);
  }

  destroy(): void {
    this.release();
    this.ready = false;
  }
}
