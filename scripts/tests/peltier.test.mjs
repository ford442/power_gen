/**
 * Peltier cooler — the resolved leg against the textbook lumped results, on
 * all three backends, plus what only this bench has: the exact Jacobian, the
 * Thomson term, array state in snapshots and the version-1 migration.
 *
 *   1. the four textbook checks — on the native binary
 *      (`sim_core_test --mode peltier-textbook`), the shipped sim_core.wasm
 *      and the TS plant, through one set of assertions:
 *        a. zero load: K·ΔT = S·I·T_c − ½I²R at every current, whose peak over
 *           I/T_c is ΔT_max = Z·T_c²/2 (within 3 %)
 *        b. … reached at I_opt = S·T_c/R
 *        c. a 10 W load: COP = (S·I·T_c − ½I²R − K·ΔT) / (I·(S·ΔT + I·R))
 *           at every current, and steady Q_c is the load
 *        d. energy balance Q_h = Q_c + P_in to 1e-3
 *      and the leg alone at fixed plate temperatures: COP(I) peaks at the
 *      textbook I_φ with the textbook COP_max (native + TS).
 *   2. TS model: exact Jacobian vs differences, Thomson energy closure,
 *      reversal, clamps, setpoint ranges
 *   3. snapshots: the node array round-trips by key, packed and through the
 *      C++ vector; a plantStateVersion-1 snapshot migrates
 *   4. the mesh colours follow the temperatures
 *
 * Usage: npm run test:peltier
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import { ROOT, bundleTs } from '../test-harness.mjs';
import { loadSimCoreFromDisk } from '../lib/sim-core-shim.mjs';

const m = await bundleTs({
  contents: `
    export * as P from './src/devices/core/peltier-plant.ts';
    export * as M from './src/devices/core/peltier-mesh.ts';
    export * as S from './src/session/plant-snapshot.ts';
    export { migratePlantState } from './src/session/plant-snapshot-migrate.ts';
    export { ros23Advance } from './src/renderers/shared/integrate.ts';
    export { PELTIER } from './generated/physics-constants.ts';
    export { PLANT_ODE } from './generated/plant-ode.ts';
    export { DEVICE_SETPOINTS } from './generated/device-catalog.ts';
  `,
  sourcefile: 'peltier-entry.ts'
});
const { P, M, S, PELTIER } = m;

const NATIVE = join(ROOT, 'cpp/build/sim_core_test');
const WASM_DIR = process.env.SIM_CORE_DIR ?? join(ROOT, 'src/wasm/sim-core');
const PELTIER_MODE = 4;

const Sm = PELTIER.seebeckVK * PELTIER.couples;   // module Seebeck, V/K
const R = PELTIER.rInternalOhm;
const K = PELTIER.conductanceWK;
const Z = (Sm * Sm) / (R * K);

/** Sweep currents: drive 0.1 … 1.0, i.e. 0.8 … 8 A. */
const DRIVES = Array.from({ length: 10 }, (_, i) => (i + 1) / 10);
/** 600 s in 0.25 s steps: far past the bench's ~20 s time constants. */
const SETTLE_STEPS = 2400;
const SETTLE_DT = 0.25;

// ── backends ────────────────────────────────────────────────────────────────

/** Steady point of the TS plant. */
function settleTs(drive, loadW, polarity) {
  const s = P.createPeltierPhysicsState();
  s.peltierLoadW = loadW;
  s.peltierPolarity = polarity;
  for (let i = 0; i < SETTLE_STEPS; i++) P.stepPeltierPhysics(s, SETTLE_DT, drive);
  return {
    drive, I: s.peltierCurrent, Tc: s.peltierColdK, Th: s.peltierHotK, dT: s.peltierDeltaT,
    V: s.peltierVoltage, P: s.peltierPowerW, Qc: s.peltierQcW, Qh: s.peltierQhW, cop: s.peltierCOP
  };
}

let wasm = null;
function settleWasm(drive, loadW, polarity) {
  const sim = new wasm.SEGSimulator();
  try {
    sim.setMode(PELTIER_MODE);
    sim.setDrive(drive);
    sim.setPeltierLoadW(loadW);
    sim.setPeltierPolarity(polarity);
    for (let i = 0; i < SETTLE_STEPS; i++) sim.step(SETTLE_DT, 0);
    return {
      drive, I: sim.getPeltierCurrent(), Tc: sim.getPeltierColdK(), Th: sim.getPeltierHotK(), dT: sim.getPeltierDeltaT(),
      V: sim.getPeltierVoltage(), P: sim.getPeltierPowerW(), Qc: sim.getPeltierQcW(), Qh: sim.getPeltierQhW(),
      cop: sim.getPeltierCOP()
    };
  } finally {
    sim.delete();
  }
}

const nativeExists = existsSync(NATIVE);
const nativeRun = nativeExists ? spawnSync(NATIVE, ['--mode', 'peltier-textbook'], { encoding: 'utf8' }) : null;
function nativeRows(tag) {
  const rows = [];
  for (const line of nativeRun?.stdout?.split('\n') ?? []) {
    if (!line.startsWith(`${tag} `)) continue;
    rows.push(Object.fromEntries(line.slice(tag.length + 1).trim().split(/\s+/).map((kv) => {
      const eq = kv.indexOf('=');
      return [kv.slice(0, eq), Number(kv.slice(eq + 1))];
    })));
  }
  return rows;
}

function sweep(settle) {
  return {
    zero: DRIVES.map((d) => settle(d, 0, 1)),
    load: DRIVES.map((d) => settle(d, 10, 1)),
    reverse: settle(0.25, 0, -1)
  };
}

// ── the four checks, backend-independent ────────────────────────────────────

/**
 * `single` backends hold temperatures in float32: one ulp at 270 K is 3e-5 K,
 * which through the 24 W/K junction conductance is ~1 mW of heat. Their heat
 * balances are held to the same 1e-3 with a 5 mW floor.
 */
function textbookChecks(name, data, { single }) {
  const floorW = single ? 5e-3 : 1e-6;

  it(`${name}: (a) zero load — every point on K·ΔT = S·I·T_c − ½I²R; ΔT_max = Z·T_c²/2 within 3 %`, () => {
    assert.equal(data.zero.length, DRIVES.length);
    // Least squares for ΔT/T_c² = a·x − b·x² over x = I/T_c: a = S/K, b = R/2K.
    let sxx = 0, sxxx = 0, sxxxx = 0, sxy = 0, sxxy = 0;
    for (const p of data.zero) {
      const lumped = (Sm * p.I * p.Tc - 0.5 * p.I * p.I * R) / K;
      assert.ok(Math.abs(p.dT - lumped) <= 0.005 * lumped + 0.02, `I = ${p.I} A: ΔT ${p.dT} K vs lumped ${lumped} K`);
      assert.ok(Math.abs(p.Qc) <= 2 * floorW + 1e-4, `I = ${p.I} A: an insulated block still pumps ${p.Qc} W`);
      const x = p.I / p.Tc;
      const y = p.dT / (p.Tc * p.Tc);
      sxx += x * x; sxxx += x ** 3; sxxxx += x ** 4; sxy += x * y; sxxy += x * x * y;
    }
    const det = sxx * sxxxx - sxxx * sxxx;
    const a = (sxy * sxxxx - sxxy * sxxx) / det;
    const b = (sxy * sxxx - sxxy * sxx) / det;
    const peak = (a * a) / (4 * b);
    assert.ok(Math.abs(peak - Z / 2) <= 0.03 * (Z / 2), `peak ΔT/T_c² ${peak} vs Z/2 = ${Z / 2}`);
    // And the grid's own best point is a real ΔT near that bound.
    const best = data.zero.reduce((q, p) => (p.dT / p.Tc ** 2 > q.dT / q.Tc ** 2 ? p : q));
    assert.ok(Math.abs(best.dT - 0.5 * Z * best.Tc ** 2) <= 0.03 * best.dT, `best grid point ΔT ${best.dT} K at T_c ${best.Tc} K`);
    assert.ok(best.dT > 70 && best.dT < 80, `ΔT_max ${best.dT} K is not a 12706-class module's`);
  });

  it(`${name}: (b) the optimum is at I_opt = S·T_c/R`, () => {
    let sxx = 0, sxxx = 0, sxxxx = 0, sxy = 0, sxxy = 0;
    for (const p of data.zero) {
      const x = p.I / p.Tc;
      const y = p.dT / (p.Tc * p.Tc);
      sxx += x * x; sxxx += x ** 3; sxxxx += x ** 4; sxy += x * y; sxxy += x * x * y;
    }
    const det = sxx * sxxxx - sxxx * sxxx;
    const a = (sxy * sxxxx - sxxy * sxxx) / det;
    const b = (sxy * sxxx - sxxy * sxx) / det;
    const xOpt = a / (2 * b);
    assert.ok(Math.abs(xOpt - Sm / R) <= 0.02 * (Sm / R), `fitted I/T_c optimum ${xOpt} vs S/R = ${Sm / R}`);
    // In amperes on this bench: about 5.5 A, between the two grid points that bracket it.
    const best = data.zero.reduce((q, p) => (p.dT / p.Tc ** 2 > q.dT / q.Tc ** 2 ? p : q));
    assert.ok(Math.abs(best.I - (Sm * best.Tc) / R) <= 0.8, `best grid current ${best.I} A vs S·T_c/R = ${(Sm * best.Tc) / R} A`);
  });

  it(`${name}: (c) 10 W load — COP is the lumped expression at every current, and falls as I rises`, () => {
    let last = Infinity;
    for (const p of data.load) {
      const lumped = (Sm * p.I * p.Tc - 0.5 * p.I * p.I * R - K * p.dT) / (p.I * (Sm * p.dT + p.I * R));
      assert.ok(Math.abs(p.cop - lumped) <= 0.01 * lumped + 1e-3, `I = ${p.I} A: COP ${p.cop} vs lumped ${lumped}`);
      assert.ok(Math.abs(p.Qc - 10) <= 1e-3 * 10 + floorW, `I = ${p.I} A: steady Q_c ${p.Qc} W is not the 10 W load`);
      assert.ok(Math.abs(p.cop - p.Qc / p.P) <= 1e-6 + 1e-6 * Math.abs(p.cop), 'COP is Q_c / P_in');
      assert.ok(p.cop < last && p.cop > 0, `COP ${p.cop} did not fall from ${last}`);
      last = p.cop;
    }
    // The load costs temperature: the block is warmer than at zero load, at every current.
    data.load.forEach((p, i) => assert.ok(p.Tc > data.zero[i].Tc + 5, `10 W left the block as cold at ${p.I} A`));
  });

  it(`${name}: (d) energy balance Q_h = Q_c + P_in to 1e-3 at every steady point`, () => {
    for (const p of [...data.zero, ...data.load, data.reverse]) {
      const resid = Math.abs(p.Qh - p.Qc - p.P);
      assert.ok(resid <= 1e-3 * Math.abs(p.Qh) + floorW, `I = ${p.I} A: Q_h ${p.Qh} ≠ Q_c ${p.Qc} + P ${p.P} (residual ${resid} W)`);
      assert.ok(Math.abs(p.P - p.I * p.V) <= 1e-5 * Math.abs(p.P) + 1e-6, 'P_in = I·V');
    }
  });

  it(`${name}: reversing the current heats the load side`, () => {
    const p = data.reverse;
    assert.ok(p.I < 0, `current ${p.I} A`);
    assert.ok(p.Tc > p.Th && p.Tc > PELTIER.ambientK + 50, `load side ${p.Tc} K, sink side ${p.Th} K`);
    assert.ok(p.dT < 0);
  });
}

describe('1. textbook checks on every backend', () => {
  before(async () => {
    wasm = await loadSimCoreFromDisk(WASM_DIR);
  });

  it('native binary exists and its own assertions pass', () => {
    assert.ok(nativeExists, 'cpp/build/sim_core_test missing. Run `npm run wasm:native` first (npm run validate does).');
    assert.equal(nativeRun.status, 0, nativeRun.stdout.split('\n').filter((l) => /FAIL/.test(l)).join('\n'));
    assert.match(nativeRun.stdout, /^peltier\.textbook OK$/m);
  });

  const native = { zero: nativeRows('peltier.zero'), load: nativeRows('peltier.load'), reverse: nativeRows('peltier.reverse')[0] ?? {} };
  if (nativeExists) textbookChecks('native', native, { single: true });

  // The WASM and TS sweeps are built lazily: `before` has to load the module first.
  const lazy = (settle) => {
    let data = null;
    const get = () => (data ??= sweep(settle));
    return { get zero() { return get().zero; }, get load() { return get().load; }, get reverse() { return get().reverse; } };
  };
  textbookChecks('wasm', lazy((d, l, p) => settleWasm(d, l, p)), { single: true });
  textbookChecks('ts', lazy(settleTs), { single: false });

  it('native ≈ wasm ≈ ts at every steady point (same plant, three builds)', () => {
    const w = sweep(settleWasm);
    const t = sweep(settleTs);
    const rows = (d) => [...d.zero, ...d.load, d.reverse];
    rows(native).forEach((n, i) => {
      for (const [other, name] of [[rows(w)[i], 'wasm'], [rows(t)[i], 'ts']]) {
        for (const key of ['Tc', 'Th', 'V', 'P', 'Qh']) {
          assert.ok(Math.abs(n[key] - other[key]) <= 2e-4 * Math.abs(n[key]) + 1e-3,
            `point ${i} ${key}: native ${n[key]} vs ${name} ${other[key]}`);
        }
        assert.ok(Math.abs(n.Qc - other.Qc) <= 1e-2, `point ${i} Qc: native ${n.Qc} vs ${name} ${other.Qc}`);
      }
    });
  });

  /** Leg alone, plates held: COP(I) at fixed ΔT, by relaxing the TS plant with enormous end capacities. */
  function legCopTs(I, Tc, Th) {
    const params = { ...PELTIER, plateHeatCapJK: 1e12, coldBlockHeatCapJK: 1e12, sinkHeatCapJK: 1e12 };
    const plant = P.makePeltierPlant(params);
    const n = params.legCells + 4;
    const x = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      x[k] = k <= 1 ? Tc : k >= n - 2 ? Th : Tc + ((Th - Tc) * (k - 2 + 0.5)) / params.legCells;
    }
    const u = { currentA: I, loadW: 0 };
    const tol = { rtol: m.PLANT_ODE.peltier.rtol, atol: m.PLANT_ODE.peltier.atol, hMax: 2 };
    assert.ok(m.ros23Advance(plant, x, u, 8, tol, { h: 0, errOld: 1e-4 }).ok);
    assert.ok(Math.abs(x[1] - Tc) < 1e-6 && Math.abs(x[n - 2] - Th) < 1e-6, 'a held plate moved');
    return P.peltierOutputs(params, x, u).cop;
  }

  it('leg alone at fixed plates (270 K / 300 K): COP(I) peaks at the textbook I_φ and COP_max — native and ts', () => {
    const Tc = 270, Th = 300;
    const mm = Math.sqrt(1 + Z * 0.5 * (Tc + Th));
    const iPhi = (Sm * (Th - Tc)) / (R * (mm - 1));
    const copMax = (Tc / (Th - Tc)) * (mm - Th / Tc) / (mm + 1);
    const nativeLeg = nativeRows('peltier.leg');
    assert.equal(nativeLeg.length, 31);
    const tsLeg = nativeLeg.map((r) => ({ I: r.I, cop: legCopTs(r.I, Tc, Th) }));
    for (const [name, leg] of [['native', nativeLeg], ['ts', tsLeg]]) {
      const best = leg.reduce((q, p) => (p.cop > q.cop ? p : q));
      assert.ok(Math.abs(best.I - iPhi) <= 0.25, `${name}: COP peaks at ${best.I} A, textbook ${iPhi} A`);
      assert.ok(Math.abs(best.cop - copMax) <= 0.02 * copMax, `${name}: COP_max ${best.cop}, textbook ${copMax}`);
      // One hump: rising to the peak, falling after it.
      const at = leg.indexOf(best);
      for (let i = 1; i < leg.length; i++) {
        assert.ok(i <= at ? leg[i].cop >= leg[i - 1].cop - 1e-3 : leg[i].cop <= leg[i - 1].cop + 1e-3, `${name}: COP(I) is not unimodal at ${leg[i].I} A`);
      }
    }
    nativeLeg.forEach((r, i) => assert.ok(Math.abs(r.cop - tsLeg[i].cop) <= 5e-3, `leg COP at ${r.I} A: native ${r.cop} vs ts ${tsLeg[i].cop}`));
  });
});

describe('2. TS model', () => {
  const n = PELTIER.legCells + 4;
  const profile = (seed = 1) => {
    let s = seed;
    const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
    return Float64Array.from({ length: n }, (_, i) => 250 + i * 3 + rnd() * 4);
  };

  it('peltierJacobian is ∂(peltierDerivs)/∂T — constant properties and with the Thomson term on', () => {
    for (const slope of [0, 1.5e-6]) {
      const params = { ...PELTIER, seebeckSlopeVK2: slope };
      for (const I of [-3, 0, 4.5]) {
        const u = { currentA: I, loadW: 6 };
        const x = profile(7);
        const J = new Float64Array(n * n);
        P.peltierJacobian(params, x, u, J);
        const f0 = new Float64Array(n);
        const f1 = new Float64Array(n);
        for (let j = 0; j < n; j++) {
          const xp = x.slice();
          const xm = x.slice();
          xp[j] += 1e-3;
          xm[j] -= 1e-3;
          P.peltierDerivs(params, xp, u, f1);
          P.peltierDerivs(params, xm, u, f0);
          for (let i = 0; i < n; i++) {
            const fd = (f1[i] - f0[i]) / 2e-3;
            assert.ok(Math.abs(J[i * n + j] - fd) <= 1e-6 * Math.abs(fd) + 1e-7, `slope ${slope}, I ${I}: J[${i}][${j}] ${J[i * n + j]} vs ${fd}`);
            if (Math.abs(i - j) > 1) assert.equal(J[i * n + j], 0, 'the chain is tridiagonal');
          }
        }
      }
    }
  });

  it('the discrete model conserves energy in a transient: Σ C·dT/dt = load + P_in − sink loss', () => {
    const u = { currentA: 3.7, loadW: 4 };
    const x = profile(3);
    const d = new Float64Array(n);
    P.peltierDerivs(PELTIER, x, u, d);
    const cap = (i) => (i === 0 ? PELTIER.coldBlockHeatCapJK : i === n - 1 ? PELTIER.sinkHeatCapJK
      : i === 1 || i === n - 2 ? PELTIER.plateHeatCapJK : PELTIER.legHeatCapJK / PELTIER.legCells);
    let stored = 0;
    for (let i = 0; i < n; i++) stored += cap(i) * d[i];
    const y = P.peltierOutputs(PELTIER, x, u);
    const sinkLoss = PELTIER.sinkWK * (x[n - 1] - PELTIER.ambientK);
    assert.ok(Math.abs(stored - (u.loadW + y.powerW - sinkLoss)) < 1e-9, `stored ${stored} W`);
  });

  it('Thomson term on: S varies with T, the EMF is ∫S dT, energy still closes at steady state', () => {
    const params = { ...PELTIER, seebeckSlopeVK2: 1.5e-6 };
    const plant = P.makePeltierPlant(params);
    const x = new Float64Array(n).fill(PELTIER.ambientK);
    const u = { currentA: 4, loadW: 5 };
    const tol = { rtol: 1e-7, atol: Array(n).fill(1e-7), hMax: 2 };
    const settle = (pl, state) => {
      const st = { h: 0, errOld: 1e-4 };
      for (let i = 0; i < 2400; i++) assert.ok(m.ros23Advance(pl, state, u, 0.25, tol, st).ok);
    };
    settle(plant, x);
    const y = P.peltierOutputs(params, x, u);
    assert.ok(Math.abs(y.qhW - y.qcW - y.powerW) < 1e-5, `residual ${y.qhW - y.qcW - y.powerW} W`);
    assert.ok(Math.abs(y.qcW - 5) < 1e-5, `steady Q_c ${y.qcW} W`);
    // It is not a no-op: the same run without the slope lands elsewhere.
    const x0 = new Float64Array(n).fill(PELTIER.ambientK);
    settle(P.makePeltierPlant(PELTIER), x0);
    assert.ok(Math.abs(x0[1] - x[1]) > 0.5, `cold plate ${x[1]} K with the slope, ${x0[1]} K without`);
  });

  it('drive sets |I|, polarity its sign, the load is clamped to the catalog range', () => {
    const s = P.createPeltierPhysicsState();
    P.stepPeltierPhysics(s, 1 / 60, 0.5);
    assert.equal(s.peltierCurrent, 0.5 * PELTIER.iMaxA);
    s.peltierPolarity = -1;
    P.stepPeltierPhysics(s, 1 / 60, 2);
    assert.equal(s.peltierCurrent, -PELTIER.iMaxA, 'drive clamps at 1');
    const sp = m.DEVICE_SETPOINTS.filter((d) => d.deviceId === 'peltier');
    assert.deepEqual(sp.map((d) => d.stateKey).sort(), ['peltierLoadW', 'peltierPolarity']);
    assert.equal(sp.find((d) => d.stateKey === 'peltierLoadW').max, PELTIER.loadMaxW);
    // A load far past the slider's range is the range's end, not a furnace.
    const a = P.createPeltierPhysicsState();
    const b = P.createPeltierPhysicsState();
    a.peltierLoadW = 1e6;
    b.peltierLoadW = PELTIER.loadMaxW;
    for (let i = 0; i < 120; i++) { P.stepPeltierPhysics(a, 1 / 60, 0.3); P.stepPeltierPhysics(b, 1 / 60, 0.3); }
    assert.deepEqual(a.peltierNodesK, b.peltierNodesK);
  });

  it('a reversed full current into the insulated block stops at the clamp, finite', () => {
    const s = P.createPeltierPhysicsState();
    s.peltierPolarity = -1;
    for (let i = 0; i < 2400; i++) P.stepPeltierPhysics(s, 0.25, 1);
    const hi = PELTIER.ambientK + PELTIER.clampAboveAmbientK;
    assert.ok(s.peltierNodesK.every((t) => Number.isFinite(t) && t <= hi + 1e-9), `max ${Math.max(...s.peltierNodesK)} K`);
    assert.ok(Math.abs(s.peltierNodesK[0] - hi) < 1e-6, 'the block sits on the clamp');
    assert.equal(s.energyLevel, 1);
  });

  it('a state with no profile (or the wrong length) starts from ambient instead of throwing', () => {
    for (const nodes of [undefined, [300, 301]]) {
      const s = { peltierNodesK: nodes };
      P.stepPeltierPhysics(s, 1 / 60, 0.4);
      assert.equal(s.peltierNodesK.length, n);
      assert.ok(s.peltierNodesK.every(Number.isFinite));
    }
  });

  it('figure of merit Z = S²/RK is a 12706-class module', () => {
    assert.ok(Math.abs(P.peltierFigureOfMerit() - Z) < 1e-15);
    assert.ok(Z > 2.2e-3 && Z < 2.8e-3, `Z = ${Z} /K`);
  });
});

describe('3. snapshots: array state and the version-1 migration', () => {
  const run = (frames, drive = 0.55) => {
    const s = P.createPeltierPhysicsState();
    s.peltierLoadW = 3;
    for (let i = 0; i < frames; i++) P.stepPeltierPhysics(s, 1 / 60, drive);
    return s;
  };

  it('the node array is saved element by element and restores into a fresh plant bit for bit', () => {
    const a = run(200);
    const keys = S.deviceStateKeys('peltier');
    assert.ok(keys.includes('peltierNodesK[0]') && keys.includes('peltierNodesK[27]') && !keys.includes('peltierNodesK'));
    const saved = S.saveDeviceState('peltier', a);
    assert.equal(Object.keys(saved).length, keys.length);
    const b = P.createPeltierPhysicsState();
    const written = S.loadDeviceState('peltier', b, JSON.parse(JSON.stringify(saved)));
    assert.equal(written.length, keys.length);
    assert.deepEqual(b.peltierNodesK, a.peltierNodesK);
    assert.notEqual(b.peltierNodesK, a.peltierNodesK, 'the plants must not share one array');
    for (let i = 0; i < 300; i++) { P.stepPeltierPhysics(a, 1 / 60, 0.55); P.stepPeltierPhysics(b, 1 / 60, 0.55); }
    assert.deepEqual(b.peltierNodesK, a.peltierNodesK);
    assert.equal(b.peltierQcW, a.peltierQcW);
  });

  it('packed vector round trip; a NaN slot leaves that node alone', () => {
    const a = run(90);
    const packed = S.packDeviceState('peltier', a);
    assert.equal(packed.length, S.deviceStateKeys('peltier').length);
    const b = P.createPeltierPhysicsState();
    packed[S.deviceStateKeys('peltier').indexOf('peltierNodesK[5]')] = NaN;
    S.loadDeviceState('peltier', b, packed);
    assert.equal(b.peltierNodesK[5], PELTIER.ambientK);
    assert.equal(b.peltierNodesK[6], a.peltierNodesK[6]);
  });

  it('keys ⇄ C++ vector carries all 28 nodes', () => {
    const a = run(150);
    const keyed = S.saveDeviceState('peltier', a);
    const size = S.DEVICE_STATE_LAYOUT.peltier.cppSize;
    const cpp = S.cppStateFromKeys('peltier', keyed, new Float32Array(size), { time: 2.5, drive: 0.55 });
    assert.equal(cpp.length, size);
    const back = S.keysFromCppState('peltier', cpp);
    for (let i = 0; i < 28; i++) {
      assert.equal(back[`peltierNodesK[${i}]`], Math.fround(a.peltierNodesK[i]));
    }
    assert.equal(back.peltierLoadW, 3);
  });

  /** What `window.lab.captureSnapshot()` wrote for this bench before the cooler existed. */
  const v1 = () => ({
    format: 'seg-plant-snapshot',
    version: 1,
    layoutHash: 0x1d82ad14,
    catalogHash: 'feedfacecafe',
    backend: 'wasm',
    focus: 'peltier',
    t: 42,
    seed: null,
    config: {},
    devices: {
      peltier: {
        peltierHotK: 371.5, peltierColdK: 301.25, peltierDeltaT: 70.25, peltierVoltage: 1.96,
        peltierCurrent: 0.785, peltierPowerW: 1.54, peltierCOP: 0.03, energyLevel: 0.878
      }
    },
    wasm: { mode: PELTIER_MODE, values: [42, 0.85, 371.5, 301.25, 70.25, 1.96, 0.785, 1.54, 0.03, 0.85] }
  });

  it('a version-1 snapshot loads: plates kept, leg seeded, stale C++ vector dropped, a warning says so', () => {
    const { snapshot, errors, warnings } = S.parsePlantSnapshot(v1());
    assert.deepEqual(errors, []);
    assert.equal(snapshot.plantStateVersion, S.PLANT_STATE_VERSION);
    assert.equal(snapshot.wasm, undefined, 'the two-node C++ vector cannot be loaded into the 28-node plant');
    assert.ok(warnings.some((w) => /peltier: snapshot predates the resolved cooler/.test(w)), warnings.join(' | '));
    const s = P.createPeltierPhysicsState();
    S.loadDeviceState('peltier', s, snapshot.devices.peltier);
    assert.equal(s.peltierHotK, 371.5);
    assert.equal(s.peltierColdK, 301.25);
    const nodes = s.peltierNodesK;
    assert.equal(nodes[0], 301.25);
    assert.equal(nodes[1], 301.25);
    assert.equal(nodes[26], 371.5);
    assert.equal(nodes[27], 371.5);
    for (let i = 3; i < 26; i++) assert.ok(nodes[i] > nodes[i - 1], 'leg cells rise monotonically from cold to hot');
    assert.ok(Math.abs(nodes[2] - (301.25 + (70.25 * 0.5) / 24)) < 1e-9);
    assert.equal(s.peltierCurrent, 0, 'generator-era electrical outputs are reset');
    // And it runs on from there.
    for (let i = 0; i < 600; i++) P.stepPeltierPhysics(s, 1 / 60, 0.5);
    assert.ok(s.peltierNodesK.every(Number.isFinite));
    assert.ok(s.peltierColdK < 301.25, 'the cooler pulls the old cold plate down');
    // The migrated keys cross-load into the C++ plant's vector.
    const cpp = S.cppStateFromKeys('peltier', snapshot.devices.peltier, new Float32Array(S.DEVICE_STATE_LAYOUT.peltier.cppSize));
    assert.equal(S.keysFromCppState('peltier', cpp)['peltierNodesK[27]'], 371.5);
  });

  it('a current snapshot is not migrated; other devices in an old one are untouched', () => {
    const cur = v1();
    cur.plantStateVersion = S.PLANT_STATE_VERSION;
    cur.layoutHash = S.PLANT_STATE_LAYOUT_HASH;
    cur.devices.peltier = S.saveDeviceState('peltier', run(30));
    cur.wasm = undefined;
    const parsed = S.parsePlantSnapshot(cur);
    assert.deepEqual(parsed.warnings, []);
    assert.deepEqual(parsed.snapshot.devices.peltier, cur.devices.peltier);

    const old = v1();
    old.devices.mhd = { mhdFlowU: 1.5, mhdBFieldT: 0.9 };
    const before = structuredClone(old.devices.mhd);
    assert.deepEqual(m.migratePlantState(old.devices, 1), ['peltier']);
    assert.deepEqual(old.devices.mhd, before);
    assert.deepEqual(m.migratePlantState(old.devices, 1), [], 'migrating twice is a no-op');
    assert.deepEqual(m.migratePlantState({ mhd: before }, 1), [], 'no peltier entry, nothing to do');
  });

  it('a snapshot from a newer plant state version is read with a warning, not migrated backwards', () => {
    const future = v1();
    future.plantStateVersion = S.PLANT_STATE_VERSION + 3;
    const { snapshot, warnings } = S.parsePlantSnapshot(future);
    assert.ok(snapshot);
    assert.ok(warnings.some((w) => /newer than/.test(w)));
    assert.equal('peltierNodesK[0]' in snapshot.devices.peltier, false);
  });
});

describe('4. the mesh follows the temperatures', () => {
  it('three bodies: sink, module, block — coloured by their own nodes', () => {
    const s = P.createPeltierPhysicsState();
    for (let i = 0; i < 2400; i++) P.stepPeltierPhysics(s, 0.25, 0.5);
    const t = M.peltierMeshTemps(s);
    assert.equal(t.sinkK, s.peltierNodesK[27]);
    assert.equal(t.blockK, s.peltierNodesK[0]);
    assert.ok(t.blockK < PELTIER.ambientK - 40 && t.sinkK > PELTIER.ambientK + 5);
    const cyl = M.buildPeltierMesh(t).cylinders();
    assert.equal(cyl.length, 3);
    const [sink, , block] = cyl;
    // packInstance: [x, y, z, role, qx, qy, qz, qw, r, g, b, emissive]
    assert.ok(sink[1] < 0 && block[1] > 0, 'sink below, block above');
    assert.ok(block[10] > block[8], 'a cold block is blue');
    assert.ok(sink[8] > sink[10], 'a warm sink is red');
  });

  it('reversed: the block turns red — nothing is painted hot or cold', () => {
    const s = P.createPeltierPhysicsState();
    s.peltierPolarity = -1;
    for (let i = 0; i < 400; i++) P.stepPeltierPhysics(s, 0.25, 0.25);
    const [, , block] = M.buildPeltierMesh(M.peltierMeshTemps(s)).cylinders();
    assert.ok(block[8] > block[10], `block colour ${block.slice(8, 11)}`);
  });

  it('air parcels: up beside a warm body, down beside a cold one, still at ambient; reversal reverses them', () => {
    const drift = (sinkK, blockK) => {
      const nodes = new Array(28).fill(PELTIER.ambientK);
      nodes[27] = sinkK;
      nodes[0] = blockK;
      const s = { peltierNodesK: nodes };
      M.advancePeltierAir(s, 0);
      // Unwrapped drift over 1 s in 60 frames.
      let sink = 0, block = 0, ps = 0, pb = 0;
      for (let f = 1; f <= 60; f++) {
        const [a, b] = M.advancePeltierAir(s, f / 60);
        sink += ((a - ps + 1.5) % 1) - 0.5;
        block += ((b - pb + 1.5) % 1) - 0.5;
        ps = a; pb = b;
      }
      return [sink, block];
    };
    const [upSink, downBlock] = drift(PELTIER.ambientK + 20, PELTIER.ambientK - 45);
    assert.ok(upSink > 0.1 && downBlock < -0.2, `cooling: sink ${upSink}, block ${downBlock}`);
    const [downSink, upBlock] = drift(PELTIER.ambientK - 5, PELTIER.ambientK + 60);
    assert.ok(downSink < 0 && upBlock > 0.2, `reversed: sink ${downSink}, block ${upBlock}`);
    assert.deepEqual(drift(PELTIER.ambientK, PELTIER.ambientK), [0, 0]);
    // √|ΔT|: four times the temperature difference, twice the speed.
    const [slow] = drift(PELTIER.ambientK + 10, PELTIER.ambientK);
    const [fast] = drift(PELTIER.ambientK + 40, PELTIER.ambientK);
    assert.ok(Math.abs(fast / slow - 2) < 1e-6, `ratio ${fast / slow}`);
    // Idempotent within a frame.
    const s = { peltierNodesK: new Array(28).fill(PELTIER.ambientK + 30) };
    M.advancePeltierAir(s, 1);
    const a = M.advancePeltierAir(s, 1.016);
    assert.deepEqual(M.advancePeltierAir(s, 1.016), a);
  });

  it('ambient is neutral grey; the ramp saturates 60 K below and 80 K above', () => {
    assert.deepEqual(M.peltierTempColor(PELTIER.ambientK), [0.5, 0.52, 0.55]);
    assert.deepEqual(M.peltierTempColor(PELTIER.ambientK - 200), M.peltierTempColor(PELTIER.ambientK - 60));
    assert.deepEqual(M.peltierTempColor(PELTIER.ambientK + 500), M.peltierTempColor(PELTIER.ambientK + 80));
    assert.deepEqual(M.peltierMeshTemps(null), { sinkK: PELTIER.ambientK, moduleK: PELTIER.ambientK, blockK: PELTIER.ambientK });
  });
});
