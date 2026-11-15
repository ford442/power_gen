#!/usr/bin/env node
/**
 * bench-wasm.mjs — `--mode bench` for the *WASM* build, through the real ABI.
 *
 * `sim_core_test --mode bench` times the native g++ binary; the browser runs
 * sim_core.wasm on V8 (or SpiderMonkey / JSC) through the generated wrappers.
 * This runs the same workloads on a given .wasm in Node's V8 — Chrome's engine
 * — through src/wasm/sim-core/instantiate.ts + abi.generated.ts, so a
 * compile-flag change (cpp/README.md → flag study) is measured where it
 * matters, call overhead included:
 *
 *   bench_seg_steps_per_sec          SEG RK4 rollers, one ABI call per step
 *   bench_particle_steps_per_sec     2000-particle replay
 *   bench_ring_<m>_sim_s_per_wall_s  jumping ring, rk4 / dopri5 / ros23
 *   bench_fdtd_cell_updates_per_sec  256² FDTD with a material map
 *   heap_*_bytes                     memory.buffer after each workload
 *                                    (the INITIAL_MEMORY question)
 *
 * Each timing is the median of --repeat runs (default 5).
 *
 * --baseline=cpp/bench-baseline.json compares against the recorded study
 * numbers: a binary > 5 % larger fails (size is deterministic under the
 * pinned emsdk); a throughput below 0.6× warns (machines differ, but that
 * still catches a lost SIMD kernel or a dropped -flto). build-wasm.yml runs it.
 *
 * Usage: node scripts/bench-wasm.mjs [path/to/sim_core.wasm] [--repeat=N] [--json] [--baseline=FILE]
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync, brotliCompressSync } from 'node:zlib';
import { ROOT } from './test-harness.mjs';
import { simCoreLoader } from './lib/sim-core-shim.mjs';

const args = process.argv.slice(2);
const wasmPath = args.find((a) => !a.startsWith('--') && a.endsWith('.wasm')) ?? join(ROOT, 'src/wasm/sim-core/sim_core.wasm');
const repeat = Number(args.find((a) => a.startsWith('--repeat='))?.slice(9) ?? 5);
const asJson = args.includes('--json');
const baselinePath = args.find((a) => a.startsWith('--baseline='))?.slice(11);
const SIZE_GROWTH_MAX = 1.05;
const THROUGHPUT_WARN = 0.6;

const bytes = readFileSync(wasmPath);
const { instantiateSimCore } = await simCoreLoader();
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const out = {
  wasm_bytes: bytes.length,
  wasm_gzip_bytes: gzipSync(bytes, { level: 9 }).length,
  wasm_brotli_bytes: brotliCompressSync(bytes).length
};

async function fresh() {
  return instantiateSimCore(bytes);
}

function time(fn) {
  const t0 = performance.now();
  fn();
  return (performance.now() - t0) / 1000;
}

const seg = [];
const particles = [];
const ring = { rk4: [], dopri5: [], ros23: [] };
const fdtd = [];
const METHOD = { rk4: 1, dopri5: 2, ros23: 3 };
for (let r = 0; r < repeat; r++) {
  const mod = await fresh();
  const sim = new mod.SEGSimulator();
  const dt = Math.fround(1 / 60);
  for (let i = 0; i < 2000; i++) sim.step(dt, 0.01);
  seg.push(100000 / time(() => { for (let i = 0; i < 100000; i++) sim.step(dt, 0.01); }));
  sim.seedParticles(2000);
  for (let i = 0; i < 500; i++) sim.stepParticles(dt);
  particles.push(5000 / time(() => { for (let i = 0; i < 5000; i++) sim.stepParticles(dt); }));
  out.heap_after_seg_bytes = Math.max(out.heap_after_seg_bytes ?? 0, mod.HEAPF32.buffer.byteLength);
  // Worst case the app can ask for: MAX_PARTICLES (50k) seeded.
  sim.seedParticles(50000);
  out.heap_after_50k_particles_bytes = Math.max(out.heap_after_50k_particles_bytes ?? 0, mod.HEAPF32.buffer.byteLength);
  sim.delete();

  for (const [name, m] of Object.entries(METHOD)) {
    const s = new mod.SEGSimulator();
    s.setMode(12);
    s.setDrive(0.85);
    s.setIntegrator(m);
    const rdt = Math.fround(1 / 90);
    ring[name].push((400 * rdt) / time(() => { for (let i = 0; i < 400; i++) s.step(rdt, 0); }));
    s.delete();
  }

  const g = new mod.FdtdTmzGrid();
  const n = 256;
  g.init(n, 28, 0.5, 0.12, 1.6);
  const mat = new Float32Array(2 * n * n);
  for (let i = 0; i < n * n; i++) mat[2 * i] = i % n < n / 2 ? 1 : 0.5;
  g.setMaterials(mat);
  g.setSources([128, 128, 1, 1]);
  g.step(20);
  fdtd.push((n * n * 400) / time(() => g.step(400)));
  out.heap_after_fdtd256_bytes = Math.max(out.heap_after_fdtd256_bytes ?? 0, mod.HEAPF32.buffer.byteLength);
  g.delete();
}
out.bench_seg_steps_per_sec = Math.round(median(seg));
out.bench_particle_steps_per_sec = Math.round(median(particles));
for (const name of Object.keys(ring)) out[`bench_ring_${name}_sim_s_per_wall_s`] = Number(median(ring[name]).toFixed(1));
out.bench_fdtd_cell_updates_per_sec = Math.round(median(fdtd));

if (asJson) console.log(JSON.stringify(out));
else for (const [k, v] of Object.entries(out)) console.log(`${k}=${v}`);

if (baselinePath) {
  const base = JSON.parse(readFileSync(baselinePath, 'utf8'));
  const gha = process.env.GITHUB_ACTIONS === 'true';
  let failed = false;
  console.log(`\n${'metric'.padEnd(38)} ${'baseline'.padStart(12)} ${'now'.padStart(12)}  ratio`);
  for (const [k, b] of Object.entries(base)) {
    if (typeof b !== 'number' || !(k in out)) continue;
    const ratio = out[k] / b;
    console.log(`${k.padEnd(38)} ${String(b).padStart(12)} ${String(out[k]).padStart(12)}  ${ratio.toFixed(3)}`);
    if (k.endsWith('_bytes') && ratio > SIZE_GROWTH_MAX) {
      failed = true;
      console.error(`${gha ? '::error::' : 'FAIL: '}${k} grew ${((ratio - 1) * 100).toFixed(1)} % (> ${((SIZE_GROWTH_MAX - 1) * 100).toFixed(0)} %) — re-baseline cpp/bench-baseline.json on purpose`);
    } else if (!k.endsWith('_bytes') && ratio < THROUGHPUT_WARN) {
      console.warn(`${gha ? '::warning::' : 'WARN: '}${k} at ${ratio.toFixed(2)}× the baseline`);
    }
  }
  if (failed) process.exitCode = 1;
}
