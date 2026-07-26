export interface OfflineSegExportResult {
  csv: string;
  rows: Record<string, number | string>[];
}

export interface OfflineSegExportOpts {
  durationSec?: number;
  sampleHz?: number;
  drive?: number;
  loadOhm?: number;
  fieldStrength?: number;
}

export function runOfflineSegExport(opts?: OfflineSegExportOpts): Promise<OfflineSegExportResult>;
export function runOfflineSegExportInWorker(opts?: OfflineSegExportOpts): Promise<OfflineSegExportResult>;
