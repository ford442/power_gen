/**
 * test:gpu-golden — what a bench adds around the MLS-MPM core, on a real GPU
 * (ADR-0022): the signed-distance boundary in mpm-grid.wgsl / mpm-g2p.wgsl,
 * and mpm-emit.wgsl, mpm-probe.wgsl, mpm-export.wgsl, all through the app's
 * `MpmSolver`. The reference is `MpmCpu` with the same boundary field and the
 * same emitter / sink frames.
 *
 * An emitter hands new particles to empty slots in whatever order the GPU
 * runs them, so slot order is not comparable — and is not meant to be. A
 * particle is identified by its dither counter (`seed`), which starts from a
 * hash of its id and steps once per substep on both sides: sorted by seed, the
 * GPU and the CPU hold the same particles.
 *
 * Tolerances were set on Lavapipe; each says what was measured.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { gpuSkip, nodeGpu, readBuffer } from '../../lib/node-gpu.mjs';
import { gpuSession } from '../../lib/gpu-app.mjs';

const gpu = await nodeGpu();
const skip = gpuSkip(gpu);
// Top level: nodeDevice() destroys the device when the enclosing scope ends.
const session = skip ? null : await gpuSession(gpu, { label: 'golden-mpm-io' });

const G = 9.80665;

async function makeSolver(cfg, options) {
  const { app, device, cache } = session;
  return app.MpmSolver.create(device, cache, app.MPM_SHADERS, cfg, options);
}

function submit(encode) {
  const enc = session.device.createCommandEncoder();
  encode(enc);
  session.device.queue.submit([enc.finish()]);
}

async function readParticles(solver) {
  return new Float32Array(await readBuffer(session.device, solver.particleBuffer));
}

/** Live records keyed by seed: Map(seed → float offset). */
function bySeed(app, particles) {
  const F = app.mpm.MPM_PARTICLE_FLOATS;
  const bits = new Uint32Array(particles.buffer, particles.byteOffset, particles.length);
  const out = new Map();
  for (let p = 0; p < particles.length / F; p++) {
    if (particles[p * F + app.mpm.MPM_P.state] !== 0) out.set(bits[p * F + app.mpm.MPM_P.seed], p * F);
  }
  return out;
}

/** Largest position / velocity difference between two particle sets matched by seed. */
function compareSets(app, a, b) {
  const A = bySeed(app, a);
  const B = bySeed(app, b);
  let pos = 0;
  let vel = 0;
  let unmatched = 0;
  for (const [seed, oa] of A) {
    const ob = B.get(seed);
    if (ob === undefined) { unmatched++; continue; }
    for (let k = 0; k < 3; k++) {
      pos = Math.max(pos, Math.abs(a[oa + k] - b[ob + k]));
      vel = Math.max(vel, Math.abs(a[oa + 4 + k] - b[ob + 4 + k]));
    }
  }
  for (const seed of B.keys()) if (!A.has(seed)) unmatched++;
  return { pos, vel, unmatched, live: A.size, liveRef: B.size };
}

const cup = { kind: 'cup', base: [0.08, 0.02, 0.08], innerRadiusM: 0.04, outerRadiusM: 0.065, floorM: 0.03, heightM: 0.11 };

describe('gpu-golden: mpm boundary, emit, probe, export vs MpmCpu', { skip }, () => {
  it('a block dropped into a cup: GPU ≈ CPU, and nothing ends inside the solid', async () => {
    const { app } = session;
    const cfg = app.mpm.mpmWaterConfig([16, 20, 16], 0.01, 2.5e-4, app.mpm.MPM_TIERS.default.particles, { maxSpeedMS: 3 });
    const field = app.bakeMpmBoundary(cfg, [cup]);
    const records = app.seedMpmBox(cfg, { min: [0.055, 0.07, 0.055], max: [0.105, 0.11, 0.105], velocity: [0.2, 0, 0.1] });
    const steps = 320;
    const cpu = new app.MpmCpu(cfg);
    cpu.setBoundary(field);
    cpu.setParticles(records);
    cpu.step(steps);
    const solver = await makeSolver(cfg, { boundary: field });
    solver.writeParticles(records);
    for (let done = 0; done < steps; done += 16) submit((enc) => solver.encode(enc, 16));
    const got = (await readParticles(solver)).subarray(0, cpu.count * app.mpm.MPM_PARTICLE_FLOATS);
    assert.deepEqual(session.device.uncaptured, [], 'GPU validation errors');

    const F = app.mpm.MPM_PARTICLE_FLOATS;
    let worst = 0;
    let deepest = 0;
    for (let p = 0; p < cpu.count; p++) {
      for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(got[p * F + k] - cpu.particles[p * F + k]));
      deepest = Math.min(deepest, app.mpmSolidDistance(cup, got[p * F], got[p * F + 1], got[p * F + 2]));
    }
    const a = app.mpmTotals(cfg, got, cpu.count);
    const b = app.mpmTotals(cfg, cpu.particles, cpu.count);
    // The water has met the cavity floor and the wall: the boundary is doing the work.
    assert.ok(b.centre[1] < 0.07 && b.centre[1] > cup.base[1] + cup.floorM, `reference centre of mass at y = ${b.centre[1]}`);
    assert.ok(a.finite);
    assert.ok(worst < 0.03 * cfg.cellM, `a particle is ${(worst / cfg.cellM).toFixed(4)} cells from its CPU twin`);
    assert.ok(deepest > -0.3 * cfg.cellM, `a particle sits ${(-deepest / cfg.cellM).toFixed(3)} cells inside the cup's wall`);
    for (let k = 0; k < 3; k++) assert.ok(Math.abs(a.centre[k] - b.centre[k]) < 2e-6);
    assert.ok(Math.abs(a.kinetic - b.kinetic) < 1e-3 * (b.kinetic + 1e-6), `kinetic energy ${a.kinetic} vs ${b.kinetic}`);
    console.log(`  ${cpu.count} particles, ${steps} substeps: max |GPU − CPU| ${(worst / cfg.cellM).toExponential(2)} cells; deepest in the solid ${(-deepest / cfg.cellM).toFixed(3)} cells`);
    solver.destroy();
  });

  it('an emitter: the GPU makes the particles the CPU makes, and twice the same', async () => {
    const { app } = session;
    const h = 0.005;
    const cfg = app.mpm.mpmWaterConfig([16, 28, 16], h, 2.5e-4, 6000, { maxSpeedMS: 2 });
    const emitters = [
      { centre: [8 * h, 4 * h, 8 * h], direction: [0, 1, 0], radiusM: 0.006, speedMS: 1, spread: 0.05 },
      { centre: [3 * h, 14 * h, 8 * h], direction: [1, 0.3, 0], radiusM: 0.004, speedMS: 0.6, spread: 0 }
    ];
    const frames = 60;
    const sub = 4;

    const cpu = new app.MpmCpu(cfg);
    const carry = [];
    let base = 0;
    for (let f = 0; f < frames; f++) {
      const counts = app.mpm.mpmEmitCounts(cfg, emitters, sub * cfg.dt, carry);
      cpu.emit({ emitters, counts, seconds: sub * cfg.dt, baseId: base, sinks: [] });
      base += counts[0] + counts[1];
      cpu.step(sub);
    }

    const once = async () => {
      const solver = await makeSolver(cfg, { io: true });
      solver.emitters = emitters;
      for (let f = 0; f < frames; f++) submit((enc) => solver.encodeFrame(enc, sub));
      const particles = await readParticles(solver);
      const requested = solver.emitRequested;
      solver.destroy();
      return { particles, requested };
    };
    const a = await once();
    const b = await once();
    assert.deepEqual(session.device.uncaptured, [], 'GPU validation errors');

    assert.equal(a.requested, base, 'the host asked for what the CPU asked for');
    const vsCpu = compareSets(app, a.particles, cpu.particles);
    assert.equal(vsCpu.live, cpu.emitted, `${vsCpu.live} live on the GPU, ${cpu.emitted} emitted on the CPU`);
    assert.equal(vsCpu.unmatched, 0, 'a particle exists on one side only');
    // Measured: 1.8e-4 cells, 4.5e-5 m/s — two streams, 240 substeps.
    assert.ok(vsCpu.pos < 0.01 * h, `a particle is ${(vsCpu.pos / h).toFixed(4)} cells from its CPU twin`);
    assert.ok(vsCpu.vel < 5e-3, `velocity differs by ${vsCpu.vel} m/s`);

    // Two GPU runs: slots may differ, the set may not — to the bit.
    const A = bySeed(app, a.particles);
    const B = bySeed(app, b.particles);
    assert.equal(A.size, B.size);
    const F = app.mpm.MPM_PARTICLE_FLOATS;
    const ua = new Uint32Array(a.particles.buffer);
    const ub = new Uint32Array(b.particles.buffer);
    let differing = 0;
    let moved = 0;
    for (const [seed, oa] of A) {
      const ob = B.get(seed);
      assert.ok(ob !== undefined, 'a particle of one run is missing from the other');
      if (oa !== ob) moved++;
      for (let k = 0; k < F; k++) if (ua[oa + k] !== ub[ob + k]) differing++;
    }
    assert.equal(differing, 0, `${differing} words differ between two runs once particles are matched by id`);
    console.log(`  ${A.size} particles from two nozzles: max |GPU − CPU| ${(vsCpu.pos / h).toExponential(2)} cells, ${vsCpu.vel.toExponential(2)} m/s; `
      + `two GPU runs identical by id (${moved} in different slots)`);
  });

  it('a sink, the profile and the draw export', async () => {
    const { app } = session;
    const cfg = app.mpm.mpmWaterConfig([16, 20, 16], 0.01, 2.5e-4, 2000, { maxSpeedMS: 3 });
    const field = app.bakeMpmBoundary(cfg, [cup]);
    const records = app.seedMpmBox(cfg, { min: [0.055, 0.06, 0.055], max: [0.105, 0.1, 0.105] });
    const n = records.length / app.mpm.MPM_PARTICLE_FLOATS;
    const solver = await makeSolver(cfg, { boundary: field, io: true });
    solver.writeParticles(records);
    solver.exportOrigin = [-7, 2.5, 4];
    solver.exportScale = 12.5;

    // No sink yet: settle in the cup, then read everything back.
    for (let f = 0; f < 150; f++) submit((enc) => solver.encodeFrame(enc, 4));
    submit((enc) => solver.encodeFrame(enc, 4, { probe: true }));
    const settled = await solver.collectProfile();
    assert.ok(settled, 'no profile came back');
    const gridVel = new Float32Array(await readBuffer(session.device, solver.gridVelBuffer));
    const want = app.mpmLayerProfile(cfg, gridVel);
    for (let j = 0; j < want.length; j++) {
      // The pass sums a layer in another order than the CPU does.
      assert.ok(Math.abs(settled.layers[j] - want[j]) <= 1e-4 * want[j] + 2 / app.mpm.MPM_PROBE_MASS_SCALE, `layer ${j}: ${settled.layers[j]} vs ${want[j]}`);
    }
    assert.ok(Math.abs(app.mpmProfileMass(settled.layers) - n) < 0.5, `profile holds ${app.mpmProfileMass(settled.layers)} particle masses for ${n} particles`);
    assert.deepEqual([settled.emitted, settled.sunk], [0, 0]);
    const floor = cup.base[1] + cup.floorM;
    const depth = (n * app.mpm.mpmDerived(cfg).particleVolume) / (Math.PI * cup.innerRadiusM ** 2);
    const top = app.mpmProfileTop(cfg, settled.layers, (0.25 * n) / (depth / cfg.cellM)) - floor;
    assert.ok(Math.abs(top / depth - 1) < 0.2, `pool top ${top} m above the cavity floor; its volume says ${depth}`);

    // The draw export: scene position = origin + metres · scale, effect type 9.
    const particles = await readParticles(solver);
    const drawn = new Float32Array(await readBuffer(session.device, solver.drawBuffer));
    const F = app.mpm.MPM_PARTICLE_FLOATS;
    let live = 0;
    for (let p = 0; p < cfg.maxParticles; p++) {
      const o = p * F;
      if (particles[o + app.mpm.MPM_P.state] === 0) {
        assert.ok(drawn[p * 4 + 1] < -1e5, `empty slot ${p} is drawn at y = ${drawn[p * 4 + 1]}`);
        assert.equal(drawn[p * 4 + 3], 9);
        continue;
      }
      live++;
      for (let k = 0; k < 3; k++) {
        const scene = solver.exportOrigin[k] + particles[o + k] * solver.exportScale;
        assert.ok(Math.abs(drawn[p * 4 + k] - scene) < 1e-5, `slot ${p} axis ${k}: ${drawn[p * 4 + k]} vs ${scene}`);
      }
      const speed = Math.hypot(particles[o + 4], particles[o + 5], particles[o + 6]) / cfg.maxSpeedMS;
      assert.equal(Math.floor(drawn[p * 4 + 3]), 9);
      assert.ok(Math.abs(drawn[p * 4 + 3] - 9 - Math.min(speed, 0.999)) < 1e-5);
    }
    assert.equal(live, n);

    // Open a drain across the cavity floor: everything goes, and is counted.
    solver.sinks = [{ min: [0.03, 0.04, 0.03], max: [0.13, 0.062, 0.13] }];
    for (let f = 0; f < 200; f++) submit((enc) => solver.encodeFrame(enc, 4));
    submit((enc) => solver.encodeFrame(enc, 4, { probe: true }));
    const drained = await solver.collectProfile();
    assert.deepEqual(session.device.uncaptured, [], 'GPU validation errors');
    assert.equal(drained.sunk, n, `${drained.sunk} of ${n} particles went down the drain`);
    assert.equal(drained.emitted, 0);
    assert.equal(app.mpmProfileMass(drained.layers), 0, 'the grid is empty');
    assert.equal(app.mpmTotals(cfg, await readParticles(solver), cfg.maxParticles).count, 0);
    // A second collect with nothing copied is a no-op, not a hang.
    assert.equal(await solver.collectProfile(), null);
    solver.destroy();
  });

  it('the export says who draws each particle: bulk liquid, spray, and bulk under a surface pass', async () => {
    const { app } = session;
    const F = app.mpm.MPM_PARTICLE_FLOATS;
    const cfg = app.mpm.mpmWaterConfig([20, 20, 20], 0.01, 1e-4, 8192, { gravity: [0, 0, 0] });
    // A block 8 cells on a side at rest, and three particles on their own.
    const block = app.seedMpmBox(cfg, { min: [0.04, 0.04, 0.04], max: [0.12, 0.12, 0.12] });
    const n = block.length / F;
    const lone = [[0.16, 0.16, 0.16], [0.03, 0.17, 0.05], [0.165, 0.04, 0.03]];
    const records = new Float32Array(block.length + lone.length * F);
    new Uint8Array(records.buffer).set(new Uint8Array(block.buffer, block.byteOffset, block.byteLength));
    lone.forEach((pos, i) => app.writeMpmParticle(records, n + i, pos));
    const solver = await makeSolver(cfg, { io: true });
    solver.writeParticles(records);
    const threshold = app.fluidSurface.FLUID_SPRAY_BELOW;

    const kinds = async (surface, sprayBelow) => {
      solver.exportSurface = surface;
      solver.sprayBelow = sprayBelow;
      submit((enc) => solver.encodeFrame(enc, 1));
      const drawn = new Float32Array(await readBuffer(session.device, solver.drawBuffer));
      const particles = await readParticles(solver);
      const gridVel = new Float32Array(await readBuffer(session.device, solver.gridVelBuffer));
      const count = { 9: 0, 10: 0, 11: 0 };
      let mismatched = 0;
      for (let p = 0; p < n + lone.length; p++) {
        const kind = Math.floor(drawn[p * 4 + 3]);
        count[kind]++;
        if (sprayBelow <= 0) continue;
        // The shader's verdict against the CPU twin on the very grid it read.
        const ratio = app.mpmDensityRatio(cfg, gridVel, [particles[p * F], particles[p * F + 1], particles[p * F + 2]]);
        if (Math.abs(ratio - sprayBelow) < 1e-4) continue;
        if ((kind === 10) !== (ratio < sprayBelow)) mismatched++;
      }
      return { count, mismatched };
    };

    // No threshold: nothing is spray, whoever draws.
    assert.deepEqual((await kinds(false, 0)).count, { 9: n + 3, 10: 0, 11: 0 });
    assert.deepEqual((await kinds(true, 0)).count, { 9: 0, 10: 0, 11: n + 3 });
    // With it: the three loners are spray; the block is liquid — also on its faces and corners.
    const plain = await kinds(false, threshold);
    assert.deepEqual(plain.count, { 9: n, 10: 3, 11: 0 });
    assert.equal(plain.mismatched, 0);
    const surfaced = await kinds(true, threshold);
    assert.deepEqual(surfaced.count, { 9: 0, 10: 3, 11: n });
    assert.equal(surfaced.mismatched, 0);
    // A higher threshold takes the block's edges and corners too (512 of its
    // particles here), exactly where the CPU twin says.
    const skin = await kinds(true, 0.6);
    assert.ok(skin.count[10] > 100 && skin.count[11] > 1000, JSON.stringify(skin.count));
    assert.equal(skin.mismatched, 0);
    assert.deepEqual(session.device.uncaptured, [], 'GPU validation errors');
    solver.destroy();
  });

  it('charged droplets: the GPU moves them as the CPU does, keeps their charge, and each sink counts its own', async () => {
    const { app } = session;
    const F = app.mpm.MPM_PARTICLE_FLOATS;
    const cfg = app.mpm.mpmWaterConfig([32, 40, 32], 0.01, 2.5e-4, 3000, { maxSpeedMS: 4 });
    const m = app.mpm.mpmDerived(cfg).particleMass;
    // Two drippers with opposite charge over two cans; each can's rim is a
    // ring at the sign of its own stream (a Kelvin dropper's cross-connection
    // seen from the drops), at 40 kV: below the threshold, so most still land.
    const emitters = [
      { centre: [0.10, 0.34, 0.16], direction: [0, -1, 0], radiusM: 0.004, speedMS: 0.4, spread: 0.3, chargeC: -5e-5 * m },
      { centre: [0.22, 0.34, 0.16], direction: [0, -1, 0], radiusM: 0.004, speedMS: 0.4, spread: 0.3, chargeC: 5e-5 * m }
    ];
    const conductors = [
      { centre: [0.10, 0.07, 0.16], radiusM: 0.04, kq: -40000 * 0.04, softM: 0.004 },
      { centre: [0.22, 0.07, 0.16], radiusM: 0.04, kq: 40000 * 0.04, softM: 0.004 },
      { centre: [0.16, 0.30, 0.16], radiusM: 0, kq: 300, softM: 0.01 }
    ];
    const sinks = [
      { min: [0.06, 0.04, 0.12], max: [0.14, 0.06, 0.20] },
      { min: [0.18, 0.04, 0.12], max: [0.26, 0.06, 0.20] },
      { min: [0, 0, 0], max: [0.32, 0.06, 0.32] }
    ];
    const frames = 420;
    const sub = 4;

    const cpu = new app.MpmCpu(cfg);
    cpu.conductors = conductors;
    const carry = [];
    let base = 0;
    for (let f = 0; f < frames; f++) {
      const counts = app.mpm.mpmEmitCounts(cfg, emitters, sub * cfg.dt, carry);
      cpu.emit({ emitters, counts, seconds: sub * cfg.dt, baseId: base, sinks });
      base += counts[0] + counts[1];
      cpu.step(sub);
    }

    const solver = await makeSolver(cfg, { io: true });
    solver.emitters = emitters;
    solver.sinks = sinks;
    solver.setConductors(conductors);
    for (let f = 0; f < frames - 1; f++) submit((enc) => solver.encodeFrame(enc, sub));
    submit((enc) => solver.encodeFrame(enc, sub, { probe: true }));
    const profile = await solver.collectProfile();
    const particles = await readParticles(solver);
    assert.deepEqual(session.device.uncaptured, [], 'GPU validation errors');

    // The same drops, in the same places.
    const vs = compareSets(app, particles, cpu.particles);
    assert.equal(vs.unmatched, 0, 'a particle exists on one side only');
    assert.ok(vs.live > 10, `${vs.live} drops in the air`);
    assert.ok(vs.pos < 0.02 * cfg.cellM, `a drop is ${(vs.pos / cfg.cellM).toFixed(4)} cells from its CPU twin`);
    assert.ok(vs.vel < 0.02, `velocity differs by ${vs.vel} m/s`);
    // Charge is what its emitter gave it — the CPU twin's, drop for drop — and nothing else.
    const onGpu = bySeed(app, particles);
    const onCpu = bySeed(app, cpu.particles);
    const charges = new Set([Math.fround(emitters[0].chargeC), Math.fround(emitters[1].chargeC)]);
    let negative = 0, positive = 0;
    for (const [seed, o] of onGpu) {
      const charge = particles[o + app.mpm.MPM_P.charge];
      assert.ok(charges.has(charge), `a drop carries ${charge}`);
      assert.equal(charge, cpu.particles[onCpu.get(seed) + app.mpm.MPM_P.charge]);
      if (charge < 0) negative++; else positive++;
    }
    assert.ok(negative > 3 && positive > 3, `${negative} negative and ${positive} positive drops`);
    // Each sink's own count, and their sum.
    assert.deepEqual(profile.sunkBy, cpu.sunkBy, 'per-sink counts');
    assert.equal(profile.sunk, cpu.sunk);
    assert.equal(profile.sunkBy.reduce((a, n) => a + n, 0), profile.sunk);
    // The third conductor makes the two sides differ: drops went to more than one sink, and the counts say which.
    assert.ok(profile.sunk > 30 && profile.sunkBy.filter((n) => n > 10).length >= 2, JSON.stringify(profile.sunkBy));
    assert.equal(profile.emitted, cpu.emitted);

    // Without the conductors the same charged drops fall straight: the field is what moved them.
    const still = await makeSolver(cfg, { io: true });
    still.emitters = emitters;
    still.sinks = sinks;
    for (let f = 0; f < 200; f++) submit((enc) => still.encodeFrame(enc, sub));
    const straight = await readParticles(still);
    let widest = 0, widestCharged = 0;
    for (let p = 0; p < cfg.maxParticles; p++) {
      // Its nozzle, by the sign it left with.
      const nozzleX = (rec) => (rec[p * F + app.mpm.MPM_P.charge] < 0 ? 0.10 : 0.22);
      if (straight[p * F + app.mpm.MPM_P.state] !== 0 && straight[p * F + 1] > 0.1) widest = Math.max(widest, Math.abs(straight[p * F] - nozzleX(straight)));
      if (particles[p * F + app.mpm.MPM_P.state] !== 0 && particles[p * F + 1] > 0.1) widestCharged = Math.max(widestCharged, Math.abs(particles[p * F] - nozzleX(particles)));
    }
    assert.deepEqual(session.device.uncaptured, [], 'GPU validation errors');
    console.log(`  ${vs.live} charged drops: max |GPU − CPU| ${(vs.pos / cfg.cellM).toExponential(2)} cells; sinks ${JSON.stringify(profile.sunkBy)}; `
      + `stream width ${(widest * 1000).toFixed(1)} mm without the field, ${(widestCharged * 1000).toFixed(1)} mm with it`);
    assert.ok(widestCharged > widest, 'the field did not widen the streams');
    solver.destroy();
    still.destroy();
  });

  it('a jet stands v²/2g tall, within 10 %, and the books balance', async () => {
    const { app } = session;
    const h = 0.005;
    const v = 1.4;
    const cfg = app.mpm.mpmWaterConfig([16, 40, 16], h, 2.5e-4, 6000, { maxSpeedMS: 2 * v });
    const b = app.mpm.mpmBounds(cfg);
    const y0 = b.min[1] + 3 * h;
    const radiusM = 0.006;
    const solver = await makeSolver(cfg, { io: true });
    solver.emitters = [{ centre: [8 * h, y0, 8 * h], direction: [0, 1, 0], radiusM, speedMS: v, spread: 0 }];
    solver.sinks = [{ min: [0, 0, 0], max: [16 * h, b.min[1] + 1.2 * h, 16 * h] }];
    const threshold = (0.1 * Math.PI * radiusM ** 2 * cfg.particlesPerCell) / (h * h);
    const tops = [];
    let last = null;
    for (let f = 0; f < 320; f++) {
      submit((enc) => solver.encodeFrame(enc, 4, { probe: true }));
      const profile = await solver.collectProfile();
      if (profile) {
        tops.push(app.mpmProfileTop(cfg, profile.layers, threshold) - y0);
        last = profile;
      }
    }
    assert.deepEqual(session.device.uncaptured, [], 'GPU validation errors');
    assert.ok(tops.length > 300, `only ${tops.length} profiles came back`);
    const tail = tops.slice(-80);
    const steady = tail.reduce((a, x) => a + x, 0) / tail.length;
    const ideal = (v * v) / (2 * G);
    assert.ok(Math.abs(steady / ideal - 1) < 0.1, `jet top ${(steady * 100).toFixed(2)} cm, v²/2g = ${(ideal * 100).toFixed(2)} cm`);
    const t = app.mpmTotals(cfg, await readParticles(solver), cfg.maxParticles);
    assert.ok(t.finite);
    // The profile is from before this read; the counters only grow, so re-probe once more to compare like with like.
    submit((enc) => solver.encodeFrame(enc, 4, { probe: true }));
    const end = await solver.collectProfile();
    const now = app.mpmTotals(cfg, await readParticles(solver), cfg.maxParticles);
    assert.equal(now.count, end.emitted - end.sunk, 'live = emitted − removed');
    assert.equal(end.emitted, solver.emitRequested, 'every particle asked for was made');
    assert.ok(last.sunk > 0, 'the fallen water reached the drain');
    console.log(`  jet at ${v} m/s: top ${(steady / ideal).toFixed(3)} of v²/2g (${(ideal / h).toFixed(1)} cells); ${now.count} live, ${end.emitted} emitted, ${end.sunk} drained`);
    solver.destroy();
  });
});
