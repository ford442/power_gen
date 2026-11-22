/**
 * The live estimator (#257 §2) — one `TwinEstimator` (cpp/src/twin/ekf.h: EKF
 * over the catalog rig, RK4 + AD predict, Joseph update, χ² window) fed one
 * bridge sample at a time:
 *
 *   predict(Δt board clock, drive the host sent) → stage readings → update
 *
 * It reads; it never writes a coil command (the bridge owns every safety rule,
 * docs/hardware_connection.md → layering). It also keeps what the panel and
 * calibration need: a short plot history and the last contiguous run.
 */
import { TWIN_RIG, TwinRigState } from '../../generated/twin-rig';
import type { TwinEstimatorInstance } from '../wasm/sim-core/abi.generated';
import type { SimCoreModule } from '../wasm/types';
import { readTwinReadout, TWIN_READOUT, type TwinEstimate } from './readout';
import { TWIN_RUN_STRIDE } from './sysid-run';

const N = TWIN_RIG.state.length;
const M = TWIN_RIG.sensors.length;
const NP = TWIN_RIG.params.length;
const RPM_PER_RAD_S = 30 / Math.PI;

/** A gap longer than this (s) restarts the filter and the run. */
export const TWIN_MAX_GAP_S = 0.25;
/** After a restore whose board clock does not continue: one nominal sample period (the mock's). */
export const TWIN_RESUME_DT_S = 0.008;
/** Plot history: 10 s at the board's 125 Hz. */
export const TWIN_HISTORY = 1250;
/** Longest run kept for calibration (s at 125 Hz). */
export const TWIN_RUN_SECONDS = 120;

/** Plot columns, one ring each (see {@link TwinEstimatorHost.history}). */
export const TWIN_HISTORY_KEYS = [
  't', 'zRpm', 'predRpm', 'innovSdRpm', 'estRpm', 'estSdRpm', 'zI', 'estI', 'estSdI', 'nuNormRpm', 'nuNormI', 'nuNormV', 'nisPerDof', 'chi2LoPerDof', 'chi2HiPerDof'
] as const;
export type TwinHistoryKey = (typeof TWIN_HISTORY_KEYS)[number];

/** Fixed-size ring of samples × stride doubles. */
export class TwinRunRecorder {
  private readonly buf: Float64Array;
  private head = 0;
  count = 0;
  constructor(readonly capacity: number, readonly stride = TWIN_RUN_STRIDE) {
    this.buf = new Float64Array(capacity * stride);
  }
  clear(): void {
    this.head = 0;
    this.count = 0;
  }
  push(row: ArrayLike<number>): void {
    this.buf.set(row as ArrayLike<number>, this.head * this.stride);
    this.head = (this.head + 1) % this.capacity;
    this.count = Math.min(this.capacity, this.count + 1);
  }
  /** The last `maxSamples` rows, oldest first (a copy). */
  rows(maxSamples = this.count): Float64Array {
    const n = Math.min(this.count, Math.max(0, Math.floor(maxSamples)));
    const out = new Float64Array(n * this.stride);
    const start = (this.head - n + this.capacity) % this.capacity;
    for (let k = 0; k < n; k++) {
      const at = ((start + k) % this.capacity) * this.stride;
      out.set(this.buf.subarray(at, at + this.stride), k * this.stride);
    }
    return out;
  }
  /** Rows with t ≥ t0, oldest first (a copy). */
  rowsSince(t0: number): Float64Array {
    const all = this.rows();
    let k = 0;
    while (k < this.count && all[k * this.stride] < t0) k++;
    return all.slice(k * this.stride);
  }
  /** Time span of the kept rows (s). */
  get durationS(): number {
    if (this.count < 2) return 0;
    const last = ((this.head - 1 + this.capacity) % this.capacity) * this.stride;
    const first = ((this.head - this.count + this.capacity) % this.capacity) * this.stride;
    return this.buf[last] - this.buf[first];
  }
}

export interface TwinSample {
  /** Board-clock time (s) and the clock epoch it belongs to. */
  t: number;
  epoch: number;
  /** Drive held over the interval ending here (V). */
  v: number;
  /** Readings in sensor order; null / NaN = not in this sample. */
  z: ReadonlyArray<number | null>;
}

export class TwinEstimatorHost {
  readonly est: TwinEstimatorInstance;
  estimate: TwinEstimate;
  /** θ the filter predicts with (catalog nominal until a profile is applied). */
  theta: number[] = TWIN_RIG.params.map((p) => p.nominal);
  /** Q and R multipliers on the catalog q / σ (the panel's sliders). */
  qScale = 1;
  rScale = 1;
  readonly run = new TwinRunRecorder(TWIN_RUN_SECONDS * 125);
  readonly history = Object.fromEntries(TWIN_HISTORY_KEYS.map((k) => [k, new Float64Array(TWIN_HISTORY)])) as Record<TwinHistoryKey, Float64Array>;
  historyCount = 0;
  private historyHead = 0;
  private lastT = NaN;
  private epoch = -1;
  /** After a snapshot restore: the next sample continues the filter instead of re-initialising. */
  private resume = false;
  /** Board time of the snapshot's last sample (NaN: unknown), for the first gap after a restore. */
  private resumeT = NaN;
  private readonly row = new Float64Array(TWIN_RUN_STRIDE);
  private ro: Float64Array;

  constructor(private readonly mod: SimCoreModule) {
    if (typeof mod.TwinEstimator !== 'function') throw new Error('sim_core.wasm has no TwinEstimator (stale binary)');
    this.est = new mod.TwinEstimator();
    if (this.est.readoutCount() !== TWIN_READOUT.COUNT) {
      throw new Error(`twin readout is ${this.est.readoutCount()} doubles, this build expects ${TWIN_READOUT.COUNT}`);
    }
    this.ro = this.view();
    this.applyNoise();
    this.estimate = readTwinReadout(this.readout());
  }

  dispose(): void {
    this.est.delete();
  }

  private view(): Float64Array {
    return new Float64Array(this.mod.HEAPF32.buffer, this.est.readoutPtr(), TWIN_READOUT.COUNT);
  }

  /** The readout block (re-viewed after a heap growth detached the old buffer). */
  private readout(): Float64Array {
    if (this.ro.buffer !== this.mod.HEAPF32.buffer || this.ro.length === 0) this.ro = this.view();
    return this.ro;
  }

  private applyNoise(): void {
    TWIN_RIG.state.forEach((s, i) => this.est.setProcessNoise(i, s.q * this.qScale));
    TWIN_RIG.sensors.forEach((s, c) => this.est.setSensorSigma(c, s.sigma * this.rScale));
  }

  /** Q / R multipliers (clamped to 10⁻³…10³). The χ² window restarts with the next update. */
  setNoiseScale(qScale: number, rScale: number): void {
    const clamp = (v: number): number => (Number.isFinite(v) ? Math.min(1e3, Math.max(1e-3, v)) : 1);
    this.qScale = clamp(qScale);
    this.rScale = clamp(rScale);
    this.applyNoise();
  }

  /** θ the filter predicts with (catalog order); the state and covariance are kept. */
  setTheta(theta: readonly number[]): void {
    for (let i = 0; i < NP; i++) {
      if (this.est.setParam(i, theta[i])) this.theta[i] = theta[i];
    }
    this.estimate = readTwinReadout(this.readout());
  }

  /** Forget the filter state; the next sample re-initialises it (and starts a new run). */
  restart(): void {
    this.lastT = NaN;
    this.resume = false;
    this.run.clear();
  }

  private initialise(s: TwinSample): void {
    const rpm = s.z[0], cur = s.z[1];
    const w = Number.isFinite(rpm) ? (rpm as number) / RPM_PER_RAD_S : 0;
    this.est.setInitial(TwinRigState.omega, w, Math.max(1, (3 * TWIN_RIG.sensors[0].sigma) / RPM_PER_RAD_S));
    this.est.setInitial(TwinRigState.currentA, Number.isFinite(cur) ? (cur as number) : 0, 0.1);
    this.est.reset();
    this.run.clear();
  }

  /** One bridge sample: predict over the board-clock gap, then update. Returns the NIS (−1: no update). */
  onSample(s: TwinSample): number {
    if (!Number.isFinite(s.t)) return -1;
    let dt = s.t - this.lastT;
    const restarted = s.epoch !== this.epoch || Number.isNaN(this.lastT);
    if (this.resume && restarted) {
      // Continue a restored filter over the gap since the snapshot's last
      // sample — or one nominal period when the board clock does not continue
      // it (another link, a reset board, a snapshot from long ago).
      const gap = s.t - this.resumeT;
      dt = gap > 0 && gap <= TWIN_MAX_GAP_S ? gap : TWIN_RESUME_DT_S;
      this.resume = false;
      this.run.clear();
    } else if (restarted || dt > TWIN_MAX_GAP_S || dt < 0) {
      this.initialise(s);
      dt = 0;
    } else if (dt === 0) {
      return -1; // a repeated sample
    }
    this.epoch = s.epoch;
    this.lastT = s.t;
    if (dt > 0) this.est.predict(dt, s.v);
    this.row[0] = s.t;
    this.row[1] = s.v;
    for (let c = 0; c < M; c++) {
      const z = s.z[c];
      const ok = z !== null && z !== undefined && Number.isFinite(z);
      this.row[2 + c] = ok ? (z as number) : NaN;
      if (ok) this.est.setMeasurement(c, z as number);
    }
    const nis = this.est.update();
    this.run.push(this.row);
    this.estimate = readTwinReadout(this.readout());
    this.pushHistory(s);
    return nis;
  }

  private pushHistory(s: TwinSample): void {
    const e = this.estimate;
    const w = e.window;
    const perDof = w.dof > 0 ? 1 / w.dof : NaN;
    const vals: Record<TwinHistoryKey, number> = {
      t: s.t,
      zRpm: this.row[2],
      predRpm: e.yPred[0],
      innovSdRpm: e.nuSigma[0],
      estRpm: e.x[TwinRigState.omega] * RPM_PER_RAD_S,
      estSdRpm: Math.sqrt(Math.max(0, e.P[0])) * RPM_PER_RAD_S,
      zI: this.row[3],
      estI: e.x[TwinRigState.currentA],
      estSdI: Math.sqrt(Math.max(0, e.P[N * N - 1])),
      nuNormRpm: e.nu[0] / e.nuSigma[0],
      nuNormI: e.nu[1] / e.nuSigma[1],
      nuNormV: e.nu[2] / e.nuSigma[2],
      nisPerDof: w.nis * perDof,
      chi2LoPerDof: w.lo * perDof,
      chi2HiPerDof: w.hi * perDof
    };
    for (const k of TWIN_HISTORY_KEYS) this.history[k][this.historyHead] = vals[k];
    this.historyHead = (this.historyHead + 1) % TWIN_HISTORY;
    this.historyCount = Math.min(TWIN_HISTORY, this.historyCount + 1);
  }

  /** One history column, oldest first. */
  historyColumn(key: TwinHistoryKey): number[] {
    const out = new Array<number>(this.historyCount);
    const ring = this.history[key];
    const start = (this.historyHead - this.historyCount + TWIN_HISTORY) % TWIN_HISTORY;
    for (let k = 0; k < this.historyCount; k++) out[k] = ring[(start + k) % TWIN_HISTORY];
    return out;
  }

  /** Board-clock time of the last sample the filter took (NaN before one). */
  get lastSampleT(): number {
    return this.lastT;
  }

  /** Filtered ω (rad/s) and its σ, or null before the first update. */
  omega(): { value: number; sd: number } | null {
    const e = this.estimate;
    if (!(e.updates > 0)) return null;
    return { value: e.x[TwinRigState.omega], sd: Math.sqrt(Math.max(0, e.P[0])) };
  }

  /** The filter's snapshot block (ADR-0015 `twin` section): t, x, P, θ, q, σ, hMax. */
  save(): number[] {
    this.est.save();
    return Array.from(new Float64Array(this.mod.HEAPF32.buffer, this.est.snapshotPtr(), this.est.snapshotCount()));
  }

  /**
   * Restore {@link save}; false (and nothing changed) on a layout mismatch.
   * `lastSampleT` is the board time of the snapshot's last sample
   * ({@link lastSampleT} when it was saved), so a filter restored on the same
   * board clock continues over the true gap.
   */
  load(values: ArrayLike<number>, lastSampleT = NaN): boolean {
    if (values.length !== this.est.snapshotCount()) return false;
    new Float64Array(this.mod.HEAPF32.buffer, this.est.snapshotPtr(), values.length).set(values);
    if (!this.est.load()) return false;
    for (let i = 0; i < NP; i++) this.theta[i] = this.est.getParam(i);
    // The block carries Q and R too: report the multipliers it implies.
    this.qScale = this.est.getProcessNoise(0) / TWIN_RIG.state[0].q;
    this.rScale = this.est.getSensorSigma(0) / TWIN_RIG.sensors[0].sigma;
    this.estimate = readTwinReadout(this.readout());
    this.resume = true;
    this.resumeT = Number.isFinite(lastSampleT) ? lastSampleT : NaN;
    return true;
  }
}
