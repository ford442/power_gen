/**
 * Least-squares fits for the analysis panel and experiment `expect` blocks.
 *
 * Pure functions, no DOM. Pairs where either value is non-finite are ignored.
 * A fit reports what the simulated numbers do; it is never a calibrated
 * measurement (docs/ANALYSIS.md).
 */

export interface LinearFit {
  kind: 'linear';
  slope: number;
  intercept: number;
  /** Coefficient of determination, 1 − SS_res / SS_tot (NaN when y is constant). */
  r2: number;
  /** Pairs used. Fewer than 2, or all x equal → slope / intercept NaN. */
  n: number;
}

export interface ExponentialFit {
  kind: 'exponential';
  /** y = a · e^(b·x) */
  a: number;
  b: number;
  /** e-folding length −1/b (a decay time when x is t); negative for growth, ∞ for b = 0. */
  tau: number;
  /** R² of the log-linear regression, i.e. in **log space** (ln y vs x) — the fit's own objective. */
  r2: number;
  /** R² of a·e^(b·x) against y in linear space, over the same points (for comparison). */
  r2Linear: number;
  /** Positive finite pairs used (y ≤ 0 has no logarithm and is skipped). */
  n: number;
}

export type Fit = LinearFit | ExponentialFit;

/** Ordinary least squares y = slope·x + intercept (two-pass, centred sums). */
export function linearFit(xs: ArrayLike<number>, ys: ArrayLike<number>): LinearFit {
  const len = Math.min(xs.length, ys.length);
  let n = 0;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < len; i++) {
    if (!Number.isFinite(xs[i]) || !Number.isFinite(ys[i])) continue;
    mx += xs[i];
    my += ys[i];
    n++;
  }
  if (n < 2) return { kind: 'linear', slope: NaN, intercept: NaN, r2: NaN, n };
  mx /= n;
  my /= n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < len; i++) {
    if (!Number.isFinite(xs[i]) || !Number.isFinite(ys[i])) continue;
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  if (sxx === 0) return { kind: 'linear', slope: NaN, intercept: NaN, r2: NaN, n };
  const slope = sxy / sxx;
  // For OLS with an intercept, 1 − SS_res/SS_tot = Sxy² / (Sxx·Syy).
  const r2 = syy > 0 ? (sxy * sxy) / (sxx * syy) : NaN;
  return { kind: 'linear', slope, intercept: my - slope * mx, r2, n };
}

/** y = a·e^(b·x) by least squares on ln y (points with y ≤ 0 are skipped). */
export function exponentialFit(xs: ArrayLike<number>, ys: ArrayLike<number>): ExponentialFit {
  const px: number[] = [];
  const py: number[] = [];
  const lny: number[] = [];
  const len = Math.min(xs.length, ys.length);
  for (let i = 0; i < len; i++) {
    if (!Number.isFinite(xs[i]) || !Number.isFinite(ys[i]) || ys[i] <= 0) continue;
    px.push(xs[i]);
    py.push(ys[i]);
    lny.push(Math.log(ys[i]));
  }
  const lin = linearFit(px, lny);
  const a = Math.exp(lin.intercept);
  const b = lin.slope;
  let r2Linear = NaN;
  if (Number.isFinite(a) && Number.isFinite(b) && py.length >= 2) {
    const mean = py.reduce((s, v) => s + v, 0) / py.length;
    let ssRes = 0;
    let ssTot = 0;
    for (let i = 0; i < py.length; i++) {
      const e = py[i] - a * Math.exp(b * px[i]);
      ssRes += e * e;
      ssTot += (py[i] - mean) * (py[i] - mean);
    }
    r2Linear = ssTot > 0 ? 1 - ssRes / ssTot : NaN;
  }
  return { kind: 'exponential', a, b, tau: b === 0 ? Infinity : -1 / b, r2: lin.r2, r2Linear, n: px.length };
}

export interface EnvelopeOpts {
  /** Drop peaks below this fraction of the largest one (float noise in the tail). Default 0.01. */
  minFraction?: number;
}

/**
 * Local maxima of |y| — the envelope of an oscillating signal. For a damped
 * sine A·e^(−t/τ)·sin(ωt + φ) the peaks sit π/ω apart with the same |sin|, so
 * their heights decay exactly as e^(−t/τ) and an exponential fit gives τ.
 */
export function envelopePeaks(
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
  opts: EnvelopeOpts = {}
): { xs: number[]; ys: number[] } {
  const len = Math.min(xs.length, ys.length);
  const ax: number[] = [];
  const ay: number[] = [];
  for (let i = 1; i < len - 1; i++) {
    const prev = Math.abs(ys[i - 1]);
    const cur = Math.abs(ys[i]);
    const next = Math.abs(ys[i + 1]);
    if (!Number.isFinite(xs[i]) || !Number.isFinite(cur)) continue;
    if (cur > prev && cur >= next) {
      ax.push(xs[i]);
      ay.push(cur);
    }
  }
  const top = ay.reduce((m, v) => Math.max(m, v), 0);
  const min = top * (opts.minFraction ?? 0.01);
  const keep = ay.map((v) => v >= min && v > 0);
  return { xs: ax.filter((_, i) => keep[i]), ys: ay.filter((_, i) => keep[i]) };
}

/** Exponential fit through the |y| envelope peaks (pulse-coil RLC ring-down → τ). */
export function ringDownFit(
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
  opts: EnvelopeOpts = {}
): ExponentialFit {
  const env = envelopePeaks(xs, ys, opts);
  return exponentialFit(env.xs, env.ys);
}

/** The fitted curve at x. */
export function evaluateFit(fit: Fit, x: number): number {
  return fit.kind === 'linear' ? fit.slope * x + fit.intercept : fit.a * Math.exp(fit.b * x);
}
