/**
 * `window.lab` — the console / agent / embed surface for LabConfig (#224 §1).
 *
 * The entry chunk carries only this table of lazy hooks plus a drop listener
 * for `.lab.json` files; loading, exporting and the share dialog are their own
 * chunks. Snapshots (§2) are lazy stubs here too (session/lab-snapshot.ts);
 * experiments (§3) add their methods when their chunk installs.
 */
import {
  labConfig,
  labConfigResolved,
  type LabConfig,
  type LabConfigKey,
  type LabConfigSource
} from './lab-config';
import type { LabFile, LabLoadResult } from './lab-file';
import type { PlantSnapshot } from '../session/plant-snapshot';

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
  exportLabFile(): Promise<LabFile>;
  /** Download {@link exportLabFile} as `<name>.lab.json`. */
  downloadLabFile(name?: string): Promise<void>;
  /** Plant snapshot (§2): every plant, the operator, clock and seed — docs/SNAPSHOTS.md. */
  captureSnapshot(): Promise<PlantSnapshot>;
  /** Restore a {@link captureSnapshot} object; false when it is not one or the C++ plant refused it. */
  restoreSnapshot(state: unknown): Promise<boolean>;
  /** Installed by the experiments chunk (§3): show / run an experiment by id. */
  openExperiment?: (id: string) => void;
  [extra: string]: unknown;
}

const lazyFile = (): Promise<typeof import('./lab-file')> => import('./lab-file');
const lazySnapshot = (): Promise<typeof import('../session/lab-snapshot')> => import('../session/lab-snapshot');

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
    exportLabFile: () => lazyFile().then((m) => m.exportLabFile()),
    downloadLabFile: (name) => lazyFile().then((m) => m.downloadLabFile(name)),
    captureSnapshot: () => lazySnapshot().then((m) => m.captureLabSnapshot()),
    restoreSnapshot: (state) => lazySnapshot().then((m) => m.restoreLabSnapshot(state))
  };
  window.lab = api;
  installLabFileDrop();
}
