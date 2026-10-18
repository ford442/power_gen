/**
 * Offline experiment run (dedicated worker, #224 §3). One message, one run:
 * the worker builds its own bench — and, when asked, its own `sim_core.wasm`
 * simulator — steps it faster than real time and posts the RecordedRun back.
 * A sweep starts one of these per grid point (src/experiments/run.ts).
 */
import type { RecordedRun } from '../analysis/run-types';
import { runExperimentSync } from '../experiments/offline';
import { validateExperiment } from '../experiments/validate';
import { SEGSim } from '../wasm/sim';

export interface ExperimentWorkerRequest {
  /** A (validated) experiment definition — re-validated here. */
  def: unknown;
  sweepPoint?: Record<string, number>;
  /** Step the focus device on the C++ plant (falls back to JS if WASM is missing). */
  wasm: boolean;
}

export type ExperimentWorkerResponse =
  | { type: 'progress'; fraction: number }
  | { type: 'done'; run: RecordedRun; wasmAvailable: boolean }
  | { type: 'error'; error: string };

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<ExperimentWorkerRequest>) => void) | null;
  postMessage(msg: ExperimentWorkerResponse): void;
};

ctx.onmessage = async (e) => {
  let sim: SEGSim | null = null;
  try {
    const { def, sweepPoint, wasm } = e.data;
    const v = validateExperiment(def);
    if (wasm) {
      sim = await SEGSim.create();
      if (!sim.wasmAvailable) sim = null;
    }
    const run = runExperimentSync(v, {
      cpp: sim,
      sweepPoint,
      onProgress: (fraction) => ctx.postMessage({ type: 'progress', fraction })
    });
    ctx.postMessage({ type: 'done', run, wasmAvailable: !!sim });
  } catch (err) {
    ctx.postMessage({ type: 'error', error: err instanceof Error ? err.message : String(err) });
  } finally {
    sim?.dispose();
  }
};
