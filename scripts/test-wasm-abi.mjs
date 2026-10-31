#!/usr/bin/env node
/**
 * test-wasm-abi.mjs — call every Embind export of the *shipped* sim_core.
 *
 * `test:golden` compares native g++ against TS; nothing else loads the
 * src/public/wasm/sim_core.{js,wasm} that Pages serves. A binding can compile,
 * pass `tsc` (types.ts is hand-written) and still be uncallable from JS — e.g.
 * a `std::vector<float>` parameter only accepts a registered FloatVector
 * handle, never a JS array. This test:
 *
 *   1. parses every `function("…")` / `.function("…")` / `.class_function("…")`
 *      out of cpp/src/sim_core_embind.cpp and requires a call spec for each
 *      (a new binding without one fails here, as does a stale spec);
 *   2. calls each one once on the shipped module with representative args;
 *   3. checks the array-input paths (val + scratch) give the right numbers,
 *      including after a heap growth;
 *   4. drives the TS wrappers (SEGSim, segWasm → EnergyNetwork, gpuChores)
 *      against the same module, plus the one-shot WASM → JS bus fallback.
 */
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// SIM_CORE_DIR: point at another build (e.g. an old artefact) to see what fails.
const WASM_DIR = process.env.SIM_CORE_DIR ?? join(ROOT, 'src/public/wasm');

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
const near = (a, b, eps = 1e-4) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(b));

// ENVIRONMENT=web glue is a classic script declaring `var SimCore`; with
// `wasmBinary` it never fetches, so plain Node can instantiate it.
const SimCore = new Function(`${readFileSync(join(WASM_DIR, 'sim_core.js'), 'utf8')}\n;return SimCore;`)();
const wasmBinary = readFileSync(join(WASM_DIR, 'sim_core.wasm'));
const mod = await SimCore({ wasmBinary });
console.log(`test-wasm-abi: ${mod.sim_core_version()} (shipped src/public/wasm)`);

// ── 1. Binding inventory from the Embind source ───────────────────────────
const embindSrc = readFileSync(join(ROOT, 'cpp/src/sim_core_embind.cpp'), 'utf8')
  .replace(/\/\/.*$/gm, '');
const freeNames = [...embindSrc.matchAll(/(?<![.\w])function\("(\w+)"/g)].map((m) => m[1]);
const methodNames = [...embindSrc.matchAll(/\.function\("(\w+)"/g)].map((m) => m[1]);
const staticNames = [...embindSrc.matchAll(/\.class_function\("(\w+)"/g)].map((m) => m[1]);

const v3 = (x, y, z) => ({ x, y, z });
const MODE_COUNT = 13;

/** Free functions: name → args. Every one needs an entry. */
const FREE_ARGS = {
  magneticDipoleField: [v3(0.1, 0, 0), v3(0, 1, 0)],
  magneticDipoleForce: [v3(0, 0, 0), v3(0, 1, 0), v3(0.1, 0, 0), v3(0, 1, 0)],
  axialBField: [0, 0.05, 0.025, 1.2],
  estimateHalbachFieldT: [0.01, 1.2],
  sim_core_version: [],
  chores_scratch_ptr: [3],
  chores_reduce_f32_scratch: [3],
  chores_map_scale_f32_scratch: [3, 2, 1],
  chores_fft_db_scratch: [3, true, -120],
  plant_state_layout_hash: []
};

/** SEGSimulator methods that take arguments; anything else is called with none. */
const METHOD_ARGS = {
  step: [1 / 60, 0.01],
  seedParticles: [64],
  stepParticles: [1 / 60],
  getAngle: [0],
  sampleBField: [v3(0.1, 0, 0)],
  rollerWorldPos: [0],
  estimatePower: [0.01],
  getParticle: [0],
  setRingLoadTorque: [0, 0.01],
  setRingLoadTorques: [0.01, 0.01, 0.01],
  stepWithPerRingTorques: [1 / 60],
  setMode: [0],
  setDrive: [0.5],
  setKelvinSeedV: [100],
  setTransformerLeakage: [true],
  setHallCarrierMetal: [false],
  setHallFieldCoupledT: [0.5],
  setLorentzFieldT: [0.5],
  setNetworkEdges: [[0, 1, 10, 1, 0]],
  getScratchPtr: [2 * MODE_COUNT],
  updateEnergyNetworkFromScratch: [true, 100, 50, MODE_COUNT],
  getNetworkEdgeAllocatedW: [0],
  getNetworkDevicePower: [0],
  plantStateSize: [1],
  plantSave: [1],
  // Wrong hash on purpose: the call must be refused, not throw.
  plantLoad: [1, 8, 0]
};

console.log('\n1. Binding inventory');
check(`parsed ${freeNames.length} free, ${methodNames.length} methods, ${staticNames.length} static`,
  freeNames.length > 0 && methodNames.length > 0);
for (const n of freeNames) {
  if (!(n in FREE_ARGS)) check(`free function ${n} has a call spec`, false, 'add it to FREE_ARGS');
}
for (const n of Object.keys(FREE_ARGS)) {
  if (!freeNames.includes(n)) check(`FREE_ARGS.${n} is still bound`, false, 'stale spec');
}
for (const n of Object.keys(METHOD_ARGS)) {
  if (!methodNames.includes(n)) check(`METHOD_ARGS.${n} is still bound`, false, 'stale spec');
}
check('no std::vector registration (handles reject JS arrays, leak without .delete())',
  !/register_vector\s*</.test(embindSrc));

// ── 2. Call every binding once ────────────────────────────────────────────
console.log('\n2. Every binding, called once');
function callAll(label, names, target, argsFor) {
  const failed = [];
  for (const n of names) {
    if (typeof target[n] !== 'function') {
      failed.push(`${n} (not on the module)`);
      continue;
    }
    try {
      target[n](...argsFor(n));
    } catch (err) {
      failed.push(`${n}: ${err?.name ?? 'Error'} ${String(err?.message ?? err).slice(0, 100)}`);
    }
  }
  check(`${label}: ${names.length - failed.length}/${names.length} callable`, failed.length === 0, failed.join('; '));
}
callAll('free functions', freeNames, mod, (n) => FREE_ARGS[n] ?? []);
const sim = new mod.SEGSimulator();
callAll('SEGSimulator methods', methodNames, sim, (n) => METHOD_ARGS[n] ?? []);
callAll('SEGSimulator static', staticNames, mod.SEGSimulator, () => []);

// ── 3. Array-input paths give the right numbers ───────────────────────────
console.log('\n3. Array inputs (val + scratch)');
sim.setNetworkEdges([0, 1, 10, 1, 0, 1, 2, 5, 0.9, 0]);
check('setNetworkEdges(number[]) → 2 edges', sim.getNetworkEdgeCount() === 2);
sim.setNetworkEdges(new Float32Array([0, 1, 10, 1, 0]));
check('setNetworkEdges(Float32Array) → 1 edge', sim.getNetworkEdgeCount() === 1);
sim.setNetworkEdges([NaN, 1, 10, 1, 0, 0, Infinity, 10, 1, 0, 0, 2, 10, 1, 0]);
check('setNetworkEdges drops NaN / ±inf endpoints (no UB cast)', sim.getNetworkEdgeCount() === 1);

check('getAngle(out of range) → 0', sim.getAngle(9999) === 0 && sim.getAngle(-1) === 0);
const oob = sim.rollerWorldPos(9999);
check('rollerWorldPos(out of range) → origin', oob.x === 0 && oob.y === 0 && oob.z === 0);

function scratchWrite(ptrFn, values) {
  const ptr = Number(ptrFn(values.length));
  mod.HEAPF32.set(values, ptr >> 2); // read HEAPF32 after the ptr call (may grow)
  return ptr >> 2;
}
scratchWrite(mod.chores_scratch_ptr, [1, 2, 3, NaN]);
const r = mod.chores_reduce_f32_scratch(4);
check('chores_reduce_f32_scratch([1,2,3,NaN]) = {6,1,3,14,3}',
  r.sum === 6 && r.min === 1 && r.max === 3 && r.sumSq === 14 && r.count === 3, JSON.stringify(r));
const base = scratchWrite(mod.chores_scratch_ptr, [1, 2, 3]);
mod.chores_map_scale_f32_scratch(3, 2, 1);
const mapped = Array.from(mod.HEAPF32.subarray(base, base + 3));
check('chores_map_scale_f32_scratch(×2+1) in place = [3,5,7]', mapped.join() === '3,5,7', mapped.join());

// FFT writes N/2 + 1 dB bins over the head of the same scratch (full golden: test:analysis).
const tone = Array.from({ length: 64 }, (_, i) => Math.sin((2 * Math.PI * 5 * i) / 64));
const fb = scratchWrite(mod.chores_scratch_ptr, tone);
const fbins = mod.chores_fft_db_scratch(64, true, -120);
const fdb = Array.from(mod.HEAPF32.subarray(fb, fb + fbins));
const fpeak = fdb.indexOf(Math.max(...fdb));
check('chores_fft_db_scratch(64-pt sine @ bin 5) → 33 bins, peak bin 5 at 0 dB',
  fbins === 33 && fpeak === 5 && Math.abs(fdb[5]) < 1e-3, `bins ${fbins}, peak ${fpeak} @ ${fdb[fpeak]}`);
check('chores_fft_db_scratch(0) / oversize → 0 bins',
  mod.chores_fft_db_scratch(0, true, -120) === 0 && mod.chores_fft_db_scratch((1 << 20) + 1, true, -120) === 0);

const heapBefore = mod.HEAPF32.buffer.byteLength;
const big = new Float32Array(8 * 1024 * 1024).fill(0.5); // 32 MB > INITIAL_MEMORY
scratchWrite(mod.chores_scratch_ptr, big);
const rb = mod.chores_reduce_f32_scratch(big.length);
check('scratch survives heap growth (HEAPF32 refreshed)',
  mod.HEAPF32.buffer.byteLength > heapBefore && near(rb.sum, big.length * 0.5) && rb.count === big.length,
  `heap ${heapBefore} → ${mod.HEAPF32.buffer.byteLength}, sum ${rb.sum}`);

sim.setNetworkEdges([0, 1, 10, 1, 0]);
const eb = scratchWrite((n) => sim.getScratchPtr(n), [
  ...Array(MODE_COUNT).fill(0.5),
  ...Array(MODE_COUNT).fill(1)
]);
sim.updateEnergyNetworkFromScratch(true, 100, 50, MODE_COUNT);
const sum = sim.getNetworkSummary();
check('updateEnergyNetworkFromScratch allocates against a budget',
  sum.couplingEnabled && sum.labBudgetW > 100 && sum.totalAllocatedW > 0 && near(sum.residualW, sum.labBudgetW - sum.totalAllocatedW),
  JSON.stringify(sum));
mod.HEAPF32[eb + MODE_COUNT] = 0; // disable SEG (source of the only edge)
sim.updateEnergyNetworkFromScratch(true, 100, 50, MODE_COUNT);
check('enabled flags are read from scratch[modeCount…]', sim.getNetworkEdgeAllocatedW(0) === 0);

// Plant snapshots (#224 §2) ride the same scratch: plantSave → read n floats,
// write n floats → plantLoad. test:snapshots does the per-mode exactness.
const hash = mod.plant_state_layout_hash();
sim.setMode(1);
sim.setDrive(0.8);
for (let i = 0; i < 30; i++) sim.step(1 / 60, 0);
const n = sim.plantSave(1);
const at = Number(sim.getScratchPtr(n)) >> 2;
const saved = Array.from(mod.HEAPF32.subarray(at, at + n));
check('plantSave(heron) count = plantStateSize, head > 0', n === sim.plantStateSize(1) && n > 2 && saved[2] > 0, `n=${n} head=${saved[2]}`);
const fresh = new mod.SEGSimulator();
fresh.setMode(1);
scratchWrite((k) => fresh.getScratchPtr(k), saved);
check('plantLoad refuses a layout-hash mismatch', fresh.plantLoad(1, n, (hash ^ 1) >>> 0) === false && fresh.getHeronHead() === 0);
scratchWrite((k) => fresh.getScratchPtr(k), saved);
check('plantLoad(own hash) restores the plant', fresh.plantLoad(1, n, hash) === true && fresh.getHeronHead() === sim.getHeronHead(),
  `${fresh.getHeronHead()} vs ${sim.getHeronHead()}`);
fresh.delete();
sim.delete();

// ── 4. TS wrappers on the same binary ─────────────────────────────────────
console.log('\n4. TS wrappers (SEGSim, segWasm → EnergyNetwork, gpuChores)');
const viteRawStub = {
  name: 'vite-raw-stub',
  setup(build) {
    build.onResolve({ filter: /\?raw$/ }, (args) => ({ path: args.path, namespace: 'raw-stub' }));
    build.onLoad({ filter: /.*/, namespace: 'raw-stub' }, () => ({ contents: 'export default "";', loader: 'js' }));
  }
};
const built = await esbuild.build({
  bundle: true,
  plugins: [viteRawStub],
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  write: false,
  logLevel: 'warning',
  stdin: {
    contents: `
      export { SEGSim } from './src/wasm/sim';
      export { segWasm } from './src/wasm/seg-physics-bridge';
      export { EnergyNetwork, ENERGY_PIPE_EDGES } from './src/renderers/shared/energy-network';
      export { gpuChores } from './src/gpu-chores/session';
      export { WASM_DEVICE_IDS } from './generated/device-catalog';
    `,
    resolveDir: ROOT,
    sourcefile: 'wasm-abi-harness.ts',
    loader: 'ts'
  }
});

// Browser surface the loader touches: HEAD probe, a pre-registered factory
// (loadSimCoreFactory checks globalThis.SimCore first), ?wasmPhysics=1.
const storage = new Map();
globalThis.localStorage = {
  getItem: (k) => storage.get(k) ?? null,
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k)
};
globalThis.window = globalThis;
globalThis.location = { search: '?wasmPhysics=1', hash: '' };
globalThis.fetch = async () => ({ ok: true });
globalThis.SimCore = (opts) => SimCore({ ...opts, wasmBinary });
const quiet = { info: console.info, log: console.log };
console.info = () => {};
console.log = () => {};

const TMP = mkdtempSync(join(tmpdir(), 'wasm-abi-'));
let harness;
try {
  const file = join(TMP, 'harness.mjs');
  writeFileSync(file, built.outputFiles[0].text);
  harness = await import(pathToFileURL(file).href);
} finally {
  rmSync(TMP, { recursive: true, force: true });
}
const { SEGSim, segWasm, EnergyNetwork, ENERGY_PIPE_EDGES, gpuChores, WASM_DEVICE_IDS } = harness;

const segSim = await SEGSim.create();
await segWasm.init();
console.info = quiet.info;
console.log = quiet.log;
check('SEGSim loads the shipped module', segSim.wasmAvailable);
check('WASM_DEVICE_IDS.length matches the C++ mode count', WASM_DEVICE_IDS.length === MODE_COUNT);

segSim.seedParticles(16);
check('SEGSim.getParticles(4) (getParticle loop, no vector return)', segSim.getParticles(4).length === 4);

const energyByDevice = Object.fromEntries(WASM_DEVICE_IDS.map((id) => [id, 0.6]));
segSim.setNetworkEdges(ENERGY_PIPE_EDGES);
const s1 = segSim.updateEnergyNetwork({
  couplingEnabled: true, segPowerW: 120, segEfficiencyPct: 40, energyByDevice, enabledByDevice: {}
});
check(`SEGSim network: ${ENERGY_PIPE_EDGES.length} pipe edges, budget allocated`,
  s1.labBudgetW > 120 && s1.totalAllocatedW > 0, JSON.stringify(s1));

// The production frame path: EnergyNetwork → window.segWasm → SEGSim → binary.
check('segWasm enabled under ?wasmPhysics=1', segWasm.enabled);
window.segWasm = segWasm;
const devices = Object.fromEntries(WASM_DEVICE_IDS.map((id) => [id, { energyLevel: 0.6 }]));
const devicesEnabled = Object.fromEntries(WASM_DEVICE_IDS.map((id) => [id, true]));
const frame = { devices, devicesEnabled, segPowerW: 120, segEfficiencyPct: 40, deltaTime: 1 / 60 };
const net = new EnergyNetwork(true);
let snap;
let threw = null;
try {
  for (let i = 0; i < 3; i++) snap = net.update(frame);
} catch (err) {
  threw = err;
}
check('EnergyNetwork runs the WASM bus without throwing', !threw, String(threw?.message ?? ''));
check('energy bus status = wasm, no fallback',
  net.busStatus().backend === 'wasm' && net.busStatus().fallbackReason === null, JSON.stringify(net.busStatus()));
check('WASM bus snapshot carries a budget', (snap?.labBudgetW ?? 0) > 0 && (snap?.totalAllocatedW ?? 0) > 0);

// A bus that throws falls back to JS once and stays there.
let calls = 0;
window.segWasm = {
  enabled: true,
  setNetworkEdges() { calls++; throw new Error('boom'); },
  updateEnergyNetwork() { calls++; throw new Error('boom'); }
};
const warn = console.warn;
console.warn = () => {};
const net2 = new EnergyNetwork(true);
let snap2 = null;
threw = null;
try {
  snap2 = net2.update(frame);
  net2.update(frame);
  net2.update(frame);
} catch (err) {
  threw = err;
}
console.warn = warn;
check('a throwing WASM bus does not propagate', !threw, String(threw?.message ?? ''));
check('…falls back to the JS bus with a reason', net2.busStatus().backend === 'js' && net2.busStatus().fallbackReason === 'boom',
  JSON.stringify(net2.busStatus()));
check('…tries the WASM bus once, not per frame', calls === 1, `calls=${calls}`);
check('…and the JS bus still produces a snapshot', (snap2?.labBudgetW ?? 0) > 0);
window.segWasm = segWasm;

gpuChores.adopt({ sessionApi: 'webgl2' });
const red = gpuChores.reduceF32(new Float32Array([1, 2, 3]));
const crumb = gpuChores.breadcrumb();
check('gpuChores reduce runs on wasm (not a silent JS fallback)',
  red.backend === 'wasm' && red.sum === 6 && crumb.lastBackend === 'wasm' && crumb.wasmError === null,
  JSON.stringify({ backend: red.backend, sum: red.sum, crumb }));
const ms = gpuChores.mapScaleF32([1, 2, 3], { scale: 2, bias: 1 });
check('gpuChores mapScale runs on wasm', Array.from(ms).join() === '3,5,7' && gpuChores.breadcrumb().lastBackend === 'wasm',
  Array.from(ms).join());

segSim.dispose?.();
console.log(failures === 0 ? '\ntest-wasm-abi: OK' : `\ntest-wasm-abi: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
