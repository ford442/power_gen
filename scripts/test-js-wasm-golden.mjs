#!/usr/bin/env node
/**
 * test-js-wasm-golden.mjs — JS fallback ⇄ C++ plant telemetry golden.
 *
 * ADR-0002 keeps two plants for every dual device: the C++ one behind
 * `?wasmPhysics=1`, and a TypeScript fallback. Nothing used to hold them to
 * the same numbers, so toggling the flag silently changed ΔT, Hartmann
 * number, Hall voltage and the rest. This test closes that:
 *
 *   1. `sim_core_test --mode golden` replays every dual plant from a fixed
 *      seed and prints its schedule (drive / frames / dt) and its catalog
 *      telemetry keys. The native run is authoritative for the schedule.
 *   2. This script steps the TypeScript fallback over the schedule it read
 *      back — same drive, same frame count, and the same float32-rounded dt
 *      the native binary used (emitted at full double precision).
 *   3. Every catalog `telemetryKeys` entry must agree within ε, and no
 *      value on either side may be NaN or Inf.
 *
 * ## ε
 *
 * The two plants run the same equations over the same schedule, so the only
 * expected difference is arithmetic width: C++ integrates in `float`
 * (~7 significant digits), JS in `double`. Per step that is ~1e-7 relative;
 * over a few hundred steps of a contracting ODE it stays well inside:
 *
 *   |a − b| <= max(ABS_EPS, REL_EPS * max(|a|, |b|))
 *
 * with REL_EPS = 2e-4 (2e-2 %) and ABS_EPS = 1e-9 so keys that settle at
 * zero (a lift that is exactly clamped off, a spark counter in an empty
 * window) compare cleanly. The worst key across the current schedule sits
 * at 4.1e-5 relative (the Peltier stack's COP and power, 240 frames of a
 * two-node thermal integration), so 2e-4 is roughly 5× headroom. A failure
 * at this tolerance is a *model* difference, not rounding — the two plants
 * have drifted apart again.
 *
 * `PER_KEY_EPS` records the handful of keys that need a looser bound and
 * why. Keep that list short: each entry is a place the plants only nearly
 * agree.
 *
 * Usage: node scripts/test-js-wasm-golden.mjs   (exit 1 on failure)
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NATIVE = join(ROOT, 'cpp', 'build', 'sim_core_test');

const REL_EPS = 2e-4;
const ABS_EPS = 1e-9;

/**
 * Looser bounds, with the reason. `vdgSparkHz` is `sparksInWindow /
 * windowSeconds`, and the window closes on a float32 vs float64 running sum
 * of dt crossing 1 s — the count matches, the divisor differs in the last
 * couple of digits.
 */
const PER_KEY_EPS = {
  // The 60 Hz drive is sampled at dt = 1/60 s, i.e. exactly one period per
  // frame, so every frame boundary lands on a zero crossing of a ±25.2 V
  // swing. What is left there is the plants' accumulated phase difference
  // (float32 ω·h vs float64), ~1e-5 rad — negligible against the waveform,
  // but not against a value that is itself ~0. Compared on an absolute
  // scale instead: 5 mV is 2e-4 of the drive amplitude, the same 2e-2 %
  // this file asks of every other key.
  'transformer.transformerVp': {
    abs: 5e-3,
    why: 'drive sampled at a zero crossing — compared against the ±25.2 V amplitude, not against itself',
  },
};

/** Per-device: the JS fallback entry points and how to seed / step them. */
const PLANTS = {
  peltier: { create: 'createPeltierPhysicsState', step: 'stepPeltierPhysics' },
  mhd: { create: 'createMhdPhysicsState', step: 'stepMhdPhysics' },
  maglev: { create: 'createMagLevPhysicsState', step: 'stepMagLevPhysics' },
  homopolar: { create: 'createHomopolarPhysicsState', step: 'stepHomopolarPhysics' },
  transformer: { create: 'createTransformerPhysicsState', step: 'stepTransformerPhysics' },
  vdg: { create: 'createVdgPhysicsState', step: 'stepVdgPhysics' },
  hall: { create: 'createHallPhysicsState', step: 'stepHallPhysics' },
  'lorentz-sled': { create: 'createLorentzSledPhysicsState', step: 'stepLorentzSledPhysics' },
  'jumping-ring': { create: 'createJumpingRingPhysicsState', step: 'stepJumpingRingPhysics' },
};

/** Bundled rather than transformed one file at a time: the plugins import
 *  mesh/material helpers, and esbuild tree-shakes the render half away. */
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
export { DEVICE_CATALOG } from './generated/device-catalog.ts';
`;

const failures = [];
const fail = (msg) => failures.push(msg);

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

/**
 * Parse `golden.case <id> k=v …` / `golden.value <id> <key> <v>`.
 *
 * The key=value tail is read generically rather than positionally, so the
 * native side can add a knob (a coupled B setpoint, say) without this parser
 * needing a new capture group. `device` names the catalog device the case
 * covers, which is not the case id for a variant like `hall-coupled`.
 */
function parseGolden(stdout) {
  const cases = new Map();
  let done = false;
  for (const line of stdout.split('\n')) {
    const c = line.match(/^golden\.case (\S+) (.*)$/);
    if (c) {
      const kv = new Map(
        c[2].trim().split(/\s+/).filter(Boolean).map((pair) => {
          const eq = pair.indexOf('=');
          return [pair.slice(0, eq), pair.slice(eq + 1)];
        })
      );
      const id = c[1];
      cases.set(id, {
        id,
        device: kv.get('device') ?? id,
        drive: Number(kv.get('drive')),
        frames: Number(kv.get('frames')),
        dt: Number(kv.get('dt')),
        // Lab field coupling (ADR-0011) — negative means "no coupling".
        hallFieldCoupledT: Number(kv.get('hallFieldCoupledT') ?? -1),
        lorentzFieldT: Number(kv.get('lorentzFieldT') ?? -1),
        values: new Map(),
      });
      continue;
    }
    const v = line.match(/^golden\.value (\S+) (\S+) (\S+)$/);
    if (v) {
      const entry = cases.get(v[1]);
      if (!entry) {
        fail(`native emitted a value for ${v[1]} before its golden.case line`);
        continue;
      }
      entry.values.set(v[2], Number(v[3]));
      continue;
    }
    if (/^golden\.done /.test(line)) done = true;
  }
  return { cases, done };
}

function epsFor(deviceId, key) {
  const override = PER_KEY_EPS[`${deviceId}.${key}`];
  return {
    rel: override?.rel ?? REL_EPS,
    abs: override?.abs ?? ABS_EPS,
    why: override?.why,
  };
}

function agree(a, b, eps) {
  const diff = Math.abs(a - b);
  return diff <= Math.max(eps.abs, eps.rel * Math.max(Math.abs(a), Math.abs(b)));
}

// ── 1. native side ───────────────────────────────────────────────────────
if (!existsSync(NATIVE)) {
  console.error(
    '[golden] native binary missing at cpp/build/sim_core_test.\n' +
    '         Run `npm run wasm:native` first (npm run validate does).'
  );
  process.exit(1);
}
const run = spawnSync(NATIVE, ['--mode', 'golden'], { encoding: 'utf8' });
process.stderr.write(run.stderr || '');
if (run.status !== 0) {
  console.error(`[golden] native --mode golden exited ${run.status}`);
  process.exit(run.status || 1);
}
const { cases, done } = parseGolden(run.stdout || '');
if (!done) fail('native --mode golden did not print golden.done');

// ── 2. JS side ───────────────────────────────────────────────────────────
const js = await importBundle(ENTRY, 'golden-entry.ts');
const catalogById = new Map(js.DEVICE_CATALOG.map((d) => [d.id, d]));

// Every dual device — catalog wasmMode set *and* a JS fallback plant — must
// be covered. This is what stops a new plant landing without a golden. A
// device may have more than one case (a default one and a field-coupled
// variant); it must have at least one.
const dualIds = js.DEVICE_CATALOG.filter((d) => d.wasmMode !== null && PLANTS[d.id]).map((d) => d.id);
const casesByDevice = new Map();
for (const kase of cases.values()) {
  if (!casesByDevice.has(kase.device)) casesByDevice.set(kase.device, []);
  casesByDevice.get(kase.device).push(kase);
}
for (const id of dualIds) {
  if (!casesByDevice.has(id)) fail(`no native golden case for dual device '${id}' — add it to GOLDEN_CASES`);
}
for (const kase of cases.values()) {
  if (!PLANTS[kase.device]) {
    fail(`native emitted golden case '${kase.id}' for device '${kase.device}' with no JS fallback plant wired up here`);
  }
}

/**
 * Apply a case's coupled setpoints to the JS state before stepping. This is
 * the same write `FieldNetwork.update` makes each frame, so the fallback sees
 * exactly what `setHallFieldCoupledT` / `setLorentzFieldT` gave the C++ plant.
 */
function seedCoupling(state, kase) {
  if (kase.hallFieldCoupledT >= 0) state.hallFieldCoupledT = kase.hallFieldCoupledT;
  if (kase.lorentzFieldT >= 0) state.lorentzFieldT = kase.lorentzFieldT;
}

let compared = 0;
for (const kase of cases.values()) {
  const id = kase.id;
  const plant = PLANTS[kase.device];
  const entry = catalogById.get(kase.device);
  if (!plant || !entry) continue;

  const create = js[plant.create];
  const step = js[plant.step];
  if (typeof create !== 'function' || typeof step !== 'function') {
    fail(`${id}: JS fallback exports missing (${plant.create} / ${plant.step})`);
    continue;
  }

  const state = create();
  seedCoupling(state, kase);
  for (let i = 0; i < kase.frames; i++) step(state, kase.dt, kase.drive);

  for (const key of entry.telemetryKeys) {
    const native = kase.values.get(key);
    if (native === undefined) {
      fail(`${id}.${key}: catalog telemetry key has no native golden value`);
      continue;
    }
    const mine = state[key];
    if (typeof mine !== 'number') {
      fail(`${id}.${key}: JS fallback left it ${mine === undefined ? 'unset' : String(mine)}`);
      continue;
    }
    if (!Number.isFinite(mine)) { fail(`${id}.${key}: JS value is ${mine}`); continue; }
    if (!Number.isFinite(native)) { fail(`${id}.${key}: native value is ${native}`); continue; }

    const eps = epsFor(kase.device, key);
    compared++;
    if (!agree(mine, native, eps)) {
      const diff = Math.abs(mine - native);
      const rel = diff / Math.max(Math.abs(mine), Math.abs(native), Number.MIN_VALUE);
      fail(
        `${id}.${key}: JS ${mine} vs native ${native} — |Δ| ${diff.toExponential(3)} ` +
        `(relative ${rel.toExponential(3)}) exceeds rel ${eps.rel.toExponential(1)} / ` +
        `abs ${eps.abs.toExponential(1)}${eps.why ? ` (${eps.why})` : ''}`
      );
    }
  }

  // Keys the native side reports that the catalog does not list would drop
  // out of the diff unnoticed.
  for (const key of kase.values.keys()) {
    if (!entry.telemetryKeys.includes(key)) {
      fail(`${id}.${key}: native golden emits it, but it is not in the catalog telemetryKeys`);
    }
  }
}

if (failures.length) {
  console.error(`[golden] ${failures.length} failure(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(
  `[golden] JS fallback matches the C++ plant on ${compared} telemetry keys ` +
  `across ${cases.size} cases / ${dualIds.length} dual devices ` +
  `(rel ε ${REL_EPS.toExponential(0)}, abs ε ${ABS_EPS.toExponential(0)})`
);
