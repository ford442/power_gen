/**
 * Live experiment runner (#224 §3) — the steps ride the session clock.
 *
 * `LabSession.stepPlant` calls `beforeStep(simSteps)` before any plant work
 * and `publishFrame` calls `afterPublish()` once the frame's physics and hub
 * publish are done. Run time is the sum of the substeps the session actually
 * stepped, so pause stops the experiment, `.` advances it one frame and
 * slow-mo stretches it; nothing here reads a wall clock or a timer. A batch is
 * cut at the next step or sample (and at 0.1 s), so a slow frame slows the run
 * down instead of skipping through it.
 *
 * Operator actions win (ADR-0009): START / STOP / E-stop / reset / replay bump
 * `segOperator.epoch`, and a changed epoch — or leaving the experiment's mode —
 * stops the run (the promise rejects with the partial run attached). With the
 * plant worker on, the devices hold the previous batch's result, so a sample
 * lags its `t` by one frame (docs/EXPERIMENTS.md).
 */
import { WASM_MODE_BY_ID } from '../../generated/device-catalog';
import { LAB_CONFIG_FIELDS } from '../../generated/lab-config';
import type { RecordedRun, RunBackend } from '../analysis/run-types';
import { labConfig } from '../config/lab-config';
import { segOperator } from '../seg-operator-state';
import type { LabExperimentClock, LabSession } from '../session/lab-session';
import { telemetryHub } from '../telemetry-hub';
import { segWasm } from '../wasm/seg-physics-bridge';
import { ExperimentInterpreter, liveBatch } from './interpreter';
import { knobSpec, type KnobTarget } from './knobs';
import { readRecordKey, type PlantView } from './readers';
import type { ValidatedExperiment } from './validate';

export interface LiveRunOpts {
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

/** A live run that stopped early; `run` holds what was recorded. */
export class ExperimentStoppedError extends Error {
  constructor(message: string, readonly run: RecordedRun) {
    super(message);
    this.name = 'ExperimentStoppedError';
  }
}

const BOOT_ONLY = new Set<string>(LAB_CONFIG_FIELDS.filter((f) => !f.live).map((f) => f.key));

export function liveSession(): LabSession | null {
  const v = window.multiVisualizer as { session?: LabSession } | undefined;
  return v?.session ?? null;
}

/** Boot-only config fields the experiment wants but this page booted without. */
export function bootOnlyMismatches(v: ValidatedExperiment): string[] {
  const now = labConfig() as unknown as Record<string, unknown>;
  return Object.entries(v.config)
    .filter(([k, val]) => BOOT_ONLY.has(k) && JSON.stringify(now[k]) !== JSON.stringify(val))
    .map(([k]) => k);
}

function syncDriveUi(drive: number): void {
  const dc = document.getElementById('driveControl') as HTMLInputElement | null;
  const dv = document.getElementById('driveVal');
  const pct = String(Math.round(drive * 100));
  if (dc && dc.value !== pct) dc.value = pct;
  if (dv) dv.textContent = `${pct}%`;
}

class LiveRun implements LabExperimentClock {
  private t = 0;
  private pendingT = 0;
  private stepped = false;
  private finished = false;
  private readonly startedAt = new Date().toISOString();
  private readonly interp: ExperimentInterpreter;
  private readonly view: PlantView;
  private readonly host: { write(k: string, x: number): void; read(k: string): number };
  private lastProgress = -1;

  constructor(
    private readonly session: LabSession,
    private readonly v: ValidatedExperiment,
    private readonly epoch: number,
    private readonly opts: LiveRunOpts,
    private readonly resolve: (run: RecordedRun) => void,
    private readonly reject: (err: Error) => void
  ) {
    this.interp = new ExperimentInterpreter(v);
    const w = window as unknown as Record<string, unknown>;
    const target: KnobTarget = {
      devices: session.devices,
      operator: segOperator,
      fieldCoupled: (id) => !!session.fieldNetwork.getLinkForDestination(id)?.active,
      windowApi: (name) => (typeof w[name] === 'function' ? (w[name] as (x: never) => void) : undefined)
    };
    this.view = { ...target, segTelemetry: () => telemetryHub.getSeg() };
    this.host = {
      write: (k, x) => {
        if (!knobSpec(k)?.write(target, x)) return;
        if (k === 'drive') syncDriveUi(segOperator.targetDrive);
      },
      read: (k) => readRecordKey(this.view, k)
    };
    opts.signal?.addEventListener('abort', () => this.stop('cancelled'), { once: true });
  }

  beforeStep(simSteps: readonly number[], replayLocked: boolean): number[] | null {
    if (this.finished) return null;
    if (replayLocked) return this.stop('replay started — the plant is not stepping');
    if (segOperator.epoch !== this.epoch) return this.stop('operator START / STOP / E-stop took over');
    if (this.session.plantFocus() !== this.v.focus) return this.stop(`left ${this.v.focus} for ${this.session.plantFocus()}`);
    this.interp.applyDue(this.t, this.host);
    const steps = liveBatch(simSteps, this.interp.nextEvent(this.t) - this.t);
    let dt = 0;
    for (const s of steps) if (s > 0) dt += s;
    this.pendingT = this.t + dt;
    this.stepped = true;
    return steps;
  }

  afterPublish(): void {
    if (this.finished || !this.stepped) return;
    this.stepped = false;
    this.t = this.pendingT;
    this.interp.observe(this.t, this.host);
    const f = Math.min(1, this.t / this.v.duration);
    if (this.opts.onProgress && f - this.lastProgress >= 0.01) {
      this.lastProgress = f;
      this.opts.onProgress(f);
    }
    if (this.interp.done) this.finish();
  }

  private backend(): RunBackend {
    const cpp = segWasm.enabled && this.session.wasmPlantError === null && WASM_MODE_BY_ID[this.v.focus] !== undefined;
    if (!cpp) return 'js';
    return this.v.devices.length > 1 ? 'mixed' : 'wasm';
  }

  private detach(): RecordedRun {
    this.finished = true;
    if (this.session.experimentClock === this) this.session.experimentClock = null;
    return this.interp.toRun({ runner: 'live', backend: this.backend(), startedAt: this.startedAt });
  }

  private finish(): void {
    this.opts.onProgress?.(1);
    this.resolve(this.detach());
  }

  stop(reason: string): null {
    if (this.finished) return null;
    const run = this.detach();
    this.reject(new ExperimentStoppedError(`experiment ${this.v.def.id} stopped at t = ${this.t.toFixed(2)} s: ${reason}`, run));
    return null;
  }
}

/**
 * Restore the experiment's snapshot (if any), apply its live config, START
 * the plant if it is idle, and run the steps on the session clock. Without a
 * snapshot a live run starts from the lab as it stands (an offline run starts
 * from a fresh bench), so set every knob the result depends on. Boot-only fields (`wasmPhysics`, …) cannot change mid-session:
 * they are reported in `warnings` and the run's `backend` says what actually
 * stepped.
 */
export async function runLive(v: ValidatedExperiment, opts: LiveRunOpts = {}): Promise<{ run: RecordedRun; warnings: string[] }> {
  const session = liveSession();
  if (!session) throw new Error('the lab has not booted yet');
  if (session.experimentClock) throw new Error('an experiment is already running');
  if (session.replayLocked) throw new Error('a replay is playing — stop it first');

  const warnings = bootOnlyMismatches(v).map(
    (k) => `${k} is chosen at boot — this run uses the page's ${JSON.stringify((labConfig() as unknown as Record<string, unknown>)[k])}; reload with the experiment's config to change it`
  );
  const live = Object.fromEntries(Object.entries(v.config).filter(([k]) => !BOOT_ONLY.has(k)));
  // A saved operating point first, so the experiment's config and steps act on it.
  if (v.snapshot) {
    const { restoreLabSnapshot } = await import('../session/lab-snapshot');
    if (!(await restoreLabSnapshot(v.snapshot))) throw new Error('the lab could not restore the experiment\'s snapshot');
  }
  const { applyLabConfig } = await import('../seg-explainer/lab-url');
  await applyLabConfig(live);
  if (session.plantFocus() !== v.focus) throw new Error(`could not switch to ${v.focus}`);

  if (!segOperator.isRunning) segOperator.start();
  const run = await new Promise<RecordedRun>((resolve, reject) => {
    session.experimentClock = new LiveRun(session, v, segOperator.epoch, opts, resolve, reject);
  });
  return { run, warnings };
}
