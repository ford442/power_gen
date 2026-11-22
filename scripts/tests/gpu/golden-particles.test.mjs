/**
 * test:gpu-golden — particle-compute.wgsl invariants (#258 §3).
 *
 * The pass places each particle on a closed-form path per device mode; the
 * CPU path in renderers/shared/particle-physics.ts integrates a different
 * (velocity-carrying, 32 B) particle, so most modes have no cell-for-cell
 * twin. The MHD duct does — its timelines are the analytic Hartmann profile
 * (devices/core/mhd-parcels.ts), compared position for position below.
 * What must hold for every one of the catalog's shader modes, at any time
 * and any plant state:
 *
 *   - no NaN / Inf position;
 *   - positions stay inside the device's bounding sphere — the 16-unit
 *     radius the overview cull pass tests, so a particle outside it could be
 *     drawn by a device the cull pass removed, or vanish with one it kept;
 *   - count conserved: `phase` (the particle's identity) is written back bit
 *     for bit, and particles above the LOD threshold are not touched at all.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { gpuSkip, nodeGpu, readBuffer } from '../../lib/node-gpu.mjs';
import { gpuSession } from '../../lib/gpu-app.mjs';

const gpu = await nodeGpu();
const skip = gpuSkip(gpu);
const session = skip ? null : await gpuSession(gpu, { label: 'golden-particles' });

const COUNT = 4096;
/** renderers/shared/view-lod.ts DEFAULT_DEVICE_CULL_RADIUS. */
const BOUND = 16;
/** Scene time: boot, mid-frame, a long demo, an hour-long kiosk session. */
const TIMES = [0, 0.37, 12.5, 600, 3600];
/**
 * physics0..3 as device-compute.ts `updateComputeUniforms` packs them: 0..1
 * for every device (each is clamped there), plus the few fields that are not
 * normalised, for the device that sends them.
 */
const PHYSICS = [
  [0, 0, 0, 0],
  [1, 1, 1, 1],
  [0.5, 0.25, 0.75, 0.95],
  [1, 0, 0.3, 1]
];
const PHYSICS_BY_DEVICE = {
  // maglevGap in metres, maglevFieldT in tesla.
  maglev: [[0.018, 0.5, 0, 0], [0.002, 1.4, 0, 0]],
  // homopolarAngle in radians, unwrapped.
  homopolar: [[1, 1, 6.2, 0], [0.4, 0.2, 941.7, 0]],
  // transformerFluxN is signed.
  transformer: [[1, 1, -1, 0.95], [0.2, 0.1, 1, 0.5]],
  // [travel 0..1, B/1 T, Hartmann number (raw), -]: the bench's 0.2 T and 1.0 T,
  // B = 0, and a slug far past where cosh would overflow in f32.
  mhd: [[0.37, 0.2, 3.79, 0], [0.9, 1, 18.95, 0], [0.12, 0, 0, 0], [0.5, 1, 1895, 0]]
};

function seed(count) {
  let s = 0x2545f491;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const data = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    // Sentinel positions: a particle the pass skips keeps them.
    data[i * 4] = 1000 + i;
    data[i * 4 + 1] = -1000;
    data[i * 4 + 2] = 0.5;
    data[i * 4 + 3] = rnd();
  }
  return data;
}

describe('gpu-golden: particle-compute.wgsl invariants', { skip }, () => {
  const modes = skip ? [] : session.app.DEVICE_CATALOG.map((d) => ({ id: d.id, mode: d.shaderMode }));
  let rig;
  const setup = async () => {
    if (rig) return rig;
    const { device, cache, shaders } = session;
    await cache.ensureDevicePipelines(shaders);
    const pipeline = cache.getParticleComputePipeline();
    assert.ok(pipeline, 'particleCompute pipeline missing');
    const particles = device.createBuffer({
      size: COUNT * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
    });
    const uniforms = device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const bindGroup = cache.createBindGroup('particleCompute', [
      { binding: 0, resource: { buffer: particles } },
      { binding: 1, resource: { buffer: uniforms } }
    ]);
    rig = { pipeline, particles, uniforms, bindGroup, initial: seed(COUNT) };
    return rig;
  };

  async function run({ mode, time, physics, lod = 0, speedMult = 1 }) {
    const { device } = session;
    const r = await setup();
    device.queue.writeBuffer(r.particles, 0, r.initial);
    // ComputeUniforms write order: device-compute.ts updateComputeUniforms.
    device.queue.writeBuffer(r.uniforms, 0, new Float32Array([time, mode, COUNT, speedMult, ...physics, lod, 0, 0, 0]));
    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(r.pipeline);
    pass.setBindGroup(0, r.bindGroup);
    pass.dispatchWorkgroups(Math.ceil(COUNT / 64));
    pass.end();
    device.queue.submit([enc.finish()]);
    return new Float32Array(await readBuffer(device, r.particles));
  }

  for (const { id, mode } of modes) {
    const states = [...PHYSICS, ...(PHYSICS_BY_DEVICE[id] ?? [])];
    it(`${id} (mode ${mode}): finite, inside ${BOUND} units, phase preserved — ${TIMES.length} times × ${states.length} plant states`, async () => {
      const { initial } = await setup();
      let reach = 0;
      for (const time of TIMES) {
        for (const physics of states) {
          const out = await run({ mode, time, physics });
          for (let i = 0; i < COUNT; i++) {
            const o = i * 4;
            const [x, y, z] = [out[o], out[o + 1], out[o + 2]];
            const where = `particle ${i} at t=${time}, physics [${physics}]`;
            assert.ok(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z), `${where}: non-finite position (${x}, ${y}, ${z})`);
            const r = Math.hypot(x, y, z);
            reach = Math.max(reach, r);
            assert.ok(r <= BOUND, `${where}: |pos| = ${r} leaves the bounding sphere`);
            assert.ok(Object.is(out[o + 3], initial[o + 3]), `${where}: phase changed ${initial[o + 3]} → ${out[o + 3]}`);
          }
        }
      }
      assert.deepEqual(session.device.uncaptured, [], 'GPU validation errors');
      console.log(`  farthest particle ${reach.toFixed(2)} of ${BOUND}`);
    });
  }

  it('mhd: posMhd is the analytic Hartmann timeline, position for position (CPU twin mhdParcelPosition)', async () => {
    const mode = modes.find((d) => d.id === 'mhd').mode;
    const { mhdParcelPosition, MHD_DUCT } = session.app;
    // Travel values that put a line at the inlet, mid-duct and about to wrap.
    const cases = [
      { travel: 0, ha: 0 }, { travel: 0.37, ha: 0.2 }, { travel: 0.37, ha: 0.25 }, { travel: 0.62, ha: 3.79 },
      { travel: 0.999, ha: 5 }, { travel: 0.124, ha: 18.95 }, { travel: 0.5, ha: 20 }, { travel: 0.875, ha: 1895 }
    ];
    let worst = 0;
    let spread = 0;
    for (const { travel, ha } of cases) {
      const out = await run({ mode, time: 12.5, physics: [travel, 0.6, ha, 0] });
      const want = [0, 0, 0];
      let xMin = Infinity;
      let xMax = -Infinity;
      for (let i = 0; i < COUNT; i++) {
        mhdParcelPosition(i, travel, ha, want);
        const o = i * 4;
        const d = Math.max(Math.abs(out[o] - want[0]), Math.abs(out[o + 1] - want[1]), Math.abs(out[o + 2] - want[2]));
        worst = Math.max(worst, d);
        // 1e-4 of a 4.2-unit duct: f32 exp() against double, nothing else differs.
        assert.ok(d <= 1e-4, `particle ${i}, travel ${travel}, Ha ${ha}: GPU (${out[o]}, ${out[o + 1]}, ${out[o + 2]}) vs CPU (${want})`);
        xMin = Math.min(xMin, out[o]);
        xMax = Math.max(xMax, out[o]);
      }
      spread = Math.max(spread, xMax - xMin);
      assert.ok(xMin >= MHD_DUCT.xIn - 1e-4 && xMax <= MHD_DUCT.xIn + MHD_DUCT.lengthU + 1e-4, `Ha ${ha}: x in [${xMin}, ${xMax}]`);
    }
    // The comparison is not of a pile at the inlet: lines reach well down the duct.
    assert.ok(spread > 0.8 * MHD_DUCT.lengthU, `timelines only span ${spread} units`);
    assert.deepEqual(session.device.uncaptured, [], 'GPU validation errors');
    console.log(`  worst |GPU − CPU| = ${worst.toExponential(2)} units`);
  });

  it('mhd: a larger Hartmann number flattens the timeline — more of it keeps up with the centre', async () => {
    const mode = modes.find((d) => d.id === 'mhd').mode;
    const { MHD_DUCT } = session.app;
    // One line (idx % 8 === 0) at τ = 0.75: count parcels within 10 % of its leading edge.
    const lead = MHD_DUCT.xIn + MHD_DUCT.lengthU * 0.75;
    const upFront = async (ha) => {
      const out = await run({ mode, time: 1, physics: [0.75, 0.6, ha, 0] });
      let n = 0;
      for (let i = 0; i < COUNT; i += 8) if (out[i * 4] > lead - 0.1 * MHD_DUCT.lengthU * 0.75) n++;
      return n / (COUNT / 8);
    };
    const [parabola, low, high] = [await upFront(0), await upFront(3.79), await upFront(18.95)];
    // u/u0 > 0.9: |η| < 0.316 for the parabola; nearly the whole gap at Ha 19.
    assert.ok(Math.abs(parabola - 0.316) < 0.02, `B = 0: ${parabola}`);
    assert.ok(low > parabola + 0.1 && high > low + 0.3 && high > 0.85, `fractions ${parabola}, ${low}, ${high}`);
  });

  it('LOD 0..3: exactly count >> lod particles are integrated, the rest untouched', async () => {
    const { initial } = await setup();
    for (let lod = 0; lod <= 3; lod++) {
      const out = await run({ mode: 0, time: 3, physics: PHYSICS[2], lod });
      const live = session.app.overviewLodParticleCount(COUNT, lod);
      let moved = 0;
      for (let i = 0; i < COUNT; i++) {
        const o = i * 4;
        const same = out[o] === initial[o] && out[o + 1] === initial[o + 1] && out[o + 2] === initial[o + 2];
        if (!same) moved++;
        assert.equal(!same, i < live, `lod ${lod}: particle ${i} ${same ? 'was skipped' : 'was integrated'} (live count ${live})`);
      }
      assert.equal(moved, live);
    }
  });

  it('an unknown mode still writes finite positions (fallback branch)', async () => {
    const out = await run({ mode: 99, time: 1, physics: PHYSICS[1] });
    assert.ok(out.every(Number.isFinite));
  });
});
