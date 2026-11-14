/**
 * Scripted experiments — the `*.experiment.json` format (#224 §3).
 *
 *   {
 *     "id": "lorentz-force-vs-field",
 *     "title": "Force on a current-carrying rail vs B",
 *     "config": { "mode": "lorentz-sled", "wasmPhysics": true, "seed": 42 },
 *     "steps": [
 *       { "at": 0,  "set":    { "drive": 1, "lorentz-sled.fieldT": 0.05 } },
 *       { "at": 1,  "ramp":   { "lorentz-sled.fieldT": [0.05, 0.6] }, "over": 10 },
 *       { "at": 1,  "record": ["lorentzFieldT", "lorentzForceN"], "hz": 30, "until": 11 },
 *       { "at": 11, "expect": { "fit": { "x": "lorentzFieldT", "y": "lorentzForceN",
 *                                        "model": "linear", "r2": { "gt": 0.98 } } } }
 *     ],
 *     "plots": [{ "x": "lorentzFieldT", "y": "lorentzForceN", "fit": "linear" }]
 *   }
 *
 * Times are **session-clock** seconds from the run's start — simulated time,
 * so pause, `.` and slow-mo stretch a live run exactly as they stretch the
 * plant. One interpreter (interpreter.ts) serves the live runner and the
 * offline / headless one. The full reference is docs/EXPERIMENTS.md.
 *
 * Simulated, not metrology: an experiment checks what the simulated plant
 * does, never a real bench.
 */
import type { RunPlotHint } from '../analysis/run-types';

/** `{ gt: 0.98 }`, `{ between: [0.3, 0.34] }`, `{ approx: 0.25, rel: 0.02 }` … */
export interface Condition {
  gt?: number;
  gte?: number;
  lt?: number;
  lte?: number;
  between?: [number, number];
  /** Target value; with `tol` (absolute) and/or `rel` (relative, default 1 %). */
  approx?: number;
  tol?: number;
  rel?: number;
}

/** Reduction of one column over a window of samples. */
export type StatKind = 'mean' | 'min' | 'max' | 'rms' | 'std' | 'p2p' | 'first' | 'last';

export type FitModel = 'linear' | 'proportional' | 'exponential';

/** Sample window, seconds on the run clock (inclusive). Default: everything recorded so far. */
export interface ExpectWindow {
  from?: number;
  until?: number;
}

export interface FitExpect extends ExpectWindow {
  x: string;
  y: string;
  model: FitModel;
  r2?: Condition;
  slope?: Condition;
  intercept?: Condition;
  /** Exponential only: rate b of y = a·e^(b·x). */
  b?: Condition;
}

export interface StatExpect extends ExpectWindow, Condition {
  key: string;
  of: StatKind;
}

/** `of(num) / of(den)` — e.g. rms(V_s) / rms(V_p) for a turns ratio. */
export interface RatioExpect extends ExpectWindow, Condition {
  num: string;
  den: string;
  of: StatKind;
}

/** One verdict. Exactly one of the kinds; `label` overrides the generated one. */
export interface ExpectDef {
  label?: string;
  fit?: FitExpect;
  stat?: StatExpect;
  ratio?: RatioExpect;
}

export type KnobValue = number | boolean;

export interface SetStep {
  at: number;
  set: Record<string, KnobValue>;
}

export interface RampStep {
  at: number;
  /** Linear from → to over `over` seconds, written every substep batch. */
  ramp: Record<string, [number, number]>;
  over: number;
}

export interface RecordStep {
  at: number;
  /** Catalog telemetry keys and/or knob ids. */
  record: string[];
  /** Sample rate on the session clock (default 30 Hz). */
  hz?: number;
  /** Stop recording here (default: the end of the run). */
  until?: number;
}

export interface ExpectStep {
  at: number;
  /** One verdict, or several evaluated at the same time. */
  expect: ExpectDef | ExpectDef[];
}

export type ExperimentStep = SetStep | RampStep | RecordStep | ExpectStep;

/** One swept knob: an evenly spaced range, or explicit values. */
export type SweepAxis = { from: number; to: number; n: number } | { values: number[] };

/** How each sweep run collapses to one summary row. */
export interface SweepSummary {
  /** Window of each run's recording to reduce (default: its last second). */
  from?: number;
  until?: number;
  /** Reduction applied to every recorded key (default `mean`). */
  of?: StatKind;
  /** Extra derived columns, e.g. `{ "ratioRms": { "ratio": ["transformerVs", "transformerVp"], "of": "rms" } }`. */
  columns?: Record<string, { key: string; of?: StatKind } | { ratio: [string, string]; of?: StatKind }>;
}

export interface ExperimentDef {
  id: string;
  title: string;
  description?: string;
  /** LabConfig fields the run starts from (same coercion as the URL). */
  config?: Record<string, unknown>;
  /**
   * Offline step, seconds (default 1/60 — the live substep at 1×). A live run
   * always uses the frame loop's substeps; this only sets the headless clock.
   */
  dt?: number;
  /** Run length, seconds (default: the last step's end). */
  duration?: number;
  steps: ExperimentStep[];
  plots?: RunPlotHint[];
  /** Run once per grid point (cartesian product), offline, one worker each. */
  sweep?: Record<string, SweepAxis>;
  summary?: SweepSummary;
  /** Verdicts over the sweep's summary table (one row per run). */
  summaryExpect?: ExpectDef[];
  /**
   * Start from a saved operating point: a §2 plant snapshot
   * (`window.lab.captureSnapshot()`, docs/SNAPSHOTS.md). Offline it loads
   * into the fresh bench; live it restores the lab before the steps run.
   */
  snapshot?: unknown;
}
