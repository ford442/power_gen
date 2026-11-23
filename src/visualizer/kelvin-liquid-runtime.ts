/**
 * Kelvin's dropper on the liquid solver — the part that owns GPU resources
 * (ADR-0022, docs/FLUIDS.md → Kelvin). WebGPU only, loaded on demand by
 * kelvin-liquid-pass.ts the first frame its gate opens: it shares the liquid
 * chunk with Heron's pass.
 *
 * The pass owns an MLS-MPM solver while the bench is in focus. Each frame it
 * gives the two drip tips the plant's flow and the charge the rings induce,
 * sets the four conductors to the plant's potential, and reads back what the
 * collectors took against what reached the floor. The drops are always
 * particles: nothing here is thick enough to be a surface.
 */
import type { MultiDeviceVisualizer } from '../multi-device-visualizer.js';
import type { MpmPipelines } from '../pipeline-layout/pipeline-layout-cache.js';
import type { ResourceLifetime } from './frame-graph';
import { MPM_SHADERS } from '../fluids/mpm-shaders';
import { MpmSolver } from '../fluids/mpm-solver';
import {
  KelvinEfficiency, kelvinConductors, kelvinEmitters, kelvinLanded, kelvinLiquidScene,
  type KelvinLiquidScene
} from '../fluids/kelvin-liquid';

type Host = MultiDeviceVisualizer;

/** Frames between profile read-backs. */
const PROBE_EVERY = 6;
/** Most substeps a frame may run: four nominal frames' worth. */
const MAX_SUBSTEPS_PER_FRAME = 64;

export class KelvinLiquidPass {
  ready = false;
  /** True on a frame `update` asked for work. */
  active = false;
  solver: MpmSolver | null = null;
  scene: KelvinLiquidScene | null = null;
  /** Drops the collectors took / that reached the floor, as of the last read-back. */
  landed = 0;
  missed = 0;
  /** The share that landed over the last seconds; null while too few have come down to say. */
  readonly efficiency = new KelvinEfficiency();
  private pipelines: MpmPipelines | null = null;
  private substepDebt = 0;
  private substepsNow = 0;
  private frame = 0;
  private clock = 0;

  constructor(private readonly device: GPUDevice, private readonly host: Host) {}

  async init(): Promise<boolean> {
    const cache = this.host.pipelineCache;
    if (!cache) return false;
    this.pipelines = await cache.ensureMpmPipelines(MPM_SHADERS);
    this.ready = true;
    return true;
  }

  lifetime(): ResourceLifetime {
    return {
      name: 'kelvin-liquid',
      isAllocated: () => !!this.solver,
      ensure: () => this.allocate(),
      release: () => this.release()
    };
  }

  private allocate(): void {
    const cache = this.host.pipelineCache;
    if (this.solver || !this.pipelines || !cache) return;
    const scene = kelvinLiquidScene();
    this.solver = MpmSolver.build(this.device, cache, this.pipelines, scene.config, { io: true });
    this.solver.sinks = scene.sinks;
    this.solver.exportOrigin = scene.origin;
    this.solver.exportScale = scene.scale;
    this.scene = scene;
    this.substepDebt = 0;
    this.landed = 0;
    this.missed = 0;
    this.efficiency.reset();
  }

  private release(): void {
    this.solver?.destroy();
    this.solver = null;
    this.scene = null;
    this.landed = 0;
    this.missed = 0;
    this.efficiency.reset();
  }

  /** Not wanted this frame: nothing is stepped or drawn, and the graph may release. */
  idle(): void {
    this.active = false;
    this.substepsNow = 0;
  }

  /**
   * Per frame, in focus.
   * @param o.drive the plant's drive: the tips' flow
   * @param o.volts what the rings stand at: the plant's voltage plus any coupled seed
   * @param o.frameDt displayed seconds since the last frame
   * @returns the landing share, or null while it is not known
   */
  update(o: { drive: number; volts: number; frameDt: number }): number | null {
    this.active = true;
    const solver = this.solver;
    const scene = this.scene;
    if (!solver || !scene) {
      this.substepsNow = 0;
      return null; // the graph allocates before the next encode
    }
    this.clock += Math.max(0, o.frameDt);

    // The read-back of an earlier frame, if its copy has been submitted.
    const clock = this.clock;
    void solver.collectProfile().then((p) => {
      if (!p || this.solver !== solver) return;
      const { landed, missed } = kelvinLanded(p.sunkBy);
      this.landed = landed;
      this.missed = missed;
      this.efficiency.update(clock, landed, missed);
    });

    // Fixed substeps, as many as the displayed time owes at the bench's time
    // scale. The bound is generous — the grid is small and a substep cheap —
    // because here falling behind is not only a slower picture: the plant
    // keeps real time, and drops that fall slower than it see more of its
    // voltage swing than they should and miss more. Down to 15 fps they keep pace.
    const maxSubsteps = Math.max(2 * scene.substepsPerFrame, MAX_SUBSTEPS_PER_FRAME);
    this.substepDebt = Math.min(this.substepDebt + (Math.max(0, o.frameDt) * scene.timeScale) / scene.config.dt, maxSubsteps);
    this.substepsNow = Math.floor(this.substepDebt);
    this.substepDebt -= this.substepsNow;

    solver.emitters = kelvinEmitters(scene, o.drive, o.volts);
    solver.setConductors(kelvinConductors(scene, o.volts));
    // Every drop is on its own: drawn as particles, none as spray-or-surface.
    solver.sprayBelow = 0;
    solver.exportSurface = false;
    return this.efficiency.value;
  }

  /** The frame-graph pass body: true whenever the solver exists and is wanted. */
  encode(encoder: GPUCommandEncoder): boolean {
    const solver = this.solver;
    if (!this.active || !solver) return false;
    if (this.substepsNow > 0) solver.encodeFrame(encoder, this.substepsNow, { probe: this.frame++ % PROBE_EVERY === 0 });
    return true;
  }

  /** The records the particle pipeline should draw for the bench this frame, or null. */
  draw(): { buffer: GPUBuffer; count: number } | null {
    const solver = this.solver;
    if (!this.active || !solver?.drawBuffer || solver.substeps === 0) return null;
    return { buffer: solver.drawBuffer, count: solver.config.maxParticles };
  }

  destroy(): void {
    this.release();
    this.ready = false;
  }
}
