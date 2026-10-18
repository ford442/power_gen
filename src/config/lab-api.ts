/**
 * `window.lab` — the console / agent / embed surface for LabConfig (#224 §1).
 *
 * The entry chunk carries only this table of lazy hooks plus a drop listener
 * for `.lab.json` files; loading, exporting, the share dialog and the
 * experiment runner / panel are their own chunks. Snapshots (§2) add their
 * methods here when their chunk installs.
 */
import {
  labConfig,
  labConfigResolved,
  type LabConfig,
  type LabConfigKey,
  type LabConfigSource
} from './lab-config';
import type { LabFile, LabFileExportOpts, LabLoadResult } from './lab-file';
import type { RecordedRun } from '../analysis/run-types';
import type { RunExperimentOpts } from '../experiments/run';
import type { ExperimentSummary } from '../experiments/registry';

export interface LabApi {
  /** Resolved config for this page load (URL > share hash > storage > default). */
  config(): LabConfig;
  /** Where each field came from. */
  sources(): Record<LabConfigKey, LabConfigSource>;
  /**
   * Apply a `.lab.json` object (or a bare config object). Live fields apply in
   * place; a boot-only difference (WASM backend, prototype) reloads via a
   * `#lab2=` link. Resolves with what was applied.
   */
  loadConfig(obj: unknown): Promise<LabLoadResult>;
  /** Read and apply a dropped / picked `.lab.json` file. */
  loadFile(file: File): Promise<LabLoadResult>;
  /** Build (and copy) a `#lab2=` link for the running lab. */
  shareLink(): Promise<string>;
  /** Share dialog: link, QR code, `.lab.json` download. */
  openShareDialog(): Promise<void>;
  /** The running lab as a `.lab.json` object (config, plus snapshot/runs when available). */
  exportLabFile(opts?: LabFileExportOpts): Promise<LabFile>;
  /** Download {@link exportLabFile} as `<name>.lab.json` (`opts.runs` picks the runs). */
  downloadLabFile(name?: string, opts?: LabFileExportOpts): Promise<void>;
  /**
   * Run an experiment (a shipped id or a definition object, docs/EXPERIMENTS.md).
   * Offline by default (a worker, faster than real time); `{ runner: 'live' }`
   * rides the session clock. A sweep resolves with its summary run. Every run
   * is added to the analysis panel.
   */
  runExperiment(idOrDef: unknown, opts?: RunExperimentOpts): Promise<RecordedRun>;
  /** The shipped reference experiments. */
  listExperiments(): Promise<ExperimentSummary[]>;
  /** Open the experiment panel, optionally on one experiment. */
  openExperiment(id?: string): Promise<void>;
  /** Add an experiment definition (e.g. from a `.lab.json`) and open it in the panel. */
  openExperimentDef(def: unknown): Promise<void>;
  [extra: string]: unknown;
}

const lazyFile = (): Promise<typeof import('./lab-file')> => import('./lab-file');
const lazyPanel = (): Promise<typeof import('../experiments/experiment-panel')> => import('../experiments/experiment-panel');

/** True for a drag that carries at least one file (we cannot see names until drop). */
function dragHasFiles(e: DragEvent): boolean {
  return !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
}

function installLabFileDrop(): void {
  if (typeof document === 'undefined') return;
  document.addEventListener('dragover', (e) => {
    if (dragHasFiles(e)) e.preventDefault();
  });
  document.addEventListener('drop', (e) => {
    const file = Array.from(e.dataTransfer?.files ?? []).find((f) => /\.lab\.json$/i.test(f.name));
    if (!file) return;
    e.preventDefault();
    void lazyFile()
      .then((m) => m.loadLabFile(file))
      .then((r) => setLabStatus(`Loaded ${file.name}: ${r.applied.length} setting(s)${r.reloading ? ' — reloading' : ''}`))
      .catch((err: unknown) => setLabStatus(`Could not load ${file.name}: ${err instanceof Error ? err.message : String(err)}`));
  });
}

function setLabStatus(text: string): void {
  console.info(`[lab] ${text}`);
  const el = document.getElementById('explainerStatus');
  if (el) el.textContent = text;
}

export function installLabApi(): void {
  if (typeof window === 'undefined') return;
  const prior = (window.lab ?? {}) as Partial<LabApi>;
  const api: LabApi = {
    ...prior,
    config: () => labConfig(),
    sources: () => labConfigResolved().sources,
    loadConfig: (obj) => lazyFile().then((m) => m.loadLabConfig(obj)),
    loadFile: (file) => lazyFile().then((m) => m.loadLabFile(file)),
    shareLink: () => import('../seg-explainer/lab-url').then((m) => m.shareLabLink()),
    openShareDialog: () => import('./share-dialog').then((m) => m.openShareDialog()),
    exportLabFile: (opts) => lazyFile().then((m) => m.exportLabFile(opts)),
    downloadLabFile: (name, opts) => lazyFile().then((m) => m.downloadLabFile(name, opts)),
    runExperiment: (idOrDef, opts) => import('../experiments/run').then((m) => m.runExperiment(idOrDef, opts)),
    listExperiments: () => import('../experiments/registry').then((m) => m.listReferenceExperiments()),
    openExperiment: (id) => lazyPanel().then((m) => m.openExperimentPanel(id)),
    openExperimentDef: (def) => lazyPanel().then((m) => m.openExperimentDefinition(def))
  };
  window.lab = api;
  installLabFileDrop();
  installExperimentsButton();
}

/** "Experiments" beside the Analysis button in the Telemetry Export row. */
function installExperimentsButton(): void {
  if (typeof document === 'undefined' || document.getElementById('experimentsOpenBtn')) return;
  const row = document.getElementById('telemetryBenchExportBtn')?.parentElement;
  if (!row) return;
  const btn = Object.assign(document.createElement('button'), {
    type: 'button',
    id: 'experimentsOpenBtn',
    className: 'ctrl-btn',
    textContent: 'Experiments',
    title: 'Scripted experiments and sweeps (simulated, not metrology)',
    onclick: () => { void window.lab?.openExperiment().catch((err: unknown) => console.warn('[experiments] panel failed to load', err)); }
  });
  btn.style.fontSize = '0.68rem';
  btn.setAttribute('aria-haspopup', 'dialog');
  row.append(btn);
}
