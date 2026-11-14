#!/usr/bin/env node
/**
 * test-snapshots.mjs — plant snapshot goldens (#224 §2).
 *
 * A snapshot is only worth having if restoring it is exact: a plant loaded
 * from one must step on exactly as the plant it was taken from. This holds
 * every backend to that:
 *
 *   1. native  `sim_core_test --mode snapshots` — every C++ mode: run A,
 *      plantSave, plantLoad into a fresh B, step both → bit-identical
 *      (standalone_snapshots.cpp; also refuses a wrong hash / short vector /
 *      NaN).
 *   2. wasm    the *shipped* src/public/wasm/sim_core — the same round trip
 *      through the Embind scratch ABI for all 13 modes, bit-identical, plus
 *      `plantLoad` refusing a layout-hash mismatch and leaving B untouched.
 *   3. TS      every JS device plant (10 dual + seg / heron / solar + the
 *      TS-only pulse-coil / halbach-viz / drop-tube): save → JSON → load into
 *      a fresh state → step both → every scalar field bit-identical. Any
 *      field the step reads that the catalog `state` block misses shows up
 *      here as a divergence.
 *   4. cross   JS snapshot → `cppStateFromKeys` → C++ `plantLoad` → step,
 *      against the JS plant stepping on, for every native golden case. Same
 *      ε as test:golden (rel 2e-4, the transformerVp zero-crossing override):
 *      the two plants agree to that from t = 0, and must keep agreeing from
 *      a restored mid-run state.
 *   5. replay  `keyframes` are optional in a replay file and survive
 *      validateReplayFile (old files load unchanged).
 *
 * Usage: node scripts/test-snapshots.mjs   (exit 1 on failure)
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NATIVE = join(ROOT, 'cpp', 'build', 'sim_core_test');
const WASM_DIR = process.env.SIM_CORE_DIR ?? join(ROOT, 'src/public/wasm');

const DT = Math.fround(1 / 60);
const DRIVE = 0.73;
const FRAMES_BEFORE = 90;
const FRAMES_AFTER = 90;
/**
 * TS plants are saved at several points of a run: a field that only matters
 * mid-event (a spark accumulator, a pulse timer) is zero at most instants, so
 * one save point can miss it.
 */
const TS_SAVE_AT = [23, 90, 241, 607];

// Same tolerance (and the same single override) as test-js-wasm-golden.mjs.
const REL_EPS = 2e-4;
const ABS_EPS = 1e-9;
const PER_KEY_EPS = {
  'transformer.transformerVp': { abs: 5e-3 },
};

/**
 * Scalars a plant keeps purely for drawing — never read by its step. The
 * pulse-coil oscilloscope ring buffer index is the only one; its arrays are
 * skipped with every other non-scalar.
 */
const VISUAL_ONLY = new Set(['pulseCoilHistIdx']);

const failures = [];
const fail = (msg) => failures.push(msg);

// ── 1. native ─────────────────────────────────────────────────────────────
if (!existsSync(NATIVE)) {
  console.error('[snapshots] native binary missing at cpp/build/sim_core_test — run `npm run wasm:native` first.');
  process.exit(1);
}
const nativeRun = spawnSync(NATIVE, ['--mode', 'snapshots'], { encoding: 'utf8' });
process.stderr.write(nativeRun.stderr || '');
const nativeOk = (nativeRun.stdout || '').split('\n').filter((l) => l.startsWith('snapshots.ok ')).length;
const nativeDone = /snapshots\.done modes=(\d+) hash=(0x[0-9a-f]+)/.exec(nativeRun.stdout || '');
if (nativeRun.status !== 0) fail(`native --mode snapshots exited ${nativeRun.status}`);
if (!nativeDone) fail('native --mode snapshots did not print snapshots.done');

// ── bundle the TS side ────────────────────────────────────────────────────
const ENTRY = `
export { createPeltierPhysicsState, stepPeltierPhysics } from './src/devices/core/peltier-mesh.ts';
export { createMhdPhysicsState, stepMhdPhysics } from './src/devices/core/mhd-mesh.ts';
export { createMagLevPhysicsState, stepMagLevPhysics } from './src/devices/quanta/magnetic-levitation.ts';
export { createHomopolarPhysicsState, stepHomopolarPhysics } from './src/devices/quanta/homopolar-generator.ts';
export { createTransformerPhysicsState, stepTransformerPhysics } from './src/devices/quanta/transformer.ts';
export { createVdgPhysicsState, stepVdgPhysics } from './src/devices/quanta/van-de-graaff.ts';
export { createHallPhysicsState, stepHallPhysics } from './src/devices/quanta/hall-effect.ts';
export { createLorentzSledPhysicsState, stepLorentzSledPhysics } from './src/devices/quanta/lorentz-sled.ts';
export { createJumpingRingPhysicsState, stepJumpingRingPhysics } from './src/devices/quanta/jumping-ring.ts';
export { createPulseCoilPhysicsState, stepPulseCoilPhysics } from './src/devices/quanta/pulse-coil.ts';
export { createHalbachVizPhysicsState, stepHalbachVizPhysics } from './src/devices/quanta/halbach-viz.ts';
export { createDropTubePhysicsState, stepDropTubePhysics } from './src/devices/quanta/drop-tube.ts';
export { createDevicePhysicsState, stepDevicePhysics } from './src/renderers/shared/device-physics.ts';
export { DEVICE_CATALOG } from './generated/device-catalog.ts';
export * from './src/session/plant-snapshot.ts';
export { validateReplayFile } from './src/telemetry/replay-parse.ts';
`;

async function importBundle(contents, sourcefile) {
  const built = await esbuild.build({
    stdin: { contents, resolveDir: ROOT, sourcefile, loader: 'ts' },
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    write: false,
    logLevel: 'warning',
  });
  const code = built.outputFiles[0].text;
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
}

const js = await importBundle(ENTRY, 'snapshots-entry.ts');
const { DEVICE_STATE_LAYOUT, PLANT_STATE_LAYOUT_HASH } = js;

/** The JS plant behind each device id (core devices share stepDevicePhysics). */
const core = (id) => ({
  create: () => js.createDevicePhysicsState(id),
  step: (s, dt, drive) => js.stepDevicePhysics(s, dt, drive),
});
const plugin = (create, step) => ({ create: js[create], step: js[step] });
const PLANTS = {
  seg: core('seg'),
  heron: core('heron'),
  kelvin: core('kelvin'),
  solar: core('solar'),
  peltier: plugin('createPeltierPhysicsState', 'stepPeltierPhysics'),
  mhd: plugin('createMhdPhysicsState', 'stepMhdPhysics'),
  maglev: plugin('createMagLevPhysicsState', 'stepMagLevPhysics'),
  'pulse-coil': plugin('createPulseCoilPhysicsState', 'stepPulseCoilPhysics'),
  homopolar: plugin('createHomopolarPhysicsState', 'stepHomopolarPhysics'),
  'halbach-viz': plugin('createHalbachVizPhysicsState', 'stepHalbachVizPhysics'),
  transformer: plugin('createTransformerPhysicsState', 'stepTransformerPhysics'),
  vdg: plugin('createVdgPhysicsState', 'stepVdgPhysics'),
  hall: plugin('createHallPhysicsState', 'stepHallPhysics'),
  'lorentz-sled': plugin('createLorentzSledPhysicsState', 'stepLorentzSledPhysics'),
  'jumping-ring': plugin('createJumpingRingPhysicsState', 'stepJumpingRingPhysics'),
  'drop-tube': plugin('createDropTubePhysicsState', 'stepDropTubePhysics'),
};

/**
 * Non-default knobs on the run being saved, so a load that drops one of them
 * diverges instead of matching by luck (a fresh state has the defaults).
 */
const KNOBS = {
  kelvin: { kelvinSeedCoupledV: 9000 },
  transformer: { transformerLeakage: true },
  hall: { hallCarrierType: 'metal', hallFieldCoupledT: 0.27 },
  'lorentz-sled': { lorentzFieldT: 0.41 },
  'pulse-coil': { pulseCoilChargeSetpointV: 180 },
  'halbach-viz': { halbachSegmentSetpoint: 12, halbachLayout: 'linear' },
  'drop-tube': { dropTubeSigmaSetpointMSm: 21 },
  seg: { magneticFieldStrength: 0.8 },
};

const sameBits = (a, b) => Object.is(a, b);

function scalarDiffs(a, b) {
  const out = [];
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (VISUAL_ONLY.has(key)) continue;
    const va = a[key];
    const vb = b[key];
    const scalar = (v) => v === null || v === undefined || ['number', 'boolean', 'string'].includes(typeof v);
    if (!scalar(va) || !scalar(vb)) continue;
    if (!sameBits(va, vb)) out.push(`${key}: ${String(va)} vs ${String(vb)}`);
  }
  return out;
}

// ── 3. TS plants: save → JSON → load → step bit-identical ─────────────────
const catalogIds = js.DEVICE_CATALOG.map((d) => d.id);
for (const id of catalogIds) {
  if (!PLANTS[id]) fail(`ts: no JS plant wired up for catalog device '${id}'`);
  if (!DEVICE_STATE_LAYOUT[id]) fail(`ts: '${id}' has no DEVICE_STATE_LAYOUT entry`);
}
let tsChecked = 0;
for (const [id, plant] of Object.entries(PLANTS)) {
  if (typeof plant.create !== 'function' || typeof plant.step !== 'function') {
    fail(`ts ${id}: JS plant exports missing`);
    continue;
  }
  let moved = false;
  for (const saveAt of TS_SAVE_AT) {
    const r = checkTsRoundTrip(id, plant, saveAt);
    if (r === null) break;
    moved ||= r;
  }
  if (!moved && id !== 'halbach-viz') fail(`ts ${id}: plant never moved after a load — the check proves nothing`);
  tsChecked++;
}

/** One save point: returns whether the plant moved after it, null on a hard failure. */
function checkTsRoundTrip(id, plant, saveAt) {
  const tag = `ts ${id}@${saveAt}`;
  const a = plant.create();
  Object.assign(a, KNOBS[id] ?? {});
  for (let i = 0; i < saveAt; i++) plant.step(a, DT, DRIVE);

  // Through JSON, the way a snapshot travels (NaN → null → NaN).
  const snap = {
    format: 'seg-plant-snapshot', version: 1, layoutHash: PLANT_STATE_LAYOUT_HASH, catalogHash: '',
    backend: 'js', focus: id, t: 0, seed: null, config: {}, devices: { [id]: js.saveDeviceState(id, a) },
  };
  const parsed = js.parsePlantSnapshot(JSON.stringify(snap));
  if (!parsed.snapshot) {
    fail(`${tag}: own snapshot failed to parse — ${parsed.errors.join('; ')}`);
    return null;
  }
  const packed = js.packDeviceState(id, a);
  const b = plant.create();
  const c = plant.create();
  const written = js.loadDeviceState(id, b, parsed.snapshot.devices[id]);
  js.loadDeviceState(id, c, packed);
  if (written.length !== js.deviceStateKeys(id).length) {
    fail(`${tag}: loaded ${written.length} of ${js.deviceStateKeys(id).length} layout keys (${js.deviceStateKeys(id).filter((k) => !written.includes(k)).join(', ')} unset)`);
  }
  const before = JSON.stringify(js.saveDeviceState(id, a));
  // Compared every frame, not just at the end: a missed accumulator can
  // diverge for a window and then re-converge (the VdG spark counter does).
  for (let i = 0; i < FRAMES_AFTER; i++) {
    plant.step(a, DT, DRIVE);
    plant.step(b, DT, DRIVE);
    plant.step(c, DT, DRIVE);
    const keyed = scalarDiffs(a, b);
    const vec = scalarDiffs(a, c);
    if (keyed.length) fail(`${tag}: keyed load diverged at frame +${i + 1} — ${keyed.slice(0, 4).join('; ')}`);
    if (vec.length) fail(`${tag}: packed load diverged at frame +${i + 1} — ${vec.slice(0, 4).join('; ')}`);
    if (keyed.length || vec.length) break;
  }
  return JSON.stringify(js.saveDeviceState(id, a)) !== before;
}

// ── 2. shipped wasm: round trip all 13 modes ──────────────────────────────
const SimCore = new Function(`${readFileSync(join(WASM_DIR, 'sim_core.js'), 'utf8')}\n;return SimCore;`)();
const mod = await SimCore({ wasmBinary: readFileSync(join(WASM_DIR, 'sim_core.wasm')) });
if ((mod.plant_state_layout_hash() >>> 0) !== PLANT_STATE_LAYOUT_HASH) {
  fail(`wasm: plant_state_layout_hash ${mod.plant_state_layout_hash()} ≠ generated ${PLANT_STATE_LAYOUT_HASH} — rebuild src/public/wasm`);
}

function save(sim, mode) {
  const n = sim.plantSave(mode);
  const ptr = Number(sim.getScratchPtr(n)) >> 2;
  return mod.HEAPF32.slice(ptr, ptr + n);
}
function load(sim, mode, values, hash = PLANT_STATE_LAYOUT_HASH) {
  const ptr = Number(sim.getScratchPtr(values.length)) >> 2;
  mod.HEAPF32.set(values, ptr);
  return sim.plantLoad(mode, values.length, hash >>> 0);
}
const bitsEqual = (x, y) =>
  x.length === y.length && Buffer.compare(Buffer.from(x.buffer, x.byteOffset, x.byteLength), Buffer.from(y.buffer, y.byteOffset, y.byteLength)) === 0;

function wasmKnobs(sim, id) {
  sim.setDrive(DRIVE);
  if (id === 'seg') sim.setRingLoadTorques(0.004, 0.009, 0.013);
  if (id === 'kelvin') sim.setKelvinSeedV(9000);
  if (id === 'transformer') sim.setTransformerLeakage(true);
  if (id === 'hall') { sim.setHallCarrierMetal(true); sim.setHallFieldCoupledT(0.27); }
  if (id === 'lorentz-sled') sim.setLorentzFieldT(0.41);
}

let wasmChecked = 0;
for (const [id, layout] of Object.entries(DEVICE_STATE_LAYOUT)) {
  if (layout.wasmMode === null) continue;
  const mode = layout.wasmMode;
  const a = new mod.SEGSimulator();
  const b = new mod.SEGSimulator();
  try {
    if (a.plantStateSize(mode) !== layout.cppSize) {
      fail(`wasm ${id}: plantStateSize ${a.plantStateSize(mode)} ≠ layout ${layout.cppSize}`);
      continue;
    }
    a.setMode(mode);
    wasmKnobs(a, id);
    for (let i = 0; i < FRAMES_BEFORE; i++) a.stepWithPerRingTorques(DT);
    const saved = save(a, mode);

    b.setMode(mode);
    const fresh = save(b, mode);
    if (load(b, mode, saved, PLANT_STATE_LAYOUT_HASH ^ 1)) fail(`wasm ${id}: plantLoad accepted a layout-hash mismatch`);
    if (!bitsEqual(save(b, mode), fresh)) fail(`wasm ${id}: a refused plantLoad still changed the plant`);
    if (!load(b, mode, saved)) {
      fail(`wasm ${id}: plantLoad refused its own vector`);
      continue;
    }
    if (!bitsEqual(save(b, mode), saved)) fail(`wasm ${id}: save → load → save is not the identity`);
    let sa = saved;
    for (let i = 0; i < FRAMES_AFTER; i++) {
      a.stepWithPerRingTorques(DT);
      b.stepWithPerRingTorques(DT);
      sa = save(a, mode);
      const sb = save(b, mode);
      if (!bitsEqual(sa, sb)) {
        const at = sa.findIndex((v, k) => !Object.is(v, sb[k]));
        fail(`wasm ${id}: diverged at frame +${i + 1}, float ${at} (${sa[at]} vs ${sb[at]})`);
        break;
      }
    }
    if (bitsEqual(sa, saved)) fail(`wasm ${id}: plant did not move — the check proves nothing`);
    if (!Object.is(a.getEnergyLevel(), b.getEnergyLevel())) fail(`wasm ${id}: energy level differs after load`);
    wasmChecked++;
  } finally {
    a.delete();
    b.delete();
  }
}

// ── 4. cross-load JS → C++ over the native golden schedules ──────────────
const golden = spawnSync(NATIVE, ['--mode', 'golden'], { encoding: 'utf8' });
const cases = [];
for (const line of (golden.stdout || '').split('\n')) {
  const m = /^golden\.case (\S+) (.*)$/.exec(line);
  if (!m) continue;
  const kv = Object.fromEntries(m[2].trim().split(/\s+/).map((p) => [p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1)]));
  cases.push({
    id: m[1],
    device: kv.device ?? m[1],
    drive: Number(kv.drive),
    frames: Number(kv.frames),
    dt: Number(kv.dt),
    hallFieldCoupledT: Number(kv.hallFieldCoupledT ?? -1),
    lorentzFieldT: Number(kv.lorentzFieldT ?? -1),
    kelvinSeedV: Number(kv.kelvinSeedV ?? -1),
  });
}
if (golden.status !== 0 || !cases.length) fail(`cross: native --mode golden exited ${golden.status} with ${cases.length} cases`);

const agree = (x, y, eps) => Math.abs(x - y) <= Math.max(eps.abs, eps.rel * Math.max(Math.abs(x), Math.abs(y)));
const catalogById = new Map(js.DEVICE_CATALOG.map((d) => [d.id, d]));
let crossKeys = 0;
let worstRel = 0;
for (const kase of cases) {
  const plant = PLANTS[kase.device];
  const layout = DEVICE_STATE_LAYOUT[kase.device];
  const entry = catalogById.get(kase.device);
  if (!plant || !layout || layout.wasmMode === null || !entry) {
    fail(`cross ${kase.id}: no JS plant / layout for '${kase.device}'`);
    continue;
  }
  const state = plant.create();
  if (kase.hallFieldCoupledT >= 0) state.hallFieldCoupledT = kase.hallFieldCoupledT;
  if (kase.lorentzFieldT >= 0) state.lorentzFieldT = kase.lorentzFieldT;
  if (kase.kelvinSeedV >= 0) state.kelvinSeedCoupledV = kase.kelvinSeedV;
  for (let i = 0; i < kase.frames; i++) plant.step(state, kase.dt, kase.drive);

  const sim = new mod.SEGSimulator();
  try {
    sim.setMode(layout.wasmMode);
    sim.setDrive(kase.drive);
    const vec = js.cppStateFromKeys(kase.device, js.saveDeviceState(kase.device, state), save(sim, layout.wasmMode), { drive: kase.drive });
    if (!vec || !load(sim, layout.wasmMode, vec)) {
      fail(`cross ${kase.id}: C++ refused the cross-loaded JS state`);
      continue;
    }
    for (let i = 0; i < kase.frames; i++) {
      plant.step(state, kase.dt, kase.drive);
      sim.step(kase.dt, 0);
    }
    const cpp = js.keysFromCppState(kase.device, save(sim, layout.wasmMode));
    for (const key of entry.telemetryKeys) {
      if (!(key in cpp)) continue;
      const mine = state[key];
      const theirs = cpp[key];
      const o = PER_KEY_EPS[`${kase.device}.${key}`];
      const eps = { rel: o?.rel ?? REL_EPS, abs: o?.abs ?? ABS_EPS };
      crossKeys++;
      if (typeof mine !== 'number' || !Number.isFinite(mine) || !Number.isFinite(theirs)) {
        fail(`cross ${kase.id}.${key}: JS ${mine} vs C++ ${theirs}`);
        continue;
      }
      const rel = Math.abs(mine - theirs) / Math.max(Math.abs(mine), Math.abs(theirs), Number.MIN_VALUE);
      if (!o) worstRel = Math.max(worstRel, Math.abs(mine - theirs) <= ABS_EPS ? 0 : rel);
      if (!agree(mine, theirs, eps)) {
        fail(`cross ${kase.id}.${key}: JS ${mine} vs C++ ${theirs} after a JS→C++ load (relative ${rel.toExponential(3)})`);
      }
    }
  } finally {
    sim.delete();
  }
}

// ── 5. replay files: keyframes optional, passed through ───────────────────
const replayBase = { replayVersion: 1, seed: null, speedCurve: [], config: {}, samples: [] };
const withFrames = js.validateReplayFile({ ...replayBase, keyframes: [{ t: 2, snapshot: { format: 'seg-plant-snapshot' } }] });
const without = js.validateReplayFile(replayBase);
if (withFrames.keyframes?.length !== 1 || withFrames.keyframes[0].t !== 2) fail('replay: keyframes did not survive validateReplayFile');
if ('keyframes' in without) fail('replay: a file without keyframes gained a keyframes key');

if (failures.length) {
  console.error(`[snapshots] ${failures.length} failure(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(
  `[snapshots] native ${nativeOk} modes bit-identical (layout ${nativeDone[2]}); ` +
  `shipped wasm ${wasmChecked} modes bit-identical + hash-mismatch refused; ` +
  `TS ${tsChecked} plants bit-identical after save → JSON → load; ` +
  `JS→C++ cross-load ${crossKeys} keys over ${cases.length} golden cases within rel ${REL_EPS.toExponential(0)} ` +
  `(worst ${worstRel.toExponential(2)}); replay keyframes optional + passed through`
);
