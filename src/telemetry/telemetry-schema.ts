/**
 * Shared telemetry export schema (CSV columns + row builders).
 *
 * Columns are the SEG/plant base set plus one column per catalog
 * `telemetryKeys` entry (`TELEMETRY_CSV_DEVICE_COLUMNS`, generated from
 * `physics/devices.json`). Adding a device to the catalog therefore widens
 * export and replay with no edit here.
 *
 * Keep in sync with cpp/src/telemetry_export.h for native `make native` CSV.
 */

import {
  DEVICE_TELEMETRY_FIELDS,
  TELEMETRY_CSV_DEVICE_COLUMNS
} from '../../generated/device-catalog';
import type { DevicePhysicsState } from '../renderers/shared/device-physics';
import type { DeviceTelemetrySnap, TelemetrySnapshot } from './types';

export { TELEMETRY_CSV_DEVICE_COLUMNS };

/** v2 added the per-device catalog telemetry columns. */
export const TELEMETRY_CSV_VERSION = 2;

/** SEG plant / lab-bus columns, always first. */
export const TELEMETRY_CSV_BASE_COLUMNS = [
  'time_s',
  'frame_id',
  'view',
  'mode',
  'status',
  'rpm_inner',
  'seg_omega',
  'corona',
  'voltage_v',
  'current_a',
  'power_w',
  'field_sim_t',
  'energy_density_j_m3',
  'drive',
  'excitation_pct',
  'temperature_c',
  'efficiency_pct',
  'particle_flux',
  'load_ohm',
  'hw_connected',
  'hw_connection_state',
  'phase_error_deg',
  'rpm_error',
  'voltage_error_v',
  'current_error_a',
  'energy_residual_w',
  'energy_coupled'
] as const;

export type TelemetryCsvBaseColumn = (typeof TELEMETRY_CSV_BASE_COLUMNS)[number];

/** Full column order for CSV and native export: base columns, then device keys. */
export const TELEMETRY_CSV_COLUMNS: readonly string[] = [
  ...TELEMETRY_CSV_BASE_COLUMNS,
  ...TELEMETRY_CSV_DEVICE_COLUMNS
];

export type TelemetryCsvColumn = string;

/**
 * A row always carries the base columns; device columns are indexed by name
 * (`row.hall_voltage`) so a catalog addition needs no type change.
 */
export type TelemetryCsvRow =
  { [K in TelemetryCsvBaseColumn]: number | string }
  & { [column: string]: number | string };

const BASE_STRING_COLUMNS = new Set<string>(['view', 'mode', 'status', 'hw_connection_state']);
const BASE_OPTIONAL_NUMBER_COLUMNS = new Set<string>([
  'phase_error_deg',
  'rpm_error',
  'voltage_error_v',
  'current_error_a',
  'energy_residual_w'
]);

/** Per-device catalog columns for one snapshot (0 when the device is idle). */
export function deviceColumnsFromSnapshot(
  devices: Record<string, DeviceTelemetrySnap> | null | undefined
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const field of DEVICE_TELEMETRY_FIELDS) {
    const snap = devices?.[field.deviceId] as unknown as Record<string, unknown> | undefined;
    const v = snap?.[field.key];
    out[field.column] = typeof v === 'number' && Number.isFinite(v) ? v : 0;
  }
  return out;
}

/** All device columns zeroed — SEG-only row builders (WASM/native) use this. */
export function emptyDeviceColumns(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const column of TELEMETRY_CSV_DEVICE_COLUMNS) out[column] = 0;
  return out;
}

/**
 * Device columns of a parsed row → `publishFrame({ devicePhysics })` input, so
 * replay restores plugin telemetry and not only SEG RPM.
 */
export function devicePhysicsFromRow(
  row: Record<string, number | string>
): Record<string, Partial<DevicePhysicsState>> {
  const out: Record<string, Record<string, number>> = {};
  for (const field of DEVICE_TELEMETRY_FIELDS) {
    const raw = row[field.column];
    if (raw == null || raw === '') continue;
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(n)) continue;
    (out[field.deviceId] ||= {})[field.key] = n;
  }
  return out as Record<string, Partial<DevicePhysicsState>>;
}

export interface RowFromSnapshotOpts {
  loadOhm?: number;
  mode?: string;
}

/**
 * Build one CSV row from a TelemetryHub snapshot.
 */
export function rowFromSnapshot(
  snap: TelemetrySnapshot,
  simTimeS: number,
  opts: RowFromSnapshotOpts = {}
): TelemetryCsvRow {
  const seg = snap.seg;
  const sci = snap.scientific || {};
  const hw = snap.hardwareTwin;
  const net = snap.energyNetwork;
  const loadOhm = opts.loadOhm ?? 100;
  return {
    time_s: simTimeS,
    frame_id: snap.frameId ?? 0,
    view: snap.view ?? 'overview',
    mode: opts.mode ?? 'seg',
    status: seg?.status ?? 'standby',
    rpm_inner: seg?.rpmInner ?? 0,
    seg_omega: seg?.segOmega ?? 0,
    corona: seg?.corona ?? 0,
    voltage_v: seg?.voltage ?? 0,
    current_a: seg?.current ?? 0,
    power_w: seg?.power ?? 0,
    field_sim_t: seg?.fieldSim ?? 0,
    energy_density_j_m3: sci.avgEnergyDensity ?? 0,
    drive: seg?.drive ?? 0,
    excitation_pct: seg?.excitationPct ?? 0,
    temperature_c: seg?.temperature ?? 25,
    efficiency_pct: seg?.efficiency ?? 0,
    particle_flux: sci.particleFlux ?? 0,
    load_ohm: loadOhm,
    hw_connected: hw?.connected ? 1 : 0,
    hw_connection_state: hw?.connectionState ?? 'disconnected',
    phase_error_deg: hw?.shadowResidual?.phaseErrorDeg ?? '',
    rpm_error: hw?.shadowResidual?.rpmError ?? '',
    voltage_error_v: hw?.shadowResidual?.voltageError ?? '',
    current_error_a: hw?.shadowResidual?.currentError ?? '',
    energy_residual_w: net?.residualW ?? '',
    energy_coupled: net?.couplingEnabled ? 1 : 0,
    ...deviceColumnsFromSnapshot(snap.devices)
  };
}

export interface RowFromWasmSegOpts {
  simTimeS: number;
  frameId?: number;
  omega: number;
  rpm?: number;
  powerW?: number;
  energyDensityJm3?: number;
  drive?: number;
  fieldStrength?: number;
  loadOhm?: number;
  corona?: number;
  B_SURFACE_T?: number;
  view?: string;
  status?: string;
  particleFlux?: number;
}

/**
 * Build row from WASM / native C++ step outputs (SEG mode).
 * Electrical model mirrors seg-operator-state computeTelemetry.
 */
export function rowFromWasmSeg({
  simTimeS,
  frameId = 0,
  omega,
  powerW,
  energyDensityJm3,
  drive = 0.5,
  fieldStrength = 0.5,
  loadOhm = 100,
  corona = 0,
  B_SURFACE_T = 0.7048,
  view = 'seg',
  status = 'operational',
  particleFlux = 0
}: RowFromWasmSegOpts): TelemetryCsvRow {
  const segOmega = Math.min(1, Math.max(0, omega / 50));
  const rotationSpeed = Math.min(120, segOmega * 100);
  const rpmInner = Math.round(rotationSpeed * 30);
  const voltage = rotationSpeed * fieldStrength * 2.5;
  const current = loadOhm > 0 ? voltage / loadOhm : 0;
  const power = powerW ?? voltage * current;
  const fieldSim = fieldStrength * (1 + rotationSpeed / 200) * B_SURFACE_T;
  const temp = 25 + rotationSpeed * 0.3 + corona * 12;
  const efficiency = drive > 0 ? 85 + (rotationSpeed / 100) * 10 : 0;

  return {
    time_s: simTimeS,
    frame_id: frameId,
    view,
    mode: 'seg',
    status,
    rpm_inner: rpmInner,
    seg_omega: segOmega,
    corona,
    voltage_v: voltage,
    current_a: current,
    power_w: power,
    field_sim_t: fieldSim,
    energy_density_j_m3: energyDensityJm3 ?? 0,
    drive,
    excitation_pct: Math.round(fieldStrength * 100),
    temperature_c: temp,
    efficiency_pct: efficiency,
    particle_flux: particleFlux,
    load_ohm: loadOhm,
    hw_connected: 0,
    hw_connection_state: 'disconnected',
    phase_error_deg: '',
    rpm_error: '',
    voltage_error_v: '',
    current_error_a: '',
    energy_residual_w: '',
    energy_coupled: 0,
    ...emptyDeviceColumns()
  };
}

function parseCsvCell(raw: string): string {
  const s = raw.trim();
  if (s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1).replace(/""/g, '"');
  }
  return s;
}

function coerceCsvValue(col: TelemetryCsvColumn, raw: string): number | string {
  if (raw === '') {
    if (BASE_STRING_COLUMNS.has(col)) {
      return col === 'status' ? 'standby' : col === 'hw_connection_state' ? 'disconnected' : '';
    }
    return 0;
  }
  if (BASE_STRING_COLUMNS.has(col)) return raw;
  const n = Number(raw);
  if (Number.isFinite(n)) return n;
  // Optional twin/bus columns keep their raw text when not numeric.
  return BASE_OPTIONAL_NUMBER_COLUMNS.has(col) ? raw : 0;
}

/**
 * Parse a telemetry CSV (header + rows) back into {@link TelemetryCsvRow}s.
 * Unknown columns are ignored; missing known columns default to 0 / ''.
 */
export function csvToRows(text: string): TelemetryCsvRow[] {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const header = lines[0].split(',').map(parseCsvCell);
  const colIndex = new Map<string, number>();
  header.forEach((name, i) => colIndex.set(name, i));

  const rows: TelemetryCsvRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(',').map(parseCsvCell);
    const row = {} as TelemetryCsvRow;
    for (const col of TELEMETRY_CSV_COLUMNS) {
      const idx = colIndex.get(col);
      row[col] = idx == null ? coerceCsvValue(col, '') : coerceCsvValue(col, cells[idx] ?? '');
    }
    rows.push(row);
  }
  return rows;
}

export function rowsToCsv(rows: TelemetryCsvRow[]): string {
  const header = TELEMETRY_CSV_COLUMNS.join(',');
  const lines = rows.map((row) =>
    TELEMETRY_CSV_COLUMNS.map((col) => {
      const v = row[col];
      if (v == null) return '';
      if (typeof v === 'string' && (v.includes(',') || v.includes('"'))) {
        return `"${v.replace(/"/g, '""')}"`;
      }
      return String(v);
    }).join(',')
  );
  return [header, ...lines].join('\n');
}

export function downloadText(filename: string, text: string, mime = 'text/plain'): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function downloadJson(filename: string, obj: unknown): void {
  downloadText(filename, JSON.stringify(obj, null, 2), 'application/json');
}
