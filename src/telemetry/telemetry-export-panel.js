/**
 * Telemetry export UI — CSV / JSON / replay / offline WASM / benchmark pack.
 */

import { telemetryHub } from '../telemetry-hub.js';
import {
  downloadTelemetryCsv,
  downloadConfigJson,
  downloadReplayJson,
  downloadBenchmarkPack,
  buildReplayFromRecording
} from './telemetry-export.js';
import { applyReplay } from './replay-format.js';
import { setSimulationSeed } from './deterministic-rng.js';
import { runOfflineSegExportInWorker, runOfflineSegExport } from '../wasm/offline-runner.js';

function setStatus(el, text, ok = true) {
  if (!el) return;
  el.textContent = text;
  el.style.color = ok ? '#0aa' : '#f66';
}

export function initTelemetryExportPanel() {
  const sampleHzEl = document.getElementById('telemetrySampleHz');
  const recordBtn = document.getElementById('telemetryRecordBtn');
  const csvBtn = document.getElementById('telemetryCsvBtn');
  const jsonBtn = document.getElementById('telemetryJsonBtn');
  const offlineBtn = document.getElementById('telemetryOfflineBtn');
  const replayBtn = document.getElementById('telemetryReplayBtn');
  const replayFile = document.getElementById('telemetryReplayFile');
  const benchBtn = document.getElementById('telemetryBenchExportBtn');
  const statusEl = document.getElementById('telemetryExportStatus');
  const seedEl = document.getElementById('telemetrySeed');

  if (!recordBtn) return;

  const getHz = () => {
    const v = parseInt(sampleHzEl?.value || '10', 10);
    return Math.min(60, Math.max(1, v || 10));
  };

  recordBtn.addEventListener('click', () => {
    if (telemetryHub.isRecording()) {
      telemetryHub.stopRecording();
      recordBtn.textContent = '● Record 10s';
      setStatus(statusEl, `Stopped — ${telemetryHub.getRecordedRows().length} samples`);
      return;
    }
    if (!window.segOperator?.isRunning) {
      window.segOperator?.start();
    }
    telemetryHub.startRecording(10, getHz());
    recordBtn.textContent = '■ Stop';
    setStatus(statusEl, 'Recording 10s sim time…');
  });

  csvBtn?.addEventListener('click', () => {
    let rows = telemetryHub.getRecordedRows();
    if (rows.length === 0) {
      setStatus(statusEl, 'No samples — click Record 10s first', false);
      return;
    }
    downloadTelemetryCsv(rows);
    setStatus(statusEl, `Downloaded CSV (${rows.length} rows)`);
  });

  jsonBtn?.addEventListener('click', () => {
    downloadConfigJson();
    setStatus(statusEl, 'Downloaded config JSON');
  });

  offlineBtn?.addEventListener('click', async () => {
    offlineBtn.disabled = true;
    setStatus(statusEl, 'WASM offline run (worker)…');
    try {
      const drive = window.segOperator?.targetDrive ?? 0.5;
      const loadOhm = window.segOperator?.loadResistance ?? 100;
      const field = window.segOperator?.magneticFieldStrength ?? 0.5;
      let result;
      try {
        result = await runOfflineSegExportInWorker({
          durationSec: 10,
          sampleHz: getHz(),
          drive,
          loadOhm,
          fieldStrength: field
        });
      } catch (_) {
        result = await runOfflineSegExport({
          durationSec: 10,
          sampleHz: getHz(),
          drive,
          loadOhm,
          fieldStrength: field
        });
      }
      const blob = new Blob([result.csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `seg-wasm-offline-${Date.now()}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      setStatus(statusEl, `WASM CSV (${result.rows.length} rows)`);
    } catch (err) {
      setStatus(statusEl, err.message || 'Offline run failed', false);
    }
    offlineBtn.disabled = false;
  });

  replayBtn?.addEventListener('click', () => {
    const rows = telemetryHub.getRecordedRows();
    const replay = buildReplayFromRecording(rows, {
      sampleHz: getHz(),
      seed: seedEl?.value ? Number(seedEl.value) >>> 0 : null,
      segLayoutPreset: window.multiVisualizer?.getSEGLayoutPreset?.(),
      heronLayoutPreset: window.multiVisualizer?.heronLayoutPreset
    });
    downloadReplayJson(replay);
    setStatus(statusEl, 'Replay file downloaded');
  });

  replayFile?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const replay = JSON.parse(text);
      if (replay.seed != null) setSimulationSeed(replay.seed);
      applyReplay(replay);
      setStatus(statusEl, `Replay loaded (v${replay.replayVersion})`);
    } catch (err) {
      setStatus(statusEl, err.message || 'Invalid replay file', false);
    }
    replayFile.value = '';
  });

  benchBtn?.addEventListener('click', () => {
    const profiler = window.multiVisualizer?.profiler;
    if (!profiler) {
      setStatus(statusEl, 'Profiler not available', false);
      return;
    }
    let bench = null;
    if (profiler.benchmarkSamples?.length) {
      bench = profiler.endBenchmark?.() ?? {
        samples: profiler.benchmarkSamples,
        stats: profiler.getStats()
      };
    } else {
      bench = { stats: profiler.getStats(), note: 'Run F3 debug panel benchmark first' };
    }
    downloadBenchmarkPack(bench);
    setStatus(statusEl, 'Benchmark pack downloaded');
  });

  seedEl?.addEventListener('change', () => {
    const v = seedEl.value.trim();
    if (v === '') return;
    setSimulationSeed(Number(v) >>> 0);
    setStatus(statusEl, `Seed set: ${v}`);
  });
}
