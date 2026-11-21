/**
 * `expect` blocks — verdicts over a recorded table (#224 §3).
 *
 * Pure functions over `{ columns, rows }`, so the same code judges one run's
 * samples and a sweep's summary table, live or offline, in the browser or in
 * Node (CI). Fits come from the analysis panel (src/analysis/fit.ts), so a
 * verdict and the line drawn on the plot are the same regression.
 */
import { exponentialFit, linearFit } from '../analysis/fit';
import type { ExpectResult } from '../analysis/run-types';
import type { Condition, ExpectDef, ExpectWindow, FitExpect, StatKind } from './types';

export interface Table {
  columns: readonly string[];
  rows: readonly (readonly number[])[];
}

/** Values of `key` in rows whose `t` lies in [from, until]; tables without `t` take every row. */
export function windowColumn(table: Table, key: string, win: ExpectWindow = {}): number[] {
  const j = table.columns.indexOf(key);
  if (j < 0) return [];
  const tj = table.columns.indexOf('t');
  const from = win.from ?? -Infinity;
  const until = win.until ?? Infinity;
  const out: number[] = [];
  for (const r of table.rows) {
    if (tj >= 0 && (r[tj] < from - 1e-9 || r[tj] > until + 1e-9)) continue;
    out.push(r[j]);
  }
  return out;
}

/** Paired (x, y) over a window, dropping pairs with a non-finite side. */
function windowPairs(table: Table, x: string, y: string, win: ExpectWindow): { xs: number[]; ys: number[] } {
  const xs0 = windowColumn(table, x, win);
  const ys0 = windowColumn(table, y, win);
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < Math.min(xs0.length, ys0.length); i++) {
    if (Number.isFinite(xs0[i]) && Number.isFinite(ys0[i])) {
      xs.push(xs0[i]);
      ys.push(ys0[i]);
    }
  }
  return { xs, ys };
}

/**
 * Cycle frequency (Hz) of `values` sampled at `times`: rising crossings of
 * the window mean cut the trace into cycles, each cycle's maximum is timed
 * (parabolic refinement), and f = (peaks − 1) / (last peak − first peak).
 * Peaks, not crossings, because a damped ring's mean is not its midline —
 * crossings of an offset level drift as the amplitude decays, while the
 * peaks of e^(−αt)·sin ωt stay exactly 2π/ω apart. NaN with < 2 cycles.
 */
export function crossingFrequency(times: readonly number[], values: readonly number[]): number {
  const n = Math.min(times.length, values.length);
  let sum = 0, count = 0;
  for (let i = 0; i < n; i++) if (Number.isFinite(values[i])) { sum += values[i]; count++; }
  if (count < 3) return Number.NaN;
  const mean = sum / count;
  const rising: number[] = [];
  for (let i = 1; i < n; i++) if (values[i - 1] < mean && values[i] >= mean) rising.push(i);
  const peaks: number[] = [];
  for (let c = 0; c + 1 < rising.length; c++) {
    let k = rising[c];
    for (let i = rising[c]; i < rising[c + 1]; i++) if (values[i] > values[k]) k = i;
    let t = times[k];
    if (k > 0 && k + 1 < n) {
      const a = values[k - 1], b = values[k], d = values[k + 1];
      const den = a - 2 * b + d;
      if (den < 0) t += (0.5 * (a - d) / den) * 0.5 * (times[k + 1] - times[k - 1]);
    }
    peaks.push(t);
  }
  if (peaks.length < 2) return Number.NaN;
  const span = peaks[peaks.length - 1] - peaks[0];
  return span > 0 ? (peaks.length - 1) / span : Number.NaN;
}

/** `of` over `key` in a window — `freq` needs the table's `t` column too. */
export function reduceWindow(table: Table, key: string, win: ExpectWindow, of: StatKind): number {
  if (of !== 'freq') return reduce(windowColumn(table, key, win), of);
  return crossingFrequency(windowColumn(table, 't', win), windowColumn(table, key, win));
}

export function reduce(values: readonly number[], of: StatKind): number {
  const v = values.filter((x) => Number.isFinite(x));
  if (!v.length) return Number.NaN;
  switch (of) {
    case 'freq': return Number.NaN; // needs times: reduceWindow
    case 'first': return v[0];
    case 'last': return v[v.length - 1];
    case 'min': return Math.min(...v);
    case 'max': return Math.max(...v);
    case 'p2p': return Math.max(...v) - Math.min(...v);
    case 'mean': return v.reduce((s, x) => s + x, 0) / v.length;
    case 'rms': return Math.sqrt(v.reduce((s, x) => s + x * x, 0) / v.length);
    case 'std': {
      const m = v.reduce((s, x) => s + x, 0) / v.length;
      return Math.sqrt(v.reduce((s, x) => s + (x - m) * (x - m), 0) / v.length);
    }
  }
}

/**
 * y = a·x^b by least squares on (ln x, ln y) — positive pairs only; R² of the
 * log-log line. A ripple ∝ 1/C has b ≈ −1, an LC frequency b ≈ −½.
 */
export function powerFit(xs: readonly number[], ys: readonly number[]): { a: number; b: number; r2: number; n: number } {
  const lx: number[] = [], ly: number[] = [];
  for (let i = 0; i < Math.min(xs.length, ys.length); i++) {
    if (xs[i] > 0 && ys[i] > 0) { lx.push(Math.log(xs[i])); ly.push(Math.log(ys[i])); }
  }
  const fit = linearFit(lx, ly);
  return { a: Math.exp(fit.intercept), b: fit.slope, r2: fit.r2, n: lx.length };
}

/** y = k·x through the origin; R² against the mean of y, like the free fit. */
export function proportionalFit(xs: readonly number[], ys: readonly number[]): { slope: number; r2: number; n: number } {
  let sxy = 0;
  let sxx = 0;
  let my = 0;
  for (let i = 0; i < xs.length; i++) {
    sxy += xs[i] * ys[i];
    sxx += xs[i] * xs[i];
    my += ys[i];
  }
  const n = xs.length;
  if (n < 2 || sxx === 0) return { slope: Number.NaN, r2: Number.NaN, n };
  my /= n;
  const k = sxy / sxx;
  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i++) {
    ssRes += (ys[i] - k * xs[i]) ** 2;
    ssTot += (ys[i] - my) ** 2;
  }
  return { slope: k, r2: ssTot > 0 ? 1 - ssRes / ssTot : Number.NaN, n };
}

const DEFAULT_REL = 0.01;

/** True when `v` satisfies every bound in `c` (NaN never does). */
export function meets(v: number, c: Condition): boolean {
  if (!Number.isFinite(v)) return false;
  if (c.gt !== undefined && !(v > c.gt)) return false;
  if (c.gte !== undefined && !(v >= c.gte)) return false;
  if (c.lt !== undefined && !(v < c.lt)) return false;
  if (c.lte !== undefined && !(v <= c.lte)) return false;
  if (c.between && !(v >= c.between[0] && v <= c.between[1])) return false;
  if (c.approx !== undefined) {
    const tol = Math.max(c.tol ?? 0, Math.abs(c.approx) * (c.rel ?? (c.tol === undefined ? DEFAULT_REL : 0)));
    if (!(Math.abs(v - c.approx) <= tol)) return false;
  }
  return true;
}

export function hasBound(c: Partial<Condition> | undefined): boolean {
  if (!c) return false;
  return c.gt !== undefined || c.gte !== undefined || c.lt !== undefined || c.lte !== undefined
    || c.between !== undefined || c.approx !== undefined;
}

/** `r2 > 0.98`, `slope ≈ 0.25 ± 2%`, `ratio in [0.3, 0.34]`. */
export function conditionText(name: string, c: Condition): string {
  const parts: string[] = [];
  if (c.gt !== undefined) parts.push(`${name} > ${c.gt}`);
  if (c.gte !== undefined) parts.push(`${name} ≥ ${c.gte}`);
  if (c.lt !== undefined) parts.push(`${name} < ${c.lt}`);
  if (c.lte !== undefined) parts.push(`${name} ≤ ${c.lte}`);
  if (c.between) parts.push(`${name} in [${c.between[0]}, ${c.between[1]}]`);
  if (c.approx !== undefined) {
    const tol = c.tol !== undefined && c.rel === undefined
      ? `± ${c.tol}`
      : `± ${+((c.rel ?? DEFAULT_REL) * 100).toPrecision(3)}%${c.tol !== undefined ? ` (≥ ${c.tol})` : ''}`;
    parts.push(`${name} ≈ ${c.approx} ${tol}`);
  }
  return parts.join(' and ');
}

function pickCondition(o: Condition): Condition {
  const { gt, gte, lt, lte, between, approx, tol, rel } = o;
  return { gt, gte, lt, lte, between, approx, tol, rel };
}

function windowText(w: ExpectWindow): string {
  if (w.from === undefined && w.until === undefined) return '';
  return ` over t ∈ [${w.from ?? 0}, ${w.until ?? 'end'}] s`;
}

function evalFit(f: FitExpect, table: Table, label?: string): ExpectResult {
  const { xs, ys } = windowPairs(table, f.x, f.y, f);
  const measured: Record<string, number> = { n: xs.length };
  if (f.model === 'exponential') {
    const fit = exponentialFit(xs, ys);
    Object.assign(measured, { r2: fit.r2, a: fit.a, b: fit.b, tau: fit.tau });
  } else if (f.model === 'power') {
    const fit = powerFit(xs, ys);
    Object.assign(measured, { r2: fit.r2, a: fit.a, b: fit.b });
  } else if (f.model === 'proportional') {
    const fit = proportionalFit(xs, ys);
    Object.assign(measured, { r2: fit.r2, slope: fit.slope });
  } else {
    const fit = linearFit(xs, ys);
    Object.assign(measured, { r2: fit.r2, slope: fit.slope, intercept: fit.intercept });
  }
  const checks: [string, Condition | undefined][] = [
    ['r2', f.r2], ['slope', f.slope], ['intercept', f.intercept], ['b', f.b]
  ];
  let pass = xs.length >= 2;
  const conds: string[] = [];
  for (const [name, c] of checks) {
    if (!c) continue;
    conds.push(conditionText(name === 'r2' ? 'R²' : name, c));
    if (!meets(measured[name] ?? Number.NaN, c)) pass = false;
  }
  return {
    label: label ?? `fit ${f.y} ~ ${f.x} (${f.model})${windowText(f)}`,
    pass,
    measured,
    condition: conds.join(' and ') || 'n ≥ 2'
  };
}

/** Evaluate one expect block against a table. */
export function evaluateExpect(e: ExpectDef, table: Table): ExpectResult {
  if (e.fit) return evalFit(e.fit, table, e.label);
  if (e.stat) {
    const s = e.stat;
    const v = reduceWindow(table, s.key, s, s.of);
    const c = pickCondition(s);
    return {
      label: e.label ?? `${s.of}(${s.key})${windowText(s)}`,
      pass: meets(v, c),
      measured: { [s.of]: v },
      condition: conditionText(`${s.of}(${s.key})`, c)
    };
  }
  if (e.ratio) {
    const r = e.ratio;
    const num = reduceWindow(table, r.num, r, r.of);
    const den = reduceWindow(table, r.den, r, r.of);
    const v = den !== 0 ? num / den : Number.NaN;
    const c = pickCondition(r);
    return {
      label: e.label ?? `${r.of}(${r.num}) / ${r.of}(${r.den})${windowText(r)}`,
      pass: meets(v, c),
      measured: { ratio: v, num, den },
      condition: conditionText('ratio', c)
    };
  }
  return { label: e.label ?? 'expect', pass: false, measured: {}, condition: 'unknown expect kind' };
}
