/**
 * Record keys — what a `record` step may sample (#224 §3).
 *
 * A key is a catalog telemetry key (`lorentzForceN`, `rpm`, …, physics/devices.json
 * `telemetryKeys`) or a knob id (`drive`, `lorentz-sled.lorentzField`), so a
 * ramp's own setpoint can be an X axis. Non-SEG keys are the device's
 * `physicsState` field of the same name — exactly what TelemetryHub publishes.
 * SEG keys come from the operator telemetry (SegOperatorTelemetry), mapped
 * below.
 */
import { DEVICE_CATALOG } from '../../generated/device-catalog';
import { SEG_SPEC } from '../seg-operator-state';
import type { SegOperatorTelemetry } from '../telemetry/types';
import { knobSpec, type KnobTarget } from './knobs';

/** Telemetry key → owning catalog device id. */
export const TELEMETRY_KEY_DEVICE: ReadonlyMap<string, string> = new Map(
  DEVICE_CATALOG.flatMap((d) => d.telemetryKeys.map((k) => [k, d.id] as [string, string]))
);

/** SEG catalog keys → the operator telemetry field each one reads. */
const SEG_READERS: Record<string, (t: SegOperatorTelemetry) => number> = {
  rpm: (t) => t.rpmInner,
  omega: (t) => t.segOmega,
  corona: (t) => t.corona,
  voltage: (t) => t.voltage,
  current: (t) => t.current,
  power: (t) => t.power,
  fieldSim: (t) => t.fieldSim,
  // Same surface-density scaling the hub uses for avgEnergyDensity.
  energyDensity: (t) => SEG_SPEC.ENERGY_DENSITY_SURFACE_JM3 * Math.min(1, Math.max(0, t.segOmega))
};

/** A plant a record step can read: knob target + the last SEG telemetry. */
export interface PlantView extends KnobTarget {
  segTelemetry(): SegOperatorTelemetry | null;
}

export function isRecordKey(key: string): boolean {
  return TELEMETRY_KEY_DEVICE.has(key) || knobSpec(key) !== undefined;
}

/** Device a key depends on (null for operator keys: SEG telemetry, `drive`). */
export function recordKeyDevice(key: string): string | null {
  const dev = TELEMETRY_KEY_DEVICE.get(key);
  if (dev) return dev === 'seg' ? null : dev;
  return knobSpec(key)?.deviceId ?? null;
}

/** The key's value now; NaN when the plant has not produced it. */
export function readRecordKey(view: PlantView, key: string): number {
  const dev = TELEMETRY_KEY_DEVICE.get(key);
  if (dev === 'seg') {
    const t = view.segTelemetry();
    const v = t ? SEG_READERS[key]?.(t) : undefined;
    return typeof v === 'number' && Number.isFinite(v) ? v : Number.NaN;
  }
  if (dev) {
    const d = view.devices[dev];
    const v = ((d?.physicsState ?? d?.physics) as Record<string, unknown> | undefined)?.[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : Number.NaN;
  }
  const knob = knobSpec(key);
  return knob?.read(view) ?? Number.NaN;
}
