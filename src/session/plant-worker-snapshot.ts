/**
 * Plant snapshot calls to the plant worker (#224 §2) — `plantSave` /
 * `plantLoad` against the worker's own sim_core instance.
 *
 * Lazy (imported by lab-snapshot.ts), so the entry-chunk host only hands out
 * its Worker (`PlantWorkerHost.snapshotPort`). Each call listens for the
 * reply with its `id` on that Worker; the host's step loop ignores these
 * replies (no `seq`). The worker handles messages in order, so a save sees
 * every step batch posted before it and a load lands before any batch posted
 * after it.
 */
import type {
  PlantWorkerCallReply,
  PlantWorkerLoadState,
  PlantWorkerSaveState
} from './plant-worker-protocol';

/** A reply slower than this (a wedged or terminated worker) resolves as "no plant". */
const CALL_TIMEOUT_MS = 5000;

let nextId = 0;

/** The slice of `Worker` a call needs. */
export interface PlantWorkerPort {
  postMessage(msg: unknown): void;
  addEventListener(type: 'message', fn: (e: MessageEvent) => void): void;
  removeEventListener(type: 'message', fn: (e: MessageEvent) => void): void;
}

function call(port: PlantWorkerPort, msg: PlantWorkerSaveState | PlantWorkerLoadState): Promise<PlantWorkerCallReply | null> {
  const id = ++nextId;
  return new Promise((resolve) => {
    const finish = (reply: PlantWorkerCallReply | null): void => {
      clearTimeout(timer);
      port.removeEventListener('message', onMessage);
      resolve(reply);
    };
    const onMessage = (e: MessageEvent): void => {
      const d = e.data as PlantWorkerCallReply | null;
      if (d && (d.type === 'plantState' || d.type === 'plantLoaded') && d.id === id) finish(d);
    };
    const timer = setTimeout(() => finish(null), CALL_TIMEOUT_MS);
    port.addEventListener('message', onMessage);
    try {
      port.postMessage({ ...msg, id });
    } catch {
      finish(null);
    }
  });
}

/** The worker sim_core's `mode` state vector; null when it has no C++ plant. */
export async function workerSavePlantState(port: PlantWorkerPort, mode: number): Promise<Float32Array | null> {
  const reply = await call(port, { type: 'plantSave', id: 0, mode });
  return reply?.type === 'plantState' && reply.values ? Float32Array.from(reply.values) : null;
}

/** Load a vector into the worker sim_core; false when it refused (or did not answer). */
export async function workerLoadPlantState(
  port: PlantWorkerPort,
  mode: number,
  values: ArrayLike<number>,
  layoutHash: number
): Promise<boolean> {
  const reply = await call(port, { type: 'plantLoad', id: 0, mode, values: Array.from(values), layoutHash });
  return reply?.type === 'plantLoaded' && reply.ok;
}
