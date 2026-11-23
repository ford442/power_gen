/**
 * test:gpu-golden — the MHD duct slice (docs/FLUIDS.md → MHD duct → The
 * slice) on a real GPU: `passes/mhd-slice-lbm.wgsl` and `mhd-slice-phi.wgsl`
 * through the app's `MhdSliceSolver`, against the CPU twin and the analysis.
 *
 *   - the gap slice settles on the Hartmann profile at Ha = 0, 5 and 20
 *     (L2 under 2 %), at the mean speed the analysis gives
 *   - mass on the lattice holds to 1e-5 over 1000 steps
 *   - the mid-plane, step for step against the CPU twin: moments, potential,
 *     electrode voltages and currents
 *   - open circuit in a uniform field reads B·ū·w within 3 %
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { gpuSkip, nodeGpu, readBuffer } from '../../lib/node-gpu.mjs';
import { gpuSession } from '../../lib/gpu-app.mjs';

const gpu = await nodeGpu();
const skip = gpuSkip(gpu);
// Top level: nodeDevice() destroys the device when the enclosing scope ends.
const session = skip ? null : await gpuSession(gpu, { label: 'golden-mhd-slice' });

/** Run `steps` on the GPU, a few hundred to a submit so a software rasteriser's queue stays short. */
async function run(solver, steps) {
  const { device } = session;
  for (let left = steps; left > 0;) {
    const n = Math.min(250, left);
    const enc = device.createCommandEncoder();
    solver.encodeSteps(enc, n);
    device.queue.submit([enc.finish()]);
    left -= n;
    await device.queue.onSubmittedWorkDone();
  }
}

const f32 = async (buffer) => new Float32Array(await readBuffer(session.device, buffer));

describe('gpu-golden: MHD slice — the gap slice against the Hartmann profile', { skip }, () => {
  for (const [ha, steps] of [[0, 30000], [5, 12000], [20, 3000]]) {
    it(`Ha = ${ha}: profile within 2 % (L2), mean speed as the analysis gives`, async () => {
      const { app, device, cache } = session;
      const S = app.mhdSlice;
      const cfg = S.mhdGapConfig(ha);
      const solver = await app.MhdSliceSolver.create(device, cache, app.MHD_SLICE_SHADERS, cfg);
      await run(solver, steps);
      const m = await f32(solver.moments);
      solver.destroy();
      const column = cfg.nx >> 1;
      let mean = 0;
      let wantMean = 0;
      const got = [];
      const want = [];
      for (let j = 0; j < cfg.ny; j++) {
        got.push(m[(j * cfg.nx + column) * 4]);
        want.push(app.hartmannProfile((j + 0.5 - cfg.ny / 2) / (cfg.ny / 2), ha));
        mean += got[j];
        wantMean += want[j];
      }
      mean /= cfg.ny;
      wantMean /= cfg.ny;
      let num = 0;
      let den = 0;
      for (let j = 0; j < cfg.ny; j++) {
        num += (got[j] / mean - want[j] / wantMean) ** 2;
        den += (want[j] / wantMean) ** 2;
      }
      const l2 = Math.sqrt(num / den);
      const speed = mean / S.mhdGapSettledSpeed(cfg, ha);
      console.log(`  Ha ${ha}: L2 ${l2.toExponential(2)}, mean speed ${speed.toFixed(4)} of the analysis`);
      assert.deepEqual(session.device.uncaptured, [], 'GPU validation errors');
      assert.ok(l2 < 0.02, `L2 ${l2}`);
      assert.ok(Math.abs(speed - 1) < 0.01, `mean speed ${speed} of the analysis`);
      // Nothing moves across the gap, and the flow is the same at every x.
      let across = 0;
      let alongX = 0;
      for (let j = 0; j < cfg.ny; j++) {
        across = Math.max(across, Math.abs(m[(j * cfg.nx + column) * 4 + 1]));
        alongX = Math.max(alongX, Math.abs(m[(j * cfg.nx) * 4] - got[j]));
      }
      assert.ok(across < 1e-3 * mean, `cross-gap speed ${across} against a mean of ${mean}`);
      assert.ok(alongX < 1e-3 * mean, `profile differs by ${alongX} between two columns`);
    });
  }

  it('mass on the lattice holds to 1e-5 over 1000 steps', async () => {
    const { app, device, cache } = session;
    const cfg = app.mhdSlice.mhdGapConfig(5, { nx: 64 });
    const solver = await app.MhdSliceSolver.create(device, cache, app.MHD_SLICE_SHADERS, cfg);
    const sum = async () => (await f32(solver.distributions)).reduce((s, v) => s + v, 0);
    const before = await sum();
    await run(solver, 1000);
    const after = await sum();
    solver.destroy();
    const drift = Math.abs(after / before - 1);
    console.log(`  mass drift over 1000 steps: ${drift.toExponential(2)}`);
    assert.ok(Math.abs(before - cfg.nx * cfg.ny) < 1e-3 * cfg.nx * cfg.ny, `starts at rest density: ${before}`);
    assert.ok(drift < 1e-5, `mass drifted by ${drift}`);
  });
});

describe('gpu-golden: MHD slice — the mid-plane against its CPU twin', { skip }, () => {
  const GRID = { nx: 128, ny: 20 };

  it('300 steps, loaded: moments, potential, voltages and currents agree', async () => {
    const { app, device, cache } = session;
    const S = app.mhdSlice;
    const cfg = S.mhdSliceConfig({ bFieldT: 0.8, flowU: 1.5 }, app.MHD, GRID);
    const cpu = new app.MhdSliceCpu(cfg);
    cpu.step(300);
    const solver = await app.MhdSliceSolver.create(device, cache, app.MHD_SLICE_SHADERS, cfg);
    await run(solver, 300);
    const enc = device.createCommandEncoder();
    assert.equal(solver.requestReadout(enc), true);
    device.queue.submit([enc.finish()]);
    const readout = await solver.resolveReadout();
    const m = await f32(solver.moments);
    const phi = await f32(solver.potential);
    solver.destroy();
    assert.deepEqual(session.device.uncaptured, [], 'GPU validation errors');

    const worst = { u: 0, phi: 0 };
    let phiScale = 0;
    for (let c = 0; c < cfg.nx * cfg.ny; c++) {
      worst.u = Math.max(worst.u, Math.abs(m[c * 4] - cpu.macro[c * 4]), Math.abs(m[c * 4 + 1] - cpu.macro[c * 4 + 1]));
      worst.phi = Math.max(worst.phi, Math.abs(phi[c] - cpu.phi[c]));
      phiScale = Math.max(phiScale, Math.abs(cpu.phi[c]));
    }
    console.log(`  worst |GPU − CPU|: velocity ${worst.u.toExponential(2)} of an inlet ${cfg.inletU.toFixed(3)}, potential ${worst.phi.toExponential(2)} of ${phiScale.toFixed(3)}`);
    assert.ok(worst.u < 2e-4 * cfg.inletU, `velocity differs by ${worst.u}`);
    assert.ok(worst.phi < 2e-4 * phiScale, `potential differs by ${worst.phi}`);
    const v = cpu.voltages();
    const i = cpu.currents();
    assert.equal(readout.voltages.length, cfg.segments);
    for (let k = 0; k < cfg.segments; k++) {
      assert.ok(v[k] > 0 && i[k] > 0, `segment ${k} delivers: V ${v[k]}, I ${i[k]}`);
      assert.ok(Math.abs(readout.voltages[k] / v[k] - 1) < 1e-3, `segment ${k}: V GPU ${readout.voltages[k]}, CPU ${v[k]}`);
      assert.ok(Math.abs(readout.currents[k] / i[k] - 1) < 1e-3, `segment ${k}: I GPU ${readout.currents[k]}, CPU ${i[k]}`);
    }
  });

  it('open circuit in a uniform field: each electrode pair reads B·ū·w within 3 %', async () => {
    const { app, device, cache } = session;
    const S = app.mhdSlice;
    const input = { bFieldT: 1, flowU: 1.44, rLoadOhm: Infinity };
    const cfg = S.mhdSliceConfig(input, app.MHD, GRID);
    // The whole slice under the poles: no ends for current to leak round.
    const mid = (cfg.nx >> 1) * 4;
    for (let c = 0; c < cfg.nx; c++) {
      cfg.columns[c * 4] = 1;
      cfg.columns[c * 4 + 1] = cfg.columns[mid + 1];
    }
    const solver = await app.MhdSliceSolver.create(device, cache, app.MHD_SLICE_SHADERS, cfg);
    await run(solver, 5000);
    const enc = device.createCommandEncoder();
    solver.requestReadout(enc);
    device.queue.submit([enc.finish()]);
    const readout = await solver.resolveReadout();
    solver.destroy();
    const units = S.mhdSliceUnits(input.bFieldT, app.MHD, GRID.ny);
    const plant = input.bFieldT * input.flowU * app.MHD.widthM;
    const volts = readout.voltages.map((x) => x * units.volts);
    console.log(`  open-circuit volts per pair: ${volts.map((x) => x.toFixed(4)).join(', ')}; the plant's B·ū·w = ${plant.toFixed(4)}`);
    assert.deepEqual(session.device.uncaptured, [], 'GPU validation errors');
    for (const x of volts) assert.ok(Math.abs(x / plant - 1) < 0.03, `${x} V against ${plant} V`);
    for (const c of readout.currents) assert.ok(Math.abs(c * units.amps) < 0.02 * (plant / (2 * app.MHD.rLoadOhm)), `open circuit carries ${c * units.amps} A`);
  });
});
