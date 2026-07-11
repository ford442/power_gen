/**
 * Shared telemetry export schema (CSV columns + row builders).
 * Keep in sync with cpp/src/telemetry_export.h for native `make native` CSV.
 */

export const TELEMETRY_CSV_VERSION = 1;

/** Column order for CSV and native export. */
export const TELEMETRY_CSV_COLUMNS = [
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
  'load_ohm'
];

/**
 * Build one CSV row from a TelemetryHub snapshot.
 * @param {object} snap  telemetryHub snapshot
 * @param {number} simTimeS  integrated simulation time (seconds)
 * @param {object} [opts]
 */
export function rowFromSnapshot(snap, simTimeS, opts = {}) {
  const seg = snap.seg || {};
  const sci = snap.scientific || {};
  const loadOhm = opts.loadOhm ?? 100;
  return {
    time_s: simTimeS,
    frame_id: snap.frameId ?? 0,
    view: snap.view ?? 'overview',
    mode: opts.mode ?? 'seg',
    status: seg.status ?? 'standby',
    rpm_inner: seg.rpmInner ?? 0,
    seg_omega: seg.segOmega ?? 0,
    corona: seg.corona ?? 0,
    voltage_v: seg.voltage ?? 0,
    current_a: seg.current ?? 0,
    power_w: seg.power ?? 0,
    field_sim_t: seg.fieldSim ?? 0,
    energy_density_j_m3: sci.avgEnergyDensity ?? 0,
    drive: seg.drive ?? 0,
    excitation_pct: seg.excitationPct ?? 0,
    temperature_c: seg.temperature ?? 25,
    efficiency_pct: seg.efficiency ?? 0,
    particle_flux: sci.particleFlux ?? 0,
    load_ohm: loadOhm
  };
}

/**
 * Build row from WASM / native C++ step outputs (SEG mode).
 * Electrical model mirrors seg-operator-state.js computeTelemetry.
 */
export function rowFromWasmSeg({
  simTimeS,
  frameId = 0,
  omega,
  rpm,
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
}) {
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
    load_ohm: loadOhm
  };
}

/** @param {Record<string, number|string>[]} rows */
export function rowsToCsv(rows) {
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

export function downloadText(filename, text, mime = 'text/plain') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function downloadJson(filename, obj) {
  downloadText(filename, JSON.stringify(obj, null, 2), 'application/json');
}
