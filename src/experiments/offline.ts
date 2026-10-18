/**
 * Offline / headless experiment runner (#224 §3).
 *
 * Steps an `ExperimentBench` on a fixed `dt` as fast as the CPU allows — no
 * frame loop, no renderer — so it runs in a worker, in a sweep pool, and in
 * Node for CI (scripts/test-experiments.mjs). The live runner shares the
 * interpreter; only the clock differs.
 */
import { LAB_CONFIG_DEFAULTS } from '../../generated/lab-config';
import type { RecordedRun, RunBackend } from '../analysis/run-types';
import { setSimulationSeed } from '../telemetry/deterministic-rng';
import { ExperimentBench, type CppPlant } from './bench';
import { evaluateExpect, reduce, windowColumn } from './expect';
import { ExperimentInterpreter, newExperimentRunId } from './interpreter';
import { knobSpec } from './knobs';
import { readRecordKey } from './readers';
import type { StatKind } from './types';
import type { ValidatedExperiment } from './validate';

export interface OfflineRunOpts {
  /** One fresh simulator for this run, or null for the JS plants. */
  cpp: CppPlant | null;
  sweepPoint?: Record<string, number>;
  /** 0..1, at most every ~2 % of the run. */
  onProgress?: (fraction: number) => void;
  startedAt?: string;
}

export function runExperimentSync(v: ValidatedExperiment, opts: OfflineRunOpts): RecordedRun {
  const seed = typeof v.config.seed === 'number' ? v.config.seed : LAB_CONFIG_DEFAULTS.seed;
  if (typeof seed === 'number') setSimulationSeed(seed, false);

  const bench = new ExperimentBench(v.focus, v.devices, v.config, opts.cpp);
  const interp = new ExperimentInterpreter(v, opts.sweepPoint);
  const host = {
    write: (k: string, value: number) => { knobSpec(k)?.write(bench, value); },
    read: (k: string) => readRecordKey(bench, k)
  };

  const steps = Math.max(1, Math.ceil(v.duration / v.dt - 1e-9));
  const every = Math.max(1, Math.floor(steps / 50));
  interp.applyDue(0, host);
  interp.observe(0, host);
  for (let i = 1; i <= steps; i++) {
    bench.step(v.dt);
    // i·dt, not a running sum: a long run must not drift off the step grid.
    const t = i * v.dt;
    interp.observe(t, host);
    if (i < steps) interp.applyDue(t, host);
    if (opts.onProgress && i % every === 0) opts.onProgress(i / steps);
  }
  opts.onProgress?.(1);
  return interp.toRun({
    runner: 'offline',
    backend: bench.backend,
    startedAt: opts.startedAt ?? new Date().toISOString()
  });
}

/** Column name → reducer over one run's window. */
function summaryReducers(v: ValidatedExperiment): [string, (run: RecordedRun, win: { from: number; until: number }) => number][] {
  const s = v.def.summary ?? {};
  const of: StatKind = s.of ?? 'mean';
  const cols: [string, (run: RecordedRun, win: { from: number; until: number }) => number][] = v.recordKeys.map((k) => [
    k,
    (run, win) => reduce(windowColumn(run, k, win), of)
  ]);
  for (const [name, c] of Object.entries(s.columns ?? {})) {
    const cof = c.of ?? of;
    if ('ratio' in c) {
      const [num, den] = c.ratio;
      cols.push([name, (run, win) => reduce(windowColumn(run, num, win), cof) / reduce(windowColumn(run, den, win), cof)]);
    } else {
      cols.push([name, (run, win) => reduce(windowColumn(run, c.key, win), cof)]);
    }
  }
  return cols;
}

/**
 * One row per sweep run: the sweep point, each recorded key reduced over the
 * summary window (default: the run's last second), any derived columns, and
 * `pass` (1 when every per-run expect passed). `summaryExpect` is judged on
 * this table.
 */
export function summarizeSweep(v: ValidatedExperiment, runs: readonly RecordedRun[]): RecordedRun {
  const knobs = Object.keys(v.def.sweep ?? {});
  const reducers = summaryReducers(v);
  const columns = [...knobs, ...reducers.map(([n]) => n), 'pass'];
  const rows = runs.map((run) => {
    const tj = run.columns.indexOf('t');
    const tEnd = tj >= 0 && run.rows.length ? run.rows[run.rows.length - 1][tj] : v.duration;
    const win = {
      from: v.def.summary?.from ?? tEnd - 1,
      until: v.def.summary?.until ?? tEnd
    };
    return [
      ...knobs.map((k) => run.sweep?.[k] ?? Number.NaN),
      ...reducers.map(([, f]) => f(run, win)),
      (run.expects ?? []).every((e) => e.pass) ? 1 : 0
    ];
  });
  const table = { columns, rows };
  const backends = new Set<RunBackend>(runs.map((r) => r.backend));
  return {
    id: newExperimentRunId(`${v.def.id}-sweep`),
    experimentId: v.def.id,
    title: `${v.def.title} — sweep (${runs.length} runs)`,
    startedAt: runs[0]?.startedAt ?? new Date().toISOString(),
    runner: 'offline',
    backend: backends.size === 1 ? [...backends][0] : 'mixed',
    hz: 0,
    columns,
    rows,
    config: v.config,
    expects: (v.def.summaryExpect ?? []).map((e) => evaluateExpect(e, table)),
    ...(v.def.plots ? { plots: v.def.plots } : {})
  };
}
