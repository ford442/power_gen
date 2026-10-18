/**
 * Experiment validation (#224 §3) — one checker for files, `.lab.json`
 * imports, `window.lab.runExperiment(def)` and CI.
 *
 * `config` goes through the LabConfig coercion (an unknown or unparsable field
 * is an error, not a silent default); `record` / `expect` / `plots` keys must
 * be catalog telemetry keys or knobs on a device the run actually steps; and
 * `set` / `ramp` / `sweep` must name knobs. The result is a normalised copy:
 * canonical knob ids, numeric knob values, steps in time order.
 */
import { DEVICE_BY_ID } from '../../generated/device-catalog';
import { LAB_CONFIG_FIELDS, type LabConfigKey } from '../../generated/lab-config';
import { coerceLabField } from '../config/lab-config';
import { CHARGE_COUPLING_EDGES } from '../renderers/shared/charge-network';
import { FIELD_COUPLING_EDGES } from '../renderers/shared/field-network';
import { canonicalKnobId, knobNumber, knobSpec } from './knobs';
import { isRecordKey, recordKeyDevice } from './readers';
import { hasBound } from './expect';
import type {
  Condition,
  ExpectDef,
  ExperimentDef,
  ExperimentStep,
  RecordStep,
  StatKind,
  SweepAxis
} from './types';

export const EXPERIMENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const DEFAULT_DT = 1 / 60;
export const DEFAULT_RECORD_HZ = 30;
export const MAX_SWEEP_RUNS = 64;
/** Longest run a file may ask for — a guard against typos (seconds). */
export const MAX_DURATION_S = 600;
const MAX_RECORD_HZ = 10_000;

const STATS: readonly StatKind[] = ['mean', 'min', 'max', 'rms', 'std', 'p2p', 'first', 'last'];
const FIELD_KEYS = new Set<string>(LAB_CONFIG_FIELDS.map((f) => f.key));

export interface ValidatedExperiment {
  def: ExperimentDef;
  /** Focus device (`config.mode`). */
  focus: string;
  /** Devices the run steps: the focus plus live coupling sources into it. */
  devices: string[];
  /** Coerced LabConfig fields from `config`. */
  config: Record<string, unknown>;
  duration: number;
  dt: number;
  /** Every recorded key, in first-recorded order (no `t`). */
  recordKeys: string[];
  /** Sweep grid points (empty without a sweep). */
  sweepPoints: Record<string, number>[];
  warnings: string[];
}

export class ExperimentError extends Error {
  constructor(readonly errors: string[]) {
    super(`invalid experiment: ${errors.join('; ')}`);
    this.name = 'ExperimentError';
  }
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Devices stepped for `focus`: it, plus every coupling source the config turns on. */
export function benchDevices(focus: string, config: Record<string, unknown>): string[] {
  const out = [focus];
  const add = (id: string) => { if (!out.includes(id)) out.push(id); };
  if (config.fieldCoupling === true) {
    for (const e of FIELD_COUPLING_EDGES) if (e.to === focus) add(e.from);
  }
  if (config.chargeCoupling === true) {
    for (const e of CHARGE_COUPLING_EDGES) if (e.to === focus) add(e.from);
  }
  return out;
}

function sweepValues(axis: SweepAxis): number[] {
  if ('values' in axis) return axis.values.slice();
  if (axis.n === 1) return [axis.from];
  return Array.from({ length: axis.n }, (_, i) => axis.from + ((axis.to - axis.from) * i) / (axis.n - 1));
}

/** Cartesian product of the sweep axes, first axis slowest. */
export function sweepGrid(sweep: Record<string, SweepAxis> | undefined): Record<string, number>[] {
  if (!sweep) return [];
  let grid: Record<string, number>[] = [{}];
  for (const [knob, axis] of Object.entries(sweep)) {
    const next: Record<string, number>[] = [];
    for (const point of grid) for (const v of sweepValues(axis)) next.push({ ...point, [knob]: v });
    grid = next;
  }
  return grid;
}

function stepEnd(s: ExperimentStep, fallback: number): number {
  if ('ramp' in s) return s.at + s.over;
  if ('record' in s) return s.until ?? fallback;
  return s.at;
}

export function validateExperiment(raw: unknown): ValidatedExperiment {
  const errors: string[] = [];
  const warnings: string[] = [];
  const err = (m: string) => errors.push(m);

  if (!isObj(raw)) throw new ExperimentError(['an experiment is a JSON object']);
  const id = raw.id;
  if (typeof id !== 'string' || !EXPERIMENT_ID_PATTERN.test(id)) {
    err(`id must match ${EXPERIMENT_ID_PATTERN} (got ${JSON.stringify(id)})`);
  }
  if (typeof raw.title !== 'string' || !raw.title.trim()) err('title is required');

  // ── config ─────────────────────────────────────────────────────────────
  const config: Record<string, unknown> = {};
  if (raw.config !== undefined && !isObj(raw.config)) err('config must be an object');
  for (const [k, v] of Object.entries(isObj(raw.config) ? raw.config : {})) {
    if (!FIELD_KEYS.has(k)) { err(`config.${k}: not a LabConfig field (docs/LAB_CONFIG.md)`); continue; }
    const c = coerceLabField(k as LabConfigKey, v);
    if (c === undefined) { err(`config.${k}: ${JSON.stringify(v)} does not parse`); continue; }
    config[k] = c;
  }
  const focus = typeof config.mode === 'string' ? config.mode : '';
  if (!focus || !DEVICE_BY_ID[focus]) {
    err(`config.mode must name a catalog device (got ${JSON.stringify(config.mode)})`);
  }
  const devices = focus ? benchDevices(focus, config) : [];

  // ── clock ──────────────────────────────────────────────────────────────
  const dt = raw.dt === undefined ? DEFAULT_DT : raw.dt;
  if (!isNum(dt) || dt < 1e-5 || dt > 0.1) err(`dt must be in [1e-5, 0.1] s (got ${JSON.stringify(raw.dt)})`);

  // ── knobs (shared by set / ramp / sweep) ───────────────────────────────
  const knobUsable = (where: string, knobId: string, numericOnly = false): string | null => {
    const spec = knobSpec(knobId);
    if (!spec) { err(`${where}: unknown knob ${JSON.stringify(knobId)} (see docs/EXPERIMENTS.md#knobs)`); return null; }
    if (spec.deviceId && focus && !devices.includes(spec.deviceId)) {
      err(`${where}: ${knobId} is on ${spec.deviceId}, which this run does not step (focus ${focus})`);
    }
    if (numericOnly && spec.kind === 'boolean') err(`${where}: ${knobId} is a switch — set it, do not ramp it`);
    return spec.id;
  };
  const knobValue = (where: string, knobId: string, v: unknown): number | null => {
    const spec = knobSpec(knobId);
    const n = knobNumber(v);
    if (!spec) return null;
    if (!Number.isFinite(n)) { err(`${where}: ${knobId} needs a number${spec.kind === 'boolean' ? ' or boolean' : ''}`); return null; }
    if (n < spec.min || n > spec.max) warnings.push(`${where}: ${knobId} = ${n} is clamped to [${spec.min}, ${spec.max}]`);
    return n;
  };

  // ── steps ──────────────────────────────────────────────────────────────
  const steps: ExperimentStep[] = [];
  const recordKeys: string[] = [];
  const records: RecordStep[] = [];
  if (!Array.isArray(raw.steps) || !raw.steps.length) err('steps must be a non-empty array');
  const rawSteps = Array.isArray(raw.steps) ? raw.steps : [];
  rawSteps.forEach((s: unknown, i: number) => {
    const where = `steps[${i}]`;
    if (!isObj(s)) { err(`${where}: not an object`); return; }
    if (!isNum(s.at) || s.at < 0) { err(`${where}.at must be a time ≥ 0 s`); return; }
    const kinds = ['set', 'ramp', 'record', 'expect'].filter((k) => k in s);
    if (kinds.length !== 1) { err(`${where}: needs exactly one of set / ramp / record / expect (has ${kinds.join(', ') || 'none'})`); return; }
    const at = s.at;
    if (isObj(s.set)) {
      const set: Record<string, number> = {};
      for (const [k, v] of Object.entries(s.set)) {
        const kid = knobUsable(`${where}.set`, k);
        const n = kid ? knobValue(`${where}.set`, k, v) : null;
        if (kid && n !== null) set[kid] = n;
      }
      steps.push({ at, set });
    } else if (isObj(s.ramp)) {
      if (!isNum(s.over) || s.over <= 0) err(`${where}.over must be > 0 s`);
      const ramp: Record<string, [number, number]> = {};
      for (const [k, v] of Object.entries(s.ramp)) {
        const kid = knobUsable(`${where}.ramp`, k, true);
        if (!Array.isArray(v) || v.length !== 2 || !isNum(v[0]) || !isNum(v[1])) {
          err(`${where}.ramp.${k} must be [from, to]`);
          continue;
        }
        knobValue(`${where}.ramp`, k, v[0]);
        knobValue(`${where}.ramp`, k, v[1]);
        if (kid) ramp[kid] = [v[0], v[1]];
      }
      steps.push({ at, ramp, over: isNum(s.over) ? s.over : 1 });
    } else if (Array.isArray(s.record)) {
      const hz = s.hz === undefined ? DEFAULT_RECORD_HZ : s.hz;
      if (!isNum(hz) || hz <= 0 || hz > MAX_RECORD_HZ) err(`${where}.hz must be in (0, ${MAX_RECORD_HZ}]`);
      if (s.until !== undefined && (!isNum(s.until) || s.until <= at)) err(`${where}.until must be after at`);
      const keys: string[] = [];
      for (const k of s.record) {
        if (typeof k !== 'string' || !isRecordKey(k)) { err(`${where}.record: ${JSON.stringify(k)} is not a telemetry key or knob`); continue; }
        const dev = recordKeyDevice(k);
        if (dev && focus && !devices.includes(dev)) err(`${where}.record: ${k} is on ${dev}, which this run does not step (focus ${focus})`);
        const key = knobSpec(k) ? canonicalKnobId(k) : k;
        keys.push(key);
        if (!recordKeys.includes(key)) recordKeys.push(key);
      }
      const rec: RecordStep = { at, record: keys, hz: isNum(hz) ? hz : DEFAULT_RECORD_HZ };
      if (isNum(s.until)) rec.until = s.until;
      records.push(rec);
      steps.push(rec);
    } else if (s.expect !== undefined) {
      const list = Array.isArray(s.expect) ? s.expect : [s.expect];
      steps.push({ at, expect: list.map((e, j) => normaliseExpect(`${where}.expect${list.length > 1 ? `[${j}]` : ''}`, e, err)) });
    } else {
      err(`${where}: ${kinds[0]} has the wrong shape`);
    }
  });

  // Steps in time order; at a tie the file order stands (set before ramp …).
  const order = new Map(steps.map((s, i) => [s, i]));
  steps.sort((a, b) => a.at - b.at || (order.get(a)! - order.get(b)!));

  const lastEnd = steps.reduce((m, s) => Math.max(m, stepEnd(s, 0)), 0);
  const duration = raw.duration === undefined ? lastEnd : raw.duration;
  if (!isNum(duration) || duration <= 0 || duration > MAX_DURATION_S) {
    err(`duration must be in (0, ${MAX_DURATION_S}] s (got ${JSON.stringify(duration)})`);
  } else if (duration < lastEnd) {
    warnings.push(`duration ${duration} s cuts off steps that end at ${lastEnd} s`);
  }
  const runEnd = isNum(duration) ? duration : lastEnd;

  // One recorder at a time keeps the table a single, evenly clocked grid.
  const spans = records.map((r) => [r.at, r.until ?? runEnd] as const).sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < spans.length; i++) {
    if (spans[i][0] < spans[i - 1][1] - 1e-9) err(`record steps overlap ([${spans[i - 1]}] and [${spans[i]}]) — use one record step per interval`);
  }

  const known = (where: string, k: unknown) => {
    const key = typeof k === 'string' && knobSpec(k) ? canonicalKnobId(k) : k;
    if (typeof key !== 'string' || !recordKeys.includes(key)) err(`${where}: ${JSON.stringify(k)} is not recorded by any record step`);
    return typeof key === 'string' ? key : '';
  };
  for (const s of steps) {
    if (!('expect' in s)) continue;
    for (const e of s.expect as ExpectDef[]) {
      if (e.fit) { e.fit.x = known('expect.fit.x', e.fit.x); e.fit.y = known('expect.fit.y', e.fit.y); }
      if (e.stat) e.stat.key = known('expect.stat.key', e.stat.key);
      if (e.ratio) { e.ratio.num = known('expect.ratio.num', e.ratio.num); e.ratio.den = known('expect.ratio.den', e.ratio.den); }
    }
  }

  // ── plots ──────────────────────────────────────────────────────────────
  const plots: { x: string; y: string; fit?: 'linear' | 'exponential' }[] = [];
  if (raw.plots !== undefined && !Array.isArray(raw.plots)) err('plots must be an array');
  for (const [i, p] of (Array.isArray(raw.plots) ? raw.plots : []).entries()) {
    if (!isObj(p)) { err(`plots[${i}]: not an object`); continue; }
    const sweepCol = (k: unknown) => typeof k === 'string' && isObj(raw.sweep) && (k in raw.sweep || canonicalKnobId(k) in raw.sweep);
    const summaryCol = (k: unknown) => typeof k === 'string' && isObj(raw.summary) && isObj(raw.summary.columns) && k in raw.summary.columns;
    const x = p.x === 't' || sweepCol(p.x) || summaryCol(p.x) ? String(p.x) : known(`plots[${i}].x`, p.x);
    const y = sweepCol(p.y) || summaryCol(p.y) ? String(p.y) : known(`plots[${i}].y`, p.y);
    if (p.fit !== undefined && p.fit !== 'linear' && p.fit !== 'exponential') err(`plots[${i}].fit must be linear or exponential`);
    plots.push({ x, y, ...(p.fit === 'linear' || p.fit === 'exponential' ? { fit: p.fit } : {}) });
  }

  // ── sweep ──────────────────────────────────────────────────────────────
  let sweep: Record<string, SweepAxis> | undefined;
  if (raw.sweep !== undefined) {
    if (!isObj(raw.sweep) || !Object.keys(raw.sweep).length) err('sweep must name at least one knob');
    sweep = {};
    for (const [k, axis] of Object.entries(isObj(raw.sweep) ? raw.sweep : {})) {
      const kid = knobUsable(`sweep`, k);
      if (!kid) continue;
      if (isObj(axis) && Array.isArray(axis.values)) {
        if (!axis.values.length || !axis.values.every((v) => Number.isFinite(knobNumber(v)))) err(`sweep.${k}.values must be numbers`);
        sweep[kid] = { values: axis.values.map(knobNumber) };
      } else if (isObj(axis) && isNum(axis.from) && isNum(axis.to) && Number.isInteger(axis.n) && (axis.n as number) >= 1) {
        sweep[kid] = { from: axis.from, to: axis.to, n: axis.n as number };
      } else {
        err(`sweep.${k} must be { from, to, n } or { values: [...] }`);
      }
    }
  }
  const sweepPoints = errors.length ? [] : sweepGrid(sweep);
  if (sweepPoints.length > MAX_SWEEP_RUNS) err(`sweep has ${sweepPoints.length} runs; the cap is ${MAX_SWEEP_RUNS}`);
  if (raw.summary !== undefined && !sweep) warnings.push('summary is only used by a sweep');

  let summaryExpect: ExpectDef[] | undefined;
  if (raw.summaryExpect !== undefined) {
    if (!sweep) err('summaryExpect needs a sweep');
    const list = Array.isArray(raw.summaryExpect) ? raw.summaryExpect : [raw.summaryExpect];
    summaryExpect = list.map((e, j) => normaliseExpect(`summaryExpect[${j}]`, e, err));
  }
  if (raw.summary !== undefined && !isObj(raw.summary)) err('summary must be an object');
  const summary = isObj(raw.summary) ? (raw.summary as ExperimentDef['summary']) : undefined;
  if (summary?.of !== undefined && !STATS.includes(summary.of)) err(`summary.of must be one of ${STATS.join(', ')}`);
  for (const [name, col] of Object.entries(summary?.columns ?? {})) {
    const c = col as Record<string, unknown>;
    const keys = Array.isArray(c.ratio) ? c.ratio : [c.key];
    for (const k of keys) known(`summary.columns.${name}`, k);
    if (c.of !== undefined && !STATS.includes(c.of as StatKind)) err(`summary.columns.${name}.of must be one of ${STATS.join(', ')}`);
  }
  // Summary verdicts read the summary table: sweep knobs, reduced keys, derived columns, `pass`.
  const summaryCols = new Set<string>([
    ...Object.keys(sweep ?? {}), ...recordKeys, ...Object.keys(summary?.columns ?? {}), 'pass'
  ]);
  const summaryKey = (where: string, k: string) => {
    const key = knobSpec(k) ? canonicalKnobId(k) : k;
    if (!summaryCols.has(key)) err(`${where}: ${JSON.stringify(k)} is not a summary column (${[...summaryCols].join(', ')})`);
    return key;
  };
  for (const [j, e] of (summaryExpect ?? []).entries()) {
    const where = `summaryExpect[${j}]`;
    if (e.fit) { e.fit.x = summaryKey(`${where}.fit.x`, e.fit.x); e.fit.y = summaryKey(`${where}.fit.y`, e.fit.y); }
    if (e.stat) e.stat.key = summaryKey(`${where}.stat.key`, e.stat.key);
    if (e.ratio) { e.ratio.num = summaryKey(`${where}.ratio.num`, e.ratio.num); e.ratio.den = summaryKey(`${where}.ratio.den`, e.ratio.den); }
  }

  if (errors.length) throw new ExperimentError(errors);

  const def: ExperimentDef = {
    id: id as string,
    title: (raw.title as string).trim(),
    ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
    config,
    dt: dt as number,
    duration: runEnd,
    steps,
    ...(plots.length ? { plots } : {}),
    ...(sweep ? { sweep } : {}),
    ...(summary ? { summary } : {}),
    ...(summaryExpect ? { summaryExpect } : {})
  };
  return { def, focus, devices, config, duration: runEnd, dt: dt as number, recordKeys, sweepPoints, warnings };
}

function conditionOf(where: string, o: Record<string, unknown>, err: (m: string) => void): Condition {
  const c: Condition = {};
  for (const k of ['gt', 'gte', 'lt', 'lte', 'approx', 'tol', 'rel'] as const) {
    if (o[k] === undefined) continue;
    if (!isNum(o[k])) { err(`${where}.${k} must be a number`); continue; }
    c[k] = o[k] as number;
  }
  if (o.between !== undefined) {
    const b = o.between;
    if (Array.isArray(b) && b.length === 2 && isNum(b[0]) && isNum(b[1])) c.between = [b[0], b[1]];
    else err(`${where}.between must be [low, high]`);
  }
  return c;
}

function normaliseExpect(where: string, e: unknown, err: (m: string) => void): ExpectDef {
  if (!isObj(e)) { err(`${where}: not an object`); return {}; }
  const kinds = ['fit', 'stat', 'ratio'].filter((k) => k in e);
  if (kinds.length !== 1) { err(`${where}: needs exactly one of fit / stat / ratio`); return {}; }
  const label = typeof e.label === 'string' ? { label: e.label } : {};
  const win = (o: Record<string, unknown>) => ({
    ...(isNum(o.from) ? { from: o.from } : {}),
    ...(isNum(o.until) ? { until: o.until } : {})
  });
  const body = e[kinds[0]];
  if (!isObj(body)) { err(`${where}.${kinds[0]}: not an object`); return {}; }
  if (kinds[0] === 'fit') {
    const model = body.model ?? 'linear';
    if (model !== 'linear' && model !== 'proportional' && model !== 'exponential') err(`${where}.fit.model must be linear, proportional or exponential`);
    const fit: NonNullable<ExpectDef['fit']> = {
      x: String(body.x ?? ''),
      y: String(body.y ?? ''),
      model: model as 'linear',
      ...win(body)
    };
    let any = false;
    for (const k of ['r2', 'slope', 'intercept', 'b'] as const) {
      if (body[k] === undefined) continue;
      if (!isObj(body[k])) { err(`${where}.fit.${k} must be a condition ({ "gt": … })`); continue; }
      fit[k] = conditionOf(`${where}.fit.${k}`, body[k] as Record<string, unknown>, err);
      any = any || hasBound(fit[k]);
    }
    if (!any) err(`${where}.fit needs at least one bound (r2 / slope / intercept / b)`);
    return { ...label, fit };
  }
  const of = body.of ?? 'mean';
  if (!STATS.includes(of as StatKind)) err(`${where}.${kinds[0]}.of must be one of ${STATS.join(', ')}`);
  const cond = conditionOf(`${where}.${kinds[0]}`, body, err);
  if (!hasBound(cond)) err(`${where}.${kinds[0]} needs a bound (gt / lt / between / approx …)`);
  if (kinds[0] === 'stat') {
    return { ...label, stat: { key: String(body.key ?? ''), of: of as StatKind, ...cond, ...win(body) } };
  }
  return { ...label, ratio: { num: String(body.num ?? ''), den: String(body.den ?? ''), of: of as StatKind, ...cond, ...win(body) } };
}
