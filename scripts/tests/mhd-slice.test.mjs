/**
 * The MHD duct slice without a GPU (docs/FLUIDS.md → MHD duct → The slice):
 * the lattice's units and layout, the uniform block against the WGSL, and
 * the physics on the CPU twin — the Hartmann profile in the gap slice, the
 * wall friction the plant derives, and the mid-plane's electrodes. The WGSL
 * itself runs in scripts/tests/gpu/golden-mhd-slice.test.mjs.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ROOT, bundleTs } from '../test-harness.mjs';

const M = await bundleTs({
  contents: `
    export * from './src/fluids/mhd-slice.ts';
    export * from './src/fluids/mhd-slice-cpu.ts';
    export * as H from './src/physics/hartmann.ts';
    export * as D from './src/physics/mhd-duct.ts';
    export { MHD } from './generated/physics-constants.ts';
  `,
  sourcefile: 'mhd-slice-entry.ts'
});
const { H, D, MHD } = M;
const wgsl = readFileSync(join(ROOT, 'src/shaders/common/mhd-slice.wgsl'), 'utf8');

describe('mhd slice: the uniform block and the lattice match the WGSL', () => {
  it('MhdSliceParams: twelve words and eight loads, in the order the host packs', () => {
    const body = /struct MhdSliceParams \{([\s\S]*?)\n\}/.exec(wgsl)[1];
    const fields = [...body.matchAll(/^\s*(\w+): (.+),$/gm)].map((m) => [m[1], m[2]]);
    const names = fields.map((f) => f[0]);
    assert.deepEqual(names, ['nx', 'ny', 'flags', 'segments', 'omegaPlus', 'omegaMinus', 'inletU', 'gUniform', 'lorentz', 'dragUniform', 'sorOmega', 'circuitGain', 'segLoad']);
    names.slice(0, 12).forEach((n, k) => assert.equal(M.MHD_SLICE_F[n], k, `${n} at word ${k}`));
    assert.equal(fields[12][1], 'array<vec4f, 2>');
    assert.equal(M.MHD_SLICE_F.segLoad, 12);
    assert.equal(M.MHD_SLICE_PARAMS_BYTES, (12 + 8) * 4);
    assert.equal(M.MHD_SLICE_MAX_SEGMENTS, Number(/MHD_MAX_SEGMENTS: u32 = (\d+)u/.exec(wgsl)[1]));
    assert.equal(M.MHD_SLICE_FLAG_PERIODIC, Number(/MHD_FLAG_PERIODIC: u32 = (\d+)u/.exec(wgsl)[1]));
    assert.equal(M.MHD_SLICE_FLAG_POTENTIAL, Number(/MHD_FLAG_POTENTIAL: u32 = (\d+)u/.exec(wgsl)[1]));
  });

  it('the velocity set: same order, weights sum to one, opposites are opposite', () => {
    const list = (name) => /const NAME = array<[^>]+>\(([\s\S]*?)\);/.exec(wgsl.replace(name, 'NAME'))[1].split(',').map((x) => Number(x.replace('u', '')));
    assert.deepEqual(list('D2Q9_CX'), [...M.D2Q9_CX]);
    assert.deepEqual(list('D2Q9_CY'), [...M.D2Q9_CY]);
    assert.deepEqual(list('D2Q9_OPP'), [...M.D2Q9_OPP]);
    list('D2Q9_W').forEach((w, q) => assert.ok(Math.abs(w - M.D2Q9_W[q]) < 1e-7));
    assert.ok(Math.abs(M.D2Q9_W.reduce((s, w) => s + w, 0) - 1) < 1e-15);
    for (let q = 0; q < 9; q++) {
      assert.equal(M.D2Q9_CX[M.D2Q9_OPP[q]], -M.D2Q9_CX[q] || 0);
      assert.equal(M.D2Q9_CY[M.D2Q9_OPP[q]], -M.D2Q9_CY[q] || 0);
    }
  });

  it('packs what it is given', () => {
    const c = M.mhdSliceConfig({ bFieldT: 0.6, flowU: 1.9 });
    const buf = M.packMhdSliceParams(c);
    const f = new Float32Array(buf);
    const u = new Uint32Array(buf);
    assert.equal(buf.byteLength, 80);
    assert.deepEqual([u[0], u[1], u[2], u[3]], [256, 40, M.MHD_SLICE_FLAG_POTENTIAL, 4]);
    assert.ok(Math.abs(f[M.MHD_SLICE_F.inletU] - 1.9 / 31.25) < 1e-7);
    assert.ok(Math.abs(f[M.MHD_SLICE_F.lorentz] - c.lorentz) < 1e-7);
    for (let k = 0; k < 4; k++) assert.ok(Math.abs(f[M.MHD_SLICE_F.segLoad + k] / c.segLoad[k] - 1) < 1e-6);
  });
});

describe('mhd slice: the mid-plane is the bench, to scale', () => {
  const layout = M.mhdSliceLayout();
  const units = M.mhdSliceUnits(1);

  it('square 2.5 mm cells: the 0.1 m width and 0.64 m of length, the poles and electrodes over the middle 0.4 m', () => {
    assert.ok(Math.abs(units.cellM - 0.0025) < 1e-12);
    assert.equal(M.MHD_SLICE_GRID.nx * units.cellM, 0.64);
    assert.equal(layout.poleEnd - layout.poleStart, MHD.lengthM / units.cellM);
    assert.equal(layout.poleStart, M.MHD_SLICE_GRID.nx - layout.poleEnd, 'centred');
    assert.equal(layout.electrodes.length, 4);
    let last = layout.poleStart;
    for (const e of layout.electrodes) {
      assert.ok(e.start >= last && e.start + e.cells <= layout.poleEnd, 'electrodes sit under the poles, in order');
      last = e.start + e.cells + M.MHD_SLICE_ELECTRODES.gapCells;
    }
  });

  it('the field is full under the poles and gone a few cells outside them', () => {
    const mid = (layout.poleStart + layout.poleEnd) >> 1;
    assert.ok(M.mhdSliceFieldShape(mid, layout) > 0.999999);
    assert.ok(Math.abs(M.mhdSliceFieldShape(layout.poleStart - 0.5, layout) - 0.5) < 1e-6, 'half at the edge of the pole face');
    assert.ok(M.mhdSliceFieldShape(layout.poleStart - 16, layout) < 1e-3);
    assert.ok(M.mhdSliceFieldShape(0, layout) < 1e-9);
  });

  it('units: the step, the Lorentz and wall-drag rates per step, a matched load per segment', () => {
    const c = M.mhdSliceConfig({ bFieldT: 1, flowU: 1.44 });
    assert.ok(Math.abs(units.stepS - 8e-5) < 1e-12);
    assert.ok(Math.abs(c.lorentz - (MHD.sigmaSm / MHD.rhoKgM3) * units.stepS) < 1e-9);
    const mid = (layout.poleStart + layout.poleEnd) >> 1;
    assert.ok(Math.abs(c.columns[mid * 4 + 1] - D.mhdFrictionRate(D.mhdHartmannNumber(1)) * units.stepS) < 1e-8, 'the plant\'s wall friction, per step');
    assert.ok(Math.abs(c.columns[1] - D.mhdFrictionRate(0) * units.stepS) < 1e-8, 'Poiseuille friction outside the field');
    // Each segment's load matches the fluid's resistance under it.
    layout.electrodes.forEach((e, k) => {
      const fluid = M.mhdSliceSegmentOhm(e.cells) * MHD.sigmaSm * 2 * MHD.halfGapM;
      assert.ok(Math.abs(c.segLoad[k] / fluid - 1) < 1e-9);
      assert.ok(Math.abs(fluid - M.MHD_SLICE_GRID.ny / e.cells) < 1e-9, 'w / L_k in cells');
    });
    assert.equal(M.mhdSliceConfig({ bFieldT: 1, flowU: 1, rLoadOhm: Infinity }).segLoad[0], M.MHD_SLICE_OPEN_LOAD);
    assert.equal(M.mhdSliceConfig({ bFieldT: 1, flowU: 99 }).inletU, M.MHD_SLICE_MAX_INLET, 'the inlet is capped');
    assert.equal(M.mhdSliceConfig({ bFieldT: Number.NaN, flowU: Number.NaN }).inletU, 0);
    // The lattice's own lateral viscosity is declared, and it is not the fluid's.
    assert.ok(units.lateralViscosityM2s / MHD.nuM2s > 1000);
    assert.ok(M.mhdSliceBytes(M.MHD_SLICE_GRID) < 1.2 * 1024 * 1024, `${M.mhdSliceBytes(M.MHD_SLICE_GRID)} B on the GPU`);
  });
});

describe('mhd slice: the gap slice settles on the Hartmann profile (CPU twin)', () => {
  const settle = (ha, o, steps) => {
    const cfg = M.mhdGapConfig(ha, o);
    const s = new M.MhdSliceCpu(cfg);
    const m0 = s.mass();
    s.step(steps);
    const got = s.profile(cfg.nx >> 1);
    const want = Array.from(got, (_, j) => H.hartmannProfile((j + 0.5 - cfg.ny / 2) / (cfg.ny / 2), ha));
    const mean = got.reduce((a, v) => a + v, 0) / cfg.ny;
    const wantMean = want.reduce((a, v) => a + v, 0) / cfg.ny;
    let num = 0;
    let den = 0;
    for (let j = 0; j < cfg.ny; j++) {
      num += (got[j] / mean - want[j] / wantMean) ** 2;
      den += (want[j] / wantMean) ** 2;
    }
    return { cfg, mean, l2: Math.sqrt(num / den), drift: Math.abs(s.mass() / m0 - 1) / (steps / 1000) };
  };

  for (const [ha, o, steps] of [[0, { ny: 32 }, 8000], [5, { ny: 48 }, 7000], [20, {}, 3000]]) {
    it(`Ha = ${ha}: L2 under 2 %, the analysis's mean speed, mass kept`, () => {
      const r = settle(ha, o, steps);
      console.log(`  Ha ${ha} on ${r.cfg.ny} nodes: L2 ${r.l2.toExponential(2)}, speed ${(r.mean / M.mhdGapSettledSpeed(r.cfg, ha)).toFixed(4)} of the analysis, mass ${r.drift.toExponential(1)} per 1000 steps`);
      assert.ok(r.l2 < 0.02, `L2 ${r.l2}`);
      assert.ok(Math.abs(r.mean / M.mhdGapSettledSpeed(r.cfg, ha) - 1) < 0.01);
      assert.ok(r.drift < 1e-5);
    });
  }

  it('the wall friction the plant uses is the one the lattice has: (ν/a²)·Φ(Ha) within 1 % at Ha = 5, 3 % at 20', () => {
    // At Ha = 20 friction is a twentieth of the drag it is found as the remainder of, and the
    // Hartmann layer is 1.6 cells thick: a 0.1 % error in the speed is 2.4 % of Φ.
    for (const [ha, tol] of [[5, 0.01], [20, 0.03]]) {
      const r = settle(ha, ha === 5 ? { ny: 48 } : {}, ha === 5 ? 7000 : 3000);
      const a = r.cfg.ny / 2;
      const nu = (1 / r.cfg.omegaPlus - 0.5) / 3;
      // Steady: push = (drag + friction)·ū, so the lattice's friction rate is push/ū − drag.
      const friction = r.cfg.gUniform / r.mean - r.cfg.dragUniform;
      const phi = friction / (nu / (a * a));
      assert.ok(Math.abs(phi / H.hartmannWallShear(ha) - 1) < tol, `Ha ${ha}: Φ from the lattice ${phi}, analysis ${H.hartmannWallShear(ha)}`);
    }
  });
});

describe('mhd slice: the mid-plane — electrodes, loads and the field\'s edges (CPU twin, half resolution)', () => {
  const GRID = { nx: 128, ny: 20 };
  const input = { bFieldT: 1, flowU: 1.44 };
  const units = M.mhdSliceUnits(input.bFieldT, MHD, GRID.ny);
  const layout = M.mhdSliceLayout(MHD, GRID.nx, GRID.ny);
  const run = (extra, steps = 3000) => {
    const cfg = M.mhdSliceConfig({ ...input, ...extra }, MHD, GRID);
    const s = new M.MhdSliceCpu(cfg);
    s.step(steps);
    return s;
  };
  const meanSpeed = (s, column) => s.profile(column).reduce((a, v) => a + v, 0) / s.ny;
  const loaded = run({});
  const open = run({ rLoadOhm: Infinity });
  const plantOpenV = input.bFieldT * input.flowU * MHD.widthM;
  const plantA = plantOpenV / (2 * MHD.rLoadOhm);

  it('stays finite, symmetric about the centre line, and carries the plant\'s flow', () => {
    for (const s of [loaded, open]) {
      assert.ok(s.f.every(Number.isFinite) && s.phi.every(Number.isFinite));
      const mid = (layout.poleStart + layout.poleEnd) >> 1;
      const p = s.profile(mid);
      for (let j = 0; j < s.ny / 2; j++) assert.ok(Math.abs(p[j] - p[s.ny - 1 - j]) < 1e-3 * s.config.inletU, `row ${j}`);
      // To 5 %: the lattice's own friction on the side walls is not in the balance the pump's
      // body force makes, so the density falls 2–4 % along the duct and the speed rises to match.
      for (const column of [4, layout.poleStart, mid, layout.poleEnd, GRID.nx - 5]) {
        assert.ok(Math.abs(meanSpeed(s, column) / s.config.inletU - 1) < 0.05, `column ${column}: mean ${meanSpeed(s, column) / s.config.inletU} of the inflow`);
      }
    }
  });

  it('open circuit: no current, and the middle pairs read nearly B·ū·w — the end pairs less', () => {
    const v = open.voltages().map((x) => x * units.volts);
    const i = open.currents().map((x) => x * units.amps);
    console.log(`  open: ${v.map((x) => x.toFixed(4)).join(', ')} V against B·ū·w = ${plantOpenV.toFixed(4)} V`);
    for (const a of i) assert.ok(Math.abs(a) < 0.02 * plantA, `${a} A on open circuit`);
    for (const k of [1, 2]) assert.ok(v[k] / plantOpenV > 0.9 && v[k] / plantOpenV < 1.03, `pair ${k}: ${v[k]} V`);
    for (const k of [0, 3]) assert.ok(v[k] < v[1] && v[k] / plantOpenV > 0.7, `end pair ${k}: ${v[k]} V`);
  });

  it('matched loads: about half the open voltage, and less current than the plant\'s one ideal pair — what leaks round the ends', () => {
    const v = loaded.voltages().map((x) => x * units.volts);
    const i = loaded.currents().map((x) => x * units.amps);
    const total = i.reduce((a, x) => a + x, 0);
    console.log(`  loaded: ${v.map((x) => x.toFixed(4)).join(', ')} V, ${i.map((x) => x.toFixed(0)).join(' + ')} = ${total.toFixed(0)} A against the plant's ${plantA.toFixed(0)} A`);
    const openV = open.voltages().map((x) => x * units.volts);
    for (let k = 0; k < 4; k++) {
      assert.ok(v[k] / openV[k] > 0.4 && v[k] / openV[k] < 0.62, `pair ${k}: ${v[k]} V loaded, ${openV[k]} V open`);
      assert.ok(i[k] > 0);
    }
    assert.ok(total < plantA && total > 0.75 * plantA, `${total} A against ${plantA} A`);
    // Ohm's law on each load.
    layout.electrodes.forEach((e, k) => {
      const ohm = MHD.rLoadOhm * ((layout.poleEnd - layout.poleStart) / e.cells);
      assert.ok(Math.abs(v[k] / (i[k] * ohm) - 1) < 0.02, `pair ${k}: V ${v[k]}, I·R ${i[k] * ohm}`);
    });
  });

  it('where the flow enters the field it is thrown to the side walls: an M-shaped profile', () => {
    const p = loaded.profile(layout.poleStart + 1);
    const centre = p[s2(p.length)];
    const peak = Math.max(...p);
    const at = p.indexOf(peak);
    console.log(`  entering the field: peak ${(peak * units.speedMS).toFixed(2)} m/s ${at + 0.5} cells from the wall, ${(centre * units.speedMS).toFixed(2)} m/s on the centre line`);
    assert.ok(peak > 1.15 * centre, `peak ${peak}, centre ${centre}`);
    assert.ok(at < p.length / 4 || at >= (3 * p.length) / 4, `the peak is ${at} cells in`);
    // Without the field the same column has only the plug inflow's own slight overshoot.
    const bare = run({ bFieldT: 0 }, 1500).profile(layout.poleStart + 1);
    const bareRatio = Math.max(...bare) / bare[s2(bare.length)];
    console.log(`  peak over centre line: ${(peak / centre).toFixed(2)} with the field, ${bareRatio.toFixed(2)} without`);
    assert.ok(peak / centre > bareRatio + 0.08, `${peak / centre} with the field, ${bareRatio} without`);
  });

  it('no field: no volts, no force, the inflow carried through', () => {
    const s = run({ bFieldT: 0 }, 3000);
    // The potential is kept in units of the peak field, so it is the volts that vanish.
    assert.equal(M.mhdSliceUnits(0, MHD, GRID.ny).volts, 0);
    assert.equal(s.config.lorentz, 0);
    assert.ok(Math.abs(meanSpeed(s, GRID.nx >> 1) / s.config.inletU - 1) < 0.05);
  });

  it('configure keeps the state and refuses another grid; reset starts over', () => {
    const s = run({}, 50);
    const before = s.voltages()[1];
    s.configure(M.mhdSliceConfig({ bFieldT: 0.5, flowU: 1 }, MHD, GRID));
    assert.equal(s.voltages()[1], before);
    assert.throws(() => s.configure(M.mhdSliceConfig(input)), /grid size/);
    s.reset();
    assert.equal(s.steps, 0);
    assert.ok(s.voltages().every((v) => v === 0));
  });
});

function s2(n) {
  return n >> 1;
}
