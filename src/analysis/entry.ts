/**
 * Analysis panel entry (#224 §4) — the only analysis code in the entry chunk
 * besides run-store, so keep it small. It adds an "Analysis" button to the
 * Telemetry Export section and `window.openAnalysis`; uPlot, the panel and its
 * CSS are a separate chunk loaded by dynamic `import()` on first open.
 */

import { addRun, clearRuns, getRun, listRuns } from './run-store';

let panelModule: Promise<typeof import('./analysis-panel')> | null = null;

function loadPanel(): Promise<typeof import('./analysis-panel')> {
  // A failed chunk fetch (offline, stale deploy) is retried on the next open.
  panelModule ??= import('./analysis-panel').catch((err: unknown) => {
    panelModule = null;
    throw err;
  });
  return panelModule;
}

export function installAnalysisEntry(): void {
  window.analysisRuns = { addRun, listRuns, getRun, clearRuns };
  const open = (window.openAnalysis = async (runIds?: string[]) => (await loadPanel()).openAnalysisPanel(runIds));
  if (document.getElementById('analysisOpenBtn')) return;

  const btn = Object.assign(document.createElement('button'), {
    type: 'button',
    id: 'analysisOpenBtn',
    className: 'ctrl-btn',
    textContent: 'Analysis',
    title: 'Plots, fits and spectra of recorded runs (simulated, not metrology)',
    onclick: () => open().catch((err: unknown) => console.warn('[analysis] panel failed to load', err))
  });
  btn.style.fontSize = '0.68rem';
  btn.setAttribute('aria-haspopup', 'dialog');
  // Beside Replay / Bench in the Telemetry Export row (it wraps at phone width).
  // Without that row there is no button; window.openAnalysis still works.
  document.getElementById('telemetryBenchExportBtn')?.parentElement?.append(btn);
}
