/**
 * The experiment interpreter — one timeline, two clocks (#224 §3).
 *
 * It owns no clock. A runner calls, for every plant batch:
 *
 *   applyDue(t, host)   before the plant steps from run-time t — writes every
 *                       `set` that is due and every active `ramp`'s value at t;
 *   observe(t, host)    after the plant reached t — takes the samples that are
 *                       due and evaluates the `expect` blocks whose time came.
 *
 * The offline runner calls it every `dt`; the live runner once per frame with
 * the session clock (sum of the frame's substeps), so pause, `.` and slow-mo
 * stretch an experiment exactly as they stretch the plant. The live runner
 * cuts each batch at `nextEvent`, so a step or sample lands on its own time
 * even when a frame is slow. Rows carry the clock time they were actually
 * taken at, never a nominal grid time.
 */
import type { ExpectResult, RecordedRun, RunBackend, RunRunner } from '../analysis/run-types';
import { evaluateExpect } from './expect';
import type { ExpectDef, RecordStep } from './types';
import type { ValidatedExperiment } from './validate';
import { DEFAULT_RECORD_HZ } from './validate';

export interface InterpreterHost {
  write(knobId: string, value: number): void;
  read(key: string): number;
}

/** Slack for float clocks: 1/60 summed sixty times is not exactly 1. */
const EPS = 1e-7;

interface Recorder {
  step: RecordStep;
  until: number;
  period: number;
  next: number;
  cols: number[];
}

/** Longest stretch of run time one live batch may step, s. */
export const MAX_LIVE_BATCH_S = 0.1;
/** Substep of a cut live batch, s — the session's fixed step at 1×. */
export const LIVE_SUBSTEP_S = 1 / 60;

/**
 * A frame's substeps for a live run, cut so the batch ends `room` seconds on
 * (the timeline's next event) and never spans more than MAX_LIVE_BATCH_S: a
 * slow frame (a 1 fps laptop, a 3× session) cannot step past a set, a ramp's
 * end or a record tick. A cut batch is re-split into equal substeps of at
 * most LIVE_SUBSTEP_S; an uncut one keeps the frame's own.
 */
export function liveBatch(simSteps: readonly number[], room: number): number[] {
  let total = 0;
  for (const s of simSteps) if (s > 0) total += s;
  const cap = Math.min(MAX_LIVE_BATCH_S, room);
  if (total <= cap || cap <= 0) return simSteps.slice();
  const n = Math.max(1, Math.ceil(cap / LIVE_SUBSTEP_S - 1e-9));
  return new Array<number>(n).fill(cap / n);
}

let runSeq = 0;

export function newExperimentRunId(experimentId: string): string {
  runSeq = (runSeq + 1) % 1e6;
  return `${experimentId}-${Date.now().toString(36)}-${runSeq.toString(36)}`;
}

export class ExperimentInterpreter {
  readonly columns: string[];
  readonly rows: number[][] = [];
  readonly expects: ExpectResult[] = [];
  readonly duration: number;

  private readonly sets: { at: number; set: Record<string, number> }[];
  private readonly ramps: { at: number; over: number; ramp: Record<string, [number, number]>; finished: boolean }[];
  private readonly recorders: Recorder[];
  private readonly expectSteps: { at: number; expect: ExpectDef[]; done: boolean }[];
  private setIdx = 0;
  private lastObserved = -Infinity;

  constructor(readonly v: ValidatedExperiment, readonly sweepPoint: Record<string, number> = {}) {
    this.duration = v.duration;
    this.columns = ['t', ...v.recordKeys];
    const sets: { at: number; set: Record<string, number> }[] = [];
    const ramps: ExperimentInterpreter['ramps'] = [];
    const recorders: Recorder[] = [];
    const expects: ExperimentInterpreter['expectSteps'] = [];
    for (const s of v.def.steps) {
      if ('set' in s) sets.push({ at: s.at, set: s.set as Record<string, number> });
      else if ('ramp' in s) ramps.push({ at: s.at, over: s.over, ramp: s.ramp, finished: false });
      else if ('record' in s) {
        const hz = s.hz ?? DEFAULT_RECORD_HZ;
        recorders.push({
          step: s,
          until: s.until ?? v.duration,
          period: 1 / hz,
          next: s.at,
          cols: s.record.map((k) => this.columns.indexOf(k))
        });
      } else if ('expect' in s) {
        expects.push({ at: s.at, expect: Array.isArray(s.expect) ? s.expect : [s.expect], done: false });
      }
    }
    // A sweep point is written after the t = 0 sets, so it wins over them.
    if (Object.keys(sweepPoint).length) {
      const after = sets.findIndex((s) => s.at > 0);
      sets.splice(after < 0 ? sets.length : after, 0, { at: 0, set: { ...sweepPoint } });
    }
    this.sets = sets;
    this.ramps = ramps;
    this.recorders = recorders;
    this.expectSteps = expects;
  }

  /** Highest recorder rate (the run's nominal sample rate). */
  get hz(): number {
    return this.recorders.reduce((m, r) => Math.max(m, 1 / r.period), 0) || DEFAULT_RECORD_HZ;
  }

  get done(): boolean {
    return this.lastObserved >= this.duration - EPS;
  }

  applyDue(t: number, host: InterpreterHost): void {
    while (this.setIdx < this.sets.length && this.sets[this.setIdx].at <= t + EPS) {
      for (const [k, val] of Object.entries(this.sets[this.setIdx].set)) host.write(k, val);
      this.setIdx++;
    }
    for (const r of this.ramps) {
      if (r.finished || r.at > t + EPS) continue;
      const u = Math.min(1, Math.max(0, (t - r.at) / r.over));
      for (const [k, [from, to]] of Object.entries(r.ramp)) host.write(k, from + (to - from) * u);
      // The end value is written once, on the first batch at or after the end.
      if (u >= 1) r.finished = true;
    }
  }

  observe(t: number, host: InterpreterHost): void {
    if (t < this.lastObserved) return;
    this.lastObserved = t;
    for (const r of this.recorders) {
      if (r.next > t + EPS || r.next > r.until + EPS) continue;
      const row = new Array<number>(this.columns.length).fill(Number.NaN);
      row[0] = t;
      for (let i = 0; i < r.cols.length; i++) row[r.cols[i]] = host.read(r.step.record[i]);
      this.rows.push(row);
      // One row per batch at most; the next grid point strictly after t.
      r.next += r.period * Math.max(1, Math.floor((t - r.next) / r.period + EPS) + 1);
    }
    for (const e of this.expectSteps) {
      if (e.done || e.at > t + EPS) continue;
      e.done = true;
      const table = { columns: this.columns, rows: this.rows };
      for (const x of e.expect) {
        // Default window: everything recorded up to the expect's own time.
        const res = evaluateExpect(withDefaultUntil(x, e.at), table);
        this.expects.push(res);
      }
    }
  }

  /**
   * The first run time after `t` at which a set, a ramp's start or end, a
   * record sample or an expect is due — the run's end at the latest. The live
   * runner cuts its batches here, so a slow frame never steps past one.
   */
  nextEvent(t: number): number {
    let next = this.duration;
    const consider = (x: number): void => {
      if (x > t + EPS && x < next) next = x;
    };
    for (let i = this.setIdx; i < this.sets.length; i++) consider(this.sets[i].at);
    for (const r of this.ramps) {
      if (r.finished) continue;
      consider(r.at);
      consider(r.at + r.over);
    }
    for (const r of this.recorders) if (r.next <= r.until + EPS) consider(r.next);
    for (const e of this.expectSteps) if (!e.done) consider(e.at);
    return next;
  }

  /** Expect steps that never came due (a live run stopped early). */
  pendingExpects(): number {
    return this.expectSteps.filter((e) => !e.done).length;
  }

  toRun(meta: { runner: RunRunner; backend: RunBackend; startedAt: string; config?: Record<string, unknown> }): RecordedRun {
    const def = this.v.def;
    return {
      id: newExperimentRunId(def.id),
      experimentId: def.id,
      title: Object.keys(this.sweepPoint).length
        ? `${def.title} — ${Object.entries(this.sweepPoint).map(([k, v]) => `${k} = ${+v.toPrecision(4)}`).join(', ')}`
        : def.title,
      startedAt: meta.startedAt,
      runner: meta.runner,
      backend: meta.backend,
      hz: this.hz,
      columns: this.columns.slice(),
      rows: this.rows,
      ...(Object.keys(this.sweepPoint).length ? { sweep: { ...this.sweepPoint } } : {}),
      config: meta.config ?? this.v.config,
      expects: this.expects.slice(),
      ...(def.plots ? { plots: def.plots } : {})
    };
  }
}

function withDefaultUntil(e: ExpectDef, at: number): ExpectDef {
  const kind = e.fit ? 'fit' : e.stat ? 'stat' : e.ratio ? 'ratio' : null;
  if (!kind) return e;
  const body = e[kind]!;
  return body.until === undefined ? { ...e, [kind]: { ...body, until: at } } : e;
}
