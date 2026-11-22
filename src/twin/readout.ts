/**
 * TwinEstimator readout (#257) — the TS mirror of `twin::ReadoutLayout` in
 * cpp/src/twin/twin.h: one C++-owned double block, refilled after every
 * predict / update / parameter change and read zero-copy here.
 *
 *   [0] version  [1] t  [2] updates
 *   x[N]  P[N·N]  yPred[M]  ySigma[M]  nu[M]  nuSigma[M]
 *   nis  dof  winCount  winNis  winDof  chi2Lo  chi2Hi  consistent  diagnosis
 *   winMean[M]  winRms[M]  winLag1[M]  theta[P]
 *
 * scripts/tests/twin.test.mjs checks COUNT against `readoutCount()`.
 */
import { TWIN_RIG } from '../../generated/twin-rig';

const N = TWIN_RIG.state.length;
const M = TWIN_RIG.sensors.length;
const NP = TWIN_RIG.params.length;

export const TWIN_READOUT_VERSION = 1;

const X = 3;
const P = X + N;
const Y_PRED = P + N * N;
const Y_SIGMA = Y_PRED + M;
const NU = Y_SIGMA + M;
const NU_SIGMA = NU + M;
const NIS = NU_SIGMA + M;
const WIN_MEAN = NIS + 9;

export const TWIN_READOUT = {
  VERSION: 0, T: 1, UPDATES: 2, X, P, Y_PRED, Y_SIGMA, NU, NU_SIGMA,
  NIS, DOF: NIS + 1, WIN_COUNT: NIS + 2, WIN_NIS: NIS + 3, WIN_DOF: NIS + 4,
  CHI2_LO: NIS + 5, CHI2_HI: NIS + 6, CONSISTENT: NIS + 7, DIAGNOSIS: NIS + 8,
  WIN_MEAN, WIN_RMS: WIN_MEAN + M, WIN_LAG1: WIN_MEAN + 2 * M, THETA: WIN_MEAN + 3 * M,
  COUNT: WIN_MEAN + 3 * M + NP
} as const;

/**
 * The χ² window's verdict (`twin::Diagnosis`, ekf.h), by index:
 *
 * - `consistent` — NIS inside its two-sided 95 % χ² band;
 * - `sensor-noisy` — too large, innovations white and unbiased: R is too small;
 * - `model-mismatch` — too large with a bias or lag-1 correlation in some
 *   channel: the model (θ) is wrong, which calibration addresses;
 * - `overcautious` — too small: Q or R is larger than the rig needs.
 */
export const TWIN_DIAGNOSES = ['idle', 'consistent', 'sensor-noisy', 'model-mismatch', 'overcautious'] as const;
export type TwinDiagnosis = (typeof TWIN_DIAGNOSES)[number];

export interface TwinWindow {
  /** Updates in the window (≤ 100). */
  count: number;
  /** Σ NIS and Σ dof over the window. */
  nis: number;
  dof: number;
  /** Two-sided 95 % χ²(dof) bounds on `nis`. */
  lo: number;
  hi: number;
  consistent: boolean;
  diagnosis: TwinDiagnosis;
  /** Per channel: mean, RMS and lag-1 autocorrelation of ν/σ_ν. */
  mean: number[];
  rms: number[];
  lag1: number[];
}

export interface TwinEstimate {
  /** Filter time (s, board clock) and updates since reset. */
  t: number;
  updates: number;
  /** x̂ = [ω rad/s, I A] and P (row-major N×N). */
  x: number[];
  P: number[];
  /** Predicted reading and its σ (√(HPHᵀ + R)) per sensor, at the last update. */
  yPred: number[];
  ySigma: number[];
  /** Innovation ν and its σ per sensor (NaN for a channel absent from the sample). */
  nu: number[];
  nuSigma: number[];
  /** Last update's NIS and its dof (channels used). */
  nis: number;
  dof: number;
  window: TwinWindow;
  /** θ the filter predicts with. */
  theta: number[];
}

const slice = (ro: ArrayLike<number>, at: number, n: number): number[] => Array.from({ length: n }, (_, i) => ro[at + i]);

/** Decode one readout block (throws on a version or size mismatch — a stale binary). */
export function readTwinReadout(ro: ArrayLike<number>): TwinEstimate {
  const L = TWIN_READOUT;
  if (ro.length < L.COUNT || ro[L.VERSION] !== TWIN_READOUT_VERSION) {
    throw new Error(`twin readout v${ro[L.VERSION]} × ${ro.length}, expected v${TWIN_READOUT_VERSION} × ${L.COUNT}`);
  }
  const d = Math.round(ro[L.DIAGNOSIS]);
  return {
    t: ro[L.T],
    updates: ro[L.UPDATES],
    x: slice(ro, L.X, N),
    P: slice(ro, L.P, N * N),
    yPred: slice(ro, L.Y_PRED, M),
    ySigma: slice(ro, L.Y_SIGMA, M),
    nu: slice(ro, L.NU, M),
    nuSigma: slice(ro, L.NU_SIGMA, M),
    nis: ro[L.NIS],
    dof: ro[L.DOF],
    window: {
      count: ro[L.WIN_COUNT],
      nis: ro[L.WIN_NIS],
      dof: ro[L.WIN_DOF],
      lo: ro[L.CHI2_LO],
      hi: ro[L.CHI2_HI],
      consistent: ro[L.CONSISTENT] > 0.5,
      diagnosis: TWIN_DIAGNOSES[d] ?? 'idle',
      mean: slice(ro, L.WIN_MEAN, M),
      rms: slice(ro, L.WIN_RMS, M),
      lag1: slice(ro, L.WIN_LAG1, M)
    },
    theta: slice(ro, L.THETA, NP)
  };
}

/** The 3σ ellipse of a 2×2 covariance: semi-axes and the major axis angle (rad). */
export function covarianceEllipse(P: readonly number[], k = 3): { a: number; b: number; angle: number } {
  const [sxx, sxy, , syy] = P;
  const tr = sxx + syy, det = sxx * syy - sxy * sxy;
  const disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
  const l1 = Math.max(0, tr / 2 + disc), l2 = Math.max(0, tr / 2 - disc);
  return { a: k * Math.sqrt(l1), b: k * Math.sqrt(l2), angle: 0.5 * Math.atan2(2 * sxy, sxx - syy) };
}
