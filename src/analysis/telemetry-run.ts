/**
 * TelemetryHub recording → RecordedRun, so "Analyse current recording" works
 * without an experiment.
 *
 * The sampler's rows are CSV-shaped (`telemetry-schema.ts`: snake_case
 * columns, `time_s` = simulated seconds since `startRecording`). A run wants
 * catalog camelCase keys plus `t`:
 *
 * - `time_s` → `t`;
 * - device columns → their key through `TELEMETRY_FIELD_BY_COLUMN`
 *   (`lorentz_force_n` → `lorentzForceN`);
 * - the SEG base columns that carry a SEG catalog key with the same unit
 *   (`voltage_v` → `voltage`, …). `seg_omega` is the normalised 0–1 spin, not
 *   the catalog's rad/s `omega`, so it is left out, as are the bookkeeping
 *   columns (frame id, status, twin residuals, …).
 *
 * Columns that are 0 on every row (benches that were idle) are dropped unless
 * `keepIdle` is set, so a 10 s recording of one bench is not 70 flat lines.
 */

import { TELEMETRY_FIELD_BY_COLUMN } from '../../generated/device-catalog';
import type { RecordedRun, RunBackend } from './run-types';

/** SEG base CSV column → SEG catalog telemetry key (units match). */
export const SEG_COLUMN_KEYS: Readonly<Record<string, string>> = Object.freeze({
  rpm_inner: 'rpm',
  corona: 'corona',
  voltage_v: 'voltage',
  current_a: 'current',
  power_w: 'power',
  field_sim_t: 'fieldSim'
});

export interface TelemetryRunOpts {
  /** Sample rate the recording used (the sampler's `sampleHz`). */
  hz: number;
  title?: string;
  id?: string;
  /** ISO wall-clock start; defaults to now. */
  startedAt?: string;
  /** Default `js`; pass `mixed` when the C++ focus plant was on. */
  backend?: RunBackend;
  /** Keep all-zero columns (default false). */
  keepIdle?: boolean;
}

let idCounter = 0;

/** Run id unique within the page: `<prefix>-<base36 ms>-<counter>`. */
export function newRunId(prefix = 'run'): string {
  idCounter = (idCounter + 1) % 1296;
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

/** Catalog key for a recording column, or null when it has none. */
export function keyForTelemetryColumn(column: string): string | null {
  if (column === 'time_s') return 't';
  return TELEMETRY_FIELD_BY_COLUMN[column]?.key ?? SEG_COLUMN_KEYS[column] ?? null;
}

function num(v: number | string | undefined): number {
  if (typeof v === 'number') return v;
  if (v === undefined || v === '') return NaN;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

export function runFromTelemetryRows(
  rows: readonly Record<string, number | string>[],
  opts: TelemetryRunOpts
): RecordedRun {
  // Column order: `t`, then the recording's own column order.
  const pairs: { column: string; key: string }[] = [];
  const seen = new Set<string>();
  for (const column of Object.keys(rows[0] ?? {})) {
    const key = keyForTelemetryColumn(column);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    pairs.push({ column, key });
  }
  const t = pairs.findIndex((p) => p.key === 't');
  if (t > 0) pairs.unshift(...pairs.splice(t, 1));

  let kept = pairs;
  if (!opts.keepIdle) {
    kept = pairs.filter((p) => p.key === 't' || rows.some((r) => {
      const v = num(r[p.column]);
      return Number.isFinite(v) && v !== 0;
    }));
  }

  const views = new Set(rows.map((r) => String(r.mode ?? r.view ?? '')).filter(Boolean));
  const where = views.size === 1 ? ` · ${[...views][0]}` : '';
  return {
    id: opts.id ?? newRunId('rec'),
    experimentId: null,
    title: opts.title ?? `Recording${where} · ${rows.length} samples`,
    startedAt: opts.startedAt ?? new Date().toISOString(),
    runner: 'live',
    backend: opts.backend ?? 'js',
    hz: opts.hz,
    columns: kept.map((p) => p.key),
    rows: rows.map((r) => kept.map((p) => num(r[p.column])))
  };
}
