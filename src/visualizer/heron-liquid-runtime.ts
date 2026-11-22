/**
 * Heron's fountain as a liquid — the part that owns GPU resources (ADR-0022,
 * docs/FLUIDS.md → Heron). WebGPU only.
 *
 * Loaded on demand: `updateHeronLiquid` (heron-liquid-pass.ts) imports this
 * module the first frame its gate opens, so the solver, its boundary bake and
 * its six shaders are a chunk of their own and a visit that never brings
 * Heron into focus does not download them.
 *
 * The pass owns an MLS-MPM solver while the bench is in focus, drives its
 * nozzle with the plant's exit speed, and reads back the height of the jet
 * above the nozzle. Nothing is allocated until the frame graph asks
 * (lifetime `heron-liquid`).
 */
import type { MultiDeviceVisualizer } from '../multi-device-visualizer.js';
import type { MpmPipelines } from '../pipeline-layout/pipeline-layout-cache.js';
import type { ResourceLifetime } from './frame-graph';
import { getHeronLayout } from '../heron-layout';
import { bakeMpmBoundary } from '../fluids/mpm-boundary';
import { mpmProfileTop, type MpmTier } from '../fluids/mpm-params';
import { MPM_SHADERS } from '../fluids/mpm-shaders';
import { MpmSolver } from '../fluids/mpm-solver';
import {
  heronEmitters, heronLiquidPlacement, heronLiquidScene, heronRiserM,
  type HeronLiquidScene
} from '../fluids/heron-liquid';

type Host = MultiDeviceVisualizer;

/** Frames between profile read-backs. */
const PROBE_EVERY = 6;

export class HeronLiquidPass {
  ready = false;
  /** True on a frame `update` asked for work. */
  active = false;
  solver: MpmSolver | null = null;
  scene: HeronLiquidScene | null = null;
  tier: MpmTier | null = null;
  layoutId: string | null = null;
  /** Jet height above the nozzle from the last read-back, m; 0 before the first. */
  jetHeightM = 0;
  private pipelines: MpmPipelines | null = null;
  private wantTier: MpmTier = 'default';
  private wantLayout = 'classic';
  private substepDebt = 0;
  private substepsNow = 0;
  private frame = 0;

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
      name: 'heron-liquid',
      isAllocated: () => !!this.solver,
      ensure: () => this.allocate(),
      release: () => this.release()
    };
  }

  private allocate(): void {
    const cache = this.host.pipelineCache;
    if (this.solver || !this.pipelines || !cache) return;
    const layout = getHeronLayout(this.wantLayout);
    const scene = heronLiquidScene({ ...layout, riserM: heronRiserM(layout) }, this.wantTier);
    this.solver = MpmSolver.build(this.device, cache, this.pipelines, scene.config, {
      boundary: bakeMpmBoundary(scene.config, scene.solids),
      io: true
    });
    this.solver.sinks = scene.sinks;
    this.scene = scene;
    this.tier = this.wantTier;
    this.layoutId = this.wantLayout;
    this.substepDebt = 0;
    this.jetHeightM = 0;
  }

  private release(): void {
    this.solver?.destroy();
    this.solver = null;
    this.scene = null;
    this.tier = null;
    this.layoutId = null;
    this.jetHeightM = 0;
  }

  /** Not wanted this frame: nothing is stepped or drawn, and the graph may release. */
  idle(): void {
    this.active = false;
    this.substepsNow = 0;
  }

  /**
   * Per frame, in focus. A change of tier or layout preset releases the
   * solver; the frame graph allocates the new one before the next encode.
   * @returns true when the frame-graph pass should run
   */
  update(o: { tier: MpmTier; layoutId: string; vExitMS: number; frameDt: number; nozzleScene: readonly [number, number, number] }): boolean {
    this.wantTier = o.tier;
    this.wantLayout = o.layoutId;
    if (this.solver && (this.tier !== o.tier || this.layoutId !== o.layoutId)) this.release();
    this.active = true;
    const solver = this.solver;
    const scene = this.scene;
    if (!solver || !scene) {
      this.substepsNow = 0;
      return true; // lets the graph allocate; stepping starts next frame
    }

    // The read-back of an earlier frame, if its copy has been submitted.
    void solver.collectProfile().then((p) => {
      if (!p || this.solver !== solver) return;
      const top = mpmProfileTop(scene.config, p.layers, scene.jetThreshold) - scene.nozzle[1];
      this.jetHeightM = Number.isFinite(top) ? Math.max(0, top) : 0;
    });

    // Fixed substeps of config.dt, as many as the displayed time owes at the
    // bench's time scale — bounded, so a slow frame slows the liquid instead
    // of queueing a burst.
    const dt = scene.config.dt;
    const maxSubsteps = 2 * scene.substepsPerFrame;
    this.substepDebt = Math.min(this.substepDebt + (Math.max(0, o.frameDt) * scene.timeScale) / dt, maxSubsteps);
    this.substepsNow = Math.floor(this.substepDebt);
    this.substepDebt -= this.substepsNow;

    solver.emitters = heronEmitters(scene, o.vExitMS);
    const place = heronLiquidPlacement(scene, o.nozzleScene);
    solver.exportOrigin = place.origin;
    solver.exportScale = place.scale;
    return true;
  }

  /**
   * The frame-graph pass body. True whenever the solver exists and is wanted,
   * also on a frame that owes no substep: the pass still stands for the
   * liquid the scene draws.
   */
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
