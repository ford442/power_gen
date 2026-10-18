/**
 * `.lab.json` — a lab you can hand to someone (#224 §1). Lazy chunk.
 *
 *   { "format": "seg-lab", "version": 1, "schema": "<LabConfig schema hash>",
 *     "createdAt": "…", "config": { …non-default share fields… },
 *     "state"?: <plant snapshot (§2)>, "experiment"?: <experiment (§3)>,
 *     "runs"?: [<RecordedRun>…] }
 *
 * `config` is the same field set a `#lab2=` link carries and goes through the
 * same coercion (unknown keys dropped, ranges clamped), so a file from an older
 * schema still loads field by field. A bare config object (`{ "look": "lab" }`)
 * is accepted too, for `window.lab.loadConfig({...})` from the console.
 *
 * Simulated, not metrology: nothing in a lab file is a measurement.
 */
import { LAB_CONFIG_FIELDS, LAB_CONFIG_SCHEMA_HASH, type LabConfigKey } from '../../generated/lab-config';
import { labConfig, primeShareHash, sanitizeFields, type LabConfig } from './lab-config';
import { adoptShareUrl, nonDefaultShareFields } from './share-url';
import { encodeShareHash } from './share-link';

export const LAB_FILE_FORMAT = 'seg-lab';
export const LAB_FILE_VERSION = 1;

export interface LabFile {
  format: typeof LAB_FILE_FORMAT;
  version: number;
  schema: string;
  createdAt: string;
  config: Partial<LabConfig>;
  /** Plant snapshot (§2) — restored after the config applies. */
  state?: unknown;
  /** An experiment definition (§3) to open. */
  experiment?: unknown;
  /** Recorded runs (§4) to add to the analysis panel. */
  runs?: unknown[];
}

export interface LabLoadResult {
  /** Fields that were applied (or will be, after the reload). */
  applied: LabConfigKey[];
  /** Keys in the input that are not LabConfig share fields, or did not parse. */
  ignored: string[];
  /** A boot-only field differed, so the page is reloading via `#lab2=`. */
  reloading: boolean;
  /** The file carried a plant snapshot and it was restored. */
  stateRestored: boolean;
  runsAdded: number;
}

/** Hooks other chunks install on `window.lab` (snapshots, experiments, runs). */
interface LabFileHooks {
  captureSnapshot?: () => Promise<unknown> | unknown;
  restoreSnapshot?: (state: unknown) => Promise<boolean> | boolean;
  openExperimentDef?: (def: unknown) => void;
  exportRuns?: () => unknown[];
  importRuns?: (runs: unknown[]) => number;
}

function hooks(): LabFileHooks {
  return (window.lab ?? {}) as LabFileHooks;
}

const SPEC_BY_KEY = new Map(LAB_CONFIG_FIELDS.map((f) => [f.key, f]));

/** A `.lab.json` object, or a bare config object → its raw config fields. */
function configOf(obj: unknown): { raw: Record<string, unknown>; file: Partial<LabFile> | null } {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('expected a .lab.json object or a config object');
  }
  const o = obj as Record<string, unknown>;
  if (o.format === LAB_FILE_FORMAT) {
    if (typeof o.version === 'number' && o.version > LAB_FILE_VERSION) {
      console.warn(`[lab-file] version ${o.version} file; this build reads ${LAB_FILE_VERSION} — loading the fields it knows`);
    }
    const cfg = o.config;
    return {
      raw: cfg && typeof cfg === 'object' && !Array.isArray(cfg) ? (cfg as Record<string, unknown>) : {},
      file: o as Partial<LabFile>
    };
  }
  if ('format' in o) throw new Error(`not a lab file (format ${JSON.stringify(o.format)})`);
  return { raw: o, file: null };
}

function differs(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) !== JSON.stringify(b);
}

export async function loadLabConfig(obj: unknown): Promise<LabLoadResult> {
  const { raw, file } = configOf(obj);
  const fields = sanitizeFields(raw, true);
  const applied = Object.keys(fields) as LabConfigKey[];
  const ignored = Object.keys(raw).filter((k) => !(k in fields));
  const current = labConfig();
  const bootChange = applied.some((k) => !SPEC_BY_KEY.get(k)?.live && differs(fields[k], current[k]));

  const result: LabLoadResult = { applied, ignored, reloading: false, stateRestored: false, runsAdded: 0 };
  const hash = await encodeShareHash(fields);

  if (bootChange) {
    // The WASM backend / prototype are chosen once at boot: reload through the
    // share link so every boot-time reader sees the file. (A snapshot or runs
    // in the same file are lost on purpose — they belong to the other backend.)
    result.reloading = true;
    if (file?.state !== undefined || file?.runs?.length) {
      console.warn('[lab-file] boot-only fields changed; the snapshot / runs in this file were not restored — load it again after the reload');
    }
    adoptShareUrl(hash, applied, true);
    return result;
  }

  const { applyLabConfig } = await import('../seg-explainer/lab-url');
  await applyLabConfig(fields);
  primeShareHash(hash, fields);
  adoptShareUrl(hash, applied);

  const h = hooks();
  if (file?.state !== undefined && h.restoreSnapshot) {
    result.stateRestored = !!(await h.restoreSnapshot(file.state));
  }
  if (file?.experiment !== undefined) h.openExperimentDef?.(file.experiment);
  if (Array.isArray(file?.runs) && h.importRuns) result.runsAdded = h.importRuns(file.runs);
  return result;
}

export async function loadLabFile(f: File): Promise<LabLoadResult> {
  const text = await f.text();
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    throw new Error('not valid JSON');
  }
  return loadLabConfig(obj);
}

export async function exportLabFile(): Promise<LabFile> {
  const { captureShareConfig } = await import('../seg-explainer/lab-url');
  const out: LabFile = {
    format: LAB_FILE_FORMAT,
    version: LAB_FILE_VERSION,
    schema: LAB_CONFIG_SCHEMA_HASH,
    createdAt: new Date().toISOString(),
    config: nonDefaultShareFields(captureShareConfig())
  };
  const h = hooks();
  const state = await h.captureSnapshot?.();
  if (state !== undefined && state !== null) out.state = state;
  const runs = h.exportRuns?.();
  if (runs?.length) out.runs = runs;
  return out;
}

export async function downloadLabFile(name = 'seg-lab'): Promise<void> {
  const file = await exportLabFile();
  const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name.replace(/\.lab\.json$/i, '')}.lab.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
