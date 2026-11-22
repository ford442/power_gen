/**
 * test:gpu-golden — seg-roller-compute.wgsl vs its CPU twin (#258 §3).
 *
 * The pass is closed-form roller kinematics — orbit angle, rolling
 * quaternion, pole tint — as a function of (time, plant ω, layout); it does
 * not integrate anything, so its twin is `buildAllRollerInstances` in
 * src/seg-roller-model.ts (what the CPU fallback and WebGL2 draw), not a
 * plant golden. Run on the app's `rollerCompute` layout with the layout
 * uniforms from `packSEGLayoutUniforms`, read back the instance buffer.
 *
 * At ω = 1 the two formulas are the same expression, so every roller is
 * compared: orbit angle within 1e-3 rad after 1 s, radius, quaternion, ring
 * index, tint. ω scaling and the lab tint are then checked against the same
 * twin.
 *
 * Why a tolerance, and why it grows with time: the per-roller speed jitter is
 * sin(idx·127.3 + ring·53.7), and the shader evaluates that seed in f32 —
 * at idx 67 the argument is ~8600, where one f32 ULP is ~1e-3. The jitter
 * therefore differs from the double-precision twin by up to ~5e-4, and the
 * orbit angle integrates it: measured 4e-5 rad at 1 s, 1.2e-3 rad at 7.3 s
 * on Lavapipe. The bound is 1e-3 rad per second of scene time. Deterministic
 * on a given GPU, so nothing visible — but GPU and CPU roller positions are
 * not interchangeable late in a session.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { gpuSkip, nodeGpu, readBuffer } from '../../lib/node-gpu.mjs';
import { gpuSession } from '../../lib/gpu-app.mjs';

const gpu = await nodeGpu();
const skip = gpuSkip(gpu);
const session = skip ? null : await gpuSession(gpu, { label: 'golden-rollers' });

/** rad per second of scene time (at least 1 s). */
const ANGLE_TOL = 1e-3;
const INSTANCE_FLOATS = 12;

const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

async function gpuRollers(layout, { time, segOmega = 1, speedMult = 1, lab = false }) {
  const { app, device, cache, shaders } = session;
  const pipeline = await cache.ensureRollerComputePipeline(shaders.segRollerComputeShader);
  const instances = device.createBuffer({
    label: 'roller-instances',
    size: layout.maxRollers * INSTANCE_FLOATS * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
  });
  const uniforms = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const layoutBuf = device.createBuffer({
    size: app.segLayout.SEG_LAYOUT_UNIFORM_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
  });
  // [time, speedMult, prototypePreset, segOmega] — devices/core/seg-update.ts.
  device.queue.writeBuffer(uniforms, 0, new Float32Array([time, speedMult, lab ? 1 : 0, segOmega]));
  device.queue.writeBuffer(layoutBuf, 0, app.segLayout.packSEGLayoutUniforms(layout));
  const bindGroup = cache.createBindGroup('rollerCompute', [
    { binding: 0, resource: { buffer: instances } },
    { binding: 1, resource: { buffer: uniforms } },
    { binding: 2, resource: { buffer: layoutBuf } }
  ]);
  const enc = device.createCommandEncoder();
  const pass = enc.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(Math.ceil(layout.maxRollers / 64));
  pass.end();
  device.queue.submit([enc.finish()]);
  return new Float32Array(await readBuffer(device, instances));
}

/** Per-roller comparison of two instance buffers; returns the worst angle error. */
function compare(got, ref, layout, { colors = true, time = 1 } = {}) {
  const tol = ANGLE_TOL * Math.max(1, time);
  let worst = 0;
  for (let i = 0; i < layout.totalRollers; i++) {
    const g = got.subarray(i * INSTANCE_FLOATS, (i + 1) * INSTANCE_FLOATS);
    const r = ref.subarray(i * INSTANCE_FLOATS, (i + 1) * INSTANCE_FLOATS);
    const dAngle = Math.abs(wrap(Math.atan2(g[2], g[0]) - Math.atan2(r[2], r[0])));
    worst = Math.max(worst, dAngle);
    assert.ok(dAngle <= tol, `roller ${i}: orbit angle off by ${dAngle} rad (bound ${tol})`);
    const radius = Math.hypot(r[0], r[2]);
    assert.ok(Math.abs(Math.hypot(g[0], g[2]) - radius) <= 1e-4 * radius, `roller ${i}: orbit radius ${Math.hypot(g[0], g[2])} vs ${radius}`);
    assert.equal(g[1], 0, `roller ${i}: y`);
    assert.equal(g[3], r[3], `roller ${i}: ring index`);
    // q and −q are the same rotation; the gear ratio amplifies the angle error.
    const dot = Math.abs(g[4] * r[4] + g[5] * r[5] + g[6] * r[6] + g[7] * r[7]);
    assert.ok(dot >= 1 - 1e-4 * Math.max(1, time) ** 2, `roller ${i}: rolling quaternion differs (|q·q′| = ${dot})`);
    if (colors) {
      for (let c = 8; c < 11; c++) assert.ok(Math.abs(g[c] - r[c]) <= 1e-6, `roller ${i}: tint[${c - 8}] ${g[c]} vs ${r[c]}`);
    }
  }
  return worst;
}

describe('gpu-golden: seg-roller-compute.wgsl vs buildAllRollerInstances', { skip }, () => {
  for (const preset of ['searl', 'roschin', 'legacy']) {
    for (const time of [1, 7.3]) {
      it(`${preset} layout, t = ${time} s: every roller within ${ANGLE_TOL} rad/s`, async () => {
        const { app } = session;
        const layout = app.segLayout.computeSEGLayout(preset, 1);
        const got = await gpuRollers(layout, { time });
        const ref = app.buildAllRollerInstances(time, layout, { prototypePreset: 'showroom' });
        const worst = compare(got, ref, layout, { time });
        console.log(`  ${layout.totalRollers} rollers, worst orbit-angle error ${worst.toExponential(2)} rad`);
        assert.deepEqual(session.device.uncaptured, [], 'GPU validation errors');
      });
    }
  }

  it('decimated layout (quality 0.3): slots past totalRollers stay untouched', async () => {
    const { app } = session;
    const layout = app.segLayout.computeSEGLayout('searl', 0.3);
    assert.ok(layout.totalRollers < layout.maxRollers);
    const got = await gpuRollers(layout, { time: 1 });
    compare(got, app.buildAllRollerInstances(1, layout, {}), layout);
    const tail = got.subarray(layout.totalRollers * INSTANCE_FLOATS);
    assert.ok(tail.every((v) => v === 0), 'the pass wrote past totalRollers');
  });

  it('plant ω scales the orbit advance; the floor is 0.02', async () => {
    const { app } = session;
    const layout = app.segLayout.computeSEGLayout('searl', 1);
    const time = 5;
    const rest = app.buildAllRollerInstances(0, layout, {});
    const full = await gpuRollers(layout, { time, segOmega: 1 });
    const half = await gpuRollers(layout, { time, segOmega: 0.5 });
    const stopped = await gpuRollers(layout, { time, segOmega: 0 });
    const floor = await gpuRollers(layout, { time, segOmega: 0.02 });
    for (let i = 0; i < layout.totalRollers; i++) {
      const o = i * INSTANCE_FLOATS;
      const base = Math.atan2(rest[o + 2], rest[o]);
      const advance = (buf) => wrap(Math.atan2(buf[o + 2], buf[o]) - base);
      // Inner ring: 0.5·speed·t ≈ 5 rad at ω = 1, so compare unwrapped via the half run.
      const aHalf = advance(half);
      assert.ok(Math.abs(wrap(advance(full) - 2 * aHalf)) <= 2 * ANGLE_TOL, `roller ${i}: advance(ω=1) ≠ 2·advance(ω=0.5)`);
      assert.ok(Math.abs(wrap(advance(stopped) - advance(floor))) <= 1e-6, `roller ${i}: ω = 0 is not clamped to 0.02`);
    }
  });

  it('lab preset tint matches the twin', async () => {
    const { app } = session;
    const layout = app.segLayout.computeSEGLayout('roschin', 1);
    const got = await gpuRollers(layout, { time: 1, lab: true });
    compare(got, app.buildAllRollerInstances(1, layout, { prototypePreset: 'lab' }), layout);
  });
});
