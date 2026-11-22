/**
 * One calibration (#257 §3): drive the exported `TwinSysId` (cpp/src/twin/
 * sysid.h — Levenberg–Marquardt over log θ, gradients from forward
 * sensitivities) on a recorded run. Plain module over a sim_core instance, so
 * the offline worker (workers/wasm-offline-worker.ts), the main-thread
 * fallback and scripts/tests/twin.test.mjs run the same code.
 *
 * A run is `samples × [t s, v V, z₀ … z_{M−1}]` doubles (NaN = channel absent),
 * what {@link TwinRunRecorder} keeps — the drive the host sent and the board's
 * readings on the board clock.
 */
import { TWIN_RIG } from '../../generated/twin-rig';
import type { SimCoreModule } from '../wasm/types';
import { correlationOf, type TwinProfile } from './profile';

const N = TWIN_RIG.state.length;
const NP = TWIN_RIG.params.length;
const M = TWIN_RIG.sensors.length;
export const TWIN_RUN_STRIDE = 2 + M;

export interface TwinSysIdInput {
  /** samples × TWIN_RUN_STRIDE, chronological. */
  samples: Float64Array;
  /** Start θ (catalog order); default the catalog nominal. */
  theta0?: number[];
  /** Which θ to fit (default all). */
  fit?: boolean[];
  /** Sensor σ for the residual weights (default the catalog σ). */
  sigma?: number[];
  maxIterations?: number;
  /** Return the fit's simulated outputs (samples × M) for plotting. */
  trace?: boolean;
}

export interface TwinSysIdProgress {
  iteration: number;
  cost: number;
  lambda: number;
}

export type TwinFitStatus = 'converged' | 'max-iterations' | 'failed';

export interface TwinSysIdResult {
  status: TwinFitStatus;
  error: string | null;
  theta: number[];
  /** cov(θ), row-major NP×NP. */
  cov: number[];
  x0: number[];
  r2: number[];
  rmsNormalized: number[];
  reducedChi2: number;
  /** Correlation-scaled condition number of JᵀJ. */
  condition: number;
  residualAutocorr: number;
  warnings: number;
  iterations: number;
  /** χ²/2 at the start and after each iteration. */
  costHistory: number[];
  residualCount: number;
  samples: number;
  durationS: number;
  trace: Float64Array | null;
}

/** C++ `FitStatus` → name. */
function statusName(s: number): TwinFitStatus | 'running' {
  return s === 1 ? 'running' : s === 2 ? 'converged' : s === 3 ? 'max-iterations' : 'failed';
}

/** Run one fit to completion (progress after every LM iteration). */
export function runTwinSysId(
  mod: SimCoreModule,
  input: TwinSysIdInput,
  onProgress?: (p: TwinSysIdProgress) => void
): TwinSysIdResult {
  const data = input.samples;
  const n = Math.floor(data.length / TWIN_RUN_STRIDE);
  const durationS = n > 1 ? data[(n - 1) * TWIN_RUN_STRIDE] - data[0] : 0;
  const empty = (error: string): TwinSysIdResult => ({
    status: 'failed', error, theta: input.theta0 ?? TWIN_RIG.params.map((p) => p.nominal),
    cov: new Array<number>(NP * NP).fill(NaN), x0: new Array<number>(N).fill(NaN), r2: new Array<number>(M).fill(NaN),
    rmsNormalized: new Array<number>(M).fill(NaN), reducedChi2: NaN, condition: NaN, residualAutocorr: NaN,
    warnings: 0, iterations: 0, costHistory: [], residualCount: 0, samples: n, durationS, trace: null
  });
  if (typeof mod.TwinSysId !== 'function') return empty('sim_core.wasm has no TwinSysId (stale binary)');
  const id = new mod.TwinSysId();
  try {
    const ptr = id.dataPtr(n);
    if (!ptr) return empty('run buffer allocation failed');
    new Float64Array(mod.HEAPF32.buffer, ptr, n * TWIN_RUN_STRIDE).set(data.subarray(0, n * TWIN_RUN_STRIDE));
    const err = id.load(n);
    if (err !== 0) return empty(id.errorText() || `load failed (${err})`);

    const theta0 = input.theta0 ?? TWIN_RIG.params.map((p) => p.nominal);
    for (let i = 0; i < NP; i++) {
      id.setParam(i, theta0[i]);
      id.setFit(i, input.fit?.[i] ?? true);
    }
    (input.sigma ?? TWIN_RIG.sensors.map((s) => s.sigma)).forEach((s, c) => id.setSensorSigma(c, s));
    // x₀ from the first sample (fitted jointly): ω from RPM, I from the shunt or 0.
    const rpm0 = data[2], i0 = data[3];
    id.setInitialState(0, Number.isFinite(rpm0) ? (rpm0 * Math.PI) / 30 : 0);
    id.setInitialState(1, Number.isFinite(i0) ? i0 : 0);
    id.setFitInitialState(true);
    id.setMaxIterations(input.maxIterations ?? 60);

    let s = statusName(id.start());
    const costHistory = [id.cost()];
    while (s === 'running') {
      s = statusName(id.iterate());
      costHistory.push(id.cost());
      onProgress?.({ iteration: id.iterations(), cost: id.cost(), lambda: id.lambda() });
    }
    if (s === 'failed') return { ...empty(id.errorText() || 'fit failed'), costHistory };

    const cov: number[] = [];
    for (let i = 0; i < NP; i++) for (let j = 0; j < NP; j++) cov.push(id.covariance(i, j));
    let trace: Float64Array | null = null;
    if (input.trace) {
      const tp = id.fitPtr();
      trace = new Float64Array(mod.HEAPF32.buffer, tp, id.fitCount()).slice();
    }
    return {
      status: s,
      error: null,
      theta: Array.from({ length: NP }, (_, i) => id.param(i)),
      cov,
      x0: Array.from({ length: N }, (_, j) => id.initialState(j)),
      r2: Array.from({ length: M }, (_, c) => id.r2(c)),
      rmsNormalized: Array.from({ length: M }, (_, c) => id.rmsNormalized(c)),
      reducedChi2: id.reducedChi2(),
      condition: id.condition(),
      residualAutocorr: id.residualAutocorr(),
      warnings: id.warnings() >>> 0,
      iterations: id.iterations(),
      costHistory,
      residualCount: id.residualCount(),
      samples: n,
      durationS,
      trace
    };
  } finally {
    id.delete();
  }
}

/** The shareable profile of a successful fit. */
export function profileFromFit(r: TwinSysIdResult): TwinProfile {
  return {
    theta: r.theta.slice(),
    relSigma: r.theta.map((t, i) => Math.sqrt(Math.max(0, r.cov[i * NP + i])) / t),
    corr: correlationOf(r.cov),
    r2: r.r2.slice(),
    reducedChi2: r.reducedChi2,
    warnings: r.warnings,
    samples: r.samples,
    durationS: r.durationS
  };
}
