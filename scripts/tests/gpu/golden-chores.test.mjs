/**
 * test:gpu-golden — chores-reduce-f32.wgsl vs chores_reduce.cpp (#258 §3).
 *
 * The GPU side is the app's own host class (`WebgpuReduce`: upload, one
 * dispatch, per-workgroup partials merged on the CPU) on the app's
 * `choresReduce` pipeline. The reference is the C++ `chores_reduce_f32`:
 *
 *   - compiled into the shipped sim_core.wasm, called on the same data
 *     (`chores_reduce_f32_scratch`) — any length, any values;
 *   - the native binary's fixed fixture (`sim_core_test --mode chores`
 *     asserts {sum 6, min −2, max 4, sumSq 30} for [1, −2, 3, 0, 4]), which
 *     the GPU has to reproduce exactly.
 *
 * Tolerance 1e-5 relative (to Σ|x| for the sum, Σx² for sumSq): the shader
 * sums in f32 as a tree per workgroup, C++ sums sequentially in double.
 * min / max are exact.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { join } from 'node:path';
import { ROOT } from '../../test-harness.mjs';
import { gpuSkip, nodeGpu } from '../../lib/node-gpu.mjs';
import { gpuSession } from '../../lib/gpu-app.mjs';
import { loadSimCoreFromDisk } from '../../lib/sim-core-shim.mjs';

const gpu = await nodeGpu();
const skip = gpuSkip(gpu);
const session = skip ? null : await gpuSession(gpu, { label: 'golden-chores' });
const REL_TOL = 1e-5;

/** Dispatch through the app's host and wait for the readback it started. */
async function gpuReduce(reducer, data) {
  reducer.last = null;
  reducer.reduce(data);
  for (let i = 0; i < 2000 && reducer.inflight; i++) await new Promise((r) => setTimeout(r, 1));
  assert.ok(!reducer.inflight && reducer.last, 'WebgpuReduce never delivered a readback');
  return reducer.last;
}

function cppReduce(mod, data) {
  const ptr = Number(mod.chores_scratch_ptr(data.length));
  mod.HEAPF32.set(data, ptr >> 2);
  return mod.chores_reduce_f32_scratch(data.length);
}

/** Deterministic test signals (LCG; no Math.random in a golden). */
function signal(n, kind, seed = 1) {
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (kind === 'noise') out[i] = (rnd() - 0.5) * 200;
    else if (kind === 'telemetry') out[i] = 1500 + 40 * Math.sin(i * 0.07) + (rnd() - 0.5) * 3;
    else out[i] = Math.sin(i * 0.013) * Math.exp(-i / n);
  }
  return out;
}

describe('gpu-golden: chores-reduce-f32.wgsl vs chores_reduce.cpp', { skip }, () => {
  let reducer;
  let mod;
  const setup = async () => {
    if (reducer) return;
    const { app, device, cache, shaders } = session;
    reducer = new app.WebgpuReduce(device);
    await reducer.init(await cache.ensureChoresReducePipeline(shaders.choresReduceShader));
    mod = await loadSimCoreFromDisk(join(ROOT, 'src/wasm/sim-core'));
  };

  it('native fixture [1, −2, 3, 0, 4]: exact', async () => {
    await setup();
    const { app } = session;
    const got = await gpuReduce(reducer, app.CHORES_GOLDEN_INPUT);
    for (const k of ['sum', 'min', 'max', 'sumSq', 'count']) {
      assert.equal(got[k], app.CHORES_GOLDEN_ACCUM[k], `${k}: GPU ${got[k]} ≠ golden ${app.CHORES_GOLDEN_ACCUM[k]}`);
    }
  });

  // 1 (one element), 64 / 65 (workgroup edge), 4096 (HUD window), 65536 (host cap).
  for (const [n, kind] of [[1, 'noise'], [63, 'noise'], [64, 'telemetry'], [65, 'decay'], [1000, 'noise'], [4096, 'telemetry'], [65536, 'noise']]) {
    it(`${n} × ${kind}: sum / sumSq within ${REL_TOL}, min / max exact`, async () => {
      await setup();
      const data = signal(n, kind, n);
      const got = await gpuReduce(reducer, data);
      const ref = cppReduce(mod, data);
      let sumAbs = 0;
      for (const x of data) sumAbs += Math.abs(x);
      assert.ok(Math.abs(got.sum - ref.sum) <= REL_TOL * sumAbs, `sum: GPU ${got.sum}, C++ ${ref.sum} (Σ|x| ${sumAbs})`);
      assert.ok(Math.abs(got.sumSq - ref.sumSq) <= REL_TOL * ref.sumSq, `sumSq: GPU ${got.sumSq}, C++ ${ref.sumSq}`);
      assert.equal(got.min, ref.min, 'min');
      assert.equal(got.max, ref.max, 'max');
      assert.equal(got.count, ref.count, 'count');
      assert.deepEqual(session.device.uncaptured, [], 'GPU validation errors');
    });
  }
});
