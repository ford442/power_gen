import { ValidatedConstants } from '../ValidatedConstants';
import { SEG_SPEC } from '../seg-operator-state.js';
import { TELEMETRY_META } from '../telemetry-hub.js';
import {
  rowsToCsv,
  downloadText,
  downloadJson,
  TELEMETRY_CSV_VERSION
} from './telemetry-schema.js';
import { buildReplayFile } from './replay-format.js';

export { rowsToCsv, downloadText, downloadJson };

/**
 * JSON snapshot of literature constants + live operator config.
 */
export function buildConfigSnapshot() {
  const op = window.segOperator;
  const v = window.multiVisualizer;
  return {
    schemaVersion: TELEMETRY_CSV_VERSION,
    exportedAt: new Date().toISOString(),
    constants: {
      PHYSICAL_CONSTANTS: ValidatedConstants.PHYSICAL_CONSTANTS,
      SEG_MAGNET: ValidatedConstants.SEG_MAGNET,
      SEG_CONFIG: ValidatedConstants.SEG_CONFIG,
      SEG_SPEC,
      TELEMETRY_META
    },
    operator: op ? {
      targetDrive: op.targetDrive,
      magneticFieldStrength: op.magneticFieldStrength,
      loadResistance: op.loadResistance,
      status: op.status,
      isRunning: op.isRunning
    } : null,
    layout: {
      segLayoutPreset: v?.getSEGLayoutPreset?.() ?? v?.segLayoutPreset ?? null,
      heronLayoutPreset: v?.heronLayoutPreset ?? null,
      view: v?.currentView ?? 'overview',
      renderer: window.currentRenderer ?? null
    },
    seed: (() => {
      try {
        return localStorage.getItem('seg-sim-seed');
      } catch (_) {
        return null;
      }
    })()
  };
}

/**
 * @param {Record<string, number|string>[]} rows
 * @param {string} [filename]
 */
export function downloadTelemetryCsv(rows, filename) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  downloadText(filename || `seg-telemetry-${ts}.csv`, rowsToCsv(rows));
}

export function downloadConfigJson(filename) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  downloadJson(filename || `seg-config-${ts}.json`, buildConfigSnapshot());
}

export function downloadReplayJson(replay, filename) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  downloadJson(filename || `seg-replay-${ts}.json`, replay);
}

/**
 * Export performance profiler benchmark pack.
 * @param {object} benchmarkResults  from PerformanceProfiler.endBenchmark()
 */
export function downloadBenchmarkPack(benchmarkResults, extra = {}) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  downloadJson(`seg-benchmark-${ts}.json`, {
    exportedAt: new Date().toISOString(),
    renderer: window.currentRenderer ?? null,
    gpu: window.multiVisualizer?.profiler?.getStats?.() ?? null,
    benchmark: benchmarkResults,
    telemetry: window.telemetryHub?.getSnapshot?.() ?? null,
    ...extra
  });
}

export function buildReplayFromRecording(rows, opts = {}) {
  return buildReplayFile({
    ...opts,
    samples: rows
  });
}
