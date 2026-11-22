/**
 * Calibration off the frame loop (#257 §3) — lazy chunk. Runs
 * {@link runTwinSysId} in the offline worker (workers/wasm-offline-worker.ts,
 * message `kind: 'sysid'`), with progress after every LM iteration; without
 * `Worker` (or if the worker cannot load sim_core) it runs on this thread.
 */
import { getSimCore, loadSimCore } from '../wasm/index';
import type { OfflineWorkerResponse, OfflineWorkerSysIdRequest } from '../workers/wasm-offline-worker';
import { runTwinSysId, type TwinSysIdInput, type TwinSysIdProgress, type TwinSysIdResult } from './sysid-run';

async function onThisThread(input: TwinSysIdInput, onProgress?: (p: TwinSysIdProgress) => void): Promise<TwinSysIdResult> {
  const mod = getSimCore() ?? (await loadSimCore());
  if (!mod) throw new Error('sim_core.wasm unavailable — calibration needs the C++ fit');
  return runTwinSysId(mod, input, onProgress);
}

export function calibrateRun(input: TwinSysIdInput, onProgress?: (p: TwinSysIdProgress) => void): Promise<TwinSysIdResult> {
  if (typeof Worker === 'undefined') return onThisThread(input, onProgress);
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('../workers/wasm-offline-worker.ts', import.meta.url), { type: 'module' });
    } catch {
      onThisThread(input, onProgress).then(resolve, reject);
      return;
    }
    worker.onmessage = (e: MessageEvent<OfflineWorkerResponse>) => {
      const msg = e.data;
      if (msg && 'kind' in msg && msg.kind === 'sysid-progress') {
        onProgress?.(msg.progress);
        return;
      }
      worker.terminate();
      if (msg?.ok && 'kind' in msg && msg.kind === 'sysid') resolve(msg.result);
      else if (msg && !msg.ok && /sim_core/.test(msg.error)) onThisThread(input, onProgress).then(resolve, reject);
      else reject(new Error(msg && !msg.ok ? msg.error : 'calibration worker failed'));
    };
    worker.onerror = () => {
      worker.terminate();
      onThisThread(input, onProgress).then(resolve, reject);
    };
    const req: OfflineWorkerSysIdRequest = { kind: 'sysid', input };
    // Copied, not transferred: the main-thread fallback may still need it.
    worker.postMessage(req);
  });
}
