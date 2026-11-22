/**
 * Shared ODE integrators — the TS twin of cpp/src/core/integrate.h.
 *
 *   eulerFixed     one explicit Euler step
 *   rk4Fixed       one classical RK4 step, in the expression order the
 *                  hand-written plants used (porting a plant is a no-op)
 *   dopri5Advance  adaptive Dormand–Prince 5(4), PI control, dense output:
 *                  the step that crosses the frame end is interpolated, so a
 *                  frame boundary never forces a short step
 *   ros23Advance   Shampine's L-stable Rosenbrock (2,3) (MATLAB ode23s), with a
 *                  finite-difference Jacobian
 *
 * Same algorithms and constants as the C++ file; the only intended difference
 * is width (double here, float there). `npm run test:golden` holds the two to
 * each other per integrator. JS plants (and the offline worker, which steps
 * them) call these directly; no allocation per step — every work vector is
 * owned by a cached {@link OdeWork}.
 *
 * Educational lab integrators, not a general ODE suite: small dense systems
 * (a few states; the 28-node Peltier leg is the largest), no event location,
 * constraints applied after each step.
 */
import type { IntegratorName, PlantOdeSpec } from '../../../generated/plant-ode';

export type { IntegratorName };

/** dx/dt = f(t, x, u) over `stateSize` states, `u` held for one advance. */
export interface OdePlant<U> {
  readonly stateSize: number;
  derivs(t: number, x: Float64Array, u: U, dxdt: Float64Array): void;
  /** Stops / sign constraints after each accepted step; true when x changed. */
  constrain?(x: Float64Array): boolean;
  /**
   * ∂f/∂x at (t, x), row-major (`J[i·n + j] = ∂f_i/∂x_j`), for ros23. Optional:
   * without it the Jacobian is forward-differenced, n RHS calls each time —
   * fine for a handful of states, the whole cost for a 28-node chain. The C++
   * plants get theirs from one Dual evaluation; a plant that supplies this is
   * the TS counterpart.
   */
  jacobian?(t: number, x: Float64Array, u: U, J: Float64Array): void;
}

export interface StepStats {
  rhs: number;
  steps: number;
  rejected: number;
  jacobians: number;
  ok: boolean;
}

/** Adaptive carry-over between frames (and in a snapshot). h ≤ 0 = no history. */
export interface StepperState {
  h: number;
  errOld: number;
}

export interface Tolerance {
  rtol: number;
  atol: ArrayLike<number>;
  hMax?: number;
  maxSteps?: number;
}

export const newStats = (): StepStats => ({ rhs: 0, steps: 0, rejected: 0, jacobians: 0, ok: true });

export function addStats(into: StepStats, s: StepStats): StepStats {
  into.rhs += s.rhs;
  into.steps += s.steps;
  into.rejected += s.rejected;
  into.jacobians += s.jacobians;
  into.ok = into.ok && s.ok;
  return into;
}

export function toleranceOf(spec: PlantOdeSpec): Tolerance {
  return { rtol: spec.rtol, atol: spec.atol, hMax: spec.hMax };
}

/** The method a plant state runs: its bench override, else the catalog's. */
export function integratorFor(spec: PlantOdeSpec, override: IntegratorName | undefined): IntegratorName {
  return override ?? spec.integrator;
}

export const isAdaptive = (m: IntegratorName): boolean => m === 'dopri5' || m === 'ros23';

/** Per-size scratch (14 vectors + an n×n matrix), reused by every call. */
class OdeWork {
  readonly v: Float64Array[];
  readonly W: Float64Array;
  readonly J: Float64Array;
  readonly piv: Int32Array;
  constructor(readonly n: number) {
    this.v = Array.from({ length: 14 }, () => new Float64Array(n));
    this.W = new Float64Array(n * n);
    this.J = new Float64Array(n * n);
    this.piv = new Int32Array(n);
  }
}
const WORK = new Map<number, OdeWork>();
function work(n: number): OdeWork {
  let w = WORK.get(n);
  if (!w) {
    w = new OdeWork(n);
    WORK.set(n, w);
  }
  return w;
}

const allFinite = (v: Float64Array): boolean => {
  for (let i = 0; i < v.length; i++) if (!Number.isFinite(v[i])) return false;
  return true;
};

function errNorm(e: Float64Array, a: Float64Array, b: Float64Array, tol: Tolerance): number {
  let acc = 0;
  for (let i = 0; i < e.length; i++) {
    const sc = tol.atol[i] + tol.rtol * Math.max(Math.abs(a[i]), Math.abs(b[i]));
    const r = e[i] / sc;
    acc += r * r;
  }
  return Math.sqrt(acc / e.length);
}

const constrain = <U>(p: OdePlant<U>, x: Float64Array): boolean => (p.constrain ? p.constrain(x) : false);

// ── fixed steps ──────────────────────────────────────────────────────────

/** One explicit Euler step; x is always committed. */
export function eulerFixed<U>(p: OdePlant<U>, t: number, h: number, x: Float64Array, u: U): StepStats {
  const s = newStats();
  const [k] = work(p.stateSize).v;
  p.derivs(t, x, u, k);
  s.rhs = 1;
  for (let i = 0; i < x.length; i++) x[i] = x[i] + h * k[i];
  constrain(p, x);
  s.steps = 1;
  s.ok = allFinite(x);
  return s;
}

/** One RK4 step: stage times t, t + h/2, t + h/2, t + h. x untouched (ok false) on a non-finite result. */
export function rk4Fixed<U>(p: OdePlant<U>, t: number, h: number, x: Float64Array, u: U): StepStats {
  const s = newStats();
  const n = p.stateSize;
  const [y, k1, k2, k3, k4] = work(n).v;
  const tm = t + 0.5 * h;
  p.derivs(t, x, u, k1);
  for (let i = 0; i < n; i++) y[i] = x[i] + 0.5 * h * k1[i];
  p.derivs(tm, y, u, k2);
  for (let i = 0; i < n; i++) y[i] = x[i] + 0.5 * h * k2[i];
  p.derivs(tm, y, u, k3);
  for (let i = 0; i < n; i++) y[i] = x[i] + h * k3[i];
  p.derivs(t + h, y, u, k4);
  s.rhs = 4;
  const sixth = h / 6;
  for (let i = 0; i < n; i++) y[i] = x[i] + sixth * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]);
  if (!allFinite(y)) {
    s.ok = false;
    return s;
  }
  constrain(p, y);
  x.set(y);
  s.steps = 1;
  return s;
}

// ── Dormand–Prince 5(4) ──────────────────────────────────────────────────
// Hairer, Nørsett & Wanner, Solving ODEs I, §II.5 (DOPRI5) / §II.6 (CONTD5).
const C2 = 0.2, C3 = 0.3, C4 = 0.8, C5 = 8 / 9;
const A21 = 0.2;
const A31 = 3 / 40, A32 = 9 / 40;
const A41 = 44 / 45, A42 = -56 / 15, A43 = 32 / 9;
const A51 = 19372 / 6561, A52 = -25360 / 2187, A53 = 64448 / 6561, A54 = -212 / 729;
const A61 = 9017 / 3168, A62 = -355 / 33, A63 = 46732 / 5247, A64 = 49 / 176, A65 = -5103 / 18656;
const A71 = 35 / 384, A73 = 500 / 1113, A74 = 125 / 192, A75 = -2187 / 6784, A76 = 11 / 84;
const E1 = 71 / 57600, E3 = -71 / 16695, E4 = 71 / 1920, E5 = -17253 / 339200, E6 = 22 / 525, E7 = -1 / 40;
const D1 = -12715105075 / 11282082432, D3 = 87487479700 / 32700410799, D4 = -10690763975 / 1880347072,
  D5 = 701980252875 / 199316789632, D6 = -1453857185 / 822651844, D7 = 69997945 / 29380423;
const DP_SAFE = 0.9, DP_FAC_MIN = 0.2, DP_FAC_MAX = 10, DP_BETA = 0.04;
const DP_EXPO1 = 0.2 - DP_BETA * 0.75;
const F32_EPS = 2 ** -23;
const H_MIN_REL = 16 * F32_EPS;
const SQRT_EPS = Math.sqrt(F32_EPS);

/** Hairer's HINIT starting step (one probe, one extra RHS). */
function initialStep<U>(p: OdePlant<U>, x: Float64Array, k1: Float64Array, u: U, tol: Tolerance,
                        order: number, s: StepStats, y: Float64Array, k2: Float64Array): number {
  const n = p.stateSize;
  const hMax = Math.min(tol.hMax ?? Infinity, 1e30);
  let dnf = 0;
  let dny = 0;
  for (let i = 0; i < n; i++) {
    const sk = tol.atol[i] + tol.rtol * Math.abs(x[i]);
    dnf += (k1[i] / sk) ** 2;
    dny += (x[i] / sk) ** 2;
  }
  let h = dnf <= 1e-10 || dny <= 1e-10 ? 1e-6 : 0.01 * Math.sqrt(dny / dnf);
  h = Math.min(h, hMax);
  for (let i = 0; i < n; i++) y[i] = x[i] + h * k1[i];
  p.derivs(h, y, u, k2);
  s.rhs++;
  let der2 = 0;
  for (let i = 0; i < n; i++) {
    const sk = tol.atol[i] + tol.rtol * Math.abs(x[i]);
    der2 += ((k2[i] - k1[i]) / sk) ** 2;
  }
  der2 = Math.sqrt(der2) / h;
  const der12 = Math.max(Math.abs(der2), Math.sqrt(dnf));
  const h1 = der12 <= 1e-15 ? Math.max(1e-6, Math.abs(h) * 1e-3) : (0.01 / der12) ** (1 / order);
  return Math.min(100 * Math.abs(h), h1, hMax);
}

/** Advance x over [0, dt]; x ends at dt (dense output), st holds the next h. */
export function dopri5Advance<U>(p: OdePlant<U>, x: Float64Array, u: U, dt: number, tol: Tolerance,
                                 st: StepperState): StepStats {
  const s = newStats();
  if (!(dt > 0)) return s;
  const n = p.stateSize;
  const [y, yn, y6, k1, k2, k3, k4, k5, k6, k7, ys, e] = work(n).v;
  const hMax = tol.hMax ?? Infinity;
  const maxSteps = tol.maxSteps ?? 200000;
  y.set(x);
  p.derivs(0, y, u, k1);
  s.rhs++;
  let h = st.h;
  if (!(h > 0) || !Number.isFinite(h)) h = initialStep(p, y, k1, u, tol, 5, s, ys, k2);
  let errOld = st.errOld > 0 ? st.errOld : 1e-4;
  let lastRejected = false;
  let t = 0;
  for (;;) {
    if (s.steps >= maxSteps) { s.ok = false; break; }
    const hh = Math.min(h, hMax);
    if (!(hh > H_MIN_REL * Math.max(t, dt))) { s.ok = false; break; }
    for (let i = 0; i < n; i++) ys[i] = y[i] + hh * (A21 * k1[i]);
    p.derivs(t + C2 * hh, ys, u, k2);
    for (let i = 0; i < n; i++) ys[i] = y[i] + hh * (A31 * k1[i] + A32 * k2[i]);
    p.derivs(t + C3 * hh, ys, u, k3);
    for (let i = 0; i < n; i++) ys[i] = y[i] + hh * (A41 * k1[i] + A42 * k2[i] + A43 * k3[i]);
    p.derivs(t + C4 * hh, ys, u, k4);
    for (let i = 0; i < n; i++) ys[i] = y[i] + hh * (A51 * k1[i] + A52 * k2[i] + A53 * k3[i] + A54 * k4[i]);
    p.derivs(t + C5 * hh, ys, u, k5);
    for (let i = 0; i < n; i++) {
      y6[i] = y[i] + hh * (A61 * k1[i] + A62 * k2[i] + A63 * k3[i] + A64 * k4[i] + A65 * k5[i]);
    }
    p.derivs(t + hh, y6, u, k6);
    for (let i = 0; i < n; i++) {
      yn[i] = y[i] + hh * (A71 * k1[i] + A73 * k3[i] + A74 * k4[i] + A75 * k5[i] + A76 * k6[i]);
    }
    p.derivs(t + hh, yn, u, k7);
    s.rhs += 6;
    for (let i = 0; i < n; i++) {
      e[i] = hh * (E1 * k1[i] + E3 * k3[i] + E4 * k4[i] + E5 * k5[i] + E6 * k6[i] + E7 * k7[i]);
    }
    const finite = allFinite(yn) && allFinite(e);
    const err = finite ? errNorm(e, y, yn, tol) : Infinity;

    if (err <= 1) {
      const fac11 = Math.max(err, 1e-10) ** DP_EXPO1;
      let fac = fac11 / errOld ** DP_BETA;
      fac = Math.min(1 / DP_FAC_MIN, Math.max(1 / DP_FAC_MAX, fac / DP_SAFE));
      let hNew = hh / fac;
      if (lastRejected) hNew = Math.min(hNew, hh);
      errOld = Math.max(err, 1e-4);
      lastRejected = false;
      s.steps++;
      if (t + hh >= dt) {
        const th = (dt - t) / hh;
        const th1 = 1 - th;
        for (let i = 0; i < n; i++) {
          const ydiff = yn[i] - y[i];
          const bspl = hh * k1[i] - ydiff;
          const r4 = ydiff - hh * k7[i] - bspl;
          const r5 = hh * (D1 * k1[i] + D3 * k3[i] + D4 * k4[i] + D5 * k5[i] + D6 * k6[i] + D7 * k7[i]);
          ys[i] = y[i] + th * (ydiff + th1 * (bspl + th * (r4 + th1 * r5)));
        }
        constrain(p, ys);
        if (allFinite(ys)) y.set(ys);
        else s.ok = false;
        h = hNew;
        break;
      }
      t += hh;
      y.set(yn);
      if (constrain(p, y)) {
        p.derivs(t, y, u, k1);
        s.rhs++;
      } else {
        k1.set(k7);
      }
      h = hNew;
    } else {
      s.rejected++;
      lastRejected = true;
      const fac11 = finite ? err ** DP_EXPO1 : 1 / DP_FAC_MIN;
      h = hh / Math.min(1 / DP_FAC_MIN, fac11 / DP_SAFE);
    }
  }
  x.set(y);
  st.h = h;
  st.errOld = errOld;
  return s;
}

// ── Rosenbrock (2,3) — Shampine & Reichelt 1997 (ode23s) ─────────────────
const ROS_D = 1 / (2 + Math.SQRT2);
const ROS_E32 = 6 + Math.SQRT2;
const ROS_SAFE = 0.9, ROS_FAC_MIN = 0.2, ROS_FAC_MAX = 5;

/** In-place LU with partial pivoting of the row-major n×n matrix a. False if singular. */
export function luFactor(a: Float64Array, piv: Int32Array, n: number): boolean {
  for (let k = 0; k < n; k++) {
    let p = k;
    let best = Math.abs(a[k * n + k]);
    for (let r = k + 1; r < n; r++) {
      const v = Math.abs(a[r * n + k]);
      if (v > best) { best = v; p = r; }
    }
    if (!(best > 0) || !Number.isFinite(best)) return false;
    piv[k] = p;
    if (p !== k) {
      for (let c = 0; c < n; c++) {
        const tmp = a[k * n + c];
        a[k * n + c] = a[p * n + c];
        a[p * n + c] = tmp;
      }
    }
    const inv = 1 / a[k * n + k];
    for (let r = k + 1; r < n; r++) {
      const m = a[r * n + k] * inv;
      a[r * n + k] = m;
      for (let c = k + 1; c < n; c++) a[r * n + c] -= m * a[k * n + c];
    }
  }
  return true;
}

/**
 * Solve with the factors of {@link luFactor}. That routine swaps whole rows,
 * earlier columns' multipliers included, so every interchange is applied to b
 * before the forward substitution (interleaving them is only right when the
 * factor swaps just the trailing columns — and is wrong here as soon as a
 * pivot is taken past column 0).
 */
export function luSolve(a: Float64Array, piv: Int32Array, b: Float64Array, n: number): void {
  for (let k = 0; k < n; k++) {
    if (piv[k] !== k) {
      const tmp = b[k];
      b[k] = b[piv[k]];
      b[piv[k]] = tmp;
    }
  }
  for (let k = 0; k < n; k++) {
    for (let r = k + 1; r < n; r++) b[r] -= a[r * n + k] * b[k];
  }
  for (let k = n - 1; k >= 0; k--) {
    for (let c = k + 1; c < n; c++) b[k] -= a[k * n + c] * b[c];
    b[k] /= a[k * n + k];
  }
}

export function ros23Advance<U>(p: OdePlant<U>, x: Float64Array, u: U, dt: number, tol: Tolerance,
                                st: StepperState): StepStats {
  const s = newStats();
  if (!(dt > 0)) return s;
  const n = p.stateSize;
  const w = work(n);
  const [y, yn, ys, f0, f1, f2, fT, k1, k2, k3, e, T] = w.v;
  const { W, J, piv } = w;
  const hMax = tol.hMax ?? Infinity;
  const maxSteps = tol.maxSteps ?? 200000;
  y.set(x);
  p.derivs(0, y, u, f0);
  s.rhs++;
  let h = st.h;
  if (!(h > 0) || !Number.isFinite(h)) h = initialStep(p, y, f0, u, tol, 3, s, ys, fT);
  let errOld = st.errOld;
  let t = 0;
  let jacFresh = false;
  for (;;) {
    if (s.steps >= maxSteps) { s.ok = false; break; }
    const hh = Math.min(h, hMax);
    if (!(hh > H_MIN_REL * Math.max(t, dt))) { s.ok = false; break; }
    if (!jacFresh) {
      if (p.jacobian) {
        p.jacobian(t, y, u, J);
      } else {
        for (let j = 0; j < n; j++) {
          const dj = SQRT_EPS * Math.max(Math.abs(y[j]), tol.atol[j] / Math.max(tol.rtol, 1e-12));
          ys.set(y);
          ys[j] += dj;
          const dActual = ys[j] - y[j];
          p.derivs(t, ys, u, fT);
          for (let i = 0; i < n; i++) J[i * n + j] = (fT[i] - f0[i]) / dActual;
        }
      }
      const dtT = SQRT_EPS * Math.max(Math.abs(t), dt);
      p.derivs(t + dtT, y, u, fT);
      for (let i = 0; i < n; i++) T[i] = (fT[i] - f0[i]) / dtT;
      // A supplied Jacobian costs no RHS calls (as the C++ Dual evaluation does not).
      s.rhs += (p.jacobian ? 0 : n) + 1;
      s.jacobians++;
      jacFresh = true;
    }
    const hd = hh * ROS_D;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) W[i * n + j] = (i === j ? 1 : 0) - hd * J[i * n + j];
    }
    let finite = luFactor(W, piv, n);
    let err = Infinity;
    if (finite) {
      for (let i = 0; i < n; i++) k1[i] = f0[i] + hd * T[i];
      luSolve(W, piv, k1, n);
      for (let i = 0; i < n; i++) ys[i] = y[i] + 0.5 * hh * k1[i];
      p.derivs(t + 0.5 * hh, ys, u, f1);
      for (let i = 0; i < n; i++) k2[i] = f1[i] - k1[i];
      luSolve(W, piv, k2, n);
      for (let i = 0; i < n; i++) {
        k2[i] += k1[i];
        yn[i] = y[i] + hh * k2[i];
      }
      p.derivs(t + hh, yn, u, f2);
      s.rhs += 2;
      for (let i = 0; i < n; i++) k3[i] = f2[i] - ROS_E32 * (k2[i] - f1[i]) - 2 * (k1[i] - f0[i]) + hd * T[i];
      luSolve(W, piv, k3, n);
      for (let i = 0; i < n; i++) e[i] = (hh / 6) * (k1[i] - 2 * k2[i] + k3[i]);
      finite = allFinite(yn) && allFinite(e);
      if (finite) err = errNorm(e, y, yn, tol);
    }
    if (err <= 1) {
      const fac = Math.min(1 / ROS_FAC_MIN, Math.max(1 / ROS_FAC_MAX, Math.max(err, 1e-10) ** (1 / 3) / ROS_SAFE));
      const hNew = hh / fac;
      errOld = Math.max(err, 1e-4);
      s.steps++;
      if (t + hh >= dt) {
        const th = (dt - t) / hh;
        const inv = 1 / (1 - 2 * ROS_D);
        const w1 = th * (1 - th) * inv;
        const w2 = th * (th - 2 * ROS_D) * inv;
        for (let i = 0; i < n; i++) ys[i] = y[i] + hh * (w1 * k1[i] + w2 * k2[i]);
        constrain(p, ys);
        if (allFinite(ys)) y.set(ys);
        else s.ok = false;
        h = hNew;
        break;
      }
      t += hh;
      y.set(yn);
      if (constrain(p, y)) {
        p.derivs(t, y, u, f0);
        s.rhs++;
      } else {
        f0.set(f2);
      }
      jacFresh = false;
      h = hNew;
    } else {
      s.rejected++;
      const fac = finite ? err ** (1 / 3) / ROS_SAFE : 1 / ROS_FAC_MIN;
      h = hh / Math.min(1 / ROS_FAC_MIN, fac);
    }
  }
  x.set(y);
  st.h = h;
  st.errOld = errOld;
  return s;
}

export function advanceAdaptive<U>(m: IntegratorName, p: OdePlant<U>, x: Float64Array, u: U, dt: number,
                                   tol: Tolerance, st: StepperState): StepStats {
  return m === 'ros23' ? ros23Advance(p, x, u, dt, tol, st) : dopri5Advance(p, x, u, dt, tol, st);
}

/** Running work counters over every shared-integrator step (benches, tests). */
export const odeStats: StepStats = newStats();
export function resetOdeStats(): void {
  Object.assign(odeStats, newStats());
}
