/**
 * WASM offline SEG telemetry export (worker thread).
 */
import { runOfflineSegExport } from '../wasm/offline-runner';

self.onmessage = async (e) => {
  try {
    const result = await runOfflineSegExport(e.data || {});
    self.postMessage({ ok: true, ...result });
  } catch (err) {
    self.postMessage({ ok: false, error: err?.message || String(err) });
  }
};
