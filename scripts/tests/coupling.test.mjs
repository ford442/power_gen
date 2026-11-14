/**
 * coupling — contracts for the three lab buses.
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
 * Usage: npm run test:coupling   (node --test scripts/tests/coupling.test.mjs)
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import { bundleTs, ROOT } from '../test-harness.mjs';

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

let m;
before(async () => {
  m = await bundleTs({ contents: ENTRY, sourcefile: 'coupling-entry.ts' });
});

/** URL-param stub: the pref readers look at `location.search` on every call. */
function withSearch(search, fn) {
  const prev = globalThis.location;
  globalThis.location = { search };
  try { return fn(); } finally { globalThis.location = prev; }
}

const kelvinState = () => m.createDevicePhysicsState('kelvin');
const vdgState = (v) => ({ ...m.createDevicePhysicsState('vdg'), vdgVoltage: v });

describe('charge bus', () => {
  // Sequential: each `it` advances the same bench.
  let gain, kelvin, vbreak, devices, enabled, on;
  before(() => {
    gain = m.VDG.sphereRadiusM / m.CHARGE_COUPLING.vdgToKelvinSeparationM;
    kelvin = kelvinState();
    vbreak = kelvin.kelvinVbreak;
    devices = { vdg: { physicsState: vdgState(80_000) }, kelvin: { physicsState: kelvin } };
    enabled = { vdg: true, kelvin: true };
  });

  it('vdg→kelvin gain is r_sphere / d', () => {
    assert.ok(close(m.CHARGE_COUPLING_EDGES[0].gain, gain), 'vdg→kelvin gain must be r_sphere / d');
  });

  it('coupling off leaves Kelvin isolated', () => {
    const off = new m.ChargeNetwork(false);
    off.update({ devices, devicesEnabled: enabled });
    assert.ok(kelvin.kelvinSeedCoupledV === null, 'coupling off must leave Kelvin isolated (seed null)');
    assert.ok(off.getLink('vdg', 'kelvin')?.active === false, 'coupling off must report the link inactive');
  });

  it('coupling on seeds V·r/d, active and unclamped', () => {
    on = new m.ChargeNetwork(true);
    on.update({ devices, devicesEnabled: enabled });
    const link = on.getLink('vdg', 'kelvin');
    assert.ok(close(kelvin.kelvinSeedCoupledV, 80_000 * gain), `seed must be V·r/d (got ${kelvin.kelvinSeedCoupledV})`);
    assert.ok(link?.active === true && link.clamped === false, 'an in-range seed is active and unclamped');
    assert.ok(close(link.appliedV, kelvin.kelvinSeedCoupledV), 'reading must report the V actually written');
  });

  it('a sphere past its own breakdown still cannot push Kelvin past its own', () => {
    devices.vdg.physicsState.vdgVoltage = 10 * vbreak / gain;
    on.update({ devices, devicesEnabled: enabled });
    assert.ok(close(kelvin.kelvinSeedCoupledV, vbreak), 'seed must clamp at Kelvin V_break');
    assert.ok(on.getLink('vdg', 'kelvin')?.clamped === true, 'a clamped seed must be flagged');
  });

  it('NaN / Infinity / negative sources seed 0 V', () => {
    for (const bad of [NaN, Infinity, -5_000]) {
      devices.vdg.physicsState.vdgVoltage = bad;
      on.update({ devices, devicesEnabled: enabled });
      assert.ok(kelvin.kelvinSeedCoupledV === 0, `source ${bad} must seed 0 V (got ${kelvin.kelvinSeedCoupledV})`);
    }
  });

  it('a switched-off or missing source leaves Kelvin isolated', () => {
    devices.vdg.physicsState.vdgVoltage = 80_000;
    on.update({ devices, devicesEnabled: { vdg: false, kelvin: true } });
    assert.ok(kelvin.kelvinSeedCoupledV === null, 'a switched-off source leaves Kelvin isolated');
    on.update({ devices: { kelvin: { physicsState: kelvin } }, devicesEnabled: enabled });
    assert.ok(kelvin.kelvinSeedCoupledV === null, 'a missing source device leaves Kelvin isolated');
  });

  it('switching the bus off restores the isolated bench', () => {
    on.setCouplingEnabled(false);
    on.update({ devices, devicesEnabled: enabled });
    assert.ok(kelvin.kelvinSeedCoupledV === null, 'switching the bus off restores the isolated bench');
  });

  it('chargeSeedV clamps and is NaN-safe', () => {
    assert.ok(m.chargeSeedV({ gain: 1, minV: 0 }, 5, 3) === 3, 'chargeSeedV clamps high');
    assert.ok(m.chargeSeedV({ gain: 1, minV: 0 }, -5, 3) === 0, 'chargeSeedV clamps low');
    assert.ok(m.chargeSeedV({ gain: 1, minV: 0 }, NaN, 3) === 0, 'chargeSeedV is NaN-safe');
  });

  it('assertChargeGraph rejects two-way pairs and second sources, accepts the shipped graph', () => {
    const edge = m.CHARGE_COUPLING_EDGES[0];
    let threw = false;
    try { m.assertChargeGraph([edge, { ...edge, from: 'kelvin', to: 'vdg' }]); } catch { threw = true; }
    assert.ok(threw, 'assertChargeGraph must reject a two-way pair');
    threw = false;
    try { m.assertChargeGraph([edge, { ...edge, from: 'seg' }]); } catch { threw = true; }
    assert.ok(threw, 'assertChargeGraph must reject a second source for one destination');
    threw = false;
    try { m.assertChargeGraph(); } catch { threw = true; }
    assert.ok(!threw, 'the shipped charge graph must satisfy its own invariants');
  });
});

describe('Kelvin plant honours the seed, and only through induction', () => {
  const run = (seed, drive, frames = 90) => {
    const s = kelvinState();
    if (seed !== undefined) s.kelvinSeedCoupledV = seed;
    for (let i = 0; i < frames; i++) m.stepDevicePhysics(s, 1 / 60, drive);
    return s.kelvinV;
  };

  it('a 0 V or null seed is bit-identical to no seed', () => {
    assert.ok(run(undefined, 0.5) === run(0, 0.5), 'a 0 V seed must be bit-identical to no seed');
    assert.ok(run(undefined, 0.5) === run(null, 0.5), 'a null seed must be bit-identical to no seed');
  });

  it('a seed makes Kelvin charge faster, but only with water flowing', () => {
    assert.ok(run(12_000, 0.5) > 2 * run(undefined, 0.5), 'a seed must make Kelvin charge faster');
    assert.ok(run(12_000, 0) === run(undefined, 0), 'with no water flowing (drive 0) the seed does nothing');
  });

  it('kelvinSeedV clamps oversized and negative seeds', () => {
    const s = kelvinState();
    s.kelvinSeedCoupledV = 1e9;
    assert.ok(m.kelvinSeedV(s) === s.kelvinVbreak, 'the plant clamps an oversized seed at its own V_break');
    s.kelvinSeedCoupledV = -1;
    assert.ok(m.kelvinSeedV(s) === 0, 'a negative seed clears to 0');
  });
});

describe('field bus: one live source per destination', () => {
  let hall, devices, net;
  before(() => {
    hall = m.createDevicePhysicsState('hall');
    devices = {
      'halbach-viz': { physicsState: { halbachPeakBT: 0.4 } },
      homopolar: { physicsState: { homopolarFieldT: 0.55 } },
      hall: { physicsState: hall }
    };
    net = new m.FieldNetwork(true);
  });

  it('Hall sources are [halbach-viz, homopolar] in priority order; SEG does not drive Hall', () => {
    const hallEdges = m.FIELD_COUPLING_EDGES.filter((e) => e.to === 'hall').map((e) => e.from);
    assert.ok(hallEdges[0] === 'halbach-viz' && hallEdges[1] === 'homopolar',
      `Hall sources must be [halbach-viz, homopolar] in priority order (got ${hallEdges})`);
    assert.ok(!m.FIELD_COUPLING_EDGES.some((e) => e.from === 'seg' && e.to === 'hall'), 'SEG must not also drive Hall');
  });

  it('Halbach owns Hall when both are on', () => {
    net.update({ devices, devicesEnabled: { 'halbach-viz': true, homopolar: true, hall: true } });
    const snap = net.getSnapshot().links;
    assert.ok(close(hall.hallFieldCoupledT, 0.4), `Halbach must own Hall when both are on (got ${hall.hallFieldCoupledT})`);
    assert.ok(snap['halbach-viz->hall'].active && !snap['homopolar->hall'].active, 'only the owner is active');
    assert.ok(snap['homopolar->hall'].shadowedBy === 'halbach-viz', 'the loser must name who shadows it');
    assert.ok(net.getLinkForDestination('hall')?.from === 'halbach-viz', 'getLinkForDestination returns the owner');
  });

  it('homopolar takes Hall when Halbach is off', () => {
    net.update({ devices, devicesEnabled: { 'halbach-viz': false, homopolar: true, hall: true } });
    const snap = net.getSnapshot().links;
    assert.ok(close(hall.hallFieldCoupledT, 0.55), `homopolar must take Hall when Halbach is off (got ${hall.hallFieldCoupledT})`);
    assert.ok(snap['homopolar->hall'].active && snap['homopolar->hall'].shadowedBy === undefined, 'fallback source is active, not shadowed');
    assert.ok(net.getLinkForDestination('hall')?.from === 'homopolar', 'getLinkForDestination follows the fallback');
  });

  it('a disabled lower-priority edge does not clobber the owner', () => {
    // Homopolar off while Halbach owns Hall: its inactive edge must not reset B.
    net.update({ devices, devicesEnabled: { 'halbach-viz': true, homopolar: false, hall: true } });
    assert.ok(close(hall.hallFieldCoupledT, 0.4), 'a disabled lower-priority edge must not clobber the owner');
  });

  it('homopolar B clamps to the Hall bench maximum', () => {
    devices.homopolar.physicsState.homopolarFieldT = 2.0;
    net.update({ devices, devicesEnabled: { 'halbach-viz': false, homopolar: true, hall: true } });
    assert.ok(close(hall.hallFieldCoupledT, m.HALL.bMaxT), 'homopolar B clamps to the Hall bench maximum');
  });

  it('field coupling off hands Hall back its drive-derived B', () => {
    net.setCouplingEnabled(false);
    net.update({ devices, devicesEnabled: { 'halbach-viz': true, homopolar: true, hall: true } });
    assert.ok(hall.hallFieldCoupledT === null, 'field coupling off hands Hall back its drive-derived B');
  });
});

describe('energy pipes', () => {
  const coupling = JSON.parse(readFileSync(join(ROOT, 'physics', 'coupling.json'), 'utf8'));
  let nameplates, touches;
  before(() => {
    nameplates = m.ENERGY_NETWORK_NAMEPLATES.deviceNameplateWatts;
    touches = (id) => m.ENERGY_PIPE_EDGES.some((e) => e.from === id || e.to === id);
  });

  it('every coupling.json pipe reaches ENERGY_PIPE_EDGES', () => {
    assert.ok(m.ENERGY_PIPE_EDGES.length === coupling.energyPipes.length, 'every coupling.json pipe reaches ENERGY_PIPE_EDGES');
  });

  for (const [i, e] of coupling.energyPipes.entries()) {
    it(`pipe ${i} ${e.from}→${e.to}: order, nameplate, capacity, colour`, () => {
      const edge = m.ENERGY_PIPE_EDGES[i];
      assert.ok(edge.from === e.from && edge.to === e.to, `pipe ${i} order must follow coupling.json`);
      if (e.nameplate) {
        assert.ok(edge.maxWatts === nameplates[e.nameplate], `${e.from}→${e.to} must carry the ${e.nameplate} nameplate`);
      }
      assert.ok(edge.maxWatts > 0, `${e.from}→${e.to} needs positive capacity`);
      assert.ok(Array.isArray(m.PIPE_COLORS[`${e.from}-${e.to}`]), `${e.from}→${e.to} needs a colour`);
    });
  }

  it('vdg, hall and pulse-coil are on the energy graph', () => {
    assert.ok(touches('vdg') || touches('hall') || touches('pulse-coil'), 'at least one pipe must reach vdg / hall / pulse-coil');
    assert.ok(touches('vdg'), 'vdg is on the energy graph');
    assert.ok(touches('hall'), 'hall is on the energy graph');
    assert.ok(touches('pulse-coil'), 'pulse-coil is on the energy graph');
  });

  it('pulse-coil nameplate is C·V²/(4τ) of its recharge constants', () => {
    // The pulse-coil nameplate is derived, not chosen: the peak power of the
    // bank's exponential recharge, C·V²/(4τ). Retuning C, V or τ without the
    // nameplate fails here.
    const pc = m.PULSE_COIL_CORE;
    const recharge = (pc.capF * pc.vChargeMax ** 2) / (4 * pc.chargeTauS);
    assert.ok(Math.abs(nameplates['pulse-coil'] - recharge) / recharge < 0.02,
      `pulse-coil nameplate ${nameplates['pulse-coil']} W must match C·V²/(4τ) = ${recharge.toFixed(2)} W`);
  });

  for (const skip of coupling.skippedEnergyPipes ?? []) {
    it(`skipped ${skip.to} has no pipe and says why`, () => {
      assert.ok(!touches(skip.to), `${skip.to} is listed as skipped but has a pipe`);
      assert.ok(typeof skip.reason === 'string' && skip.reason.length > 20, `skipped ${skip.to} must say why`);
    });
  }
});

describe('flags are independent', () => {
  const prefs = (search) => withSearch(search, () => ({
    charge: m.readChargeCouplingPref(),
    field: m.readFieldCouplingPref(),
    energy: m.readEnergyCouplingPref()
  }));

  it('every bus defaults to off', () => {
    const none = prefs('');
    assert.ok(!none.charge && !none.field && !none.energy, 'every bus defaults to off');
  });

  it('chargeCoupling=1 does not imply field or energy coupling', () => {
    const c = prefs('?chargeCoupling=1');
    assert.ok(c.charge && !c.field && !c.energy, 'chargeCoupling=1 must not imply field or energy coupling');
  });

  it('field + energy do not imply charge coupling', () => {
    const f = prefs('?fieldCoupling=1&energyCoupling=1');
    assert.ok(!f.charge && f.field && f.energy, 'field + energy must not imply charge coupling');
  });

  it('all three combine', () => {
    const all = prefs('?chargeCoupling=1&fieldCoupling=1&energyCoupling=1');
    assert.ok(all.charge && all.field && all.energy, 'all three combine');
  });

  it('chargeCoupling=0 leaves field alone', () => {
    const zero = prefs('?chargeCoupling=0&fieldCoupling=1');
    assert.ok(!zero.charge && zero.field, 'chargeCoupling=0 wins over nothing and leaves field alone');
  });
});
