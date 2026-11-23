/**
 * test:gpu-golden — Kelvin's dropper on the liquid solver (ADR-0022,
 * docs/FLUIDS.md → Kelvin), on a real GPU.
 *
 * The scene is the bench's own (`kelvinLiquidScene`), the drops, their charge
 * and the conductors are the bench's (`kelvinEmitters`, `kelvinConductors`)
 * at fixed potentials, and what landed is read the way the bench reads it:
 * the profile's per-sink counts.
 *
 *   - uncharged, every drop lands in its own collector, at the Rayleigh–Plateau rate
 *   - the streams start to miss just under breakdown: all land at 50 kV, about
 *     half at 60 kV, none at 68 kV — as the CPU twin says, count for count
 *   - every drop is accounted for: in the air, in a collector, or on the floor
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { gpuSkip, nodeGpu, readBuffer } from '../../lib/node-gpu.mjs';
import { gpuSession } from '../../lib/gpu-app.mjs';

const gpu = await nodeGpu();
const skip = gpuSkip(gpu);
// Top level: nodeDevice() destroys the device when the enclosing scope ends.
const session = skip ? null : await gpuSession(gpu, { label: 'golden-kelvin-liquid' });

const FRAMES = 300;

/** The dropper at a fixed potential and full drive, on the GPU and on the CPU twin. */
async function dropper(volts) {
  const { app, device, cache } = session;
  const K = app.kelvinLiquid;
  const scene = K.kelvinLiquidScene();
  const cfg = scene.config;
  const emitters = K.kelvinEmitters(scene, 1, volts);
  const conductors = K.kelvinConductors(scene, volts);

  const cpu = new app.MpmCpu(cfg);
  cpu.conductors = conductors;
  const carry = [];
  let base = 0;
  for (let f = 0; f < FRAMES; f++) {
    const counts = app.mpm.mpmEmitCounts(cfg, emitters, scene.substepsPerFrame * cfg.dt, carry);
    cpu.emit({ emitters, counts, seconds: scene.substepsPerFrame * cfg.dt, baseId: base, sinks: scene.sinks });
    base += counts[0] + counts[1];
    cpu.step(scene.substepsPerFrame);
  }

  const solver = await app.MpmSolver.create(device, cache, app.MPM_SHADERS, cfg, { io: true });
  solver.emitters = emitters;
  solver.sinks = scene.sinks;
  solver.setConductors(conductors);
  for (let f = 0; f < FRAMES; f++) {
    const enc = device.createCommandEncoder();
    solver.encodeFrame(enc, scene.substepsPerFrame, { probe: f === FRAMES - 1 });
    device.queue.submit([enc.finish()]);
  }
  const profile = await solver.collectProfile();
  const particles = new Float32Array(await readBuffer(device, solver.particleBuffer));
  const totals = app.mpmTotals(cfg, particles, cfg.maxParticles);
  solver.destroy();
  const { landed, missed } = K.kelvinLanded(profile.sunkBy);
  const cpuCounts = K.kelvinLanded(cpu.sunkBy);
  return {
    scene, profile, totals, landed, missed, share: landed / Math.max(1, landed + missed),
    cpu: { ...cpuCounts, emitted: cpu.emitted, share: cpuCounts.landed / Math.max(1, cpuCounts.landed + cpuCounts.missed) }
  };
}

describe('gpu-golden: Kelvin dropper on the liquid solver', { skip }, () => {
  it('uncharged: every drop lands in its own collector, one per Rayleigh–Plateau period', async () => {
    const { app } = session;
    const r = await dropper(0);
    assert.deepEqual(session.device.uncaptured, [], 'GPU validation errors');
    assert.equal(r.missed, 0);
    assert.ok(Math.abs(r.profile.sunkBy[0] - r.profile.sunkBy[1]) <= 2, JSON.stringify(r.profile.sunkBy));
    const seconds = FRAMES * r.scene.substepsPerFrame * r.scene.config.dt;
    const expected = 2 * app.kelvinLiquid.kelvinDrops(1).rateHz * seconds;
    assert.ok(Math.abs(r.profile.emitted / expected - 1) < 0.02, `${r.profile.emitted} drops in ${seconds.toFixed(2)} s; ${expected.toFixed(0)} expected`);
    assert.ok(r.totals.finite);
    assert.equal(r.totals.count, r.profile.emitted - r.profile.sunk, 'in the box = emitted − taken');
    assert.equal(r.profile.emitted, r.cpu.emitted);
    assert.equal(r.landed, r.cpu.landed);
  });

  it('the streams start to miss just under breakdown — as the CPU twin says', async () => {
    const at50 = await dropper(50000);
    const at60 = await dropper(60000);
    const at68 = await dropper(68000);
    assert.deepEqual(session.device.uncaptured, [], 'GPU validation errors');
    console.log(`  landed / missed, GPU (CPU) — 50 kV: ${at50.landed}/${at50.missed} (${at50.cpu.landed}/${at50.cpu.missed}), `
      + `60 kV: ${at60.landed}/${at60.missed} (${at60.cpu.landed}/${at60.cpu.missed}), 68 kV: ${at68.landed}/${at68.missed} (${at68.cpu.landed}/${at68.cpu.missed})`);
    assert.ok(at50.share > 0.97, `50 kV: ${at50.landed} landed, ${at50.missed} missed`);
    assert.ok(at60.share > 0.3 && at60.share < 0.7, `60 kV: ${at60.landed} landed, ${at60.missed} missed`);
    assert.ok(at68.share < 0.03, `68 kV: ${at68.landed} landed, ${at68.missed} missed`);
    for (const r of [at50, at60, at68]) {
      // The GPU and the CPU agree on what landed, to a few drops near the threshold
      // (a drop grazing a collector's edge can go either way in f32).
      assert.ok(Math.abs(r.landed - r.cpu.landed) <= 6, `GPU ${r.landed} landed, CPU ${r.cpu.landed}`);
      assert.ok(Math.abs(r.missed - r.cpu.missed) <= 6, `GPU ${r.missed} missed, CPU ${r.cpu.missed}`);
      // Every drop is in the air, in a collector, or on the floor.
      assert.ok(r.totals.finite);
      assert.equal(r.totals.count, r.profile.emitted - r.profile.sunk);
      assert.equal(r.landed + r.missed, r.profile.sunk);
    }
  });
});
