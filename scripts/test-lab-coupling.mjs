#!/usr/bin/env node
/**
 * test-lab-coupling.mjs — contracts for the three lab buses.
 *
 * The buses are pure CPU bookkeeping, so everything that can go wrong can be
 * checked without a browser:
 *
 *   1. Charge bus (ADR-0013): off writes nothing but `null`; on writes
 *      clamp(gain × V_sphere, 0, Kelvin V_break); a NaN/negative source and a
 *      switched-off endpoint both leave the bench isolated; the graph refuses a
 *      second source per destination and any two-way pair.
 *   2. Kelvin plant: the seed only biases induction — zero drive means zero
 *      effect, a seed of 0 is bit-identical to no seed, and a seed raises V.
 *   3. Field bus (ADR-0011): one live source per destination. Halbach owns the
 *      Hall strip; homopolar takes over only when Halbach is off; a shadowed or
 *      disabled edge never clobbers the owner's write.
 *   4. Energy pipes (ADR-0004): generated from physics/coupling.json, every
 *      nameplate edge carries its nameplate watts, vdg / hall / pulse-coil are
 *      all on the graph, and the pulse-coil nameplate is still C·V²/(4τ) of
 *      its recharge constants.
 *   5. Flags: `?chargeCoupling`, `?fieldCoupling` and `?energyCoupling` are
 *      independent — setting one never implies another.
 *
 * Usage: node scripts/test-lab-coupling.mjs   (exit 1 on failure)
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const failures = [];
let checks = 0;
function check(cond, msg) {
  checks++;
  if (!cond) failures.push(msg);
}
function close(a, b, eps = 1e-9) {
  return Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));
}

const ENTRY = `
export * from './src/renderers/shared/charge-network.ts';
export { FieldNetwork, FIELD_COUPLING_EDGES, readFieldCouplingPref } from './src/renderers/shared/field-network.ts';
export { ENERGY_PIPE_EDGES, PIPE_COLORS, readEnergyCouplingPref } from './src/renderers/shared/energy-network.ts';
export { createDevicePhysicsState, stepDevicePhysics, kelvinSeedV } from './src/renderers/shared/device-physics.ts';
export { VDG, CHARGE_COUPLING, HALL, ENERGY_NETWORK_NAMEPLATES, PULSE_COIL_CORE } from './generated/physics-constants.ts';
`;

const built = await esbuild.build({
  stdin: { contents: ENTRY, resolveDir: ROOT, sourcefile: 'coupling-entry.ts', loader: 'ts' },
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  write: false,
  logLevel: 'warning',
});
const m = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);

/** URL-param stub: the pref readers look at `location.search` on every call. */
function withSearch(search, fn) {
  const prev = globalThis.location;
  globalThis.location = { search };
  try { return fn(); } finally { globalThis.location = prev; }
}

const kelvinState = () => m.createDevicePhysicsState('kelvin');
const vdgState = (v) => ({ ...m.createDevicePhysicsState('vdg'), vdgVoltage: v });

// ── 1. charge bus ────────────────────────────────────────────────────────
{
  const gain = m.VDG.sphereRadiusM / m.CHARGE_COUPLING.vdgToKelvinSeparationM;
  check(close(m.CHARGE_COUPLING_EDGES[0].gain, gain), 'vdg→kelvin gain must be r_sphere / d');

  const kelvin = kelvinState();
  const vbreak = kelvin.kelvinVbreak;
  const devices = { vdg: { physicsState: vdgState(80_000) }, kelvin: { physicsState: kelvin } };
  const enabled = { vdg: true, kelvin: true };

  const off = new m.ChargeNetwork(false);
  off.update({ devices, devicesEnabled: enabled });
  check(kelvin.kelvinSeedCoupledV === null, 'coupling off must leave Kelvin isolated (seed null)');
  check(off.getLink('vdg', 'kelvin')?.active === false, 'coupling off must report the link inactive');

  const on = new m.ChargeNetwork(true);
  on.update({ devices, devicesEnabled: enabled });
  const link = on.getLink('vdg', 'kelvin');
  check(close(kelvin.kelvinSeedCoupledV, 80_000 * gain), `seed must be V·r/d (got ${kelvin.kelvinSeedCoupledV})`);
  check(link?.active === true && link.clamped === false, 'an in-range seed is active and unclamped');
  check(close(link.appliedV, kelvin.kelvinSeedCoupledV), 'reading must report the V actually written');

  // A sphere far past its own breakdown still cannot push Kelvin past its own.
  devices.vdg.physicsState.vdgVoltage = 10 * vbreak / gain;
  on.update({ devices, devicesEnabled: enabled });
  check(close(kelvin.kelvinSeedCoupledV, vbreak), 'seed must clamp at Kelvin V_break');
  check(on.getLink('vdg', 'kelvin')?.clamped === true, 'a clamped seed must be flagged');

  for (const bad of [NaN, Infinity, -5_000]) {
    devices.vdg.physicsState.vdgVoltage = bad;
    on.update({ devices, devicesEnabled: enabled });
    check(kelvin.kelvinSeedCoupledV === 0, `source ${bad} must seed 0 V (got ${kelvin.kelvinSeedCoupledV})`);
  }

  devices.vdg.physicsState.vdgVoltage = 80_000;
  on.update({ devices, devicesEnabled: { vdg: false, kelvin: true } });
  check(kelvin.kelvinSeedCoupledV === null, 'a switched-off source leaves Kelvin isolated');
  on.update({ devices: { kelvin: { physicsState: kelvin } }, devicesEnabled: enabled });
  check(kelvin.kelvinSeedCoupledV === null, 'a missing source device leaves Kelvin isolated');

  on.setCouplingEnabled(false);
  on.update({ devices, devicesEnabled: enabled });
  check(kelvin.kelvinSeedCoupledV === null, 'switching the bus off restores the isolated bench');

  check(m.chargeSeedV({ gain: 1, minV: 0 }, 5, 3) === 3, 'chargeSeedV clamps high');
  check(m.chargeSeedV({ gain: 1, minV: 0 }, -5, 3) === 0, 'chargeSeedV clamps low');
  check(m.chargeSeedV({ gain: 1, minV: 0 }, NaN, 3) === 0, 'chargeSeedV is NaN-safe');

  const edge = m.CHARGE_COUPLING_EDGES[0];
  let threw = false;
  try { m.assertChargeGraph([edge, { ...edge, from: 'kelvin', to: 'vdg' }]); } catch { threw = true; }
  check(threw, 'assertChargeGraph must reject a two-way pair');
  threw = false;
  try { m.assertChargeGraph([edge, { ...edge, from: 'seg' }]); } catch { threw = true; }
  check(threw, 'assertChargeGraph must reject a second source for one destination');
  threw = false;
  try { m.assertChargeGraph(); } catch { threw = true; }
  check(!threw, 'the shipped charge graph must satisfy its own invariants');
}

// ── 2. Kelvin plant honours the seed, and only through induction ─────────
{
  const run = (seed, drive, frames = 90) => {
    const s = kelvinState();
    if (seed !== undefined) s.kelvinSeedCoupledV = seed;
    for (let i = 0; i < frames; i++) m.stepDevicePhysics(s, 1 / 60, drive);
    return s.kelvinV;
  };
  check(run(undefined, 0.5) === run(0, 0.5), 'a 0 V seed must be bit-identical to no seed');
  check(run(undefined, 0.5) === run(null, 0.5), 'a null seed must be bit-identical to no seed');
  check(run(12_000, 0.5) > 2 * run(undefined, 0.5), 'a seed must make Kelvin charge faster');
  check(run(12_000, 0) === run(undefined, 0), 'with no water flowing (drive 0) the seed does nothing');
  const s = kelvinState();
  s.kelvinSeedCoupledV = 1e9;
  check(m.kelvinSeedV(s) === s.kelvinVbreak, 'the plant clamps an oversized seed at its own V_break');
  s.kelvinSeedCoupledV = -1;
  check(m.kelvinSeedV(s) === 0, 'a negative seed clears to 0');
}

// ── 3. field bus: one live source per destination ────────────────────────
{
  const hallEdges = m.FIELD_COUPLING_EDGES.filter((e) => e.to === 'hall').map((e) => e.from);
  check(hallEdges[0] === 'halbach-viz' && hallEdges[1] === 'homopolar',
    `Hall sources must be [halbach-viz, homopolar] in priority order (got ${hallEdges})`);
  check(!m.FIELD_COUPLING_EDGES.some((e) => e.from === 'seg' && e.to === 'hall'), 'SEG must not also drive Hall');

  const hall = m.createDevicePhysicsState('hall');
  const devices = {
    'halbach-viz': { physicsState: { halbachPeakBT: 0.4 } },
    homopolar: { physicsState: { homopolarFieldT: 0.55 } },
    hall: { physicsState: hall }
  };
  const net = new m.FieldNetwork(true);

  net.update({ devices, devicesEnabled: { 'halbach-viz': true, homopolar: true, hall: true } });
  let snap = net.getSnapshot().links;
  check(close(hall.hallFieldCoupledT, 0.4), `Halbach must own Hall when both are on (got ${hall.hallFieldCoupledT})`);
  check(snap['halbach-viz->hall'].active && !snap['homopolar->hall'].active, 'only the owner is active');
  check(snap['homopolar->hall'].shadowedBy === 'halbach-viz', 'the loser must name who shadows it');
  check(net.getLinkForDestination('hall')?.from === 'halbach-viz', 'getLinkForDestination returns the owner');

  net.update({ devices, devicesEnabled: { 'halbach-viz': false, homopolar: true, hall: true } });
  snap = net.getSnapshot().links;
  check(close(hall.hallFieldCoupledT, 0.55), `homopolar must take Hall when Halbach is off (got ${hall.hallFieldCoupledT})`);
  check(snap['homopolar->hall'].active && snap['homopolar->hall'].shadowedBy === undefined, 'fallback source is active, not shadowed');
  check(net.getLinkForDestination('hall')?.from === 'homopolar', 'getLinkForDestination follows the fallback');

  // Homopolar off while Halbach owns Hall: its inactive edge must not reset B.
  net.update({ devices, devicesEnabled: { 'halbach-viz': true, homopolar: false, hall: true } });
  check(close(hall.hallFieldCoupledT, 0.4), 'a disabled lower-priority edge must not clobber the owner');

  devices.homopolar.physicsState.homopolarFieldT = 2.0;
  net.update({ devices, devicesEnabled: { 'halbach-viz': false, homopolar: true, hall: true } });
  check(close(hall.hallFieldCoupledT, m.HALL.bMaxT), 'homopolar B clamps to the Hall bench maximum');

  net.setCouplingEnabled(false);
  net.update({ devices, devicesEnabled: { 'halbach-viz': true, homopolar: true, hall: true } });
  check(hall.hallFieldCoupledT === null, 'field coupling off hands Hall back its drive-derived B');
}

// ── 4. energy pipes ──────────────────────────────────────────────────────
{
  const coupling = JSON.parse(readFileSync(join(ROOT, 'physics', 'coupling.json'), 'utf8'));
  const nameplates = m.ENERGY_NETWORK_NAMEPLATES.deviceNameplateWatts;
  check(m.ENERGY_PIPE_EDGES.length === coupling.energyPipes.length, 'every coupling.json pipe reaches ENERGY_PIPE_EDGES');
  for (const [i, e] of coupling.energyPipes.entries()) {
    const edge = m.ENERGY_PIPE_EDGES[i];
    check(edge.from === e.from && edge.to === e.to, `pipe ${i} order must follow coupling.json`);
    if (e.nameplate) {
      check(edge.maxWatts === nameplates[e.nameplate], `${e.from}→${e.to} must carry the ${e.nameplate} nameplate`);
    }
    check(edge.maxWatts > 0, `${e.from}→${e.to} needs positive capacity`);
    check(Array.isArray(m.PIPE_COLORS[`${e.from}-${e.to}`]), `${e.from}→${e.to} needs a colour`);
  }
  const touches = (id) => m.ENERGY_PIPE_EDGES.some((e) => e.from === id || e.to === id);
  check(touches('vdg') || touches('hall') || touches('pulse-coil'), 'at least one pipe must reach vdg / hall / pulse-coil');
  check(touches('vdg'), 'vdg is on the energy graph');
  check(touches('hall'), 'hall is on the energy graph');
  check(touches('pulse-coil'), 'pulse-coil is on the energy graph');
  // The pulse-coil nameplate is derived, not chosen: the peak power of the
  // bank's exponential recharge, C·V²/(4τ). Retuning C, V or τ without the
  // nameplate fails here.
  const pc = m.PULSE_COIL_CORE;
  const recharge = (pc.capF * pc.vChargeMax ** 2) / (4 * pc.chargeTauS);
  check(Math.abs(nameplates['pulse-coil'] - recharge) / recharge < 0.02,
    `pulse-coil nameplate ${nameplates['pulse-coil']} W must match C·V²/(4τ) = ${recharge.toFixed(2)} W`);
  for (const skip of coupling.skippedEnergyPipes ?? []) {
    check(!touches(skip.to), `${skip.to} is listed as skipped but has a pipe`);
    check(typeof skip.reason === 'string' && skip.reason.length > 20, `skipped ${skip.to} must say why`);
  }
}

// ── 5. flags are independent ─────────────────────────────────────────────
{
  const prefs = (search) => withSearch(search, () => ({
    charge: m.readChargeCouplingPref(),
    field: m.readFieldCouplingPref(),
    energy: m.readEnergyCouplingPref()
  }));
  const none = prefs('');
  check(!none.charge && !none.field && !none.energy, 'every bus defaults to off');
  const c = prefs('?chargeCoupling=1');
  check(c.charge && !c.field && !c.energy, 'chargeCoupling=1 must not imply field or energy coupling');
  const f = prefs('?fieldCoupling=1&energyCoupling=1');
  check(!f.charge && f.field && f.energy, 'field + energy must not imply charge coupling');
  const all = prefs('?chargeCoupling=1&fieldCoupling=1&energyCoupling=1');
  check(all.charge && all.field && all.energy, 'all three combine');
  const zero = prefs('?chargeCoupling=0&fieldCoupling=1');
  check(!zero.charge && zero.field, 'chargeCoupling=0 wins over nothing and leaves field alone');
}

if (failures.length) {
  console.error(`[coupling] ${failures.length} of ${checks} check(s) failed:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`[coupling] ${checks} checks OK — charge, field and energy buses`);
