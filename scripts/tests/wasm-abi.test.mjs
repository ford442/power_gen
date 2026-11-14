/**
 * wasm-abi — call every Embind export of the *shipped* sim_core.
 *
 * `test:golden` compares native g++ against TS; nothing else loads the
 * src/wasm/sim-core/sim_core.{js,wasm} that Pages serves. A binding can compile,
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
 *
 * Usage: npm run test:wasm-abi   (node --test scripts/tests/wasm-abi.test.mjs)
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { bundleTs, ROOT } from '../test-harness.mjs';
import { simCoreShim } from '../lib/sim-core-shim.mjs';
import { simCoreSourceHash } from '../sim-core-source-hash.mjs';

// SIM_CORE_DIR: point at another build (e.g. an old artefact) to see what fails.
const WASM_DIR = process.env.SIM_CORE_DIR ?? join(ROOT, 'src/wasm/sim-core');

const near = (a, b, eps = 1e-4) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(b));

let mod;
before(async () => {
  // With `wasmBinary` the glue never fetches, so plain Node can instantiate it.
  // ES-module glue (EXPORT_ES6): a plain import, like the page and workers.
  const { default: SimCore } = await import(pathToFileURL(join(WASM_DIR, 'sim_core.js')).href);
  const wasmBinary = readFileSync(join(WASM_DIR, 'sim_core.wasm'));
  mod = await SimCore({ wasmBinary });
});

describe('glue + provenance', () => {
  const glueSrc = readFileSync(join(WASM_DIR, 'sim_core.js'), 'utf8');
  it('glue is an ES module (export default SimCore)', () => {
    assert.ok(/\bexport\s+default\b/.test(glueSrc), 'glue is an ES module (export default SimCore)');
  });
  it('glue has no new Function / eval (DYNAMIC_EXECUTION=0, strict CSP)', () => {
    assert.ok(!/\bnew Function\b|\beval\s*\(/.test(glueSrc), 'glue has no new Function / eval (DYNAMIC_EXECUTION=0, strict CSP)');
  });
  it('sim_core_source_hash() matches the C++ sources', (t) => {
    // validate tests the *committed* binary, which legitimately lags a PR that
    // edits cpp/ until build-wasm.yml rebuilds it: warn. build-wasm.yml sets
    // SIM_CORE_REQUIRE_FRESH=1 on its fresh build: there it must match.
    t.diagnostic(`${mod.sim_core_version()} (shipped src/wasm/sim-core)`);
    const want = simCoreSourceHash();
    const got = typeof mod.sim_core_source_hash === 'function' ? mod.sim_core_source_hash() : 'none';
    if (process.env.SIM_CORE_REQUIRE_FRESH === '1') {
      assert.ok(got === want, `sim_core_source_hash() = sources (${want}) — binary ${got}`);
    } else if (got === want) {
      assert.ok(true, `sim_core_source_hash() = sources (${want})`);
    } else {
      t.diagnostic(`! sim_core_source_hash() ${got} ≠ sources ${want}: committed binary predates the C++ sources (CI rebuilds it on main)`);
    }
  });
});

// ── Binding inventory from the Embind source ──────────────────────────────
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
  sim_core_source_hash: [],
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

describe('binding inventory', () => {
  it(`parsed ${freeNames.length} free, ${methodNames.length} methods, ${staticNames.length} static`, () => {
    assert.ok(freeNames.length > 0 && methodNames.length > 0,
      `parsed ${freeNames.length} free, ${methodNames.length} methods, ${staticNames.length} static`);
  });
  it('every free function has a call spec', () => {
    for (const n of freeNames) assert.ok(n in FREE_ARGS, `free function ${n} has a call spec — add it to FREE_ARGS`);
  });
  it('every FREE_ARGS spec is still bound', () => {
    for (const n of Object.keys(FREE_ARGS)) assert.ok(freeNames.includes(n), `FREE_ARGS.${n} is still bound — stale spec`);
  });
  it('every METHOD_ARGS spec is still bound', () => {
    for (const n of Object.keys(METHOD_ARGS)) assert.ok(methodNames.includes(n), `METHOD_ARGS.${n} is still bound — stale spec`);
  });
  it('no std::vector registration (handles reject JS arrays, leak without .delete())', () => {
    assert.ok(!/register_vector\s*</.test(embindSrc), 'no std::vector registration (handles reject JS arrays, leak without .delete())');
  });
});

// Sequential: sections 2 and 3 share one simulator.
describe('every binding, called once; array inputs (val + scratch)', () => {
  let sim;
  before(() => { sim = new mod.SEGSimulator(); });
  after(() => { sim?.delete(); });

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
    assert.ok(failed.length === 0, `${label}: ${names.length - failed.length}/${names.length} callable — ${failed.join('; ')}`);
  }
  function scratchWrite(ptrFn, values) {
    const ptr = Number(ptrFn(values.length));
    mod.HEAPF32.set(values, ptr >> 2); // read HEAPF32 after the ptr call (may grow)
    return ptr >> 2;
  }

  it('free functions are all callable', () => {
    callAll('free functions', freeNames, mod, (n) => FREE_ARGS[n] ?? []);
  });
  it('SEGSimulator methods are all callable', () => {
    callAll('SEGSimulator methods', methodNames, sim, (n) => METHOD_ARGS[n] ?? []);
  });
  it('SEGSimulator statics are all callable', () => {
    callAll('SEGSimulator static', staticNames, mod.SEGSimulator, () => []);
  });

  it('setNetworkEdges takes number[] and Float32Array, drops non-finite endpoints', () => {
    sim.setNetworkEdges([0, 1, 10, 1, 0, 1, 2, 5, 0.9, 0]);
    assert.ok(sim.getNetworkEdgeCount() === 2, 'setNetworkEdges(number[]) → 2 edges');
    sim.setNetworkEdges(new Float32Array([0, 1, 10, 1, 0]));
    assert.ok(sim.getNetworkEdgeCount() === 1, 'setNetworkEdges(Float32Array) → 1 edge');
    sim.setNetworkEdges([NaN, 1, 10, 1, 0, 0, Infinity, 10, 1, 0, 0, 2, 10, 1, 0]);
    assert.ok(sim.getNetworkEdgeCount() === 1, 'setNetworkEdges drops NaN / ±inf endpoints (no UB cast)');
  });

  it('out-of-range indices are safe', () => {
    assert.ok(sim.getAngle(9999) === 0 && sim.getAngle(-1) === 0, 'getAngle(out of range) → 0');
    const oob = sim.rollerWorldPos(9999);
    assert.ok(oob.x === 0 && oob.y === 0 && oob.z === 0, 'rollerWorldPos(out of range) → origin');
  });

  it('chores reduce / map-scale on scratch', () => {
    scratchWrite(mod.chores_scratch_ptr, [1, 2, 3, NaN]);
    const r = mod.chores_reduce_f32_scratch(4);
    assert.ok(r.sum === 6 && r.min === 1 && r.max === 3 && r.sumSq === 14 && r.count === 3,
      `chores_reduce_f32_scratch([1,2,3,NaN]) = {6,1,3,14,3} — ${JSON.stringify(r)}`);
    const base = scratchWrite(mod.chores_scratch_ptr, [1, 2, 3]);
    mod.chores_map_scale_f32_scratch(3, 2, 1);
    const mapped = Array.from(mod.HEAPF32.subarray(base, base + 3));
    assert.ok(mapped.join() === '3,5,7', `chores_map_scale_f32_scratch(×2+1) in place = [3,5,7] — ${mapped.join()}`);
  });

  it('chores FFT on scratch', () => {
    // FFT writes N/2 + 1 dB bins over the head of the same scratch (full golden: test:analysis).
    const tone = Array.from({ length: 64 }, (_, i) => Math.sin((2 * Math.PI * 5 * i) / 64));
    const fb = scratchWrite(mod.chores_scratch_ptr, tone);
    const fbins = mod.chores_fft_db_scratch(64, true, -120);
    const fdb = Array.from(mod.HEAPF32.subarray(fb, fb + fbins));
    const fpeak = fdb.indexOf(Math.max(...fdb));
    assert.ok(fbins === 33 && fpeak === 5 && Math.abs(fdb[5]) < 1e-3,
      `chores_fft_db_scratch(64-pt sine @ bin 5) → 33 bins, peak bin 5 at 0 dB — bins ${fbins}, peak ${fpeak} @ ${fdb[fpeak]}`);
    assert.ok(mod.chores_fft_db_scratch(0, true, -120) === 0 && mod.chores_fft_db_scratch((1 << 20) + 1, true, -120) === 0,
      'chores_fft_db_scratch(0) / oversize → 0 bins');
  });

  it('scratch survives heap growth (HEAPF32 refreshed)', () => {
    const heapBefore = mod.HEAPF32.buffer.byteLength;
    const big = new Float32Array(8 * 1024 * 1024).fill(0.5); // 32 MB > INITIAL_MEMORY
    scratchWrite(mod.chores_scratch_ptr, big);
    const rb = mod.chores_reduce_f32_scratch(big.length);
    assert.ok(mod.HEAPF32.buffer.byteLength > heapBefore && near(rb.sum, big.length * 0.5) && rb.count === big.length,
      `scratch survives heap growth (HEAPF32 refreshed) — heap ${heapBefore} → ${mod.HEAPF32.buffer.byteLength}, sum ${rb.sum}`);
  });

  it('energy network reads budget and enabled flags from scratch', () => {
    sim.setNetworkEdges([0, 1, 10, 1, 0]);
    const eb = scratchWrite((n) => sim.getScratchPtr(n), [
      ...Array(MODE_COUNT).fill(0.5),
      ...Array(MODE_COUNT).fill(1)
    ]);
    sim.updateEnergyNetworkFromScratch(true, 100, 50, MODE_COUNT);
    const sum = sim.getNetworkSummary();
    assert.ok(sum.couplingEnabled && sum.labBudgetW > 100 && sum.totalAllocatedW > 0 && near(sum.residualW, sum.labBudgetW - sum.totalAllocatedW),
      `updateEnergyNetworkFromScratch allocates against a budget — ${JSON.stringify(sum)}`);
    mod.HEAPF32[eb + MODE_COUNT] = 0; // disable SEG (source of the only edge)
    sim.updateEnergyNetworkFromScratch(true, 100, 50, MODE_COUNT);
    assert.ok(sim.getNetworkEdgeAllocatedW(0) === 0, 'enabled flags are read from scratch[modeCount…]');
  });

  // Plant snapshots (#224 §2) ride the same scratch: plantSave → read n floats,
  // write n floats → plantLoad. test:snapshots does the per-mode exactness.
  it('plantSave / plantLoad over scratch', () => {
    const hash = mod.plant_state_layout_hash();
    sim.setMode(1);
    sim.setDrive(0.8);
    for (let i = 0; i < 30; i++) sim.step(1 / 60, 0);
    const n = sim.plantSave(1);
    const at = Number(sim.getScratchPtr(n)) >> 2;
    const saved = Array.from(mod.HEAPF32.subarray(at, at + n));
    assert.ok(n === sim.plantStateSize(1) && n > 2 && saved[2] > 0,
      `plantSave(heron) count = plantStateSize, head > 0 — n=${n} head=${saved[2]}`);
    const fresh = new mod.SEGSimulator();
    try {
      fresh.setMode(1);
      scratchWrite((k) => fresh.getScratchPtr(k), saved);
      assert.ok(fresh.plantLoad(1, n, (hash ^ 1) >>> 0) === false && fresh.getHeronHead() === 0,
        'plantLoad refuses a layout-hash mismatch');
      scratchWrite((k) => fresh.getScratchPtr(k), saved);
      assert.ok(fresh.plantLoad(1, n, hash) === true && fresh.getHeronHead() === sim.getHeronHead(),
        `plantLoad(own hash) restores the plant — ${fresh.getHeronHead()} vs ${sim.getHeronHead()}`);
    } finally {
      fresh.delete();
    }
  });
});

const HARNESS_ENTRY = `
  export { SEGSim } from './src/wasm/sim';
  export { segWasm } from './src/wasm/seg-physics-bridge';
  export { EnergyNetwork, ENERGY_PIPE_EDGES } from './src/renderers/shared/energy-network';
  export { gpuChores } from './src/gpu-chores/session';
  export { WASM_DEVICE_IDS } from './generated/device-catalog';
`;

// Sequential: one SEGSim, one segWasm, one window.
describe('TS wrappers (SEGSim, segWasm → EnergyNetwork, gpuChores)', () => {
  let SEGSim, segWasm, EnergyNetwork, ENERGY_PIPE_EDGES, gpuChores, WASM_DEVICE_IDS, segSim, frame;

  before(async () => {
    // Browser surface the loader touches: ?wasmPhysics=1, storage. The glue import
    // is resolved to scripts/lib/sim-core-shim.mjs (wasmBinary from disk).
    const storage = new Map();
    globalThis.localStorage = {
      getItem: (k) => storage.get(k) ?? null,
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k)
    };
    globalThis.window = globalThis;
    globalThis.location = { search: '?wasmPhysics=1', hash: '' };
    globalThis.fetch = async () => ({ ok: true });
    const quiet = { info: console.info, log: console.log };
    console.info = () => {};
    console.log = () => {};
    try {
      ({ SEGSim, segWasm, EnergyNetwork, ENERGY_PIPE_EDGES, gpuChores, WASM_DEVICE_IDS } = await bundleTs(
        { contents: HARNESS_ENTRY, sourcefile: 'wasm-abi-harness.ts' },
        { plugins: [simCoreShim(WASM_DIR)] }
      ));
      segSim = await SEGSim.create();
      await segWasm.init();
    } finally {
      console.info = quiet.info;
      console.log = quiet.log;
    }
    const devices = Object.fromEntries(WASM_DEVICE_IDS.map((id) => [id, { energyLevel: 0.6 }]));
    const devicesEnabled = Object.fromEntries(WASM_DEVICE_IDS.map((id) => [id, true]));
    frame = { devices, devicesEnabled, segPowerW: 120, segEfficiencyPct: 40, deltaTime: 1 / 60 };
  });

  after(() => { segSim?.dispose?.(); });

  it('SEGSim loads the shipped module', () => {
    assert.ok(segSim.wasmAvailable, 'SEGSim loads the shipped module');
    assert.ok(WASM_DEVICE_IDS.length === MODE_COUNT, 'WASM_DEVICE_IDS.length matches the C++ mode count');
  });

  it('SEGSim.getParticles(4) (getParticle loop, no vector return)', () => {
    segSim.seedParticles(16);
    assert.ok(segSim.getParticles(4).length === 4, 'SEGSim.getParticles(4) (getParticle loop, no vector return)');
  });

  it('SEGSim network: pipe edges, budget allocated', () => {
    const energyByDevice = Object.fromEntries(WASM_DEVICE_IDS.map((id) => [id, 0.6]));
    segSim.setNetworkEdges(ENERGY_PIPE_EDGES);
    const s1 = segSim.updateEnergyNetwork({
      couplingEnabled: true, segPowerW: 120, segEfficiencyPct: 40, energyByDevice, enabledByDevice: {}
    });
    assert.ok(s1.labBudgetW > 120 && s1.totalAllocatedW > 0,
      `SEGSim network: ${ENERGY_PIPE_EDGES.length} pipe edges, budget allocated — ${JSON.stringify(s1)}`);
  });

  // The production frame path: EnergyNetwork → window.segWasm → SEGSim → binary.
  it('EnergyNetwork runs the WASM bus', () => {
    assert.ok(segWasm.enabled, 'segWasm enabled under ?wasmPhysics=1');
    window.segWasm = segWasm;
    const net = new EnergyNetwork(true);
    let snap;
    let threw = null;
    try {
      for (let i = 0; i < 3; i++) snap = net.update(frame);
    } catch (err) {
      threw = err;
    }
    assert.ok(!threw, `EnergyNetwork runs the WASM bus without throwing — ${String(threw?.message ?? '')}`);
    assert.ok(net.busStatus().backend === 'wasm' && net.busStatus().fallbackReason === null,
      `energy bus status = wasm, no fallback — ${JSON.stringify(net.busStatus())}`);
    assert.ok((snap?.labBudgetW ?? 0) > 0 && (snap?.totalAllocatedW ?? 0) > 0, 'WASM bus snapshot carries a budget');
  });

  it('a throwing WASM bus falls back to JS once and stays there', () => {
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
    let threw = null;
    try {
      snap2 = net2.update(frame);
      net2.update(frame);
      net2.update(frame);
    } catch (err) {
      threw = err;
    } finally {
      console.warn = warn;
      window.segWasm = segWasm;
    }
    assert.ok(!threw, `a throwing WASM bus does not propagate — ${String(threw?.message ?? '')}`);
    assert.ok(net2.busStatus().backend === 'js' && net2.busStatus().fallbackReason === 'boom',
      `…falls back to the JS bus with a reason — ${JSON.stringify(net2.busStatus())}`);
    assert.ok(calls === 1, `…tries the WASM bus once, not per frame — calls=${calls}`);
    assert.ok((snap2?.labBudgetW ?? 0) > 0, '…and the JS bus still produces a snapshot');
  });

  it('gpuChores runs on wasm', () => {
    gpuChores.adopt({ sessionApi: 'webgl2' });
    const red = gpuChores.reduceF32(new Float32Array([1, 2, 3]));
    const crumb = gpuChores.breadcrumb();
    assert.ok(red.backend === 'wasm' && red.sum === 6 && crumb.lastBackend === 'wasm' && crumb.wasmError === null,
      `gpuChores reduce runs on wasm (not a silent JS fallback) — ${JSON.stringify({ backend: red.backend, sum: red.sum, crumb })}`);
    const ms = gpuChores.mapScaleF32([1, 2, 3], { scale: 2, bias: 1 });
    assert.ok(Array.from(ms).join() === '3,5,7' && gpuChores.breadcrumb().lastBackend === 'wasm',
      `gpuChores mapScale runs on wasm — ${Array.from(ms).join()}`);
  });
});
