/**
 * Column metadata for recorded runs: label / unit / display scale per catalog
 * telemetry key, from `generated/device-catalog.ts` (nothing hand-listed).
 *
 * `DEVICE_TELEMETRY_FIELDS` covers every bench except SEG, whose keys
 * (`rpm`, `voltage`, …) live only in its catalog entry's `telemetry` map, so
 * that map is the fallback. `t` is the session clock.
 */

import {
  DEVICE_CATALOG,
  DEVICE_TELEMETRY_FIELDS,
  type TelemetryFieldMeta
} from '../../generated/device-catalog';

/** The repo's honesty line: on every view, export and PNG. */
export const ANALYSIS_DISCLAIMER = 'Simulated — not metrology';

export interface ColumnMeta {
  key: string;
  /** Catalog label, e.g. `F`, `V_s`. */
  label: string;
  unit: string;
  /** Display multiplier (catalog `scale`, e.g. 0–1 → %); 1 when none. */
  scale: number;
  digits: number;
  deviceId: string | null;
  /** Catalog device label (`Lorentz Rail Sled`), null for `t` / unknown keys. */
  deviceLabel: string | null;
}

const TIME_META: ColumnMeta = {
  key: 't', label: 't', unit: 's', scale: 1, digits: 3, deviceId: null, deviceLabel: null
};

const META_BY_KEY = new Map<string, ColumnMeta>();

function fromField(key: string, deviceId: string, meta: TelemetryFieldMeta): ColumnMeta {
  const device = DEVICE_CATALOG.find((d) => d.id === deviceId);
  return {
    key,
    label: meta.label,
    unit: meta.unit,
    scale: meta.scale ?? 1,
    digits: meta.digits,
    deviceId,
    deviceLabel: device?.label ?? deviceId
  };
}

/** Label / unit / scale for a run column; unknown keys get their own name and no unit. */
export function columnMeta(key: string): ColumnMeta {
  if (key === 't') return TIME_META;
  const cached = META_BY_KEY.get(key);
  if (cached) return cached;
  let meta: ColumnMeta | null = null;
  const field = DEVICE_TELEMETRY_FIELDS.find((f) => f.key === key);
  if (field) meta = fromField(key, field.deviceId, field);
  if (!meta) {
    for (const device of DEVICE_CATALOG) {
      const m = (device.telemetry as Record<string, TelemetryFieldMeta>)[key];
      if (m) {
        meta = fromField(key, device.id, m);
        break;
      }
    }
  }
  meta ??= { key, label: key, unit: '', scale: 1, digits: 3, deviceId: null, deviceLabel: null };
  META_BY_KEY.set(key, meta);
  return meta;
}

/** `label [unit]`, e.g. `F [N]`; no brackets for unitless keys. */
export function unitLabel(meta: ColumnMeta): string {
  return meta.unit ? `${meta.label} [${meta.unit}]` : meta.label;
}

/** Axis / legend title with the bench, e.g. `Lorentz Rail Sled · F [N]`. */
export function axisLabel(meta: ColumnMeta): string {
  return meta.deviceLabel ? `${meta.deviceLabel} · ${unitLabel(meta)}` : unitLabel(meta);
}

/** Fixed-point at the catalog precision (+2 digits: the panel is for reading values). */
export function formatValue(v: number | null | undefined, meta: ColumnMeta): string {
  if (v == null || !Number.isFinite(v)) return '—';
  const digits = Math.min(8, meta.digits + 2);
  const abs = Math.abs(v);
  const text = abs !== 0 && (abs < 10 ** -digits || abs >= 1e7) ? v.toExponential(3) : v.toFixed(digits);
  return meta.unit ? `${text} ${meta.unit}` : text;
}
