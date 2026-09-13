/**
 * Catalog-driven telemetry field formatting.
 *
 * Units, labels and precision come from `physics/devices.json` →
 * `generated/device-catalog.ts` (`DEVICE_TELEMETRY_FIELDS`). Operator chrome,
 * the scientific gauge strip and the CSV/JSON exporter all read this one
 * schema, so a new device's readouts need no bespoke gauge class.
 *
 * These are **simulated** plant values, not calibrated instrument readings
 * (ADR-0004, `docs/DEVICE_GALLERY.md`) — the formatter adds units, not
 * measurement claims.
 */

import {
  DEVICE_BY_ID,
  DEVICE_TELEMETRY_FIELDS,
  telemetryFieldsForDevice,
  type DeviceTelemetryField,
  type TelemetryFieldMeta
} from '../../generated/device-catalog';
import type { DeviceTelemetrySnap } from './types';

export {
  DEVICE_TELEMETRY_FIELDS,
  telemetryFieldsForDevice,
  type DeviceTelemetryField,
  type TelemetryFieldMeta
};

/** SI prefixes for `format: 'si'` fields, exponent → symbol. */
const SI_PREFIXES: Record<number, string> = {
  [-15]: 'f',
  [-12]: 'p',
  [-9]: 'n',
  [-6]: 'µ',
  [-3]: 'm',
  [0]: '',
  [3]: 'k',
  [6]: 'M',
  [9]: 'G'
};

const SI_EXPONENTS = [9, 6, 3, 0, -3, -6, -9, -12, -15];

/**
 * Raw hub value → display string with unit, per the field's catalog schema.
 * Non-finite values render as `—` so a stalled plant never prints `NaN`.
 */
export function formatTelemetryValue(
  value: number | null | undefined,
  meta: TelemetryFieldMeta
): string {
  const raw = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(raw)) return '—';
  const scaled = raw * (meta.scale ?? 1);
  const unit = meta.unit;

  if (meta.format === 'exp') {
    return withUnit(scaled.toExponential(meta.digits), unit);
  }

  if (meta.format === 'si' && scaled !== 0) {
    const exp = siExponentFor(scaled);
    const prefix = SI_PREFIXES[exp] ?? '';
    return withUnit((scaled / 10 ** exp).toFixed(meta.digits), `${prefix}${unit}`);
  }

  return withUnit(scaled.toFixed(meta.digits), unit);
}

function siExponentFor(scaled: number): number {
  const mag = Math.abs(scaled);
  for (const exp of SI_EXPONENTS) {
    if (mag >= 10 ** exp) return exp;
  }
  return SI_EXPONENTS[SI_EXPONENTS.length - 1];
}

function withUnit(text: string, unit: string): string {
  return unit ? `${text} ${unit}` : text;
}

/** `label value unit` for one field, e.g. `V_H 1.42 mV`. */
export function formatTelemetryField(
  field: DeviceTelemetryField,
  snap: DeviceTelemetrySnap | null | undefined
): string {
  return `${field.label} ${formatTelemetryValue(readTelemetryKey(snap, field.key), field)}`;
}

/** Read a catalog telemetry key off a device snapshot without `Partial<>` casts. */
export function readTelemetryKey(
  snap: DeviceTelemetrySnap | null | undefined,
  key: string
): number {
  if (!snap) return NaN;
  const v = (snap as unknown as Record<string, unknown>)[key];
  return typeof v === 'number' ? v : NaN;
}

/** Display label for a device id (catalog label; `overview` is not a device). */
export function deviceLabel(id: string): string {
  return DEVICE_BY_ID[id]?.label ?? id;
}

/** True when the id names a catalog device with snap-backed telemetry keys. */
export function hasCatalogTelemetry(id: string): boolean {
  return telemetryFieldsForDevice(id).length > 0;
}
