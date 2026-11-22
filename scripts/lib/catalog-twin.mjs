/**
 * catalog-twin.mjs — the `twin` half of codegen-device-catalog (#257, ADR-0019).
 *
 * A device the hardware twin drives declares the *rig* it expects on the
 * bench — a model for the estimator and system identification, not the
 * device's own render plant:
 *
 *   "twin": {
 *     "model": "…",                         // what the lumped model is (and is not)
 *     "integrator": "rk4", "hMax": 0.002,  // the predict step (fixed substeps ≤ hMax)
 *     "state":   [{ "id", "label", "unit", "q" }],                 // x, q = process noise, unit²/s
 *     "params":  [{ "id", "label", "unit", "nominal", "min", "max" }], // θ, identifiable
 *     "input":   { "vPerRpm", "vMax" },     // board drive: v = vPerRpm·RPM_cmd, |v| ≤ vMax
 *     "sensors": [{ "id", "label", "unit", "sigma", "model" }]       // y, σ = noise, in unit
 *   }
 *
 * The measurement functions themselves are C++ (the plant's outputs_p, one
 * per sensor in this order); the catalog owns their names, units and noise.
 *
 * Emits generated/twin-rig.h (index enums + constants, namespace
 * power_gen::twin) and generated/twin-rig.ts (the same table for the TS host,
 * the mock rig and the panel).
 */

const ID_RE = /^[a-z][A-Za-z0-9]*$/;
const TWIN_KEYS = ['$comment', 'model', 'integrator', 'hMax', 'state', 'params', 'input', 'sensors'];
const TWIN_INTEGRATORS = ['rk4'];

const isPos = (v) => Number.isFinite(v) && v > 0;

export function validateTwin(devices) {
  const errors = [];
  const twins = devices.filter((d) => d.twin != null);
  if (twins.length > 1) errors.push(`twin: only one device may declare a rig (${twins.map((d) => d.id).join(', ')})`);
  for (const d of twins) {
    const t = d.twin;
    const where = `${d.id}.twin`;
    for (const k of Object.keys(t)) if (!TWIN_KEYS.includes(k)) errors.push(`${where}: unknown property "${k}"`);
    if (typeof t.model !== 'string' || t.model.length < 20) errors.push(`${where}.model: say what the lumped model is (and is not)`);
    if (!TWIN_INTEGRATORS.includes(t.integrator)) errors.push(`${where}.integrator: one of ${TWIN_INTEGRATORS.join(', ')} (sensitivities run through it)`);
    if (!isPos(t.hMax) || t.hMax > 0.05) errors.push(`${where}.hMax: a step in (0, 0.05] s`);
    const lists = {
      state: ['id', 'label', 'unit', 'q'],
      params: ['id', 'label', 'unit', 'nominal', 'min', 'max'],
      sensors: ['id', 'label', 'unit', 'sigma', 'model']
    };
    for (const [list, keys] of Object.entries(lists)) {
      const rows = t[list];
      if (!Array.isArray(rows) || rows.length === 0) {
        errors.push(`${where}.${list}: a non-empty array`);
        continue;
      }
      if (rows.length > 8) errors.push(`${where}.${list}: at most 8 entries (fixed-size Duals)`);
      const seen = new Set();
      for (const [i, r] of rows.entries()) {
        const at = `${where}.${list}[${i}]`;
        for (const k of Object.keys(r)) if (!keys.includes(k)) errors.push(`${at}: unknown property "${k}"`);
        if (typeof r.id !== 'string' || !ID_RE.test(r.id)) errors.push(`${at}.id: an identifier`);
        else if (seen.has(r.id)) errors.push(`${at}.id: duplicate "${r.id}"`);
        seen.add(r.id);
        for (const k of ['label', 'unit']) if (typeof r[k] !== 'string') errors.push(`${at}.${k}: a string`);
      }
    }
    for (const [i, r] of (t.state ?? []).entries()) {
      if (!(Number.isFinite(r.q) && r.q >= 0)) errors.push(`${where}.state[${i}].q: a process-noise density ≥ 0`);
    }
    for (const [i, r] of (t.params ?? []).entries()) {
      const at = `${where}.params[${i}]`;
      if (!isPos(r.min) || !isPos(r.max) || !isPos(r.nominal)) errors.push(`${at}: nominal, min, max positive (sysid works in log θ)`);
      else if (!(r.min < r.nominal && r.nominal < r.max)) errors.push(`${at}: min < nominal < max`);
    }
    for (const [i, r] of (t.sensors ?? []).entries()) {
      if (!isPos(r.sigma)) errors.push(`${where}.sensors[${i}].sigma: a positive noise σ`);
      if (typeof r.model !== 'string') errors.push(`${where}.sensors[${i}].model: what the channel measures`);
    }
    const inp = t.input ?? {};
    for (const k of Object.keys(inp)) if (!['vPerRpm', 'vMax'].includes(k)) errors.push(`${where}.input: unknown property "${k}"`);
    if (!isPos(inp.vPerRpm) || !isPos(inp.vMax)) errors.push(`${where}.input: vPerRpm and vMax positive`);
  }
  return errors;
}

const twinDevice = (devices) => devices.find((d) => d.twin != null) ?? null;

const num = (v) => {
  const s = String(v);
  return /[.eE]/.test(s) ? s : `${s}.0`;
};
const cstr = (s) => JSON.stringify(s);

export function emitTwinH(devices) {
  const d = twinDevice(devices);
  const header = `// AUTO-GENERATED from physics/devices.json — do not edit.
// Regenerate: npm run codegen:catalog
//
// The hardware twin's rig (#257, ADR-0019): index enums and constants for
// cpp/src/twin/ (rig plant, EKF, system identification). TS twin:
// generated/twin-rig.ts.

#pragma once

#include <array>
#include <cstddef>

namespace power_gen::twin {
`;
  if (!d) return `${header}
// No device declares a "twin" block.

} // namespace power_gen::twin
`;
  const t = d.twin;
  const idx = (rows) => rows.map((r, i) => `${r.id} = ${i}`).join(', ');
  const arr = (rows, f) => rows.map((r) => num(f(r))).join(', ');
  const names = (rows, f) => rows.map((r) => cstr(f(r))).join(', ');
  return `${header}
/// ${d.label} bench rig (physics/devices.json "${d.id}".twin).
struct Rig {
    static constexpr const char* DEVICE = ${cstr(d.id)};
    struct X { enum : std::size_t { ${idx(t.state)} }; };
    struct Th { enum : std::size_t { ${idx(t.params)} }; };
    struct Y { enum : std::size_t { ${idx(t.sensors)} }; };
    static constexpr std::size_t STATE_SIZE = ${t.state.length};
    static constexpr std::size_t PARAM_SIZE = ${t.params.length};
    static constexpr std::size_t SENSOR_SIZE = ${t.sensors.length};

    /// Predict-step substep cap, s (fixed RK4 substeps ≤ H_MAX).
    static constexpr double H_MAX = ${num(t.hMax)};
    /// Board drive: v = V_PER_RPM · RPM_cmd, |v| ≤ V_MAX (RUN only).
    static constexpr double V_PER_RPM = ${num(t.input.vPerRpm)};
    static constexpr double V_MAX = ${num(t.input.vMax)};

    /// Continuous process-noise density per state, unit²/s.
    static constexpr std::array<double, STATE_SIZE> PROCESS_NOISE = { ${arr(t.state, (r) => r.q)} };
    static constexpr std::array<double, PARAM_SIZE> PARAM_NOMINAL = { ${arr(t.params, (r) => r.nominal)} };
    static constexpr std::array<double, PARAM_SIZE> PARAM_MIN = { ${arr(t.params, (r) => r.min)} };
    static constexpr std::array<double, PARAM_SIZE> PARAM_MAX = { ${arr(t.params, (r) => r.max)} };
    /// Measurement noise σ per sensor, in its unit.
    static constexpr std::array<double, SENSOR_SIZE> SENSOR_SIGMA = { ${arr(t.sensors, (r) => r.sigma)} };

    static constexpr const char* STATE_NAMES[STATE_SIZE] = { ${names(t.state, (r) => r.id)} };
    static constexpr const char* PARAM_NAMES[PARAM_SIZE] = { ${names(t.params, (r) => r.id)} };
    static constexpr const char* SENSOR_NAMES[SENSOR_SIZE] = { ${names(t.sensors, (r) => r.id)} };
};

} // namespace power_gen::twin
`;
}

export function emitTwinTs(devices) {
  const d = twinDevice(devices);
  const header = `/**
 * AUTO-GENERATED from physics/devices.json — do not edit.
 * Regenerate: npm run codegen:catalog
 *
 * The hardware twin's rig (#257, ADR-0019) — the TS twin of
 * generated/twin-rig.h: what the estimator host, the mock rig and the twin
 * panel read about the model, its parameters and its sensors.
 */
`;
  if (!d) return `${header}
export const TWIN_RIG = null;
`;
  const t = d.twin;
  const rows = (list, keys) => list.map((r) => `    { ${keys.map((k) => `${k}: ${JSON.stringify(r[k])}`).join(', ')} }`).join(',\n');
  const enumOf = (list) => `{ ${list.map((r, i) => `${r.id}: ${i}`).join(', ')} } as const`;
  return `${header}
export interface TwinRigStateSpec { id: string; label: string; unit: string; q: number }
export interface TwinRigParamSpec { id: string; label: string; unit: string; nominal: number; min: number; max: number }
export interface TwinRigSensorSpec { id: string; label: string; unit: string; sigma: number; model: string }

export interface TwinRigSpec {
  device: string;
  model: string;
  integrator: 'rk4';
  /** Predict-step substep cap, s. */
  hMax: number;
  state: readonly TwinRigStateSpec[];
  params: readonly TwinRigParamSpec[];
  /** Board drive v = vPerRpm · RPM_cmd, |v| ≤ vMax, in RUN only. */
  input: { vPerRpm: number; vMax: number };
  sensors: readonly TwinRigSensorSpec[];
}

export const TWIN_RIG: TwinRigSpec = {
  device: ${JSON.stringify(d.id)},
  model: ${JSON.stringify(t.model)},
  integrator: 'rk4',
  hMax: ${t.hMax},
  state: [
${rows(t.state, ['id', 'label', 'unit', 'q'])}
  ],
  params: [
${rows(t.params, ['id', 'label', 'unit', 'nominal', 'min', 'max'])}
  ],
  input: { vPerRpm: ${t.input.vPerRpm}, vMax: ${t.input.vMax} },
  sensors: [
${rows(t.sensors, ['id', 'label', 'unit', 'sigma', 'model'])}
  ]
};

/** Index of each rig state in x. */
export const TwinRigState = ${enumOf(t.state)};
/** Index of each identifiable parameter in θ. */
export const TwinRigParam = ${enumOf(t.params)};
/** Index of each sensor channel in y. */
export const TwinRigSensor = ${enumOf(t.sensors)};
`;
}
