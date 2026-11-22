/**
 * test:gpu-golden — particle-compute.wgsl invariants (#258 §3).
 *
 * The pass places each particle on a closed-form path per device mode; the
 * CPU path in renderers/shared/particle-physics.ts integrates a different
 * (velocity-carrying, 32 B) particle, so there is no cell-for-cell twin.
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
  transformer: [[1, 1, -1, 0.95], [0.2, 0.1, 1, 0.5]]
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
