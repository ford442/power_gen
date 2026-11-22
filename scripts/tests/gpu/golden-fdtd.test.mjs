/**
 * test:gpu-golden — fdtd-tmz-compute.wgsl vs its CPU twin (#258 §3).
 *
 * The compute pass runs on a Dawn device with the app's own `fdtdCompute`
 * layout and pipelines; the reference is `FdtdTmzGrid` in
 * src/physics/fdtd-tmz.ts — same 256² grid, same sponge, same sources, same
 * drive waveform, same material map. Fields are read back after 200 Yee
 * steps and compared cell by cell.
 *
 * Tolerance: 1e-4 of the reference's peak |field|, set on a software
 * rasteriser (Lavapipe / SwiftShader). The CPU kernel evaluates in double and
 * rounds on store; a GPU evaluates in f32 and may fuse multiply-adds, so the
 * two drift by a few ULP per step — measured ≤ 6e-6 after 200 steps on Lavapipe.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { gpuSkip, nodeGpu, readBuffer } from '../../lib/node-gpu.mjs';
import { gpuSession, maxAbs, maxAbsDiff } from '../../lib/gpu-app.mjs';

const gpu = await nodeGpu();
const skip = gpuSkip(gpu);
// Top level: nodeDevice() destroys the device when the enclosing scope ends.
const session = skip ? null : await gpuSession(gpu, { label: 'golden-fdtd' });

const STEPS = 200;
/** Steps between drive updates — the app re-uploads params once per frame. */
const STEPS_PER_UPLOAD = 8;
const REL_TOL = 1e-4;

/** Winding current at a step: one 60-step cycle, as a pulse discharge would ring. */
const drive = (step) => Math.sin((2 * Math.PI * step) / 60);

async function runGpu(s, { materials }) {
  const { app, device, cache, shaders } = s;
  const F = app.fdtd;
  const cfg = F.FDTD_DEFAULT_CONFIG;
  const n = cfg.n;
  const { updateH, updateE } = await cache.ensureFdtdComputePipelines(shaders.fdtdTmzComputeShader);

  const field = (label) => device.createBuffer({
    label, size: n * n * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
  });
  const ez = field('fdtd-ez');
  const hx = field('fdtd-hx');
  const hy = field('fdtd-hy');
  const materialBuffer = device.createBuffer({
    label: 'fdtd-materials',
    size: n * n * F.FDTD_MATERIAL_COMPONENTS * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
  });
  if (materials) device.queue.writeBuffer(materialBuffer, 0, materials);
  const params = device.createBuffer({
    label: 'fdtd-params', size: F.FDTD_PARAMS_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
  });
  const bindGroup = cache.createBindGroup('fdtdCompute', [
    { binding: 0, resource: { buffer: params } },
    { binding: 1, resource: { buffer: ez } },
    { binding: 2, resource: { buffer: hx } },
    { binding: 3, resource: { buffer: hy } },
    { binding: 4, resource: { buffer: materialBuffer } }
  ]);

  const unit = app.pulseCoilFdtdSources();
  const groups = Math.ceil(n / F.FDTD_WORKGROUP);
  for (let step = 0; step < STEPS; step += STEPS_PER_UPLOAD) {
    const sources = unit.map((u) => ({ ...u, amp: u.amp * drive(step) }));
    device.queue.writeBuffer(params, 0, F.packFdtdParams(sources, cfg, undefined, { materials: !!materials }));
    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setBindGroup(0, bindGroup);
    for (let k = 0; k < STEPS_PER_UPLOAD; k++) {
      pass.setPipeline(updateH);
      pass.dispatchWorkgroups(groups, groups);
      pass.setPipeline(updateE);
      pass.dispatchWorkgroups(groups, groups);
    }
    pass.end();
    device.queue.submit([enc.finish()]);
  }
  const [a, b, c] = await Promise.all([ez, hx, hy].map((buf) => readBuffer(device, buf)));
  return { ez: new Float32Array(a), hx: new Float32Array(b), hy: new Float32Array(c) };
}

function runCpu(app, { materials }) {
  const F = app.fdtd;
  const grid = new F.FdtdTmzGrid();
  grid.setMaterials(materials ?? null);
  const unit = app.pulseCoilFdtdSources();
  for (let step = 0; step < STEPS; step += STEPS_PER_UPLOAD) {
    grid.setSources(unit.map((u) => ({ ...u, amp: u.amp * drive(step) })));
    grid.step(STEPS_PER_UPLOAD);
  }
  return grid;
}

describe('gpu-golden: fdtd-tmz-compute.wgsl vs FdtdTmzGrid', { skip }, () => {
  const cases = [
    { name: 'vacuum (ADR-0010 kernel)', materials: () => null },
    { name: 'pulse-coil material map (ADR-0012: iron armature + copper turns)', materials: (app) => app.fdtd.buildFdtdMaterialMap(app.pulseCoilFdtdMaterials()) }
  ];
  for (const c of cases) {
    it(`${c.name}: Ez / Hx / Hy within ${REL_TOL} of peak after ${STEPS} steps`, async () => {
      const materials = c.materials(session.app);
      const cpu = runCpu(session.app, { materials });
      const got = await runGpu(session, { materials });
      assert.deepEqual(session.device.uncaptured, [], 'GPU validation errors');

      const peak = Math.max(maxAbs(cpu.ez), maxAbs(cpu.hx), maxAbs(cpu.hy));
      assert.ok(peak > 1e-3, `reference field is empty (peak ${peak}) — the test drives nothing`);
      assert.equal(cpu.hasMaterials, !!materials, 'reference did not take the material path');
      const report = [];
      for (const name of ['ez', 'hx', 'hy']) {
        const d = maxAbsDiff(got[name], cpu[name]);
        report.push(`${name} ${(d.max / peak).toExponential(2)}`);
        assert.ok(Number.isFinite(d.max) && d.max <= REL_TOL * peak,
          `${name}: max |GPU − CPU| = ${d.max} at cell ${d.at} (x ${d.at % cpu.cfg.n}, y ${Math.floor(d.at / cpu.cfg.n)}), `
          + `${(d.max / peak).toExponential(2)} of peak ${peak}`);
      }
      console.log(`  max relative error: ${report.join(' · ')} (peak |field| ${peak.toFixed(4)})`);
    });
  }

  it('materials change the answer (the map is really read)', async () => {
    const map = session.app.fdtd.buildFdtdMaterialMap(session.app.pulseCoilFdtdMaterials());
    const vac = await runGpu(session, { materials: null });
    const mat = await runGpu(session, { materials: map });
    const d = maxAbsDiff(vac.ez, mat.ez);
    assert.ok(d.max > 1e-3 * maxAbs(vac.ez), `vacuum and material runs agree to ${d.max} — materialFlags is not reaching the shader`);
  });
});
