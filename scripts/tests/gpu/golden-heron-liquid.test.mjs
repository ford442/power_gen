/**
 * test:gpu-golden — Heron's fountain on the liquid solver (ADR-0022,
 * docs/FLUIDS.md → Heron), on a real GPU.
 *
 * The scene is the bench's own (`heronLiquidScene`, low tier — what a
 * software rasteriser can step in test time), the exit speed is the plant's
 * (`computeHeronHydraulics` at 80 % of each preset's head ceiling), and the
 * jet's height is read the way the bench reads it: the profile read-back.
 *
 *   - the jet stands v²/2g tall within 10 %, on three layout presets
 *   - every particle is accounted for: in the box = emitted − drained
 *   - a higher head gives a taller jet
 *   - with the nozzle below a dribble nothing is emitted
 *   - over 60 s on screen the nozzle makes the plant's Q·t of liquid within
 *     1 %, every particle of it is in the box or drained, and what is in the
 *     air neither builds up nor runs down
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { gpuSkip, nodeGpu, readBuffer } from '../../lib/node-gpu.mjs';
import { gpuSession } from '../../lib/gpu-app.mjs';

const gpu = await nodeGpu();
const skip = gpuSkip(gpu);
// Top level: nodeDevice() destroys the device when the enclosing scope ends.
const session = skip ? null : await gpuSession(gpu, { label: 'golden-heron-liquid' });

/** Run a preset's fountain for `simS` simulated seconds at a fraction of its head ceiling. */
async function fountain(presetId, headFraction, simS) {
  const { app, device, cache } = session;
  const H = app.heronLiquid;
  const layout = app.getHeronLayout(presetId);
  const scene = H.heronLiquidScene({ ...layout, riserM: H.heronRiserM(layout) }, 'low');
  const cfg = scene.config;
  const v = app.computeHeronHydraulics(layout.headMaxM * headFraction, layout).vExit;
  const solver = await app.MpmSolver.create(device, cache, app.MPM_SHADERS, cfg, {
    boundary: app.bakeMpmBoundary(cfg, scene.solids),
    io: true
  });
  solver.emitters = H.heronEmitters(scene, v);
  solver.sinks = scene.sinks;
  const frames = Math.round(simS / (scene.substepsPerFrame * cfg.dt));
  const tops = [];
  const live = [];
  let peakLive = 0;
  for (let f = 0; f < frames; f++) {
    const enc = device.createCommandEncoder();
    solver.encodeFrame(enc, scene.substepsPerFrame, { probe: true });
    device.queue.submit([enc.finish()]);
    const p = await solver.collectProfile();
    if (!p) continue;
    tops.push(app.mpmProfileTop(cfg, p.layers, scene.jetThreshold) - scene.nozzle[1]);
    live.push(p.emitted - p.sunk);
    peakLive = Math.max(peakLive, p.emitted - p.sunk);
  }
  // One more frame, then read the particles and the counters of the same moment.
  const enc = device.createCommandEncoder();
  solver.encodeFrame(enc, scene.substepsPerFrame, { probe: true });
  device.queue.submit([enc.finish()]);
  const end = await solver.collectProfile();
  const particles = new Float32Array(await readBuffer(device, solver.particleBuffer));
  const totals = app.mpmTotals(cfg, particles, cfg.maxParticles);
  const requested = solver.emitRequested;
  solver.destroy();
  const tail = tops.slice(-Math.round(tops.length / 4)).filter(Number.isFinite);
  return {
    scene, v, tops, live, end, totals, requested, peakLive, layout,
    simS: (frames + 1) * scene.substepsPerFrame * cfg.dt,
    steady: tail.reduce((a, x) => a + x, 0) / Math.max(1, tail.length),
    ideal: H.heronIdealJetHeight(v)
  };
}

describe('gpu-golden: Heron fountain on the liquid solver', { skip }, () => {
  for (const preset of ['classic', 'compact', 'tower']) {
    it(`${preset}: the jet stands v²/2g tall within 10 %, and the books balance`, async () => {
      const r = await fountain(preset, 0.8, 3);
      assert.deepEqual(session.device.uncaptured, [], 'GPU validation errors');
      assert.ok(r.v > 2, `plant exit speed ${r.v} m/s — the plant is not driving a jet`);
      assert.ok(r.tops.length > 100, `only ${r.tops.length} profiles came back`);
      assert.ok(Math.abs(r.steady / r.ideal - 1) < 0.1,
        `jet top ${(r.steady * 100).toFixed(1)} cm above the nozzle; v²/2g at ${r.v.toFixed(2)} m/s is ${(r.ideal * 100).toFixed(1)} cm`);
      assert.ok(r.totals.finite, 'a particle is not finite');
      assert.equal(r.totals.count, r.end.emitted - r.end.sunk, 'in the box = emitted − drained');
      assert.equal(r.end.emitted, r.requested, 'the budget never ran out: every particle asked for was made');
      assert.ok(r.end.sunk > 0.5 * r.end.emitted, 'the fallen water is draining through the tray');
      assert.ok(r.peakLive < 0.6 * r.scene.config.maxParticles, `${r.peakLive} particles at once on a budget of ${r.scene.config.maxParticles}`);
      const c = r.scene.config;
      console.log(`  ${preset}: v ${r.v.toFixed(2)} m/s → top ${(r.steady / r.ideal).toFixed(3)} of v²/2g = ${(r.ideal * 100).toFixed(1)} cm; `
        + `grid ${c.gridN.join('×')}, cell ${(c.cellM * 1000).toFixed(1)} mm, ${r.scene.substepsPerFrame} substeps/frame; `
        + `${r.totals.count} in the box, ${r.end.emitted} emitted, ${r.end.sunk} drained`);
    });
  }

  it('half the head, a lower jet', async () => {
    const low = await fountain('classic', 0.4, 2.5);
    const high = await fountain('classic', 0.8, 2.5);
    assert.deepEqual(session.device.uncaptured, [], 'GPU validation errors');
    // v² ∝ head, so the ideal heights are 1 : 2; the measured ones should be close to that.
    assert.ok(Math.abs(high.ideal / low.ideal - 2) < 0.05, `ideal ratio ${high.ideal / low.ideal}`);
    assert.ok(Math.abs(high.steady / low.steady - 2) < 0.4, `measured jet heights ${low.steady} m and ${high.steady} m`);
  });

  it('60 s on screen: the nozzle makes the plant\'s Q·t within 1 %, none of it is lost, and the jet holds a steady volume', async () => {
    const { app } = session;
    // 60 displayed seconds at the bench's 1/6 time scale.
    const r = await fountain('classic', 0.8, 60 * app.heronLiquid.HERON_LIQUID_TIME_SCALE);
    assert.deepEqual(session.device.uncaptured, [], 'GPU validation errors');
    const cfg = r.scene.config;
    const particleVolume = cfg.cellM ** 3 / cfg.particlesPerCell;
    // What the plant says left the nozzle: Q = A_nozzle · v.
    const plantVolume = Math.PI * (r.layout.nozzleDiameterM / 2) ** 2 * r.v * r.simS;
    const emittedVolume = r.end.emitted * particleVolume;
    assert.ok(Math.abs(emittedVolume / plantVolume - 1) < 0.01,
      `emitted ${(emittedVolume * 1e3).toFixed(3)} L; the plant's Q·t is ${(plantVolume * 1e3).toFixed(3)} L`);
    // Not one particle unaccounted for: read back from the particle buffer, not from the counters.
    assert.ok(r.totals.finite, 'a particle is not finite');
    assert.equal(r.totals.count, r.end.emitted - r.end.sunk, 'in the box = emitted − drained');
    assert.equal(r.end.emitted, r.requested, 'the budget never ran out');
    // Steady: the liquid in the air over the last quarter is what it was over the quarter before.
    const q = Math.floor(r.live.length / 4);
    const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
    const third = mean(r.live.slice(2 * q, 3 * q));
    const fourth = mean(r.live.slice(3 * q));
    assert.ok(Math.abs(fourth / third - 1) < 0.01, `in the air: ${third.toFixed(0)} particles over 30–45 s, ${fourth.toFixed(0)} over 45–60 s`);
    console.log(`  60 s: ${(emittedVolume * 1e3).toFixed(2)} L emitted of ${(plantVolume * 1e3).toFixed(2)} L (plant), `
      + `${r.end.sunk} drained, in the air ${third.toFixed(0)} → ${fourth.toFixed(0)} particles (${((fourth / third - 1) * 100).toFixed(2)} %)`);
  });

  it('below a dribble nothing is emitted', async () => {
    const r = await fountain('classic', 0.0005, 0.3);
    assert.ok(r.v < session.app.heronLiquid.HERON_MIN_JET_MS, `exit speed ${r.v}`);
    assert.equal(r.end.emitted, 0);
    assert.equal(r.totals.count, 0);
  });
});
