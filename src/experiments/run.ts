/**
 * `runExperiment(idOrDef, opts)` — the one entry point behind
 * `window.lab.runExperiment`, the experiment panel, tour `run` steps and the
 * embed protocol (#224 §3). Lazy chunk.
 *
 *   runner 'offline' (default): a worker steps a fresh bench faster than real
 *     time; a sweep fans out one worker per grid point, at most
 *     `hardwareConcurrency − 1` at once, and returns the summary run.
 *   runner 'live': the steps ride the session clock on the lab you are
 *     looking at (live-runner.ts). Sweeps are offline only.
 *
 * Every run (each sweep point too) lands in the analysis panel's run store.
 */
import type { RecordedRun } from '../analysis/run-types';
import { addRun } from '../analysis/run-store';
import { labConfig } from '../config/lab-config';
import type { ExperimentWorkerRequest, ExperimentWorkerResponse } from '../workers/experiment-worker';
import { runExperimentSync, summarizeSweep } from './offline';
import { loadReferenceExperiment } from './registry';
import { validateExperiment, type ValidatedExperiment } from './validate';

export interface RunExperimentOpts {
  runner?: 'live' | 'offline';
  /** Step the focus device on the C++ plant. Default: the experiment's `wasmPhysics`, else the page's. */
  wasm?: boolean;
  /** 0..1 across the whole experiment (all sweep points). */
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
  /** Add the runs to the analysis panel (default true). */
  store?: boolean;
}

export interface ExperimentOutcome {
  /** The run — for a sweep, its summary table (one row per point). */
  run: RecordedRun;
  /** Every recorded run (one, or one per sweep point). */
  runs: RecordedRun[];
  warnings: string[];
}

/** An id of a shipped experiment, or a definition object. */
export async function resolveExperiment(idOrDef: unknown): Promise<ValidatedExperiment> {
  if (typeof idOrDef === 'string') {
    const raw = await loadReferenceExperiment(idOrDef);
    if (!raw) throw new Error(`no experiment ${JSON.stringify(idOrDef)}`);
    return validateExperiment(raw);
  }
  return validateExperiment(idOrDef);
}

function abortError(): Error {
  return Object.assign(new Error('experiment cancelled'), { name: 'AbortError' });
}

/** One offline run in its own worker (main thread when there are no workers). */
async function runOffline(
  v: ValidatedExperiment,
  wasm: boolean,
  sweepPoint: Record<string, number> | undefined,
  onProgress: (f: number) => void,
  signal?: AbortSignal
): Promise<RecordedRun> {
  if (signal?.aborted) throw abortError();
  if (typeof Worker === 'undefined') {
    const { SEGSim } = await import('../wasm/sim');
    const sim = wasm ? await SEGSim.create() : null;
    try {
      return runExperimentSync(v, { cpp: sim?.wasmAvailable ? sim : null, sweepPoint, onProgress });
    } finally {
      sim?.dispose();
    }
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../workers/experiment-worker.ts', import.meta.url), { type: 'module' });
    const done = () => {
      worker.terminate();
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      done();
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    worker.onmessage = (e: MessageEvent<ExperimentWorkerResponse>) => {
      const msg = e.data;
      if (msg.type === 'progress') return onProgress(msg.fraction);
      done();
      if (msg.type === 'done') resolve(msg.run);
      else reject(new Error(msg.error));
    };
    worker.onerror = (e: ErrorEvent) => {
      done();
      reject(new Error(e.message || 'experiment worker failed'));
    };
    const req: ExperimentWorkerRequest = { def: v.def, sweepPoint, wasm };
    worker.postMessage(req);
  });
}

/** Run `fn` over `items` with at most `limit` in flight; results keep input order. */
async function mapPool<T, R>(items: readonly T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return out;
}

export function sweepConcurrency(): number {
  const hc = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 2 : 2;
  // Leave a core for the render loop.
  return Math.max(1, Math.min(8, hc - 1));
}

export async function runExperimentDetailed(idOrDef: unknown, opts: RunExperimentOpts = {}): Promise<ExperimentOutcome> {
  const v = await resolveExperiment(idOrDef);
  const runner = opts.runner ?? 'offline';
  const wasm = opts.wasm ?? (typeof v.config.wasmPhysics === 'boolean' ? v.config.wasmPhysics : labConfig().wasmPhysics);
  const store = (runs: RecordedRun[]) => {
    if (opts.store === false) return;
    for (const r of runs) addRun(r);
  };

  if (runner === 'live') {
    if (v.sweepPoints.length) throw new Error('a sweep runs offline only — use runner: "offline"');
    const { runLive } = await import('./live-runner');
    const { run, warnings } = await runLive(v, { onProgress: opts.onProgress, signal: opts.signal });
    store([run]);
    return { run, runs: [run], warnings: [...v.warnings, ...warnings] };
  }

  if (!v.sweepPoints.length) {
    const run = await runOffline(v, wasm, undefined, (f) => opts.onProgress?.(f), opts.signal);
    store([run]);
    return { run, runs: [run], warnings: v.warnings };
  }

  const fractions = v.sweepPoints.map(() => 0);
  const report = () => opts.onProgress?.(fractions.reduce((s, f) => s + f, 0) / fractions.length);
  const runs = await mapPool(v.sweepPoints, sweepConcurrency(), (point, i) =>
    runOffline(v, wasm, point, (f) => { fractions[i] = f; report(); }, opts.signal)
  );
  const summary = summarizeSweep(v, runs);
  // Summary last, so it is the newest — what the panel opens first.
  store([...runs, summary]);
  return { run: summary, runs, warnings: v.warnings };
}

export async function runExperiment(idOrDef: unknown, opts: RunExperimentOpts = {}): Promise<RecordedRun> {
  return (await runExperimentDetailed(idOrDef, opts)).run;
}
