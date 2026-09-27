/**
 * WASM offline SEG telemetry export (worker thread).
 */
import {
  runOfflineSegExport,
  type OfflineSegExportOpts,
  type OfflineSegExportResult
} from '../wasm/offline-runner';

/** Reply to the single `OfflineSegExportOpts` message this worker accepts. */
export type OfflineWorkerResponse =
  | ({ ok: true } & OfflineSegExportResult)
  | { ok: false; error: string };

self.onmessage = async (e: MessageEvent<OfflineSegExportOpts | null>) => {
  try {
    const result = await runOfflineSegExport(e.data || {});
    const res: OfflineWorkerResponse = { ok: true, ...result };
    self.postMessage(res);
  } catch (err) {
    const res: OfflineWorkerResponse = {
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    };
    self.postMessage(res);
  }
};
