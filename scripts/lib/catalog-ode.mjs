/**
 * catalog-ode.mjs — the `integrator` / `ode` half of codegen-device-catalog.
 *
 * A device whose plant runs on the shared integrators (cpp/src/core/
 * integrate.h, src/renderers/shared/integrate.ts) declares its ODE in
 * physics/devices.json:
 *
 *   "integrator": "rk4" | "dopri5" | "ros23" | "euler",   (default rk4)
 *   "ode": {
 *     "state":   ["primaryIA", "ringCurrentA", …],   // x, in index order
 *     "outputs": ["forceN", "couplingK"],             // derived telemetry
 *     "tolerance": { "rtol": 2e-4, "atol": { "<state>": … }, "hMax": … }
 *   }
 *
 * Every `state` / `outputs` name is a cpp field of the device's `state`
 * block, so whatever the integrator works on is also what a snapshot saves. A
 * state name may be an array field (`"nodesK"` for cpp `nodesK[]`, count 28):
 * it takes `count` consecutive indices, its enum entry is the first of them,
 * `<name>_COUNT` its length, and its one `atol` applies to every element;
 * and the block must also save `stepH` / `stepErrOld` (the adaptive steppers'
 * carry-over), so a restored plant steps on bit-identically under any method.
 *
 * Emits generated/plant-ode.h (constexpr index enums + tolerances per plant)
 * and generated/plant-ode.ts (the same table for the TS plants).
 */

export const INTEGRATORS = ['euler', 'rk4', 'dopri5', 'ros23'];
const INTEGRATOR_ENUM = { euler: 'Euler', rk4: 'Rk4', dopri5: 'Dopri5', ros23: 'Ros23' };
const STEPPER_FIELDS = ['stepH', 'stepErrOld'];
const NAME_RE = /^[a-z][A-Za-z0-9]*$/;

/** `jumping-ring` → `JumpingRing`. */
export function odeStructName(id) {
  return id.split(/[-_]/).map((p) => p[0].toUpperCase() + p.slice(1)).join('');
}

export function validateOde(devices) {
  const errors = [];
  for (const d of devices) {
    if (d.integrator != null && d.ode == null) errors.push(`${d.id}: "integrator" needs an "ode" block`);
    if (d.ode == null) continue;
    const where = `${d.id}.ode`;
    if (d.wasmMode == null) errors.push(`${where}: only a wasm plant has an ode block`);
    const integ = d.integrator ?? 'rk4';
    if (!INTEGRATORS.includes(integ)) errors.push(`${d.id}: integrator must be one of ${INTEGRATORS.join(', ')}`);
    const o = d.ode;
    const cppFields = new Set(odeFieldCounts(d).keys());
    for (const k of Object.keys(o)) {
      if (!['state', 'outputs', 'tolerance'].includes(k)) errors.push(`${where}: unknown property "${k}"`);
    }
    const lists = { state: o.state, outputs: o.outputs ?? [] };
    for (const [list, names] of Object.entries(lists)) {
      if (!Array.isArray(names) || (list === 'state' && names.length === 0)) {
        errors.push(`${where}.${list}: a ${list === 'state' ? 'non-empty ' : ''}array of plant field names`);
        continue;
      }
      const seen = new Set();
      for (const n of names) {
        if (typeof n !== 'string' || !NAME_RE.test(n)) errors.push(`${where}.${list}: "${n}" is not a field name`);
        else if (seen.has(n)) errors.push(`${where}.${list}: duplicate "${n}"`);
        else if (!cppFields.has(n)) errors.push(`${where}.${list}: "${n}" is not a cpp field of ${d.id}.state (so a snapshot would miss it)`);
        seen.add(n);
      }
    }
    for (const f of STEPPER_FIELDS) {
      if (!cppFields.has(f)) errors.push(`${d.id}.state: must save cpp "${f}" (adaptive stepper carry-over, see docs/INTEGRATORS.md)`);
    }
    const tol = o.tolerance ?? {};
    for (const k of Object.keys(tol)) {
      if (!['rtol', 'atol', 'hMax'].includes(k)) errors.push(`${where}.tolerance: unknown property "${k}"`);
    }
    if (!(Number.isFinite(tol.rtol) && tol.rtol > 0 && tol.rtol < 1)) errors.push(`${where}.tolerance.rtol: a number in (0, 1)`);
    const atol = tol.atol ?? {};
    for (const n of o.state ?? []) {
      if (!(Number.isFinite(atol[n]) && atol[n] > 0)) errors.push(`${where}.tolerance.atol.${n}: a positive number`);
    }
    for (const n of Object.keys(atol)) {
      if (!(o.state ?? []).includes(n)) errors.push(`${where}.tolerance.atol.${n}: not an ode state`);
    }
    if (tol.hMax != null && !(Number.isFinite(tol.hMax) && tol.hMax > 0)) errors.push(`${where}.tolerance.hMax: a positive number of seconds (or omit)`);
  }
  return errors;
}

const odeDevices = (devices) => devices.filter((d) => d.ode != null).sort((a, b) => a.wasmMode - b.wasmMode);

/** ODE-nameable cpp fields of a device → how many floats each takes (`x[]` is named `x`). */
function odeFieldCounts(d) {
  const out = new Map();
  for (const f of d.state?.fields ?? []) {
    if (typeof f.cpp !== 'string') continue;
    out.set(f.cpp.endsWith('[]') ? f.cpp.slice(0, -2) : f.cpp, f.cpp.endsWith('[]') ? (f.count ?? 1) : 1);
  }
  return out;
}

/**
 * The ODE state vector laid out: one row per `ode.state` name with its first
 * index and length, plus the per-element names and tolerances.
 */
function odeStateLayout(d) {
  const counts = odeFieldCounts(d);
  const atol = d.ode.tolerance.atol ?? {};
  const fields = [];
  const names = [];
  const atols = [];
  let index = 0;
  for (const name of d.ode.state) {
    const count = counts.get(name) ?? 1;
    fields.push({ name, index, count, array: count > 1 });
    for (let i = 0; i < count; i++) {
      names.push(count > 1 ? `${name}[${i}]` : name);
      atols.push(atol[name]);
    }
    index += count;
  }
  return { fields, names, atols, size: index };
}

/** Shortest round-tripping float literal. */
function f32(v) {
  const s = String(Math.fround(v) === v ? v : v);
  return /[.eE]/.test(s) ? `${s}f` : `${s}.f`;
}

export function emitPlantOdeH(devices) {
  const blocks = odeDevices(devices).map((d) => {
    const o = d.ode;
    const tol = o.tolerance;
    const outputs = o.outputs ?? [];
    const lay = odeStateLayout(d);
    const idx = lay.fields.map((f) => `${f.name} = ${f.index}`).join(', ');
    const counts = lay.fields.filter((f) => f.array)
      .map((f) => `static constexpr std::size_t ${f.name}_COUNT = ${f.count};\n    `).join('');
    const outIdx = outputs.map((n, i) => `${n} = ${i}`).join(', ');
    return `/// ${d.label} (wasmMode ${d.wasmMode}, physics/devices.json "${d.id}").
struct ${odeStructName(d.id)} {
    enum State : std::size_t { ${idx} };
    ${counts}static constexpr std::size_t STATE_SIZE = ${lay.size};
    ${outputs.length ? `enum Output : std::size_t { ${outIdx} };\n    ` : ''}static constexpr std::size_t OUTPUT_SIZE = ${outputs.length};
    static constexpr sim_core::Integrator INTEGRATOR = sim_core::Integrator::${INTEGRATOR_ENUM[d.integrator ?? 'rk4']};
    static constexpr float RTOL = ${f32(tol.rtol)};
    static constexpr std::array<float, STATE_SIZE> ATOL = { ${lay.atols.map((a) => f32(a)).join(', ')} };
    static constexpr double H_MAX = ${tol.hMax != null ? String(tol.hMax) : 'std::numeric_limits<double>::infinity()'};
    static constexpr const char* STATE_NAMES[STATE_SIZE] = { ${lay.names.map((n) => `"${n}"`).join(', ')} };

    static sim_core::Tolerance<STATE_SIZE> tolerance() {
        sim_core::Tolerance<STATE_SIZE> t;
        t.rtol = RTOL;
        t.atol = ATOL;
        t.hMax = H_MAX;
        return t;
    }
};`;
  }).join('\n\n');
  return `// AUTO-GENERATED from physics/devices.json — do not edit.
// Regenerate: npm run codegen:catalog
//
// Per-plant ODE layout for the shared integrators (cpp/src/core/integrate.h):
// the state-index enum a Plant's derivs / save / load use, its catalog
// integrator and tolerances. TS twin: generated/plant-ode.ts.

#pragma once

#include <array>
#include <cstddef>
#include <limits>

#include "../cpp/src/core/integrate.h"

namespace power_gen::ode {

${blocks}

} // namespace power_gen::ode
`;
}

export function emitPlantOdeTs(devices) {
  const rows = odeDevices(devices).map((d) => {
    const o = d.ode;
    const tol = o.tolerance;
    const outputs = o.outputs ?? [];
    const lay = odeStateLayout(d);
    return `  '${d.id}': {
    wasmMode: ${d.wasmMode},
    integrator: '${d.integrator ?? 'rk4'}',
    state: [${lay.names.map((n) => `'${n}'`).join(', ')}],
    outputs: [${outputs.map((n) => `'${n}'`).join(', ')}],
    rtol: ${tol.rtol},
    atol: [${lay.atols.join(', ')}],
    hMax: ${tol.hMax != null ? tol.hMax : 'Infinity'}
  }`;
  }).join(',\n');
  const enums = odeDevices(devices).map((d) => {
    const name = odeStructName(d.id);
    const lay = odeStateLayout(d);
    const arrays = lay.fields.filter((f) => f.array);
    const counts = arrays.length
      ? `\n\n/** ${d.label}: length of each array ODE state. */\nexport const ${name}StateCount = { ${arrays.map((f) => `${f.name}: ${f.count}`).join(', ')} } as const;`
      : '';
    return `/** ${d.label}: index of each ODE state in x (an array state: its first element). */
export const ${name}State = { ${lay.fields.map((f) => `${f.name}: ${f.index}`).join(', ')} } as const;${counts}`;
  }).join('\n\n');
  return `/**
 * AUTO-GENERATED from physics/devices.json — do not edit.
 * Regenerate: npm run codegen:catalog
 *
 * Per-plant ODE layout for the shared integrators
 * (src/renderers/shared/integrate.ts) — the TS twin of generated/plant-ode.h.
 */

export type IntegratorName = ${INTEGRATORS.map((n) => `'${n}'`).join(' | ')};

export const INTEGRATOR_NAMES: readonly IntegratorName[] = [${INTEGRATORS.map((n) => `'${n}'`).join(', ')}];

export interface PlantOdeSpec {
  wasmMode: number;
  /** Catalog default; \`physicsState.integratorOverride\` replaces it (benches / goldens). */
  integrator: IntegratorName;
  state: readonly string[];
  outputs: readonly string[];
  rtol: number;
  atol: readonly number[];
  /** Largest adaptive step, s. */
  hMax: number;
}

export const PLANT_ODE: Readonly<Record<string, PlantOdeSpec>> = {
${rows}
};

${enums}
`;
}
