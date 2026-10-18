/**
 * Recorded run — the one shape every producer (live experiment runner,
 * offline / headless runner, sweep, "analyse current telemetry") hands to the
 * analysis panel and to `.lab.json` / CSV export.
 *
 * Columns are catalog telemetry keys (`lorentzForceN`, `transformerVs`, …) plus
 * the session-clock column `t` (simulated seconds since the run started).
 * Labels and units come from `DEVICE_TELEMETRY_FIELDS`; nothing here is a
 * calibrated measurement.
 */

/** Which plant produced the numbers. `mixed` = C++ focus plant + JS benches. */
export type RunBackend = 'wasm' | 'js' | 'mixed';

/** Who stepped the clock: the live frame loop or a headless offline runner. */
export type RunRunner = 'live' | 'offline';

/** One `expect` block's verdict (see src/experiments/). */
export interface ExpectResult {
  /** Short human label, e.g. `fit lorentzForceN ~ lorentzFieldT (linear)`. */
  label: string;
  pass: boolean;
  /** Measured numbers the verdict was taken on (r2, slope, rms, …). */
  measured: Record<string, number>;
  /** The condition as written, for the pass/fail line (`r2 > 0.98`). */
  condition: string;
}

export interface RecordedRun {
  /** Unique per run (not per experiment). */
  id: string;
  /** Experiment id when produced by one, else null (free recording). */
  experimentId: string | null;
  title: string;
  /** ISO wall-clock start time — metadata only, never used for physics. */
  startedAt: string;
  runner: RunRunner;
  backend: RunBackend;
  /** Sample rate the run was recorded at, Hz (session clock). */
  hz: number;
  /** `t` first, then telemetry keys, in recording order. */
  columns: string[];
  /** Row-major samples; `rows[i][j]` is `columns[j]` at sample i. */
  rows: number[][];
  /** Sweep point this run belongs to (`{ "lorentz-sled.lorentzField": 0.3 }`). */
  sweep?: Record<string, number>;
  /** Non-default LabConfig fields the run started from (share-link subset). */
  config?: Record<string, unknown>;
  /** Verdicts of the experiment's `expect` blocks, when it has any. */
  expects?: ExpectResult[];
  /** Plot hints from the experiment (`{ x, y, fit }`). */
  plots?: RunPlotHint[];
}

export interface RunPlotHint {
  x: string;
  y: string;
  fit?: 'linear' | 'exponential';
}

/** Column accessor; returns a fresh array (NaN for a missing column). */
export function runColumn(run: RecordedRun, key: string): number[] {
  const j = run.columns.indexOf(key);
  if (j < 0) return run.rows.map(() => Number.NaN);
  return run.rows.map((r) => r[j]);
}
