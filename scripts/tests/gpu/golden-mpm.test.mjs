/**
 * test:gpu-golden — the MLS-MPM liquid passes vs their CPU twin (ADR-0022).
 *
 * passes/mpm-p2g.wgsl, mpm-grid.wgsl and mpm-g2p.wgsl run on a Dawn device
 * through the app's own host (`MpmSolver`, the `mpm` layout); the reference is
 * `MpmCpu` in src/fluids/mpm-cpu.ts — same buffers, same fixed-point scatter.
 *
 *   - GPU ≈ CPU, particle for particle, through a block dropped on the floor
 *   - mass: the grid holds the particles' mass to the count
 *   - momentum: conserved by the transfers with gravity off
 *   - hydrostatic: a settled column reads ρ·g·h within 5 %
 *   - worst-case fill: every particle of the budget on one node cannot wrap
 *   - determinism: two runs give the same bytes
 *
 * The grids are 16³ (and 12×24×12 for the column): the software rasterisers
 * CI runs on cannot afford the app's 64³ / 96³, and the method does not
 * depend on the grid size.
 *
 * Tolerances were set on Lavapipe. The CPU twin evaluates in double and
 * rounds on store; a GPU works in f32 and may fuse multiply-adds, so a
 * carried remainder now and then lands one count on the other side.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { gpuSkip, nodeGpu, readBuffer } from '../../lib/node-gpu.mjs';
import { gpuSession } from '../../lib/gpu-app.mjs';

const gpu = await nodeGpu();
const skip = gpuSkip(gpu);
// Top level: nodeDevice() destroys the device when the enclosing scope ends.
const session = skip ? null : await gpuSession(gpu, { label: 'golden-mpm' });

const G = 9.80665;
const I32_MAX = 2147483647;

async function makeSolver(cfg, records) {
  const { app, device, cache, shaders } = session;
  const solver = await app.MpmSolver.create(device, cache, shaders.mpmShaders, cfg);
  solver.writeParticles(records);
  return solver;
}

/** Run `steps` substeps in submissions of at most `chunk`. */
function run(solver, steps, chunk = 16) {
  for (let done = 0; done < steps; done += chunk) {
    const enc = session.device.createCommandEncoder();
    solver.encode(enc, Math.min(chunk, steps - done));
    session.device.queue.submit([enc.finish()]);
  }
}

async function readParticles(solver) {
  const bytes = await readBuffer(session.device, solver.particleBuffer, 0, solver.count * session.app.mpm.MPM_PARTICLE_BYTES);
  return new Float32Array(bytes);
}

/**
 * A block of water dropped on the floor of a 16³ box: free fall, impact at
 * about substep 150, spread. Stepped with the default tier's fixed-point
 * scales, the coarsest a default bench runs at.
 */
function dropCase() {
  const { app } = session;
  const cfg = app.mpm.mpmWaterConfig([16, 16, 16], 0.01, 5e-4, app.mpm.MPM_TIERS.default.particles, { maxSpeedMS: 4 });
  const records = app.seedMpmBox(cfg, { min: [0.04, 0.03, 0.05], max: [0.09, 0.08, 0.1], velocity: [0.4, 0, -0.2], jitter: 0.3, seed: 3 });
  return { cfg, records };
}

describe('gpu-golden: mpm-p2g / mpm-grid / mpm-g2p vs MpmCpu', { skip }, () => {
  it('one substep: the fixed-point grid is the CPU scatter, to a few counts in a million', async () => {
    const { app } = session;
    const { cfg, records } = dropCase();
    const cpu = new app.MpmCpu(cfg);
    cpu.setParticles(records);
    cpu.step(1);
    const solver = await makeSolver(cfg, records);
    run(solver, 1);
    const grid = new Int32Array(await readBuffer(session.device, solver.gridFixedBuffer));
    assert.deepEqual(session.device.uncaptured, [], 'GPU validation errors');
    let worst = 0;
    let differing = 0;
    let mass = 0;
    for (let i = 0; i < grid.length; i++) {
      const d = Math.abs(grid[i] - cpu.gridFixed[i]);
      if (d > 0) differing++;
      worst = Math.max(worst, d);
      if (i % 4 === 0) mass += grid[i];
    }
    const { massScale } = app.mpm.mpmFixedScales(cfg.maxParticles);
    assert.equal(mass, cpu.count * massScale, 'grid mass is the particle mass, to the count');
    // A node sums ~200 contributions; an f32 weight puts a carried remainder
    // on the other side of ½ for a few of them, one count each. Measured: 6.
    assert.ok(worst <= 32, `a grid channel differs from the CPU by ${worst} counts`);
    console.log(`  ${cpu.count} particles: ${differing} of ${grid.length} grid words differ, by at most ${worst} count(s) (a node at rest density holds ${8 * massScale})`);
    solver.destroy();
  });

  it('240 substeps of a dropped block, through the impact: positions within 2 % of a cell, same totals', async () => {
    const { app } = session;
    const { cfg, records } = dropCase();
    const steps = 240;
    const cpu = new app.MpmCpu(cfg);
    cpu.setParticles(records);
    cpu.step(steps);
    const solver = await makeSolver(cfg, records);
    run(solver, steps);
    const got = await readParticles(solver);
    assert.deepEqual(session.device.uncaptured, [], 'GPU validation errors');

    const F = app.mpm.MPM_PARTICLE_FLOATS;
    let worstPos = 0;
    let worstVel = 0;
    let worstJ = 0;
    for (let p = 0; p < cpu.count; p++) {
      for (let a = 0; a < 3; a++) {
        worstPos = Math.max(worstPos, Math.abs(got[p * F + a] - cpu.particles[p * F + a]));
        worstVel = Math.max(worstVel, Math.abs(got[p * F + 4 + a] - cpu.particles[p * F + 4 + a]));
      }
      worstJ = Math.max(worstJ, Math.abs(got[p * F + app.mpm.MPM_P.j] - cpu.particles[p * F + app.mpm.MPM_P.j]));
    }
    const a = app.mpmTotals(cfg, got, cpu.count);
    const b = app.mpmTotals(cfg, cpu.particles, cpu.count);
    assert.ok(a.finite, 'GPU particles are finite');
    // The block has hit the floor and is spreading: the case exercises
    // pressure, the walls and the affine term, not only free fall.
    assert.ok(b.centre[1] < 0.025 && b.maxSpeed > 1.5, `reference case is not a splash (centre y ${b.centre[1]}, max speed ${b.maxSpeed})`);
    // Measured on Lavapipe: 3.8e-3 cells, 2.0e-3 m/s, kinetic energy to 5 digits.
    assert.ok(worstPos < 0.02 * cfg.cellM, `a particle is ${worstPos} m from its CPU twin (${(worstPos / cfg.cellM).toFixed(4)} cells)`);
    assert.ok(worstVel < 0.02, `a particle's velocity differs by ${worstVel} m/s`);
    // Measured 1.4e-6 m: 1.4e-4 of a cell, for the mean of a thousand particles mid-splash.
    for (let k = 0; k < 3; k++) assert.ok(Math.abs(a.centre[k] - b.centre[k]) < 5e-6, `centre of mass ${a.centre} vs ${b.centre}`);
    assert.ok(Math.abs(a.kinetic / b.kinetic - 1) < 1e-3, `kinetic energy ${a.kinetic} vs ${b.kinetic}`);
    assert.ok(Math.abs(a.volume / b.volume - 1) < 1e-4, `volume ${a.volume} vs ${b.volume}`);
    const seeds = new Uint32Array(got.buffer);
    const want = new Uint32Array(cpu.particles.buffer);
    for (let p = 0; p < cpu.count; p++) assert.equal(seeds[p * F + app.mpm.MPM_P.seed], want[p * F + app.mpm.MPM_P.seed], `dither counter of particle ${p}`);
    console.log(`  max |GPU − CPU|: position ${(worstPos / cfg.cellM).toExponential(2)} cells, velocity ${worstVel.toExponential(2)} m/s, J ${worstJ.toExponential(2)}`);
    solver.destroy();
  });

  it('momentum is conserved with gravity off', async () => {
    const { app } = session;
    const cfg = app.mpm.mpmWaterConfig([16, 16, 16], 0.01, 5e-4, 4096, { gravity: [0, 0, 0], maxSpeedMS: 4 });
    const records = app.seedMpmBox(cfg, { min: [0.05, 0.05, 0.05], max: [0.09, 0.09, 0.09], velocity: [0.3, -0.2, 0.1] });
    const before = app.mpmTotals(cfg, records, records.length / app.mpm.MPM_PARTICLE_FLOATS);
    const solver = await makeSolver(cfg, records);
    run(solver, 100);
    const after = app.mpmTotals(cfg, await readParticles(solver), solver.count);
    assert.deepEqual(session.device.uncaptured, [], 'GPU validation errors');
    const scale = Math.hypot(...before.momentum);
    for (let a = 0; a < 3; a++) {
      assert.ok(Math.abs(after.momentum[a] - before.momentum[a]) / scale < 5e-5, `axis ${a}: ${before.momentum[a]} → ${after.momentum[a]} kg·m/s`);
    }
    assert.equal(after.count, before.count, 'particle count');
    assert.ok(Math.abs(after.mass / before.mass - 1) < 1e-12);
    solver.destroy();
  });

  it('a column settles to ρ·g·h within 5 %', async () => {
    const { app } = session;
    const grid = [12, 24, 12];
    const h = 0.01;
    const fill = 14;
    const base = app.mpm.mpmWaterConfig(grid, h, 2.5e-4, app.mpm.MPM_TIERS.default.particles, { gravity: [0, 0, 0], maxSpeedMS: 4 });
    const b = app.mpm.mpmBounds(base);
    const records = app.seedMpmBox(base, { min: b.min, max: [b.max[0], b.min[1] + fill * h, b.max[2]] });
    const solver = await makeSolver(base, records);
    // Gravity eased in over 400 substeps (no acoustic ring), then held for 400.
    const t0 = Date.now();
    for (let s = 0; s < 800; s += 8) {
      const x = Math.min(1, (s + 8) / 400);
      solver.setConfig({ ...base, gravity: [0, -G * x * x * (3 - 2 * x), 0] });
      run(solver, 8, 8);
    }
    const P = await readParticles(solver);
    assert.deepEqual(session.device.uncaptured, [], 'GPU validation errors');
    const cfg = solver.config;
    const d = app.mpm.mpmDerived(cfg);
    const F = app.mpm.MPM_PARTICLE_FLOATS;
    const area = (b.max[0] - b.min[0]) * (b.max[2] - b.min[2]);
    const order = [...Array(solver.count).keys()].sort((p, q) => P[q * F + 1] - P[p * F + 1]);
    const layers = new Map();
    order.forEach((p, above) => {
      const layer = Math.floor((P[p * F + 1] - b.min[1]) / h);
      const e = layers.get(layer) ?? { n: 0, pressure: 0, expected: 0 };
      e.n++;
      e.pressure += P[p * F + app.mpm.MPM_P.pressure];
      e.expected += ((above + 0.5) * d.particleMass * G) / area;
      layers.set(layer, e);
    });
    const report = [];
    let checked = 0;
    for (const [layer, e] of [...layers.entries()].sort((p, q) => p[0] - q[0])) {
      const ratio = e.pressure / e.expected;
      report.push(`${layer}:${((ratio - 1) * 100).toFixed(1)}%`);
      // The floor's reaction lives in the bottom two layers; the top one holds a few pascals.
      if (layer < 2 || layer > fill - 2) continue;
      checked++;
      assert.ok(Math.abs(ratio - 1) < 0.05, `layer ${layer}: ${(e.pressure / e.n).toFixed(1)} Pa, weight above ${(e.expected / e.n).toFixed(1)} Pa`);
    }
    assert.ok(checked >= 10, `only ${checked} layers checked`);
    const deepest = layers.get(2);
    const depth = (fill - 2.5) * h;
    assert.ok(Math.abs(deepest.pressure / deepest.n / (cfg.restDensity * G * depth) - 1) < 0.05,
      `${(deepest.pressure / deepest.n).toFixed(1)} Pa at ${depth} m; ρ·g·h = ${(cfg.restDensity * G * depth).toFixed(1)} Pa`);
    const t = app.mpmTotals(cfg, P, solver.count);
    assert.ok(t.finite && t.maxSpeed < 5e-3, `column still moving at ${t.maxSpeed} m/s`);
    console.log(`  ${solver.count} particles, 800 substeps in ${Date.now() - t0} ms; pressure vs weight above by layer: ${report.join(' ')}`);
    solver.destroy();
  });

  it('worst-case fill: the whole default budget on one node cannot wrap the grid', async () => {
    const { app } = session;
    const N = app.mpm.MPM_TIERS.default.particles;
    const cfg = app.mpm.mpmWaterConfig([16, 16, 16], 0.01, 5e-4, N, { maxSpeedMS: 4 });
    const records = new Float32Array(N * app.mpm.MPM_PARTICLE_FLOATS);
    // On a node, and moving faster than the transfer clamp in every axis.
    for (let i = 0; i < N; i++) app.writeMpmParticle(records, i, [0.08, 0.08, 0.08], [40, -40, 40]);
    const solver = await makeSolver(cfg, records);
    run(solver, 1);
    const grid = new Int32Array(await readBuffer(session.device, solver.gridFixedBuffer));
    const P = await readParticles(solver);
    assert.deepEqual(session.device.uncaptured, [], 'GPU validation errors');
    const { massScale } = app.mpm.mpmFixedScales(N);
    let peak = 0;
    let trough = 0;
    let mass = 0;
    for (let i = 0; i < grid.length; i++) {
      if (i % 4 === 0) {
        assert.ok(grid[i] >= 0, `node ${i / 4}: mass wrapped negative (${grid[i]})`);
        mass += grid[i];
      }
      peak = Math.max(peak, grid[i]);
      trough = Math.min(trough, grid[i]);
    }
    assert.ok(peak <= app.mpm.mpmWorstCaseSum(N) && peak <= I32_MAX);
    assert.ok(peak > 0.99 * I32_MAX, `peak ${peak}: the case did not fill the channel`);
    assert.ok(-trough > 0.99 * I32_MAX, `momentum trough ${trough}`);
    assert.ok(Math.abs(mass - N * massScale) <= N / 2, `grid mass ${mass} vs ${N * massScale}`);
    assert.ok(app.mpmTotals(cfg, P, N).finite, 'particles are finite after the step');
    console.log(`  ${N} particles on one node: peak ${peak} = ${(peak / I32_MAX).toFixed(4)} of i32`);
    solver.destroy();
  });

  it('two runs give the same bytes', async () => {
    const { cfg, records } = dropCase();
    const once = async () => {
      const solver = await makeSolver(cfg, records);
      run(solver, 200);
      const out = new Uint32Array((await readParticles(solver)).buffer);
      solver.destroy();
      return out;
    };
    const a = await once();
    const b = await once();
    assert.deepEqual(session.device.uncaptured, [], 'GPU validation errors');
    let differing = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) differing++;
    assert.equal(differing, 0, `${differing} of ${a.length} particle words differ between two identical runs`);
  });

  for (const tier of ['low', 'default', 'high']) {
    it(`the ${tier} tier allocates inside the device's limits and steps`, async () => {
      const { app } = session;
      const t = app.mpm.MPM_TIERS[tier];
      const gridN = [t.gridN, t.gridN, t.gridN];
      const h = 0.64 / t.gridN;
      const cfg = app.mpm.mpmWaterConfig(gridN, h, 2.5e-4, t.particles, { maxSpeedMS: 4 });
      // Nearly the full budget, as a cube hanging clear of the floor: the
      // buffers and the dispatch counts are the real ones. Only the step
      // count is small.
      const b = app.mpm.mpmBounds(cfg);
      const side = Math.floor(Math.cbrt(t.particles / 8));
      const lo = [b.min[0] + 2 * h, b.min[1] + 4 * h, b.min[2] + 2 * h];
      const records = app.seedMpmBox(cfg, { min: lo, max: lo.map((x) => x + side * h) });
      const count = records.length / app.mpm.MPM_PARTICLE_FLOATS;
      assert.ok(count > 0.9 * t.particles && count <= t.particles, `${count} particles for a budget of ${t.particles}`);
      const solver = await makeSolver(cfg, records);
      const t0 = Date.now();
      run(solver, 4, 4);
      const totals = app.mpmTotals(cfg, await readParticles(solver), solver.count);
      const ms = Date.now() - t0;
      assert.deepEqual(session.device.uncaptured, [], 'GPU validation errors');
      assert.ok(totals.finite && totals.count === count);
      // Four substeps of free fall from rest: v = −4·g·dt.
      assert.ok(Math.abs(totals.momentum[1] / totals.mass / (-4 * G * cfg.dt) - 1) < 1e-3, `mean vy ${totals.momentum[1] / totals.mass}`);
      console.log(`  ${tier}: ${t.gridN}³ grid, ${count} particles, ${(solver.memoryBytes / 2 ** 20).toFixed(1)} MiB; `
        + `4 substeps + read-back in ${ms} ms on ${gpu.adapter.info?.description || 'this adapter'} (software — not the frame budget)`);
      solver.destroy();
    });
  }

  it('an empty slot is skipped, and a solver refuses a different grid or budget', async () => {
    const { app } = session;
    const cfg = app.mpm.mpmWaterConfig([16, 16, 16], 0.01, 5e-4, 512);
    const records = app.seedMpmBox(cfg, { min: [0.05, 0.05, 0.05], max: [0.09, 0.09, 0.09] });
    const F = app.mpm.MPM_PARTICLE_FLOATS;
    records[7 * F + app.mpm.MPM_P.state] = 0;
    const dead = Array.from(new Uint32Array(records.buffer, 7 * F * 4, F));
    const solver = await makeSolver(cfg, records);
    run(solver, 10);
    const got = new Uint32Array((await readParticles(solver)).buffer);
    assert.deepEqual(Array.from(got.subarray(7 * F, 8 * F)), dead);
    assert.throws(() => solver.setConfig({ ...cfg, maxParticles: 1024 }), /fixed for the life/);
    assert.throws(() => solver.setConfig({ ...cfg, gridN: [16, 16, 32] }), /fixed for the life/);
    assert.throws(() => solver.setConfig({ ...cfg, maxSpeedMS: 1e3 }), /cells per substep/);
    // Particles and grids, the uniform, and the one-node boundary a solver without solids binds.
    assert.equal(solver.memoryBytes, app.mpm.mpmMemoryBytes(cfg.gridN, cfg.maxParticles) + app.mpm.MPM_PARAMS_BYTES + app.mpm.MPM_BOUNDARY_FLOATS * 4);
    assert.equal(solver.hasIo, false);
    assert.throws(() => solver.encodeFrame(session.device.createCommandEncoder(), 1), /needs a solver created with io/);
    assert.deepEqual(session.device.uncaptured, [], 'GPU validation errors');
    solver.destroy();
  });
});
