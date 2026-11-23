/**
 * MLS-MPM liquid solver, without a GPU (ADR-0022).
 *
 *   1. mpm-params.ts: the fixed-point scales cannot overflow for any budget,
 *      the uniform block matches the WGSL struct, bad configs are refused
 *   2. mpm-seed.ts: seeding is a pure function of its arguments
 *   3. mpm-cpu.ts, the reference the WGSL passes are held to on a real GPU
 *      (scripts/tests/gpu/golden-mpm.test.mjs): mass and momentum survive the
 *      transfers, a free block falls at g, a column settles to ρ·g·h, a vortex
 *      decays at the rate its viscosity says, walls hold
 *
 * Everything is SI: metres, seconds, kilograms, pascals.
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
  `,
  sourcefile: 'mpm-entry.ts'
});

const G = 9.80665;
const I32_MAX = 2147483647;
const F = M.MPM_PARTICLE_FLOATS;

/**
 * Byte size and field offsets of a WGSL struct of scalars, vec3s and
 * `array<Struct, N>` members, by the WGSL layout rules.
 */
function wgslStructBytes(source, name) {
  const body = source.match(new RegExp(`struct ${name} \\{([^}]*)\\}`))?.[1];
  assert.ok(body, `struct ${name} not found`);
  let offset = 0;
  let align = 1;
  const fields = [];
  for (const m of body.matchAll(/^\s*(\w+)\s*:\s*(?:array<(\w+),\s*(\d+)>|(\w+))\s*,/gm)) {
    let size, a;
    if (m[2]) {
      const element = wgslStructBytes(source, m[2]);
      a = element.align;
      size = element.bytes * Number(m[3]);
    } else {
      [size, a] = { f32: [4, 4], u32: [4, 4], i32: [4, 4], vec3f: [12, 16], vec3u: [12, 16], vec4f: [16, 16] }[m[4]] ?? [];
      assert.ok(size, `${name}.${m[1]}: type ${m[4]} is not one this check knows`);
    }
    offset = Math.ceil(offset / a) * a;
    fields.push({ name: m[1], offset });
    offset += size;
    align = Math.max(align, a);
  }
  return { bytes: Math.ceil(offset / align) * align, fields, align };
}

/** Gravity eased in over `ramp` steps (no acoustic ring), then held. */
function settleColumn(sim, cfg, steps, ramp) {
  for (let s = 0; s < steps; s++) {
    const x = Math.min(1, (s + 1) / ramp);
    sim.config = { ...cfg, gravity: [0, -G * x * x * (3 - 2 * x), 0] };
    sim.step();
  }
}

/**
 * Mean particle pressure per cell-high layer against the weight of the liquid
 * above it per unit area — ρ₀·g·h with h the depth of liquid above at rest
 * density. Returns [{ layer, pressure, expected }], bottom layer first.
 */
function pressureByDepth(cfg, particles, count) {
  const d = M.mpmDerived(cfg);
  const b = M.mpmBounds(cfg);
  const area = (b.max[0] - b.min[0]) * (b.max[2] - b.min[2]);
  const order = [...Array(count).keys()].sort((p, q) => particles[q * F + 1] - particles[p * F + 1]);
  const layers = new Map();
  order.forEach((p, above) => {
    const layer = Math.floor((particles[p * F + 1] - b.min[1]) / cfg.cellM);
    const e = layers.get(layer) ?? { layer, n: 0, pressure: 0, expected: 0 };
    e.n++;
    e.pressure += particles[p * F + M.MPM_P.pressure];
    e.expected += ((above + 0.5) * d.particleMass * G) / area;
    layers.set(layer, e);
  });
  return [...layers.values()].sort((p, q) => p.layer - q.layer)
    .map((e) => ({ layer: e.layer, pressure: e.pressure / e.n, expected: e.expected / e.n }));
}

describe('mpm-params: fixed point', () => {
  it('no budget can overflow an i32 grid channel', () => {
    for (const n of [1, 7, 512, 1213, 1214, 4851, 15000, 40000, 120000, 1e6, 5e6]) {
      const s = M.mpmFixedScales(n);
      assert.ok(M.mpmWorstCaseSum(n) <= I32_MAX, `budget ${n}: worst case ${M.mpmWorstCaseSum(n)} passes 2^31 − 1`);
      assert.ok(s.massScale <= M.MPM_MASS_SCALE_MAX && s.massScale >= M.MPM_T_MAX);
      assert.equal(s.momentumScale, s.massScale / M.MPM_T_MAX);
      assert.ok(Number.isInteger(s.massScale), 'massScale is an integer, so a particle scatters exactly its own mass');
    }
  });

  it('a larger budget gets coarser scales, and the tiers keep at least 14 bits', () => {
    let last = Infinity;
    for (const tier of ['low', 'default', 'high']) {
      const s = M.mpmFixedScales(M.MPM_TIERS[tier].particles);
      assert.ok(s.massScale < last, `${tier}: scales do not fall with the budget`);
      assert.ok(s.momentumScale >= 2 ** 14, `${tier}: momentumScale ${s.momentumScale} is under 2^14`);
      last = s.massScale;
    }
  });

  it('worst-case fill: every particle of the high tier on one node, faster than the clamp', () => {
    const N = M.MPM_TIERS.high.particles;
    const cfg = M.mpmWaterConfig([8, 8, 8], 0.01, 5e-4, N, { maxSpeedMS: 4 });
    const sim = new M.MpmCpu(cfg);
    const rec = new Float32Array(N * F);
    for (let i = 0; i < N; i++) M.writeMpmParticle(rec, i, [0.04, 0.04, 0.04], [40, -40, 40]);
    sim.setParticles(rec);
    sim.p2g();
    let max = 0;
    let min = 0;
    let mass = 0;
    sim.gridFixed.forEach((v, i) => {
      if (i % 4 === 0) {
        assert.ok(v >= 0, `node ${i / 4}: mass wrapped negative (${v})`);
        mass += v;
      }
      max = Math.max(max, v);
      min = Math.min(min, v);
    });
    const { massScale } = M.mpmFixedScales(N);
    assert.ok(max <= M.mpmWorstCaseSum(N) && max <= I32_MAX, `peak ${max} passes the bound`);
    assert.ok(max > 0.99 * I32_MAX, `peak ${max} — the case no longer fills the channel; the scales are wasting bits`);
    assert.ok(-min > 0.99 * I32_MAX && -min <= I32_MAX, `clamped momentum peak ${min}`);
    assert.ok(Math.abs(mass - N * massScale) <= N / 2, `grid mass ${mass} vs ${N * massScale}: off by more than ½ count per particle`);
    sim.gridUpdate();
    sim.g2p();
    assert.ok(M.mpmTotals(cfg, sim.particles, sim.count).finite, 'particles are finite after the step');
  });

  it('roundTiesEven is WGSL round()', () => {
    for (const [x, want] of [[0.5, 0], [1.5, 2], [2.5, 2], [-0.5, -0], [-1.5, -2], [-2.5, -2], [2.4999, 2], [-2.5001, -3], [1e6 + 0.5, 1e6], [7, 7]]) {
      // === on purpose: the sign of a zero does not survive being added to an integer.
      assert.ok(M.roundTiesEven(x) === want, `round(${x}) = ${M.roundTiesEven(x)}, expected ${want}`);
    }
  });

  it('the dither is three values in [−½, ½) and the counter does not repeat early', () => {
    const out = [0, 0, 0];
    const seen = new Set();
    let seed = M.mpmHash32(1);
    const sum = [0, 0, 0];
    const n = 20000;
    for (let i = 0; i < n; i++) {
      M.mpmDither(M.mpmSeedBits(seed), out);
      for (let a = 0; a < 3; a++) {
        assert.ok(out[a] >= -0.5 && out[a] < 0.5);
        sum[a] += out[a];
      }
      seen.add(seed);
      seed = M.mpmSeedNext(seed);
    }
    assert.equal(seen.size, n, 'counter repeated');
    // Mean of n uniform(−½, ½) draws: σ = 1/√(12 n); 5 σ is a generous gate.
    for (const s of sum) assert.ok(Math.abs(s / n) < 5 / Math.sqrt(12 * n), `dither mean ${s / n}`);
  });

  it('the counter and its hash are 32-bit PCG, checked against big-integer arithmetic', () => {
    const MASK = 0xffffffffn;
    const next = (v) => (v * 747796405n + 2891336453n) & MASK;
    const bits = (v) => {
      const word = (((v >> ((v >> 28n) + 4n)) ^ v) * 277803737n) & MASK;
      return ((word >> 22n) ^ word) & MASK;
    };
    for (const seed of [0, 1, 2, 0x7fffffff, 0x80000000, 0xffffffff, 3639132858, M.mpmHash32(12345)]) {
      assert.equal(M.mpmSeedNext(seed), Number(next(BigInt(seed))), `mpmSeedNext(${seed})`);
      assert.equal(M.mpmSeedBits(seed), Number(bits(BigInt(seed))), `mpmSeedBits(${seed})`);
    }
  });
});

describe('mpm-params: config and layouts', () => {
  const wgsl = readFileSync(join(ROOT, 'src/shaders/common/mpm.wgsl'), 'utf8');

  it('MpmParams and MpmParticle are the sizes the host allocates', () => {
    const params = wgslStructBytes(wgsl, 'MpmParams');
    assert.equal(params.bytes, M.MPM_PARAMS_BYTES);
    const particle = wgslStructBytes(wgsl, 'MpmParticle');
    assert.equal(particle.bytes, M.MPM_PARTICLE_BYTES);
    const at = Object.fromEntries(particle.fields.map((f) => [f.name, f.offset / 4]));
    for (const [name, word] of Object.entries(M.MPM_P)) assert.equal(at[name], word, `MpmParticle.${name}`);
  });

  it('conductors are packed where the WGSL struct reads them, and at most four', () => {
    const cfg = M.mpmWaterConfig([16, 16, 16], 0.01, 1e-4, 512);
    const conductor = wgslStructBytes(wgsl, 'MpmConductor');
    assert.equal(conductor.bytes, 32);
    assert.equal(Number(wgsl.match(/const MPM_MAX_CONDUCTORS = (\d+);/)[1]), M.MPM_MAX_CONDUCTORS);
    assert.equal(Number(wgsl.match(/const MPM_RING_POINTS = (\d+);/)[1]), M.MPM_RING_POINTS);
    const at = Object.fromEntries(wgslStructBytes(wgsl, 'MpmParams').fields.map((x) => [x.name, x.offset / 4]));
    const k = Object.fromEntries(conductor.fields.map((x) => [x.name, x.offset / 4]));
    const list = [
      { centre: [0.1, 0.2, 0.3], radiusM: 0.04, kq: 1500, softM: 0.002 },
      { centre: [0.4, 0.5, 0.6], radiusM: 0, kq: -900, softM: 0.01 }
    ];
    const buf = M.packMpmParams(cfg, 7, undefined, 0, list);
    const f = new Float32Array(buf);
    assert.equal(new Uint32Array(buf)[at.conductorCount], 2);
    list.forEach((c, i) => {
      const o = at.conductors + i * 8;
      assert.deepEqual([f[o + k.centre], f[o + k.centre + 1], f[o + k.centre + 2]], c.centre.map(Math.fround));
      assert.equal(f[o + k.radius], Math.fround(c.radiusM));
      assert.equal(f[o + k.kq], c.kq);
      assert.equal(f[o + k.soft], Math.fround(c.softM));
    });
    // None given: the count is 0 and a reused buffer is wiped.
    const again = M.packMpmParams(cfg, 7, buf);
    assert.equal(new Uint32Array(again)[at.conductorCount], 0);
    assert.ok(new Float32Array(again).subarray(at.conductors).every((v) => v === 0));
    assert.throws(() => M.packMpmParams(cfg, 7, undefined, 0, new Array(5).fill(list[0])), /conductors/);
  });

  it('packMpmParams writes each field where the WGSL struct reads it', () => {
    const cfg = M.mpmWaterConfig([16, 24, 32], 0.0125, 2.5e-4, 40000, { viscosityPaS: 0.3, gravity: [0.5, -9.5, 0.25], maxSpeedMS: 6 });
    const buf = M.packMpmParams(cfg, 12345);
    const f = new Float32Array(buf);
    const u = new Uint32Array(buf);
    const at = Object.fromEntries(wgslStructBytes(wgsl, 'MpmParams').fields.map((x) => [x.name, x.offset / 4]));
    const d = M.mpmDerived(cfg);
    const s = M.mpmFixedScales(cfg.maxParticles);
    assert.deepEqual([u[at.gridN], u[at.gridN + 1], u[at.gridN + 2]], [16, 24, 32]);
    assert.equal(u[at.particleCount], 12345);
    const want = {
      cellM: cfg.cellM, dt: cfg.dt, restDensity: cfg.restDensity, particleMass: d.particleMass,
      eosStiffness: cfg.eosStiffnessPa, eosGamma: cfg.eosGamma, viscosity: cfg.viscosityPaS, minJ: 1 / cfg.maxDensityRatio,
      maxSpeed: cfg.maxSpeedMS, massScale: s.massScale, momentumScale: s.momentumScale, maxJ: M.MPM_J_MAX, tMax: M.MPM_T_MAX
    };
    for (const [name, value] of Object.entries(want)) assert.equal(f[at[name]], Math.fround(value), `MpmParams.${name}`);
    assert.deepEqual([...f.subarray(at.gravity, at.gravity + 3)], cfg.gravity.map(Math.fround));
    assert.equal(u[at.flags], 0);
    assert.equal(new Uint32Array(M.packMpmParams(cfg, 1, undefined, M.MPM_FLAG_BOUNDARY))[at.flags], M.MPM_FLAG_BOUNDARY);
    // gridN, particleCount, gravity, flags, two pads, and the conductor count and
    // array (the test above) are the fields not in `want`.
    assert.equal(u[at.conductorCount], 0);
    assert.equal(Object.keys(want).length + 8, Object.keys(at).length, 'a struct field this test does not cover');
    assert.equal(new Uint32Array(M.packMpmParams(cfg, 1e9))[at.particleCount], 40000, 'particleCount is capped at the budget');
  });

  it('water defaults sit at the stability limit and say how compressible that is', () => {
    const cfg = M.mpmWaterConfig([64, 64, 64], 0.01, 2.5e-4, 40000);
    const d = M.mpmDerived(cfg);
    assert.deepEqual(M.validateMpmConfig(cfg), []);
    assert.ok(Math.abs(d.courantSound - M.MPM_MAX_COURANT) < 1e-12);
    assert.ok(Math.abs(d.soundSpeed - 20) < 1e-9, `sound speed ${d.soundSpeed}`);
    assert.ok(Math.abs(d.particleMass - 1000 * 1e-6 / 8) < 1e-15);
    // A 0.3 m column: ρ/ρ₀ − 1 ≈ g·H/c² for small compression.
    const eps = M.mpmColumnCompression(cfg, 0.3);
    assert.ok(Math.abs(eps / ((G * 0.3) / d.soundSpeed ** 2) - 1) < 0.03, `compression ${eps}`);
    // …and the pressure at that compression is the column's weight.
    assert.ok(Math.abs(M.mpmPressure(cfg, 1 / (1 + eps)) / (1000 * G * 0.3) - 1) < 1e-9);
    // The epic's step: 1/240 s on the same grid is a far softer liquid.
    const soft = M.mpmWaterConfig([64, 64, 64], 0.01, 1 / 240, 40000);
    assert.ok(M.mpmColumnCompression(soft, 0.3) > 0.25, 'at 1/240 s a 0.3 m column of "water" compresses by more than a quarter');
  });

  it('pressure: none at rest volume, none in tension, capped at the density limit', () => {
    const cfg = M.mpmWaterConfig([16, 16, 16], 0.01, 2.5e-4, 100);
    assert.equal(M.mpmPressure(cfg, 1), 0);
    assert.equal(M.mpmPressure(cfg, 1.5), 0);
    assert.equal(M.mpmPressure(cfg, 1e9), 0);
    assert.ok(M.mpmPressure(cfg, 0.99) > 0);
    assert.equal(M.mpmPressure(cfg, 0.01), M.mpmPressure(cfg, 1 / cfg.maxDensityRatio));
  });

  it('refuses configurations the explicit step cannot carry', () => {
    const ok = M.mpmWaterConfig([16, 16, 16], 0.01, 2.5e-4, 1000);
    const bad = (overrides, pattern) => {
      const errors = M.validateMpmConfig({ ...ok, ...overrides });
      assert.ok(errors.some((e) => pattern.test(e)), `${JSON.stringify(overrides)} → ${JSON.stringify(errors)}`);
    };
    bad({ eosStiffnessPa: ok.eosStiffnessPa * 16 }, /sound Courant/);
    bad({ maxDensityRatio: 3 }, /sound Courant/);
    bad({ maxSpeedMS: 100 }, /cells per substep/);
    bad({ maxSpeedMS: 0 }, /cells per substep/);
    bad({ viscosityPaS: 100 }, /viscous number/);
    bad({ gridN: [16, 5, 16] }, /at least 6 nodes/);
    bad({ maxParticles: 0 }, /maxParticles/);
    bad({ maxParticles: 10.5 }, /maxParticles/);
    bad({ maxDensityRatio: 1 }, /maxDensityRatio/);
    bad({ dt: 0 }, /positive/);
    assert.throws(() => new M.MpmCpu({ ...ok, maxSpeedMS: 100 }), /cells per substep/);
  });

  it('tiers: memory is what the docs say, and the bounds keep every stencil on the grid', () => {
    const mb = (t) => M.mpmMemoryBytes([t.gridN, t.gridN, t.gridN], t.particles) / 2 ** 20;
    assert.ok(mb(M.MPM_TIERS.low) < 2.5, `low ${mb(M.MPM_TIERS.low)} MiB`);
    assert.ok(mb(M.MPM_TIERS.default) < 12, `default ${mb(M.MPM_TIERS.default)} MiB`);
    assert.ok(mb(M.MPM_TIERS.high) < 37, `high ${mb(M.MPM_TIERS.high)} MiB`);
    const cfg = M.mpmWaterConfig([16, 20, 24], 0.02, 5e-4, 10);
    const b = M.mpmBounds(cfg);
    assert.deepEqual(b.min, [0.02, 0.02, 0.02]);
    assert.deepEqual(b.max.map((x) => Math.round(x / 0.02)), [14, 18, 22]);
    // Stencil base = floor(x/h − ½) must be ≥ 0, and base + 2 ≤ n − 1.
    for (let a = 0; a < 3; a++) {
      assert.ok(Math.floor(b.min[a] / cfg.cellM - 0.5) >= 0);
      assert.ok(Math.floor(b.max[a] / cfg.cellM - 0.5) + 2 <= cfg.gridN[a] - 1);
    }
  });
});

describe('mpm-seed', () => {
  const cfg = M.mpmWaterConfig([16, 16, 16], 0.01, 2.5e-4, 5000);
  const box = { min: [0.03, 0.03, 0.03], max: [0.08, 0.07, 0.06] };

  it('fills a box at rest density on a lattice', () => {
    const rec = M.seedMpmBox(cfg, box);
    assert.equal(rec.length / F, 10 * 8 * 6);
    const d = M.mpmDerived(cfg);
    const volume = 0.05 * 0.04 * 0.03;
    assert.ok(Math.abs(((rec.length / F) * d.particleMass) / (cfg.restDensity * volume) - 1) < 1e-12, 'mass = ρ₀·V');
    const seeds = new Set();
    const bits = new Uint32Array(rec.buffer);
    for (let p = 0; p < rec.length / F; p++) {
      for (let a = 0; a < 3; a++) assert.ok(rec[p * F + a] > box.min[a] && rec[p * F + a] < box.max[a]);
      assert.equal(rec[p * F + M.MPM_P.j], 1);
      assert.equal(rec[p * F + M.MPM_P.state], 1);
      seeds.add(bits[p * F + M.MPM_P.seed]);
    }
    assert.equal(seeds.size, rec.length / F, 'every particle has its own dither counter');
  });

  it('is a pure function of its arguments, jitter included', () => {
    const a = M.seedMpmBox(cfg, { ...box, jitter: 0.5, seed: 7, velocity: [1, 2, 3] });
    const b = M.seedMpmBox(cfg, { ...box, jitter: 0.5, seed: 7, velocity: [1, 2, 3] });
    const c = M.seedMpmBox(cfg, { ...box, jitter: 0.5, seed: 8, velocity: [1, 2, 3] });
    assert.deepEqual(new Uint32Array(a.buffer), new Uint32Array(b.buffer));
    assert.notDeepEqual(new Uint32Array(a.buffer), new Uint32Array(c.buffer));
    assert.deepEqual([a[4], a[5], a[6]], [1, 2, 3]);
    const plain = M.seedMpmBox(cfg, box);
    let moved = 0;
    for (let p = 0; p < plain.length / F; p++) {
      const dx = Math.abs(a[p * F] - plain[p * F]);
      assert.ok(dx <= 0.25 * cfg.cellM / 2 + 1e-9, 'jitter 0.5 moves a particle at most a quarter of the spacing');
      if (dx > 0) moved++;
    }
    assert.ok(moved > plain.length / F / 2);
  });

  it('refuses a box over budget and a non-cubic particles-per-cell', () => {
    assert.throws(() => M.seedMpmBox({ ...cfg, maxParticles: 100 }, box), /exceed the budget/);
    assert.throws(() => M.seedMpmBox({ ...cfg, particlesPerCell: 6 }, box), /not a cube/);
  });
});

describe('mpm-cpu: transfers conserve', () => {
  for (const budget of [4096, M.MPM_TIERS.high.particles]) {
    it(`mass exactly, momentum to the fixed-point resolution (scales of a ${budget}-particle budget)`, () => {
      const cfg = M.mpmWaterConfig([16, 16, 16], 0.01, 5e-4, budget, { gravity: [0, 0, 0], maxSpeedMS: 4 });
      const sim = new M.MpmCpu(cfg);
      sim.setParticles(M.seedMpmBox(cfg, { min: [0.04, 0.04, 0.04], max: [0.08, 0.08, 0.08], velocity: [0.3, -0.2, 0.1] }));
      const before = M.mpmTotals(cfg, sim.particles, sim.count);
      sim.p2g();
      let mass = 0;
      for (let i = 0; i < sim.gridFixed.length; i += 4) mass += sim.gridFixed[i];
      assert.equal(mass, sim.count * M.mpmFixedScales(budget).massScale, 'grid mass is the particle mass, to the count');
      sim.step(100);
      const after = M.mpmTotals(cfg, sim.particles, sim.count);
      const scale = Math.hypot(...before.momentum);
      // One count of momentum per particle per step, random: the bound grows as √steps.
      const tol = budget > 5000 ? 5e-4 : 2e-5;
      for (let a = 0; a < 3; a++) {
        assert.ok(Math.abs(after.momentum[a] - before.momentum[a]) / scale < tol,
          `axis ${a}: momentum ${before.momentum[a]} → ${after.momentum[a]}`);
      }
      assert.ok(Math.abs(after.kinetic / before.kinetic - 1) < 1e-3, `kinetic energy ${before.kinetic} → ${after.kinetic}`);
      assert.equal(after.count, before.count);
    });
  }

  it('fixed point and exact accumulation tell the same story', () => {
    const run = (fixedPoint) => {
      const cfg = M.mpmWaterConfig([12, 16, 12], 0.01, 5e-4, M.MPM_TIERS.default.particles, { maxSpeedMS: 4 });
      const sim = new M.MpmCpu(cfg, { fixedPoint });
      sim.setParticles(M.seedMpmBox(cfg, { min: [0.03, 0.05, 0.03], max: [0.07, 0.1, 0.07] }));
      sim.step(160);
      return M.mpmTotals(cfg, sim.particles, sim.count);
    };
    const fixed = run(true);
    const exact = run(false);
    // A block dropped on the floor, mid-splash: same centre of mass and energy.
    for (let a = 0; a < 3; a++) assert.ok(Math.abs(fixed.centre[a] - exact.centre[a]) < 2e-5, `centre ${fixed.centre} vs ${exact.centre}`);
    assert.ok(Math.abs(fixed.kinetic / exact.kinetic - 1) < 0.02, `kinetic ${fixed.kinetic} vs ${exact.kinetic}`);
    assert.ok(Math.abs(fixed.volume / exact.volume - 1) < 2e-3, `volume ${fixed.volume} vs ${exact.volume}`);
  });
});

describe('mpm-cpu: SI gravity', () => {
  it('a free block falls by g·dt²·n(n+1)/2 and keeps its volume', () => {
    const dt = 5e-4;
    const cfg = M.mpmWaterConfig([10, 24, 10], 0.01, dt, 512, { maxSpeedMS: 8 });
    const sim = new M.MpmCpu(cfg);
    sim.setParticles(M.seedMpmBox(cfg, { min: [0.03, 0.15, 0.03], max: [0.07, 0.19, 0.07] }));
    const y0 = M.mpmTotals(cfg, sim.particles, sim.count).centre[1];
    const n = 200;
    sim.step(n);
    const t = M.mpmTotals(cfg, sim.particles, sim.count);
    // Symplectic Euler: v is updated first, so the drop is ½·g·dt²·n·(n + 1).
    const drop = (G * dt * dt * n * (n + 1)) / 2;
    assert.ok(Math.abs((y0 - t.centre[1]) / drop - 1) < 2e-4, `dropped ${y0 - t.centre[1]} m, expected ${drop}`);
    assert.ok(Math.abs(t.momentum[1] / t.mass / (-G * dt * n) - 1) < 2e-4, `v = ${t.momentum[1] / t.mass}`);
    assert.ok(Math.abs(t.volume / (sim.count * M.mpmDerived(cfg).particleVolume) - 1) < 1e-3, 'a falling block neither swells nor shrinks');
  });

  for (const tier of ['default', 'high']) {
    it(`a column settles to ρ·g·h within 5 % (fixed-point scales of the ${tier} tier)`, () => {
      const grid = [8, 20, 8];
      const fill = 12;
      const h = 0.01;
      const base = M.mpmWaterConfig(grid, h, 2.5e-4, M.MPM_TIERS[tier].particles, { gravity: [0, 0, 0], maxSpeedMS: 4 });
      const b = M.mpmBounds(base);
      const sim = new M.MpmCpu(base);
      sim.setParticles(M.seedMpmBox(base, { min: b.min, max: [b.max[0], b.min[1] + fill * h, b.max[2]] }));
      settleColumn(sim, base, 700, 350);
      const cfg = { ...base, gravity: [0, -G, 0] };
      const layers = pressureByDepth(cfg, sim.particles, sim.count);
      // Away from the floor (the wall reaction lives in the bottom two layers)
      // and from the free surface, where one layer holds only a few pascals.
      const bulk = layers.filter((l) => l.layer >= 2 && l.layer <= fill - 2);
      assert.ok(bulk.length >= 8);
      for (const l of bulk) {
        assert.ok(Math.abs(l.pressure / l.expected - 1) < 0.05,
          `layer ${l.layer}: ${l.pressure.toFixed(1)} Pa, weight above ${l.expected.toFixed(1)} Pa`);
      }
      // The deepest bulk layer really is ρ₀·g·h for its depth.
      const deep = bulk[0];
      const depth = (fill - deep.layer - 0.5) * h;
      assert.ok(Math.abs(deep.expected / (1000 * G * depth) - 1) < 0.02, `expected ${deep.expected} Pa at ${depth} m`);
      const t = M.mpmTotals(cfg, sim.particles, sim.count);
      assert.ok(t.maxSpeed < 5e-3, `column still moving at ${t.maxSpeed} m/s`);
      // It compressed by what the equation of state says, on average about half the base figure.
      const squash = 1 - t.volume / (sim.count * M.mpmDerived(cfg).particleVolume);
      const atBase = M.mpmColumnCompression(cfg, fill * h);
      assert.ok(squash > 0.3 * atBase && squash < 0.7 * atBase, `volume fell ${squash}, base compression ${atBase}`);
    });
  }
});

describe('mpm-cpu: viscosity', () => {
  /** Decay rate (1/s) of a Taylor–Green cell in a full box with slip walls. */
  function vortexDecay(mu) {
    const n = 16;
    const h = 0.01;
    const dt = 5e-4;
    const grid = [n, n, 8];
    const count = (n - 3) * (n - 3) * 5 * 8;
    const cfg = M.mpmWaterConfig(grid, h, dt, count, { gravity: [0, 0, 0], viscosityPaS: mu, maxSpeedMS: 2 });
    const b = M.mpmBounds(cfg);
    const L = b.max[0] - b.min[0];
    const k = Math.PI / L;
    // ψ = sin(kx)·sin(ky): no flow through any wall, no shear on any wall —
    // an exact decaying solution, e^(−2νk²t).
    const mode = (x, y) => [Math.sin(k * (x - b.min[0])) * Math.cos(k * (y - b.min[1])), -Math.cos(k * (x - b.min[0])) * Math.sin(k * (y - b.min[1]))];
    const rec = M.seedMpmBox(cfg, { min: b.min, max: b.max });
    for (let p = 0; p < count; p++) {
      const m = mode(rec[p * F], rec[p * F + 1]);
      rec[p * F + 4] = 0.1 * m[0];
      rec[p * F + 5] = 0.1 * m[1];
    }
    const sim = new M.MpmCpu(cfg);
    sim.setParticles(rec);
    const amplitude = () => {
      let a = 0;
      let s = 0;
      for (let p = 0; p < count; p++) {
        const m = mode(sim.particles[p * F], sim.particles[p * F + 1]);
        a += sim.particles[p * F + 4] * m[0] + sim.particles[p * F + 5] * m[1];
        s += m[0] * m[0] + m[1] * m[1];
      }
      return a / s;
    };
    const a0 = amplitude();
    const steps = 200;
    sim.step(steps);
    return { rate: -Math.log(amplitude() / a0) / (steps * dt), theory: (2 * (mu / cfg.restDensity)) * k * k, k, cfg };
  }

  it('a vortex decays at 2νk² on top of the scheme\'s own damping', () => {
    const inviscid = vortexDecay(0);
    const thick = vortexDecay(10);
    const physical = thick.rate - inviscid.rate;
    assert.ok(Math.abs(physical / thick.theory - 1) < 0.05,
      `μ = 10 Pa·s adds ${physical.toFixed(3)} 1/s of decay; 2νk² = ${thick.theory.toFixed(3)}`);
    // The scheme's own damping, as a viscosity. docs/FLUIDS.md quotes this
    // figure: about a thousand times water's 1e-6 m²/s, so water's μ is moot.
    const numerical = inviscid.rate / (2 * inviscid.k ** 2);
    assert.ok(numerical > 5e-4 && numerical < 4e-3, `numerical viscosity ${numerical} m²/s`);
  });
});

describe('mpm-cpu: walls', () => {
  it('a block thrown into a corner at the speed limit stays in the box and finite', () => {
    const cfg = M.mpmWaterConfig([12, 12, 12], 0.01, 5e-4, 1000, { maxSpeedMS: 8 });
    const b = M.mpmBounds(cfg);
    const sim = new M.MpmCpu(cfg);
    sim.setParticles(M.seedMpmBox(cfg, { min: [0.05, 0.05, 0.05], max: [0.09, 0.09, 0.09], velocity: [8, 8, 8] }));
    sim.step(150);
    const t = M.mpmTotals(cfg, sim.particles, sim.count);
    assert.ok(t.finite);
    assert.equal(t.count, 512);
    assert.ok(t.maxSpeed <= 8 * Math.sqrt(3) + 1e-6, `max speed ${t.maxSpeed}`);
    for (let p = 0; p < sim.count; p++) {
      for (let a = 0; a < 3; a++) {
        const x = sim.particles[p * F + a];
        assert.ok(x >= b.min[a] - 1e-7 && x <= b.max[a] + 1e-7, `particle ${p} axis ${a} at ${x}`);
      }
      const j = sim.particles[p * F + M.MPM_P.j];
      assert.ok(j >= 1 / cfg.maxDensityRatio - 1e-6 && j <= M.MPM_J_MAX);
    }
  });

  it('an empty slot is never touched', () => {
    const cfg = M.mpmWaterConfig([12, 12, 12], 0.01, 5e-4, 64);
    const sim = new M.MpmCpu(cfg);
    const rec = M.seedMpmBox(cfg, { min: [0.04, 0.04, 0.04], max: [0.06, 0.06, 0.06] });
    rec[5 * F + M.MPM_P.state] = 0;
    const dead = Array.from(rec.subarray(5 * F, 6 * F));
    sim.setParticles(rec);
    sim.step(20);
    assert.deepEqual(Array.from(sim.particles.subarray(5 * F, 6 * F)), dead);
    assert.equal(M.mpmTotals(cfg, sim.particles, sim.count).count, 63);
  });
});
