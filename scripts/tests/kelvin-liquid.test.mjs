/**
 * Kelvin's water dropper as a liquid scene (ADR-0022, docs/FLUIDS.md → Kelvin).
 *
 *   - Rayleigh–Plateau drops and the Rayleigh limit on their charge
 *   - the scene: tips, rings and collector mouths where the bench draws them,
 *     one particle per drop, the collectors' sinks ahead of the floor's
 *   - conductors and emitters: the cross-connection's signs
 *   - the effect the bench is for, on the CPU twin: every drop lands at
 *     50 kV, about half at the plant's 60 kV breakdown, none by 68 kV
 *   - the landing share as the bench reads it back
 *
 * The same scene runs on a GPU in scripts/tests/gpu/golden-kelvin-liquid.test.mjs.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ROOT, bundleTs } from '../test-harness.mjs';

const M = await bundleTs({
  contents: `
    export * from './src/fluids/kelvin-liquid.ts';
    export * as mpm from './src/fluids/mpm-params.ts';
    export { MpmCpu } from './src/fluids/mpm-cpu.ts';
    export { KELVIN_APPARATUS, KELVIN_COLLECTOR_MOUTH_Y, KELVIN_FALL_M, kelvinFocusCamera } from './src/kelvin-layout.ts';
    export { buildKelvinRingInstances, buildKelvinBucketInstances, buildKelvinTubeInstances, DEVICE_MESH_LAYOUTS } from './src/device-mesh-layouts.ts';
    export { KELVIN_CONSTANTS, PHYSICAL_CONSTANTS } from './generated/physics-constants.ts';
    export { stepKelvinDrops, KELVIN_PARK_DROP, kelvinDropperParts, kelvinStandInDrop, KELVIN_STAND_IN_MIN_MS, KELVIN_MIN_DRIVE as MIN_DRIVE } from './src/physics/kelvin-dropper.ts';
    export { stepParticles } from './src/renderers/shared/particle-physics.ts';
    export { kelvinDropsNoteText } from './src/kelvin-drops-note.ts';
    export { createDevicePhysicsState, stepDevicePhysics, kelvinSeedV } from './src/renderers/shared/device-physics.ts';
  `,
  sourcefile: 'kelvin-liquid-entry.ts'
});

const K = M.KELVIN_CONSTANTS;
const EPS0 = 8.8541878128e-12;

describe('kelvin-liquid: drops', () => {
  it('Rayleigh–Plateau: one wavelength of jet per drop, 4.508 bores long', () => {
    const d = K.NOZZLE_DIAMETER_M;
    const full = M.kelvinDrops(1);
    assert.ok(Math.abs(full.jetSpeedMS - K.JET_SPEED_MAX_MS) < 1e-12);
    // Volume of a 4.508 d length of a jet of diameter d, as a sphere.
    assert.ok(Math.abs(full.volumeM3 - Math.PI * (d / 2) ** 2 * 4.508 * d) < 1e-18);
    assert.ok(Math.abs(full.radiusM / d - 0.945) < 0.001, `drop radius ${full.radiusM / d} bores`);
    assert.ok(Math.abs(full.rateHz - K.JET_SPEED_MAX_MS / (4.508 * d)) < 1e-9);
    // What a tip lets go is what flows through it: rate × volume = area × speed.
    assert.ok(Math.abs(full.rateHz * full.volumeM3 / (Math.PI * (d / 2) ** 2 * full.jetSpeedMS) - 1) < 1e-12);
    // Half the drive: the same drops, half as often.
    const half = M.kelvinDrops(0.5);
    assert.equal(half.radiusM, full.radiusM);
    assert.ok(Math.abs(half.rateHz / full.rateHz - 0.5) < 1e-12);
    assert.equal(M.kelvinDrops(0).rateHz, 0);
    assert.equal(M.kelvinDrops(7).jetSpeedMS, K.JET_SPEED_MAX_MS);
  });

  it('a drop takes the charge of a sphere at the ring\'s potential, up to the Rayleigh limit', () => {
    const r = M.kelvinDrops(1).radiusM;
    const limit = M.rayleighLimitC(r);
    assert.ok(Math.abs(limit / (8 * Math.PI * Math.sqrt(EPS0 * K.SURFACE_TENSION_NM * r ** 3)) - 1) < 1e-6);
    // Below the limit: 4πε₀·r·V.
    assert.ok(Math.abs(M.kelvinDropChargeC(1000, r) / (4 * Math.PI * EPS0 * r * 1000) - 1) < 1e-6);
    assert.equal(M.kelvinDropChargeC(-1000, r), M.kelvinDropChargeC(1000, r));
    assert.equal(M.kelvinDropChargeC(0, r), 0);
    // It saturates near 10 kV, and stays there.
    const saturatesAt = limit / (4 * Math.PI * EPS0 * r);
    assert.ok(saturatesAt > 9000 && saturatesAt < 12000, `the limit is reached at ${saturatesAt} V`);
    assert.equal(M.kelvinDropChargeC(30000, r), limit);
    assert.equal(M.kelvinDropChargeC(60000, r), limit);
    // 3.8 nC on 0.15 g: 2.5e-5 C/kg.
    const qOverM = limit / M.kelvinDrops(1).massKg;
    assert.ok(qOverM > 2.3e-5 && qOverM < 2.7e-5, `q/m = ${qOverM}`);
  });
});

describe('kelvin-liquid: the scene is the drawn bench', () => {
  const scene = M.kelvinLiquidScene();
  const c = scene.config;
  const a = M.KELVIN_APPARATUS;
  const toScene = (p) => p.map((v, k) => scene.origin[k] + v * scene.scale);

  it('tips, rings and mouths map back to where the meshes are', () => {
    const near = (got, want) => got.every((v, k) => Math.abs(v - want[k]) < 1e-9);
    assert.ok(near(toScene(scene.tips[0]), [-a.columnX, a.tipY, 0]), JSON.stringify(toScene(scene.tips[0])));
    assert.ok(near(toScene(scene.tips[1]), [a.columnX, a.tipY, 0]));
    assert.ok(near(toScene(scene.rings[0]), [-a.columnX, a.ringY, 0]));
    assert.ok(near(toScene(scene.mouths[1]), [a.columnX, M.KELVIN_COLLECTOR_MOUTH_Y, 0]));
    assert.ok(Math.abs(scene.scale - 1 / K.METRES_PER_SCENE_UNIT) < 1e-12);
    assert.ok(Math.abs(scene.fallM - M.KELVIN_FALL_M) < 1e-12);
    assert.ok(scene.fallM > 0.35 && scene.fallM < 0.42, `fall ${scene.fallM} m`);
    // The drawn meshes use the same table.
    const rings = M.buildKelvinRingInstances();
    assert.deepEqual(rings.map((r) => [r[0], r[1], r[2]]), [[-a.columnX, a.ringY, 0], [a.columnX, a.ringY, 0]]);
    const cans = M.buildKelvinBucketInstances();
    assert.deepEqual(cans.map((r) => [r[0], r[1]]), [[-a.columnX, a.collectorY], [a.columnX, a.collectorY]]);
    // Nothing solid is drawn in a stream's path any more: two collectors are the only cylinders.
    assert.equal(M.DEVICE_MESH_LAYOUTS.kelvin.cylinders().length, 2);
    // A drip tip ends above its ring's wire and inside its bore.
    assert.ok(a.tipY > a.ringY + a.ringWire && a.tipY < a.beamY);
    assert.ok(M.buildKelvinTubeInstances().length > 4);
  });

  it('the box holds the apparatus inside its walls, on a small grid, with one particle per drop', () => {
    const [nx, ny, nz] = c.gridN;
    const h = c.cellM;
    assert.ok(nx * ny * nz < 1.8 * 32 ** 3, `${nx}×${ny}×${nz} nodes`);
    for (const p of [...scene.tips, ...scene.rings, ...scene.mouths]) {
      assert.ok(p[0] > 3 * h && p[0] < (nx - 3) * h && p[1] > 3 * h && p[1] < (ny - 3) * h && p[2] > 3 * h && p[2] < (nz - 3) * h, `point ${p} is at a wall`);
    }
    const drops = M.kelvinDrops(1);
    const d = M.mpm.mpmDerived(c);
    assert.ok(Math.abs(d.particleVolume / drops.volumeM3 - 1) < 1e-9, 'a particle is not one drop');
    assert.ok(Math.abs(d.particleMass / drops.massKg - 1) < 1e-9);
    assert.deepEqual(M.mpm.validateMpmConfig(c), []);
    // A fall plus a kick stays under half a cell a substep, and the frame is a whole number of substeps.
    assert.ok(4 * c.dt < 0.5 * h + 1e-12);
    assert.ok(Math.abs(scene.substepsPerFrame * c.dt - scene.timeScale / 60) < 1e-12);
    assert.equal(scene.timeScale, K.LIQUID_TIME_SCALE);
    assert.equal(scene.nozzleDiameterM, K.NOZZLE_DIAMETER_M);
  });

  it('the collectors\' sinks come before the floor\'s: the column under each mouth, and nothing above it', () => {
    assert.equal(scene.sinks.length, 3);
    for (const side of [0, 1]) {
      const s = scene.sinks[side];
      const m = scene.mouths[side];
      assert.ok(m[0] > s.min[0] && m[0] < s.max[0] && m[1] > s.min[1] && m[1] < s.max[1] && m[2] > s.min[2] && m[2] < s.max[2]);
      // The square has the round mouth's area.
      assert.ok(Math.abs((s.max[0] - s.min[0]) * (s.max[2] - s.min[2]) / (Math.PI * scene.collectorRadiusM ** 2) - 1) < 1e-9);
      // A drop falling from the tip reaches it; one beside the collector does not.
      assert.ok(scene.tips[side][0] > s.min[0] && scene.tips[side][0] < s.max[0]);
    }
    // A column reaches the floor: a drop cannot fall through it between two tests of the sinks.
    assert.equal(scene.sinks[0].min[1], 0);
    assert.ok(scene.sinks[0].max[1] < scene.mouths[0][1] + c.cellM, 'a collector takes drops from above its mouth');
    const floor = scene.sinks[2];
    assert.ok(floor.max[1] < scene.mouths[0][1] - 2 * c.cellM, 'the floor sink reaches the mouths');
    assert.ok(floor.max[1] > 1.5 * c.cellM, 'the floor sink is under the wall plane a drop rests on');
    assert.equal(floor.min[0], 0);
    assert.ok(Math.abs(floor.max[0] - c.gridN[0] * c.cellM) < 1e-12);
  });

  it('the focus camera holds the whole dropper', () => {
    const cam = M.kelvinFocusCamera();
    const half = Math.tan(Math.PI / 8) * Math.hypot(cam.cameraOffset[2], cam.cameraOffset[1] - cam.cameraTarget[1]);
    assert.ok(cam.cameraTarget[1] + half > a.beamY, 'the supply beam is out of frame');
    assert.ok(cam.cameraTarget[1] - half < a.collectorY - a.collectorHalfHeight, 'the collectors\' feet are out of frame');
    assert.ok(half > a.columnX + a.ringRadius);
  });
});

describe('kelvin-liquid: conductors and tips', () => {
  const scene = M.kelvinLiquidScene();

  it('each ring at ±V, each collector at the opposite ring\'s potential; V at the centre of every ring', () => {
    const list = M.kelvinConductors(scene, 30000);
    assert.equal(list.length, 4);
    const [ringL, ringR, canL, canR] = list;
    assert.ok(ringL.kq > 0 && ringR.kq < 0 && canL.kq < 0 && canR.kq > 0);
    // kq / R is the potential at a ring's own centre.
    for (const k of list) assert.ok(Math.abs(Math.abs(k.kq) / k.radiusM - 30000) < 1e-6);
    assert.deepEqual(ringL.centre, scene.rings[0]);
    assert.deepEqual(canR.centre, scene.mouths[1]);
    assert.equal(ringL.radiusM, scene.ringRadiusM);
    assert.equal(ringL.softM, scene.ringWireM);
    // The potential the left stream starts in is its own ring's, less what the
    // tip's height above the ring plane and the three other conductors take
    // off: 0.74 V. (The drop's charge is taken as that of the full V.)
    const tip = scene.tips[0];
    const v = M.mpm.mpmPotentialAt(list, tip[0], tip[1], tip[2]);
    assert.ok(v > 0.65 * 30000 && v < 1.0 * 30000, `potential at the left tip ${v} V`);
    // No potential, no field; junk reads as none.
    for (const volts of [0, -5, Number.NaN]) assert.ok(M.kelvinConductors(scene, volts).every((k) => k.kq === 0));
  });

  it('the left stream is negative, the right positive, and a weeping tip lets nothing go', () => {
    const e = M.kelvinEmitters(scene, 1, 30000);
    assert.equal(e.length, 2);
    const limit = M.rayleighLimitC(M.kelvinDrops(1).radiusM);
    assert.equal(e[0].chargeC, -limit);
    assert.equal(e[1].chargeC, limit);
    assert.deepEqual(e[0].direction, [0, -1, 0]);
    assert.equal(e[0].radiusM, scene.nozzleDiameterM / 2);
    assert.deepEqual(e[0].centre, scene.tips[0]);
    // The emitter's flow is one drop per Rayleigh–Plateau period.
    const perSecond = M.mpm.mpmEmitterFlow(e[0]) / M.mpm.mpmDerived(scene.config).particleVolume;
    assert.ok(Math.abs(perSecond / M.kelvinDrops(1).rateHz - 1) < 1e-9, `${perSecond} particles a second`);
    // A stream is attracted to its own ring: opposite signs.
    const rings = M.kelvinConductors(scene, 30000);
    assert.ok(e[0].chargeC * rings[0].kq < 0 && e[1].chargeC * rings[1].kq < 0);
    // …and repelled by its own collector: like signs.
    assert.ok(e[0].chargeC * rings[2].kq > 0 && e[1].chargeC * rings[3].kq > 0);
    assert.equal(M.kelvinEmitters(scene, 0, 30000).length, 0);
    assert.equal(M.kelvinEmitters(scene, 0.01, 30000).length, 0);
    assert.equal(M.kelvinEmitters(scene, Number.NaN, 30000).length, 0);
    // At 2 kV the charge is below the limit and follows the voltage.
    assert.ok(M.kelvinEmitters(scene, 1, 2000)[1].chargeC < 0.3 * limit);
  });
});

describe('kelvin-liquid: what lands', () => {
  const scene = M.kelvinLiquidScene();
  const c = scene.config;

  /** Run the dropper at a fixed potential and full drive; returns the per-sink counts. */
  function run(volts, frames = 700) {
    const sim = new M.MpmCpu(c);
    sim.conductors = M.kelvinConductors(scene, volts);
    const emitters = M.kelvinEmitters(scene, 1, volts);
    const carry = [];
    let base = 0;
    for (let f = 0; f < frames; f++) {
      const counts = M.mpm.mpmEmitCounts(c, emitters, scene.substepsPerFrame * c.dt, carry);
      sim.emit({ emitters, counts, seconds: scene.substepsPerFrame * c.dt, baseId: base, sinks: scene.sinks });
      base += counts[0] + counts[1];
      sim.step(scene.substepsPerFrame);
    }
    const landed = sim.sunkBy[0] + sim.sunkBy[1];
    return { landed, missed: sim.sunkBy[2], left: sim.sunkBy[0], right: sim.sunkBy[1], emitted: sim.emitted, inAir: sim.emitted - sim.sunk, share: landed / Math.max(1, landed + sim.sunkBy[2]) };
  }

  it('uncharged: every drop falls into its own collector, 38 a second a side', () => {
    const r = run(0);
    assert.equal(r.missed, 0);
    assert.ok(Math.abs(r.left - r.right) <= 2, `${r.left} left, ${r.right} right`);
    // 700 frames are 11.7 s of flow from two tips.
    const expected = 2 * M.kelvinDrops(1).rateHz * 700 * scene.substepsPerFrame * c.dt;
    assert.ok(Math.abs(r.emitted / expected - 1) < 0.02, `${r.emitted} drops; ${expected.toFixed(0)} expected`);
    // What is in the air is the rate times the fall time.
    const fallS = (-0.6 + Math.sqrt(0.36 + 2 * 9.80665 * scene.fallM)) / 9.80665;
    assert.ok(Math.abs(r.inAir / (2 * M.kelvinDrops(1).rateHz * fallS) - 1) < 0.25, `${r.inAir} drops in the air`);
  });

  it('the streams start to miss just under breakdown: all land at 50 kV, about half at 60 kV, none at 68 kV', () => {
    const at50 = run(50000);
    const at60 = run(60000);
    const at68 = run(68000);
    console.log(`  landed / missed — 50 kV: ${at50.landed}/${at50.missed}, 60 kV: ${at60.landed}/${at60.missed}, 68 kV: ${at68.landed}/${at68.missed}`);
    assert.ok(at50.share > 0.97, `50 kV: ${at50.landed} landed, ${at50.missed} missed`);
    assert.ok(at60.share > 0.3 && at60.share < 0.7, `60 kV: ${at60.landed} landed, ${at60.missed} missed`);
    assert.ok(at68.share < 0.03, `68 kV: ${at68.landed} landed, ${at68.missed} missed`);
    // Missing is not vanishing: every drop is in a collector, on the floor, or still in the air.
    for (const r of [at50, at60, at68]) assert.equal(r.landed + r.missed + r.inAir, r.emitted);
  });

  it('the landing share as the bench reads it: nothing until a dozen drops are down, then a window', () => {
    const e = new M.KelvinEfficiency();
    // The solver's per-sink totals: collectors first, then the floor.
    const feed = (t, sunkBy) => { const { landed, missed } = M.kelvinLanded(sunkBy); return e.update(t, landed, missed); };
    assert.deepEqual(M.kelvinLanded([3, 4, 5, 9]), { landed: 7, missed: 5 });
    assert.equal(e.value, null);
    assert.equal(feed(0, [0, 0, 0, 0]), null);
    assert.equal(feed(0.5, [3, 4, 0, 0]), null, 'seven drops are too few to say');
    assert.equal(feed(1.0, [8, 8, 0, 0]), 1);
    // Half of the next drops miss: the window still holds the good ones.
    const mixed = feed(2.0, [12, 12, 8, 0]);
    assert.ok(Math.abs(mixed - 24 / 32) < 1e-12, `share ${mixed}`);
    // Three seconds on, only the recent ones count.
    feed(4.0, [16, 16, 24, 0]);
    const recent = feed(5.2, [20, 20, 40, 0]);
    assert.ok(recent < 0.45, `share ${recent} once the old drops have left the window`);
    // The stream stops: after a window with nothing coming down the share is unknown again.
    feed(6.0, [20, 20, 40, 0]);
    assert.equal(feed(9.5, [20, 20, 40, 0]), null);
    // A new solver starts its counts from zero: the history goes with the old one.
    feed(10, [2, 2, 0, 0]);
    assert.equal(e.value, null);
    assert.equal(feed(10.5, [9, 9, 0, 0]), 1);
    e.reset();
    assert.equal(e.value, null);
  });
});

describe('kelvin: the fallback renderer\'s drops follow the same law', () => {
  const a = M.KELVIN_APPARATUS;

  /** Run the CPU drops as WebGL2 does: `seconds` on screen at a frame rate, fixed potential. */
  function run(volts, { drive = 1, seconds = 12, hz = 60, n = 600 } = {}) {
    const particles = new Float32Array(n * 8);
    const tally = { landed: 0, missed: 0 };
    let released = 0;
    let lowestFlying = Infinity;
    let widest = 0;
    for (let f = 0; f < seconds * hz; f++) {
      const before = flying(particles, n);
      M.stepParticles(particles, { time: f / hz, mode: 2, particleCount: n, dt: 1 / hz, simClock: f / hz, kelvinDrive: drive, kelvinVolts: volts, kelvinTally: tally });
      const after = flying(particles, n);
      released += Math.max(0, after - before + (tally.landed + tally.missed - (run.done ?? 0)));
      run.done = tally.landed + tally.missed;
      for (let i = 0; i < n; i++) {
        if (particles[i * 8 + 7] === 0) continue;
        lowestFlying = Math.min(lowestFlying, particles[i * 8 + 1]);
        widest = Math.max(widest, Math.abs(Math.abs(particles[i * 8]) - a.columnX));
      }
    }
    run.done = 0;
    return { ...tally, released, inAir: flying(particles, n), lowestFlying, widest, particles, share: tally.landed / Math.max(1, tally.landed + tally.missed) };
  }
  const flying = (p, n) => { let c = 0; for (let i = 0; i < n; i++) if (p[i * 8 + 7] !== 0) c++; return c; };

  it('uncharged: drops leave each tip at the Rayleigh–Plateau rate, fall straight and all land', () => {
    const r = run(0);
    assert.equal(r.missed, 0);
    // 12 s of flow from two tips.
    const expected = 2 * M.kelvinDrops(1).rateHz * 12 * K.LIQUID_TIME_SCALE;
    assert.ok(Math.abs((r.landed + r.inAir) / expected - 1) < 0.12, `${r.landed + r.inAir} drops; ${expected.toFixed(0)} expected`);
    // The bore (0.04 units) plus what a 2 % spread adds over the fall: well inside the mouth's 0.7.
    assert.ok(r.widest < 0.15, `a drop strayed ${r.widest} scene units from its column with no field`);
    // Waiting drops are out of the picture; flying ones are between the tips and the mouths.
    for (let i = 0; i < 600; i++) {
      const y = r.particles[i * 8 + 1];
      if (r.particles[i * 8 + 7] === 0) assert.ok(y < -1000, `a waiting drop is drawn at y = ${y}`);
      else assert.ok(y <= a.tipY + 1e-6 && y > M.KELVIN_COLLECTOR_MOUTH_Y - 0.6, `a flying drop is at y = ${y}`);
    }
    // No flow, no drops.
    const dry = run(0, { drive: 0, seconds: 2 });
    assert.equal(dry.landed + dry.missed + dry.inAir, 0);
  });

  it('the same threshold as the solver: all land at 50 kV, about half at 60 kV, none at 68 kV', () => {
    const at50 = run(50000);
    const at60 = run(60000);
    const at68 = run(68000);
    console.log(`  CPU drops, landed / missed — 50 kV: ${at50.landed}/${at50.missed}, 60 kV: ${at60.landed}/${at60.missed}, 68 kV: ${at68.landed}/${at68.missed}`);
    assert.ok(at50.share > 0.95, `50 kV: ${at50.landed} landed, ${at50.missed} missed`);
    assert.ok(at60.share > 0.25 && at60.share < 0.75, `60 kV: ${at60.landed} landed, ${at60.missed} missed`);
    assert.ok(at68.share < 0.05, `68 kV: ${at68.landed} landed, ${at68.missed} missed`);
    // The streams splay: wider at 60 kV than at 50 kV.
    assert.ok(at60.widest > at50.widest, `stream half-width ${at50.widest} at 50 kV, ${at60.widest} at 60 kV`);
  });

  it('a slow frame rate changes nothing that matters', () => {
    const fast = run(58000, { hz: 60 });
    const slow = run(58000, { hz: 15 });
    assert.ok(Math.abs(fast.share - slow.share) < 0.15, `landing share ${fast.share} at 60 fps, ${slow.share} at 15 fps`);
    assert.ok(Math.abs((slow.landed + slow.missed) / (fast.landed + fast.missed) - 1) < 0.15);
  });
});

describe('kelvin: the stand-in drop train (no solver, no field)', () => {
  const a = M.KELVIN_APPARATUS;
  const wgsl = readFileSync(join(ROOT, 'src/shaders/passes/particle-compute.wgsl'), 'utf8');
  const constant = (name) => Number(wgsl.match(new RegExp(`const ${name}: f32 = ([-\\d.e]+);`))?.[1]);

  it('the shader\'s copy of the dropper is the layout table and the constants file', () => {
    assert.equal(constant('KELVIN_COLUMN_X'), a.columnX);
    assert.equal(constant('KELVIN_TIP_Y'), a.tipY);
    assert.equal(constant('KELVIN_MOUTH_Y'), M.KELVIN_COLLECTOR_MOUTH_Y);
    assert.equal(constant('KELVIN_COLLECTOR_Y'), a.collectorY);
    assert.equal(constant('KELVIN_M_PER_UNIT'), K.METRES_PER_SCENE_UNIT);
    assert.equal(constant('KELVIN_TIME_SCALE'), K.LIQUID_TIME_SCALE);
    assert.equal(constant('KELVIN_NOZZLE_D'), K.NOZZLE_DIAMETER_M);
    assert.equal(constant('KELVIN_RP_WAVELENGTH'), M.RAYLEIGH_PLATEAU_WAVELENGTH);
    assert.ok(Math.abs(constant('KELVIN_MIN_JET_MS') - M.KELVIN_STAND_IN_MIN_MS) < 1e-12);
    assert.equal(constant('KELVIN_G'), M.PHYSICAL_CONSTANTS.G);
  });

  it('one drop every Rayleigh–Plateau period per tip, falling under gravity alone', () => {
    const v0 = K.JET_SPEED_MAX_MS;
    const fallS = (Math.sqrt(v0 * v0 + 2 * 9.80665 * M.KELVIN_FALL_M) - v0) / 9.80665;
    const period = 1 / M.kelvinDrops(1).rateHz;
    const n = 400;
    const flying = (t) => {
      const ys = [[], []];
      for (let i = 0; i < n; i++) {
        const p = M.kelvinStandInDrop(i, t, v0);
        assert.ok(Math.abs(Math.abs(p[0]) - a.columnX) < 1e-6 && p[2] === 0);
        assert.equal(p[0] > 0, (i & 1) === 1, 'even slots are the left tip\'s');
        if (p[1] > M.KELVIN_COLLECTOR_MOUTH_Y - 1e-4) {
          assert.ok(p[1] <= a.tipY + 1e-5);
          ys[i & 1].push(p[1]);
        } else {
          // Landed, or a slot the train has no use for: inside the collector.
          assert.equal(p[1], a.collectorY);
        }
      }
      return ys;
    };
    for (const t of [0, 0.37, 1.9, 12.25, 61.3]) {
      const [left, right] = flying(t);
      // What is in the air is the rate times the flight time, give or take the one being let go.
      for (const side of [left, right]) assert.ok(Math.abs(side.length - fallS / period) <= 1, `${side.length} drops in the air at t = ${t}; ${(fallS / period).toFixed(1)} expected`);
      // The two tips are in step, and no two drops of a tip share a height.
      assert.deepEqual(left, right);
      assert.equal(new Set(left.map((y) => y.toFixed(4))).size, left.length);
    }
    // A drop is where free fall puts it: follow slot 0 from its release.
    const scale = K.METRES_PER_SCENE_UNIT;
    const slots = Math.ceil(Math.fround(fallS / period)) + 1;
    const cycle = slots * period / K.LIQUID_TIME_SCALE; // displayed seconds
    for (const frac of [0.1, 0.4, 0.8]) {
      const tau = frac * fallS;
      const y = M.kelvinStandInDrop(0, 7 * cycle + tau / K.LIQUID_TIME_SCALE, v0)[1];
      const want = a.tipY - (v0 * tau + 0.5 * 9.80665 * tau * tau) / scale;
      assert.ok(Math.abs(y - want) < 2e-3, `after ${tau.toFixed(3)} s of fall: y = ${y}, free fall says ${want}`);
    }
  });

  it('half the flow: half as many drops, each falling for longer; a weeping tip shows none', () => {
    const count = (v0) => { let c = 0; for (let i = 0; i < 400; i++) if (M.kelvinStandInDrop(i, 3.3, v0)[1] > M.KELVIN_COLLECTOR_MOUTH_Y) c++; return c; };
    const full = count(K.JET_SPEED_MAX_MS), half = count(0.5 * K.JET_SPEED_MAX_MS);
    assert.ok(half < 0.7 * full && half > 0.4 * full, `${full} drops at full flow, ${half} at half`);
    assert.equal(count(0), 0);
    assert.equal(count(0.5 * M.KELVIN_STAND_IN_MIN_MS), 0);
    assert.equal(count(Number.NaN), 0);
    assert.ok(Math.abs(M.KELVIN_STAND_IN_MIN_MS - M.MIN_DRIVE * K.JET_SPEED_MAX_MS) < 1e-12);
  });
});

describe('kelvin: the note says what the drops are', () => {
  const running = { build: 'ready', allocated: true, active: true, live: 21, substeps: 400 };
  it('WebGL2: the same law on the CPU, and that the solver needs WebGPU', () => {
    const text = M.kelvinDropsNoteText({ renderer: 'webgl2', landingShare: 0.874 });
    assert.match(text, /Rayleigh–Plateau drop \(3\.3 mm\)/);
    assert.match(text, /on the CPU \(the liquid solver needs WebGPU\)/);
    assert.match(text, /87 % landing in the collectors/);
    assert.match(text, /not a measurement/);
    assert.match(M.kelvinDropsNoteText({ renderer: 'webgl2', landingShare: null }), /landing share not known yet/);
    // The drop size in the note is the one the physics uses.
    assert.ok(Math.abs(M.kelvinDrops(1).radiusM * 1000 - 3.3) < 0.05);
  });
  it('WebGPU: the solver\'s drops and their count — or why not', () => {
    const on = M.kelvinDropsNoteText({ renderer: 'webgpu', liquid: running, landingShare: 1 });
    assert.match(on, /Drops on the liquid solver/);
    assert.match(on, /21 in the air · 100 % landing/);
    assert.match(M.kelvinDropsNoteText({ renderer: 'webgpu', liquid: { ...running, build: 'pending', allocated: false, active: false, substeps: 0 } }), /starting/);
    assert.match(M.kelvinDropsNoteText({ renderer: 'webgpu', liquid: { ...running, allocated: true, substeps: 0 } }), /starting/);
    const off = M.kelvinDropsNoteText({ renderer: 'webgpu', liquid: { ...running, allocated: false, active: false } });
    assert.match(off, /gravity alone/);
    assert.match(off, /assumes they all land/);
    assert.match(M.kelvinDropsNoteText({ renderer: 'webgpu', liquid: null }), /gravity alone/);
  });
});

describe('kelvin: the loop closed — plant, drops, and what lands fed back', () => {
  /** A minute of the JS plant and the CPU drops at a drive, with or without the landing share fed back. */
  function minute(drive, feedback) {
    const hz = 60;
    const state = M.createDevicePhysicsState('kelvin');
    const particles = new Float32Array(600 * 8);
    const tally = { landed: 0, missed: 0 };
    const share = new M.KelvinEfficiency();
    let sparks = 0;
    let wasSpark = false;
    let vMaxLate = 0;
    for (let f = 0; f < 60 * hz; f++) {
      const t = f / hz;
      M.stepDevicePhysics(state, 1 / hz, drive);
      const spark = state.kelvinSparkTimer > 0;
      if (spark && !wasSpark) sparks++;
      wasSpark = spark;
      M.stepKelvinDrops(particles, 600, { dt: 1 / hz, drive, volts: state.kelvinV + M.kelvinSeedV(state), simClock: t, tally });
      const measured = share.update(t, tally.landed, tally.missed);
      state.kelvinCollectionEff = feedback ? measured : null;
      if (t > 30) vMaxLate = Math.max(vMaxLate, state.kelvinV);
    }
    return { sparks, vMaxLate, landed: tally.landed, missed: tally.missed, charged: state.kelvinLandedShare };
  }

  it('at full drive the plant sweeps through the window faster than a drop falls: the feedback changes nothing', () => {
    const fed = minute(1, true);
    const free = minute(1, false);
    assert.ok(fed.sparks > 30, `${fed.sparks} sparks in a minute`);
    assert.ok(Math.abs(fed.sparks - free.sparks) <= 1, `${fed.sparks} sparks with the share fed back, ${free.sparks} without`);
    assert.ok(fed.missed < 0.02 * fed.landed, `${fed.missed} drops missed of ${fed.landed + fed.missed}`);
  });

  it('at a trickle it dwells there: the streams miss, and the bench stalls under breakdown instead of sparking', () => {
    const fed = minute(0.2, true);
    const free = minute(0.2, false);
    console.log(`  20 % drive, a minute: ${fed.sparks} sparks with the share fed back (V up to ${(fed.vMaxLate / 1000).toFixed(1)} kV, ${fed.landed}/${fed.missed} landed/missed), ${free.sparks} with everything assumed to land`);
    assert.ok(free.sparks >= 2, `${free.sparks} sparks with everything landing`);
    assert.equal(fed.sparks, 0, 'the bench still sparks although a third of its drops miss');
    // It sits under breakdown, not at zero: charging and loss have met.
    assert.ok(fed.vMaxLate > 40000 && fed.vMaxLate < 58000, `V settles at ${fed.vMaxLate}`);
    assert.ok(fed.missed > 0.15 * (fed.landed + fed.missed), `${fed.missed} of ${fed.landed + fed.missed} drops missed`);
    // The plant reports the share it was charged with.
    assert.ok(fed.charged > 0.3 && fed.charged < 1, `kelvinLandedShare ${fed.charged}`);
    assert.equal(free.charged, 1);
  });
});
