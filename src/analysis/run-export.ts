/**
 * CSV export of recorded runs (analysis panel). `.lab.json` belongs to the
 * LabConfig work (§1) — the panel calls `window.lab.exportLabJson` when it
 * exists — and the PNG export lives in the panel (it needs the canvas).
 *
 * Each run is one block: `#` comment lines with the run metadata, the units
 * and the disclaimer, then a header row of catalog keys and the samples.
 * Two runs (main + overlay) are two blocks separated by a blank line.
 */

import { ANALYSIS_DISCLAIMER, columnMeta, unitLabel } from './run-columns';
import type { RecordedRun } from './run-types';

function cell(v: number): string {
  return Number.isFinite(v) ? String(v) : '';
}

/** Free text inside a `#` line must not break out of the comment. */
function oneLine(text: string): string {
  return text.replace(/[\r\n]+/g, ' ');
}

export function runToCsv(run: RecordedRun): string {
  const lines = [
    `# SEG WebGPU Visualizer recorded run · ${ANALYSIS_DISCLAIMER}`,
    `# id: ${run.id}`,
    `# title: ${oneLine(run.title)}`,
    `# experimentId: ${run.experimentId ?? ''}`,
    `# startedAt: ${run.startedAt}`,
    `# runner: ${run.runner}`,
    `# backend: ${run.backend}`,
    `# hz: ${run.hz}`
  ];
  if (run.sweep) lines.push(`# sweep: ${JSON.stringify(run.sweep)}`);
  if (run.config) lines.push(`# config: ${JSON.stringify(run.config)}`);
  for (const e of run.expects ?? []) {
    lines.push(`# expect: ${e.pass ? 'PASS' : 'FAIL'} ${oneLine(`${e.label} (${e.condition})`)} ${JSON.stringify(e.measured)}`);
  }
  lines.push(`# units: ${run.columns.map((k) => `${k}=${unitLabel(columnMeta(k))}`).join('; ')}`);
  lines.push('# values are raw run values (no catalog display scale)');
  lines.push(run.columns.join(','));
  for (const row of run.rows) lines.push(row.map(cell).join(','));
  return lines.join('\n');
}

export function runsToCsv(runs: readonly RecordedRun[]): string {
  return runs.map(runToCsv).join('\n\n') + '\n';
}

/** `seg-run-<id>[+<id>].csv`, filesystem-safe. */
export function runsCsvFilename(runs: readonly RecordedRun[]): string {
  const ids = runs.map((r) => r.id.replace(/[^\w.-]+/g, '_')).join('+');
  return `seg-run-${ids || 'empty'}.csv`;
}
