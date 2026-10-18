/**
 * `window.lab` — the console / agent / embed surface for LabConfig (#224 §1).
 *
 * The entry chunk carries only this table of lazy hooks; loading, exporting,
 * the share dialog and the `.lab.json` drop target (lab-post-boot.ts) are
 * their own chunks. Experiments (§3) and snapshots (§2) add their methods
 * here when their chunks install.
 */
import {
  labConfig,
  labConfigResolved,
  type LabConfig,
  type LabConfigKey,
  type LabConfigSource
} from './lab-config';
import type { LabFile, LabLoadResult } from './lab-file';

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
  /** Installed by the experiments chunk (§3): show / run an experiment by id. */
  openExperiment?: (id: string) => void;
  /** Teacher console: broadcast to this lab's other tabs (src/embed/, EMBED.md). */
  openTeacherConsole(): Promise<void>;
  /** Under `?embed=1`: the origins the postMessage endpoint answers. */
  embedOrigins?: () => string[];
  [extra: string]: unknown;
}

const lazyFile = (): Promise<typeof import('./lab-file')> => import('./lab-file');

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
    openTeacherConsole: () => import('../embed/teacher-console').then((m) => void m.openTeacherConsole())
  };
  window.lab = api;
  // Before first paint, so an embedded lab never flashes the dashboard chrome.
  if (labConfig().embed) document.documentElement.dataset.labEmbed = '';
}
