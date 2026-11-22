/**
 * WASM offline work (worker thread): the SEG telemetry export, and the hardware
 * twin's calibration fit (#257 §3, `kind: 'sysid'` — progress after every
 * Levenberg–Marquardt iteration, then the result).
 */
import {
  runOfflineSegExport,
  type OfflineSegExportOpts,
  type OfflineSegExportResult
} from '../wasm/offline-runner';
import { loadSimCore } from '../wasm/index';
import { runTwinSysId, type TwinSysIdInput, type TwinSysIdProgress, type TwinSysIdResult } from '../twin/sysid-run';

export interface OfflineWorkerSysIdRequest {
  kind: 'sysid';
  input: TwinSysIdInput;
}

/** Replies: the export's single result, or the fit's progress lines then its result. */
export type OfflineWorkerResponse =
  | ({ ok: true } & OfflineSegExportResult)
  | { ok: true; kind: 'sysid-progress'; progress: TwinSysIdProgress }
  | { ok: true; kind: 'sysid'; result: TwinSysIdResult }
  | { ok: false; error: string };

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

async function sysid(req: OfflineWorkerSysIdRequest): Promise<void> {
  const mod = await loadSimCore();
  if (!mod) throw new Error('sim_core unavailable in the worker');
  const result = runTwinSysId(mod, req.input, (progress) => {
    const msg: OfflineWorkerResponse = { ok: true, kind: 'sysid-progress', progress };
    self.postMessage(msg);
  });
  const res: OfflineWorkerResponse = { ok: true, kind: 'sysid', result };
  self.postMessage(res);
}

self.onmessage = async (e: MessageEvent<OfflineSegExportOpts | OfflineWorkerSysIdRequest | null>) => {
  try {
    const data = e.data;
    if (data && 'kind' in data && data.kind === 'sysid') {
      await sysid(data);
      return;
    }
    const result = await runOfflineSegExport((data as OfflineSegExportOpts | null) || {});
    const res: OfflineWorkerResponse = { ok: true, ...result };
    self.postMessage(res);
  } catch (err) {
    const res: OfflineWorkerResponse = { ok: false, error: errText(err) };
    self.postMessage(res);
  }
};
