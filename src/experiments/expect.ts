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

export function reduce(values: readonly number[], of: StatKind): number {
  const v = values.filter((x) => Number.isFinite(x));
  if (!v.length) return Number.NaN;
  switch (of) {
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
    const v = reduce(windowColumn(table, s.key, s), s.of);
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
    const num = reduce(windowColumn(table, r.num, r), r.of);
    const den = reduce(windowColumn(table, r.den, r), r.of);
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
