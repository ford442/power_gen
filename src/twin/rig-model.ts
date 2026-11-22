/**
 * The hardware twin's rig model in TS (#257, ADR-0019) — the same equations as
 * cpp/src/twin/rig_plant.h, for the two places that must not depend on the
 * estimator they test:
 *
 *   - the mock board (`?mockHardware=1`, mock-serial-transport.ts) runs a
 *     *ground-truth* rig: catalog θ × (1 ± `mockParamError`), process noise at
 *     the catalog q and sensor noise at the catalog σ, so the estimator and
 *     the calibration have a right answer to find;
 *   - `rigDriveVolts` is the board drive both sides agree on (catalog
 *     `twin.input`): the mock applies it, the estimator host predicts with it.
 *
 *   J·dω/dt = k_e·I − b·ω          L·dI/dt = v − R·I − k_e·ω
 *   y = [ω·30/π RPM, I A, k_e·ω V]
 *
 * Simulated, not metrology: a lumped DC-machine stand-in for a commutated
 * coil array (the catalog `twin.model` text says what it leaves out).
 */
import { TWIN_RIG, TwinRigParam, TwinRigState } from '../../generated/twin-rig';
import { MODE_RUN } from '../hardware-protocol-shared';

export const RIG_STATES = TWIN_RIG.state.length;
export const RIG_PARAMS = TWIN_RIG.params.length;
export const RIG_SENSORS = TWIN_RIG.sensors.length;

/** Catalog nominal θ, in `TwinRigParam` order. */
export function rigNominal(): number[] {
  return TWIN_RIG.params.map((p) => p.nominal);
}

/**
 * The board's drive over the next sample interval (V): `vPerRpm × RPM` clamped
 * to ±vMax in RUN; 0 in coast, brake or a manual coil override.
 */
export function rigDriveVolts(rpm: number, mode: number, manual: boolean): number {
  if (manual || mode !== MODE_RUN || !Number.isFinite(rpm)) return 0;
  const { vPerRpm, vMax } = TWIN_RIG.input;
  return Math.max(-vMax, Math.min(vMax, vPerRpm * rpm));
}

/** Truth θ for a mock with `error` param error: nominal × (1 ± error), alternating sign. */
export function rigTruthParams(error: number): number[] {
  const e = Math.max(0, Math.min(0.9, Number.isFinite(error) ? error : 0));
  return TWIN_RIG.params.map((p, i) => p.nominal * (1 + (i % 2 === 0 ? e : -e)));
}

function derivs(x: readonly number[], th: readonly number[], v: number, out: number[]): void {
  const w = x[TwinRigState.omega], i = x[TwinRigState.currentA];
  const J = th[TwinRigParam.inertia], b = th[TwinRigParam.friction];
  const R = th[TwinRigParam.coilR], L = th[TwinRigParam.coilL], k = th[TwinRigParam.kE];
  out[TwinRigState.omega] = (k * i - b * w) / J;
  out[TwinRigState.currentA] = (v - R * i - k * w) / L;
}

/** y = [RPM, I, V] for state x under θ. */
export function rigOutputs(x: readonly number[], th: readonly number[]): number[] {
  const w = x[TwinRigState.omega];
  return [w * 30 / Math.PI, x[TwinRigState.currentA], th[TwinRigParam.kE] * w];
}

/** One classic RK4 step of length h (in place). */
export function rigRk4(x: number[], th: readonly number[], v: number, h: number): void {
  const n = x.length;
  const k1 = new Array<number>(n), k2 = new Array<number>(n), k3 = new Array<number>(n), k4 = new Array<number>(n);
  const y = new Array<number>(n);
  derivs(x, th, v, k1);
  for (let j = 0; j < n; j++) y[j] = x[j] + 0.5 * h * k1[j];
  derivs(y, th, v, k2);
  for (let j = 0; j < n; j++) y[j] = x[j] + 0.5 * h * k2[j];
  derivs(y, th, v, k3);
  for (let j = 0; j < n; j++) y[j] = x[j] + h * k3[j];
  derivs(y, th, v, k4);
  for (let j = 0; j < n; j++) x[j] += (h / 6) * (k1[j] + 2 * k2[j] + 2 * k3[j] + k4[j]);
}

/** mulberry32: a small seeded PRNG, so a mock run is reproducible. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal from a uniform source (Box–Muller). */
export function gaussian(rand: () => number): number {
  const u1 = Math.max(rand(), 1e-300), u2 = rand();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

export interface RigTruthOptions {
  /** ±fraction applied to every catalog θ (alternating sign). Default 0. */
  paramError?: number;
  /** PRNG seed (default fixed: a mock run is reproducible). */
  seed?: number;
  /** Scale on the catalog process noise q (default 1; 0 = deterministic). */
  processNoise?: number;
  /** Scale on the catalog sensor σ (default 1; 0 = exact readings). */
  sensorNoise?: number;
}

/**
 * A ground-truth rig: integrates at 1 ms with RK4 and adds the catalog
 * process noise each substep, exactly what the estimator assumes is on the
 * bench (so its innovations should be χ²-consistent when θ is right).
 */
export class RigTruth {
  readonly theta: number[];
  readonly x: number[] = new Array<number>(RIG_STATES).fill(0);
  private readonly rand: () => number;
  private readonly q: number[];
  private readonly sigma: number[];
  static readonly SUBSTEP_S = 0.001;

  constructor(opts: RigTruthOptions = {}) {
    this.theta = rigTruthParams(opts.paramError ?? 0);
    this.rand = seededRandom(opts.seed ?? 0x5eed257);
    const qs = opts.processNoise ?? 1, rs = opts.sensorNoise ?? 1;
    this.q = TWIN_RIG.state.map((s) => s.q * qs);
    this.sigma = TWIN_RIG.sensors.map((s) => s.sigma * rs);
  }

  /** Advance dt s with drive v held. */
  advance(v: number, dt: number): void {
    const steps = Math.max(1, Math.round(dt / RigTruth.SUBSTEP_S));
    const h = dt / steps;
    for (let s = 0; s < steps; s++) {
      rigRk4(this.x, this.theta, v, h);
      for (let j = 0; j < this.x.length; j++) {
        if (this.q[j] > 0) this.x[j] += Math.sqrt(this.q[j] * h) * gaussian(this.rand);
      }
    }
  }

  /** Noisy readings y + σ·n, in sensor order. */
  read(): number[] {
    const y = rigOutputs(this.x, this.theta);
    return y.map((v, c) => v + (this.sigma[c] > 0 ? this.sigma[c] * gaussian(this.rand) : 0));
  }

  /** Put the rotor at `rpm` with the current that holds it there (tests / demos). */
  pin(rpm: number): void {
    const w = rpm * Math.PI / 30;
    this.x[TwinRigState.omega] = w;
    this.x[TwinRigState.currentA] = this.theta[TwinRigParam.friction] * w / this.theta[TwinRigParam.kE];
  }
}
