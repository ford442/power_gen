/**
 * MLS-MPM liquid solver, without a GPU — what a bench adds around the core
 * (ADR-0022): solid boundaries, emitters, sinks and the height profile.
 *
 *   1. mpm-boundary.ts: signed distances of the primitives, the baked field
 *   2. mpm-params.ts: the emitter / sink uniform against its WGSL struct, how
 *      many particles a flow owes, where a new particle goes
 *   3. mpm-cpu.ts: a vessel holds water, a sink empties it, a jet rises to
 *      v²/2g, and emitted − removed = what is in the box
 *
 * The WGSL twins run in scripts/tests/gpu/golden-mpm-io.test.mjs.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ROOT, bundleTs } from '../test-harness.mjs';

const M = await bundleTs({
  contents: `
    export * from './src/fluids/mpm-params.ts';
    export * from './src/fluids/mpm-cpu.ts';
    export * from './src/fluids/mpm-seed.ts';
    export * from './src/fluids/mpm-boundary.ts';
  `,
  sourcefile: 'mpm-io-entry.ts'
});

const G = 9.80665;
const F = M.MPM_PARTICLE_FLOATS;
const near = (a, b, tol) => Math.abs(a - b) <= tol;

/** Byte layout of a WGSL struct of scalars, vec3s and fixed arrays of other structs in the same source. */
function wgslStruct(source, name) {
  const body = source.match(new RegExp(`struct ${name} \\{([^}]*)\\}`))?.[1];
  assert.ok(body, `struct ${name} not found`);
  const scalar = { f32: [4, 4], u32: [4, 4], i32: [4, 4], vec3f: [12, 16], vec3u: [12, 16], vec4f: [16, 16] };
  let offset = 0;
  let align = 1;
  const fields = {};
  for (const m of body.matchAll(/(\w+)\s*:\s*(array<(\w+),\s*(\d+)>|\w+)\s*,/g)) {
    let size;
    let a;
    if (m[3]) {
      const inner = wgslStruct(source, m[3]);
      size = inner.bytes * Number(m[4]);
      a = inner.align;
    } else {
      assert.ok(scalar[m[2]], `${name}.${m[1]}: type ${m[2]} is not one this check knows`);
      [size, a] = scalar[m[2]];
    }
    offset = Math.ceil(offset / a) * a;
    fields[m[1]] = offset;
    offset += size;
    align = Math.max(align, a);
  }
  return { bytes: Math.ceil(offset / align) * align, align, fields };
}

describe('mpm-boundary: primitives', () => {
  it('box, cylinder, tube and cup: negative inside, zero on the surface, the distance outside', () => {
    const box = { kind: 'box', min: [0, 0, 0], max: [2, 1, 4] };
    assert.ok(near(M.mpmSolidDistance(box, 1, 0.5, 2), -0.5, 1e-12));
    assert.ok(near(M.mpmSolidDistance(box, 3, 0.5, 2), 1, 1e-12));
    assert.ok(near(M.mpmSolidDistance(box, 5, 5, 2), 5, 1e-12), 'corner distance is Euclidean');

    const cyl = { kind: 'cylinder', base: [1, 0, 1], radiusM: 0.5, heightM: 2 };
    assert.ok(near(M.mpmSolidDistance(cyl, 1, 1, 1), -0.5, 1e-12));
    assert.ok(near(M.mpmSolidDistance(cyl, 2, 1, 1), 0.5, 1e-12));
    assert.ok(near(M.mpmSolidDistance(cyl, 1, 2.3, 1), 0.3, 1e-12));
    assert.ok(near(M.mpmSolidDistance(cyl, 1.5, 1, 1), 0, 1e-12));

    const tube = { kind: 'tube', base: [0, 0, 0], innerRadiusM: 0.2, outerRadiusM: 0.3, heightM: 1 };
    assert.ok(M.mpmSolidDistance(tube, 0, 0.5, 0) > 0, 'the bore is open');
    assert.ok(near(M.mpmSolidDistance(tube, 0, 0.5, 0), 0.2, 1e-12));
    assert.ok(near(M.mpmSolidDistance(tube, 0.25, 0.5, 0), -0.05, 1e-12));

    const cup = { kind: 'cup', base: [0, 0, 0], innerRadiusM: 0.2, outerRadiusM: 0.3, floorM: 0.1, heightM: 0.5 };
    assert.ok(near(M.mpmSolidDistance(cup, 0, 0.3, 0), 0.2, 1e-12), 'inside the cavity: distance to the wall');
    assert.ok(near(M.mpmSolidDistance(cup, 0, 0.15, 0), 0.05, 1e-12), 'just above the floor');
    assert.ok(near(M.mpmSolidDistance(cup, 0, 0.05, 0), -0.05, 1e-12), 'in the floor');
    assert.ok(near(M.mpmSolidDistance(cup, 0.25, 0.3, 0), -0.05, 1e-12), 'in the wall');
    assert.ok(M.mpmSolidDistance(cup, 0, 0.8, 0) > 0, 'open at the top');
    assert.equal(M.mpmSolidsDistance([], 0, 0, 0), Infinity);
    assert.ok(near(M.mpmSolidsDistance([box, cyl], 1, 0.5, 1), Math.min(M.mpmSolidDistance(box, 1, 0.5, 1), M.mpmSolidDistance(cyl, 1, 0.5, 1)), 0));
  });

  it('the baked field: distances on the nodes, unit normals pointing out of the solid, sampled trilinearly', () => {
    const cfg = M.mpmWaterConfig([16, 16, 16], 0.01, 2.5e-4, 100);
    const cup = { kind: 'cup', base: [0.08, 0.02, 0.08], innerRadiusM: 0.04, outerRadiusM: 0.065, floorM: 0.025, heightM: 0.08 };
    const field = M.bakeMpmBoundary(cfg, [cup]);
    assert.equal(field.length, 16 ** 3 * M.MPM_BOUNDARY_FLOATS);
    let inside = 0;
    for (let k = 0; k < 16; k++) for (let j = 0; j < 16; j++) for (let i = 0; i < 16; i++) {
      const o = ((k * 16 + j) * 16 + i) * 4;
      const d = M.mpmSolidDistance(cup, i * 0.01, j * 0.01, k * 0.01);
      assert.ok(near(field[o + 3], d, 1e-6), `node ${i},${j},${k}: ${field[o + 3]} vs ${d}`);
      const len = Math.hypot(field[o], field[o + 1], field[o + 2]);
      if (Math.abs(d) < 0.03 && len > 0) assert.ok(near(len, 1, 1e-5), `normal length ${len}`);
      if (Math.abs(d) >= 0.03) assert.equal(len, 0, 'no normal far from every surface');
      if (d < 0) inside++;
    }
    assert.ok(inside > 200, `${inside} nodes inside the cup: too thin to hold anything`);
    // On the floor of the cavity the normal points up; inside the wall it points to the nearer face.
    const up = M.sampleMpmBoundary(cfg, field, 0.08, 0.045, 0.08);
    assert.ok(near(up[3], 0, 2e-3) && up[1] > 0.9, `cavity floor: ${up}`);
    const wall = M.sampleMpmBoundary(cfg, field, 0.08 + 0.045, 0.08, 0.08);
    assert.ok(wall[3] < 0 && wall[0] < -0.5, `inner face of the wall: normal ${wall} should point back into the cavity`);
    const free = M.sampleMpmBoundary(cfg, field, 0.08, 0.14, 0.08);
    assert.ok(free[3] > 0.02);
    assert.throws(() => new M.MpmCpu(cfg).setBoundary(new Float32Array(8)), /does not match the grid/);
  });
});

describe('mpm-params: emitters and sinks', () => {
  const wgsl = readFileSync(join(ROOT, 'src/shaders/common/mpm.wgsl'), 'utf8');
  const cfg = M.mpmWaterConfig([16, 32, 16], 0.01, 2.5e-4, 5000);
  const nozzle = { centre: [0.08, 0.05, 0.08], direction: [0, 2, 0], radiusM: 0.012, speedMS: 1.5, spread: 0.05 };

  it('MpmIoParams is packed where the WGSL struct reads it', () => {
    const io = wgslStruct(wgsl, 'MpmIoParams');
    const em = wgslStruct(wgsl, 'MpmEmitter');
    const sk = wgslStruct(wgsl, 'MpmSink');
    assert.equal(io.bytes, M.MPM_IO_PARAMS_BYTES);
    assert.equal(em.bytes, 48);
    assert.equal(sk.bytes, 32);
    const second = { ...nozzle, centre: [0.03, 0.2, 0.04], direction: [1, 0, 0], speedMS: 0.7 };
    const buf = M.packMpmIoParams(cfg, {
      emitters: [nozzle, second], counts: [11, 7], seconds: 0.004, baseId: 1000,
      sinks: [{ min: [0, 0, 0], max: [0.16, 0.02, 0.16] }], exportOrigin: [1, 2, 3], exportScale: 12.5
    });
    const f = new Float32Array(buf);
    const u = new Uint32Array(buf);
    const e1 = (io.fields.emitters + em.bytes) / 4;
    assert.deepEqual([...f.subarray(em.fields.centre / 4, em.fields.centre / 4 + 3)], nozzle.centre.map(Math.fround));
    assert.deepEqual([...f.subarray(em.fields.dir / 4, em.fields.dir / 4 + 3)], [0, 1, 0], 'direction is normalised');
    assert.equal(f[em.fields.radius / 4], Math.fround(0.012));
    assert.equal(f[em.fields.speed / 4], 1.5);
    assert.equal(u[em.fields.count / 4], 11);
    assert.equal(u[em.fields.baseId / 4], 1000);
    assert.equal(f[em.fields.length / 4], Math.fround(1.5 * 0.004));
    assert.equal(f[em.fields.spread / 4], Math.fround(0.05));
    assert.equal(u[e1 + em.fields.count / 4], 7);
    assert.equal(u[e1 + em.fields.baseId / 4], 1011, 'the second emitter continues the id sequence');
    assert.equal(f[e1 + em.fields.speed / 4], Math.fround(0.7));
    const s0 = io.fields.sinks / 4;
    assert.equal(f[s0 + sk.fields.on / 4], 1);
    assert.equal(f[s0 + sk.fields.hi / 4 + 1], Math.fround(0.02));
    assert.equal(f[s0 + sk.bytes / 4 + sk.fields.on / 4], 0, 'the unused sink is off');
    assert.deepEqual([...f.subarray(io.fields.exportOrigin / 4, io.fields.exportOrigin / 4 + 3)], [1, 2, 3]);
    assert.equal(f[io.fields.exportScale / 4], 12.5);
    assert.equal(u[io.fields.capacity / 4], 5000);
    assert.throws(() => M.packMpmIoParams(cfg, { emitters: [nozzle, nozzle, nozzle], counts: [], seconds: 0, baseId: 0, sinks: [], exportOrigin: [0, 0, 0], exportScale: 1 }), /emitters/);
  });

  it('a flow owes Q·t / V₀ particles, exactly over many frames', () => {
    const carry = [];
    let total = 0;
    const frames = 5000;
    const seconds = 4 * cfg.dt;
    for (let i = 0; i < frames; i++) {
      const [n] = M.mpmEmitCounts(cfg, [nozzle], seconds, carry);
      assert.ok(Number.isInteger(n) && n >= 0);
      assert.ok(carry[0] >= 0 && carry[0] < 1);
      total += n;
    }
    const owed = (M.mpmEmitterFlow(nozzle) * seconds * frames) / M.mpmDerived(cfg).particleVolume;
    assert.ok(near(M.mpmEmitterFlow(nozzle), Math.PI * 0.012 ** 2 * 1.5, 1e-15));
    assert.ok(Math.abs(total - owed) < 1, `${total} particles for ${owed} owed`);
  });

  it('new particles fill the swept cylinder evenly and leave at the nozzle speed', () => {
    const count = 4000;
    const length = 0.03;
    let r2 = 0;
    let along = 0;
    let worstAngle = 0;
    const seen = new Set();
    for (let t = 0; t < count; t++) {
      const { pos, vel } = M.mpmEmitParticle(nozzle, 500 + t, t, count, length);
      const dx = pos[0] - nozzle.centre[0];
      const dz = pos[2] - nozzle.centre[2];
      const a = pos[1] - nozzle.centre[1];
      const r = Math.hypot(dx, dz);
      assert.ok(r <= nozzle.radiusM + 1e-12 && a >= 0 && a < length);
      assert.ok(near(Math.hypot(...vel), nozzle.speedMS, 1e-12));
      // Stratified: ticket t sits in slice t of `count`.
      assert.equal(Math.floor((a / length) * count + 1e-9), t);
      worstAngle = Math.max(worstAngle, Math.acos(vel[1] / nozzle.speedMS));
      // The spread is radial: velocity leans the way the particle is off-axis.
      if (r > 1e-4) assert.ok((vel[0] * dx + vel[2] * dz) > 0);
      r2 += r * r;
      along += a;
      seen.add(`${pos[0].toFixed(9)},${pos[2].toFixed(9)}`);
    }
    assert.ok(near(r2 / count / nozzle.radiusM ** 2, 0.5, 0.03), `mean r²/R² = ${r2 / count / nozzle.radiusM ** 2} (uniform over a disc: ½)`);
    assert.ok(near(along / count / length, 0.5, 0.01));
    assert.ok(worstAngle <= Math.atan(nozzle.spread) + 1e-9 && worstAngle > 0.9 * Math.atan(nozzle.spread));
    assert.equal(seen.size, count, 'no two particles share a spot in the disc');
    // The same id gives the same particle, on every call.
    assert.deepEqual(M.mpmEmitParticle(nozzle, 7, 3, 10, 0.01), M.mpmEmitParticle(nozzle, 7, 3, 10, 0.01));
    // A sideways nozzle: the disc stands on edge.
    const side = M.mpmEmitParticle({ ...nozzle, direction: [1, 0, 0], spread: 0 }, 9, 0, 1, 0.01);
    assert.ok(side.vel[0] === nozzle.speedMS && side.vel[1] === 0 && side.vel[2] === 0);
    assert.ok(side.pos[0] >= nozzle.centre[0] && Math.hypot(side.pos[1] - nozzle.centre[1], side.pos[2] - nozzle.centre[2]) <= nozzle.radiusM);
  });

  it('the hash is the one the shaders use', () => {
    // lowbias32 against big-integer arithmetic; mpmHash01 keeps 24 bits, exact in f32.
    const ref = (n) => {
      let x = BigInt(n) & 0xffffffffn;
      x = ((x ^ (x >> 16n)) * 0x7feb352dn) & 0xffffffffn;
      x = ((x ^ (x >> 15n)) * 0x846ca68bn) & 0xffffffffn;
      return Number(x ^ (x >> 16n));
    };
    for (const n of [0, 1, 2, 12345, 0x7fffffff, 0x80000000, 0xffffffff]) {
      assert.equal(M.mpmHash32(n), ref(n));
      const h = M.mpmHash01(n);
      assert.ok(h >= 0 && h < 1 && Math.fround(h) === h);
    }
    assert.equal(M.mpmHash32(2 ** 32 + 5), M.mpmHash32(5), 'ids wrap like a u32');
  });
});

describe('mpm-cpu: a vessel, a drain', () => {
  const grid = [16, 20, 16];
  const h = 0.01;
  const cup = { kind: 'cup', base: [0.08, 0.02, 0.08], innerRadiusM: 0.04, outerRadiusM: 0.065, floorM: 0.03, heightM: 0.11 };
  const water = { min: [0.055, 0.06, 0.055], max: [0.105, 0.1, 0.105] };

  function filled(maxParticles = 2000) {
    const cfg = M.mpmWaterConfig(grid, h, 2.5e-4, maxParticles, { maxSpeedMS: 3 });
    const sim = new M.MpmCpu(cfg);
    sim.setBoundary(M.bakeMpmBoundary(cfg, [cup]));
    sim.setParticles(M.seedMpmBox(cfg, water));
    return { cfg, sim };
  }

  it('a cup holds the water dropped into it', () => {
    const { cfg, sim } = filled();
    const n = sim.count;
    sim.step(900);
    const t = M.mpmTotals(cfg, sim.particles, sim.count);
    assert.equal(t.count, n);
    assert.ok(t.finite && t.maxSpeed < 0.05, `still moving at ${t.maxSpeed} m/s`);
    let deepest = Infinity;
    for (let p = 0; p < sim.count; p++) {
      const x = sim.particles[p * F], y = sim.particles[p * F + 1], z = sim.particles[p * F + 2];
      const r = Math.hypot(x - cup.base[0], z - cup.base[2]);
      assert.ok(r < cup.innerRadiusM + 0.3 * h, `particle ${p} is ${r} m off-axis: through the wall`);
      assert.ok(M.mpmSolidDistance(cup, x, y, z) > -0.3 * h, `particle ${p} is inside the solid`);
      deepest = Math.min(deepest, y);
    }
    const floor = cup.base[1] + cup.floorM;
    assert.ok(deepest > floor - 0.3 * h && deepest < floor + h, `lowest particle at ${deepest}, cavity floor at ${floor}`);
    // The pool is as deep as its volume says: N·V₀ over the cavity's cross-section.
    const depth = (n * M.mpmDerived(cfg).particleVolume) / (Math.PI * cup.innerRadiusM ** 2);
    const prof = M.mpmLayerProfile(cfg, sim.gridVel);
    assert.ok(near(M.mpmProfileMass(prof), n, 0.5), `profile mass ${M.mpmProfileMass(prof)} for ${n} particles`);
    const top = M.mpmProfileTop(cfg, prof, 0.25 * n / (depth / h)) - floor;
    assert.ok(near(top / depth, 1, 0.2), `pool top ${top} m above the floor, volume says ${depth}`);
  });

  it('without the cup the same water ends on the floor of the box', () => {
    const cfg = M.mpmWaterConfig(grid, h, 2.5e-4, 2000, { maxSpeedMS: 3 });
    const sim = new M.MpmCpu(cfg);
    sim.setParticles(M.seedMpmBox(cfg, water));
    sim.step(900);
    assert.ok(M.mpmTotals(cfg, sim.particles, sim.count).centre[1] < 0.025);
  });

  it('a sink removes what enters it, and the books balance', () => {
    const { cfg, sim } = filled();
    const n = sim.count;
    // A drain across the whole cavity, the bottom 1.2 cm of it; nothing is emitted.
    const io = { emitters: [], counts: [], seconds: 4 * cfg.dt, baseId: 0, sinks: [{ min: [0.03, 0.04, 0.03], max: [0.13, 0.062, 0.13] }] };
    let last = n;
    for (let f = 0; f < 200; f++) {
      sim.emit(io);
      sim.step(4);
      const live = M.mpmTotals(cfg, sim.particles, sim.count).count;
      assert.ok(live <= last, 'a sink never adds');
      assert.equal(live, n - sim.sunk, 'live = seeded − removed');
      last = live;
    }
    assert.equal(sim.emitted, 0);
    assert.equal(sim.sunk, n, `${sim.sunk} of ${n} drained`);
    assert.equal(sim.count, cfg.maxParticles, 'every slot is visited once slots can be reused');
  });
});

describe('mpm-cpu: a jet', () => {
  /** A vertical nozzle near the floor of a tall box, a drain plane under it. */
  function jet({ v, radiusM = 0.006, gridY = 28, frames = 260, spread = 0 }) {
    const h = 0.005;
    const cfg = M.mpmWaterConfig([16, gridY, 16], h, 2.5e-4, 6000, { maxSpeedMS: 2 * v });
    const b = M.mpmBounds(cfg);
    const sim = new M.MpmCpu(cfg);
    const y0 = b.min[1] + 3 * h;
    const emitters = [{ centre: [8 * h, y0, 8 * h], direction: [0, 1, 0], radiusM, speedMS: v, spread }];
    const sinks = [{ min: [0, 0, 0], max: [16 * h, b.min[1] + 1.2 * h, 16 * h] }];
    // A layer of the nozzle's own cross-section holds π R² h / V₀ particles; a tenth of that is "liquid here".
    const threshold = (0.1 * Math.PI * radiusM ** 2 * cfg.particlesPerCell) / (h * h);
    const carry = [];
    const tops = [];
    let base = 0;
    for (let f = 0; f < frames; f++) {
      const seconds = 4 * cfg.dt;
      const counts = M.mpmEmitCounts(cfg, emitters, seconds, carry);
      sim.emit({ emitters, counts, seconds, baseId: base, sinks });
      base += counts[0];
      sim.step(4);
      tops.push(M.mpmProfileTop(cfg, M.mpmLayerProfile(cfg, sim.gridVel), threshold) - y0);
    }
    const tail = tops.slice(-80);
    return { cfg, sim, requested: base, steady: tail.reduce((a, x) => a + x, 0) / tail.length, ideal: (v * v) / (2 * G) };
  }

  for (const v of [1.0, 1.4]) {
    it(`leaving at ${v} m/s it stands v²/2g tall, within 10 %`, () => {
      const r = jet({ v, gridY: v > 1.2 ? 40 : 28, frames: v > 1.2 ? 320 : 260 });
      assert.ok(Math.abs(r.steady / r.ideal - 1) < 0.1, `jet top ${(r.steady * 100).toFixed(2)} cm, v²/2g = ${(r.ideal * 100).toFixed(2)} cm`);
      // Every particle asked for was made (the budget never ran out), and none vanished unaccounted.
      assert.equal(r.sim.emitted, r.requested);
      const t = M.mpmTotals(r.cfg, r.sim.particles, r.sim.count);
      assert.equal(t.count, r.sim.emitted - r.sim.sunk);
      assert.ok(t.finite);
      // Nothing crushes a free jet, and the falling half of it stretches as
      // it speeds up (a real stream thins and breaks there): mean J sits a
      // little over 1. Measured 1.06 and 1.09.
      const meanJ = t.volume / (t.count * M.mpmDerived(r.cfg).particleVolume);
      assert.ok(meanJ > 0.98 && meanJ < 1.2, `mean J ${meanJ}`);
    });
  }

  it('a faster jet is a taller one, by the square', () => {
    const a = jet({ v: 1.0 });
    const b = jet({ v: 1.4, gridY: 40, frames: 320 });
    assert.ok(near(b.steady / a.steady, 1.96, 0.2), `height ratio ${b.steady / a.steady} for a speed ratio of 1.4`);
  });

  it('when the budget runs out the emitter makes what fits and says so', () => {
    const h = 0.005;
    const cfg = M.mpmWaterConfig([16, 28, 16], h, 2.5e-4, 300, { maxSpeedMS: 2 });
    const sim = new M.MpmCpu(cfg);
    const emitters = [{ centre: [8 * h, 4 * h, 8 * h], direction: [0, 1, 0], radiusM: 0.006, speedMS: 1, spread: 0 }];
    const carry = [];
    let base = 0;
    for (let f = 0; f < 80; f++) {
      const counts = M.mpmEmitCounts(cfg, emitters, 4 * cfg.dt, carry);
      sim.emit({ emitters, counts, seconds: 4 * cfg.dt, baseId: base, sinks: [] });
      base += counts[0];
      sim.step(4);
    }
    assert.ok(base > 300, 'the case asks for more than the budget');
    assert.equal(sim.emitted, 300);
    assert.equal(M.mpmTotals(cfg, sim.particles, sim.count).count, 300);
  });
});

describe('mpm-cpu: the profile', () => {
  it('top of the liquid: the highest layer over the threshold, interpolated', () => {
    const cfg = M.mpmWaterConfig([8, 8, 8], 0.02, 5e-4, 10);
    assert.ok(near(M.mpmProfileTop(cfg, [0, 10, 10, 5, 0, 0, 0, 0], 2), (3 + 3 / 5) * 0.02, 1e-12));
    assert.ok(near(M.mpmProfileTop(cfg, [0, 10, 10, 10, 0, 0, 0, 0], 10), 3 * 0.02, 1e-12));
    assert.ok(Number.isNaN(M.mpmProfileTop(cfg, [0, 1, 1, 0, 0, 0, 0, 0], 2)), 'nothing reaches the threshold');
    // A lone droplet above does not count.
    assert.ok(M.mpmProfileTop(cfg, [0, 10, 10, 0, 0, 1, 0, 0], 2) < 3 * 0.02);
    assert.equal(M.mpmProfileMass([1, 2, 3.5]), 6.5);
  });
});

describe('mpm: charged liquid in the field of conductors', () => {
  const lone = (cfg, pos, vel, charge) => {
    const records = new Float32Array(F);
    M.writeMpmParticle(records, 0, pos, vel);
    records[M.MPM_P.charge] = charge;
    const sim = new M.MpmCpu(cfg);
    sim.setParticles(records);
    return sim;
  };

  it('a ring\'s field: exact on its axis, close to a fine quadrature off it, zero net pull at its centre', () => {
    const ring = { centre: [0.1, 0.2, 0.3], radiusM: 0.04, kq: 1800, softM: 0 };
    // On the axis: E = kq·y / (y² + R²)^(3/2), along the axis.
    for (const y of [-0.09, -0.02, 0.01, 0.04, 0.15]) {
      const e = M.mpmFieldAt([ring], 0.1, 0.2 + y, 0.3);
      const want = (ring.kq * y) / (y * y + ring.radiusM ** 2) ** 1.5;
      assert.ok(Math.abs(e[1] - want) < 1e-9 * Math.abs(want) + 1e-9, `axis y=${y}: ${e[1]} vs ${want}`);
      assert.ok(Math.abs(e[0]) < 1e-6 && Math.abs(e[2]) < 1e-6, `off-axis components ${e[0]}, ${e[2]}`);
    }
    assert.ok(Math.hypot(...M.mpmFieldAt([ring], 0.1, 0.2, 0.3)) < 1e-6);
    // Off the axis, against the same ring cut into 720 pieces.
    const fine = (x, y, z) => {
      const e = [0, 0, 0];
      for (let i = 0; i < 720; i++) {
        const a = (2 * Math.PI * (i + 0.5)) / 720;
        const r = [x - (0.1 + Math.cos(a) * 0.04), y - 0.2, z - (0.3 + Math.sin(a) * 0.04)];
        const d = Math.hypot(...r);
        for (let k = 0; k < 3; k++) e[k] += (ring.kq / 720) * r[k] / d ** 3;
      }
      return e;
    };
    let worst = 0;
    for (const [dx, dy, dz] of [[0.09, 0, 0], [0.07, 0.05, 0.02], [0.02, 0.04, 0.01], [0.01, 0.03, 0], [0.0, -0.05, 0.085], [0.12, 0.1, -0.05]]) {
      const got = M.mpmFieldAt([ring], 0.1 + dx, 0.2 + dy, 0.3 + dz);
      const want = fine(0.1 + dx, 0.2 + dy, 0.3 + dz);
      worst = Math.max(worst, Math.hypot(got[0] - want[0], got[1] - want[1], got[2] - want[2]) / Math.hypot(...want));
    }
    // Twelve points: a few percent a ring radius or more from the wire.
    assert.ok(worst < 0.05, `12-point ring is ${(worst * 100).toFixed(2)} % off the fine ring`);
    // A point conductor is Coulomb's law; softening caps it at the centre.
    const point = { centre: [0, 0, 0], radiusM: 0, kq: 900, softM: 0.01 };
    assert.ok(Math.abs(M.mpmFieldAt([point], 0.3, 0, 0)[0] - 900 / (0.09 + 1e-4) ** 1.5 * 0.3) < 1e-6);
    assert.equal(Math.hypot(...M.mpmFieldAt([point], 0, 0, 0)), 0);
    // The field is minus the gradient of the potential.
    const eps = 1e-5;
    const e = M.mpmFieldAt([ring, point], 0.17, 0.23, 0.31);
    const grad = [0, 1, 2].map((k) => {
      const p = [0.17, 0.23, 0.31], q = [0.17, 0.23, 0.31];
      p[k] += eps; q[k] -= eps;
      return -(M.mpmPotentialAt([ring, point], ...p) - M.mpmPotentialAt([ring, point], ...q)) / (2 * eps);
    });
    for (let k = 0; k < 3; k++) assert.ok(Math.abs(e[k] - grad[k]) < 1e-4 * Math.hypot(...e), `E[${k}] ${e[k]} vs −∇V ${grad[k]}`);
  });

  it('a charged drop passing a like-charged conductor: kinetic + q·V + m·g·y is kept, and it is thrown aside', () => {
    const cfg = M.mpmWaterConfig([24, 48, 24], 0.01, 2.5e-4, 64, { maxSpeedMS: 6 });
    const d = M.mpmDerived(cfg);
    // A collector at 20 kV, 3 cm in radius (kq = V·R), and a drop charged to 4e-5 C/kg,
    // let go 32 cm above it and 5 mm off its axis.
    const collector = { centre: [0.12, 0.08, 0.12], radiusM: 0, kq: 20000 * 0.03, softM: 0.005 };
    const q = 4e-5 * d.particleMass;
    const sim = lone(cfg, [0.125, 0.40, 0.118], [0, 0, 0], q);
    sim.conductors = [collector];
    const energy = () => {
      const P = sim.particles;
      const v2 = P[4] ** 2 + P[5] ** 2 + P[6] ** 2;
      return 0.5 * d.particleMass * v2 + q * M.mpmPotentialAt([collector], P[0], P[1], P[2]) + d.particleMass * G * P[1];
    };
    const e0 = energy();
    const scale = d.particleMass * G * 0.3; // what falling 30 cm is worth
    // Until just before it reaches the floor: a wall takes the normal speed, and the energy with it.
    let worst = 0;
    let closest = Infinity;
    for (let s = 0; s < 1200; s++) {
      sim.step();
      const P = sim.particles;
      assert.ok(P[0] > 0.02 && P[0] < 0.22 && P[1] > 0.02 && P[2] > 0.02 && P[2] < 0.22, `the drop reached a wall at substep ${s}`);
      worst = Math.max(worst, Math.abs(energy() - e0));
      closest = Math.min(closest, Math.hypot(P[0] - 0.12, P[1] - 0.08, P[2] - 0.12));
    }
    // Symplectic Euler at 0.25 ms, through a field of megavolts per metre: under a percent.
    assert.ok(worst < 0.01 * scale, `energy moved by ${(worst / scale * 100).toFixed(3)} % of m·g·(0.3 m)`);
    // Deflected, not absorbed: it came within a centimetre and left 6 cm to the side.
    assert.ok(closest < 0.015, `closest approach ${closest} m`);
    assert.ok(sim.particles[0] - 0.125 > 0.05, `ended at x = ${sim.particles[0]}`);
    // The same drop, uncharged, falls straight.
    const neutral = lone(cfg, [0.125, 0.40, 0.118], [0, 0, 0], 0);
    neutral.conductors = [collector];
    for (let s = 0; s < 1200; s++) neutral.step();
    assert.ok(Math.abs(neutral.particles[0] - 0.125) < 1e-4, `the neutral drop drifted to x = ${neutral.particles[0]}`);
  });

  it('q·E = m·g holds a drop where it is; a neutral drop is not moved by any conductor', () => {
    const cfg = M.mpmWaterConfig([16, 32, 16], 0.01, 2.5e-4, 64);
    const d = M.mpmDerived(cfg);
    const below = { centre: [0.08, 0.05, 0.08], radiusM: 0, kq: 600, softM: 0 };
    const r = 0.15;
    const q = (d.particleMass * G * r * r) / below.kq;
    const sim = lone(cfg, [0.08, 0.05 + r, 0.08], [0, 0, 0], q);
    sim.conductors = [below];
    for (let s = 0; s < 40; s++) sim.step();
    // 10 ms of free fall would be 0.5 mm and 0.1 m/s.
    assert.ok(Math.abs(sim.particles[1] - (0.05 + r)) < 2e-5, `it moved to ${sim.particles[1]}`);
    assert.ok(Math.abs(sim.particles[5]) < 5e-3, `vy = ${sim.particles[5]}`);

    const a = lone(cfg, [0.07, 0.2, 0.09], [0.1, 0, -0.05], 0);
    const b = lone(cfg, [0.07, 0.2, 0.09], [0.1, 0, -0.05], 0);
    b.conductors = [below, { centre: [0.08, 0.25, 0.08], radiusM: 0.03, kq: -4000, softM: 0.002 }];
    for (let s = 0; s < 200; s++) { a.step(); b.step(); }
    assert.deepEqual(new Uint32Array(b.particles.buffer, 0, F), new Uint32Array(a.particles.buffer, 0, F));
  });

  it('each emitter gives its particles its own charge, and each sink counts what it took', () => {
    const cfg = M.mpmWaterConfig([24, 24, 24], 0.01, 2.5e-4, 2000, { maxSpeedMS: 3 });
    const emitters = [
      { centre: [0.07, 0.18, 0.12], direction: [0, -1, 0], radiusM: 0.006, speedMS: 0.5, spread: 0, chargeC: -3e-9 },
      { centre: [0.17, 0.18, 0.12], direction: [0, -1, 0], radiusM: 0.006, speedMS: 0.5, spread: 0, chargeC: 2e-9 }
    ];
    // A can under each nozzle, and the floor between and around them. The floor
    // slab also covers the cans' footprints: the cans come first and take theirs.
    const sinks = [
      { min: [0.04, 0.04, 0.09], max: [0.10, 0.06, 0.15] },
      { min: [0.14, 0.04, 0.09], max: [0.20, 0.06, 0.15] },
      { min: [0, 0, 0], max: [0.24, 0.06, 0.24] }
    ];
    const sim = new M.MpmCpu(cfg);
    const carry = [];
    let base = 0;
    for (let f = 0; f < 400; f++) {
      const counts = M.mpmEmitCounts(cfg, emitters, 4 * cfg.dt, carry);
      sim.emit({ emitters, counts, seconds: 4 * cfg.dt, baseId: base, sinks });
      base += counts[0] + counts[1];
      sim.step(4);
    }
    const P = sim.particles;
    let left = 0, right = 0;
    for (let p = 0; p < cfg.maxParticles; p++) {
      if (P[p * F + M.MPM_P.state] === 0) continue;
      const charge = P[p * F + M.MPM_P.charge];
      if (P[p * F] < 0.12) { left++; assert.equal(charge, Math.fround(-3e-9)); } else { right++; assert.equal(charge, Math.fround(2e-9)); }
    }
    assert.ok(left > 5 && right > 5, `${left} and ${right} drops in the air`);
    assert.ok(sim.emitted > 100);
    // Neutral-field run: everything lands in its own can, nothing on the floor.
    assert.equal(sim.sunkBy[0] + sim.sunkBy[1] + sim.sunkBy[2] + sim.sunkBy[3], sim.sunk);
    assert.ok(sim.sunkBy[0] > 20 && sim.sunkBy[1] > 20, JSON.stringify(sim.sunkBy));
    assert.equal(sim.sunkBy[2], 0, 'a drop over a can went to the floor sink');
    assert.equal(sim.sunkBy[3], 0);
    assert.equal(sim.emitted - sim.sunk, left + right);
    assert.throws(() => M.packMpmIoParams(cfg, { emitters: [], counts: [], seconds: 0, baseId: 0, sinks: new Array(5).fill(sinks[0]), exportOrigin: [0, 0, 0], exportScale: 1 }), /sinks/);
  });

  it('like charge on the collector throws the stream off it: fewer drops land as the potential rises', () => {
    const cfg = M.mpmWaterConfig([32, 40, 32], 0.01, 2.5e-4, 3000, { maxSpeedMS: 4 });
    const d = M.mpmDerived(cfg);
    const nozzle = { centre: [0.16, 0.34, 0.16], direction: [0, -1, 0], radiusM: 0.004, speedMS: 0.4, spread: 0.3 };
    const can = { min: [0.12, 0.04, 0.12], max: [0.20, 0.06, 0.20] };
    const floor = { min: [0, 0, 0], max: [0.32, 0.06, 0.32] };
    const landed = (volts) => {
      // The can's rim as a ring at `volts`, 4 cm in radius; drops at 5e-5 C/kg.
      const rim = { centre: [0.16, 0.07, 0.16], radiusM: 0.04, kq: volts * 0.04, softM: 0.004 };
      const sim = new M.MpmCpu(cfg);
      sim.conductors = [rim];
      const emitters = [{ ...nozzle, chargeC: 5e-5 * d.particleMass }];
      const carry = [];
      let base = 0;
      for (let f = 0; f < 700; f++) {
        const counts = M.mpmEmitCounts(cfg, emitters, 4 * cfg.dt, carry);
        sim.emit({ emitters, counts, seconds: 4 * cfg.dt, baseId: base, sinks: [can, floor] });
        base += counts[0];
        sim.step(4);
      }
      return { can: sim.sunkBy[0], floor: sim.sunkBy[1], share: sim.sunkBy[0] / Math.max(1, sim.sunk) };
    };
    const runs = [0, 25000, 50000, 60000, 70000, 90000].map((v) => ({ volts: v, ...landed(v) }));
    console.log('  ' + runs.map((r) => `${r.volts / 1000} kV: ${r.can} in the can, ${r.floor} beside it`).join('; '));
    const [quiet, charged, , , high] = runs;
    assert.ok(quiet.share > 0.95, `uncharged collector: ${quiet.can} in the can, ${quiet.floor} on the floor`);
    assert.ok(charged.share <= quiet.share, `25 kV: ${charged.can} / ${charged.floor}`);
    assert.ok(high.share < 0.25, `70 kV: ${high.can} in the can, ${high.floor} beside it`);
    assert.ok(high.share < charged.share);
  });
});
