#!/usr/bin/env node
/**
 * test-plant-worker.mjs — LabSession plant worker contract (no browser).
 *
 * Runs the real `PlantWorkerHost` against the real `src/workers/plant-worker.ts`
 * bundle inside a Node `worker_threads` thread (structured clone + transfer,
 * separate module graph — so the worker's `segOperator` is a true mirror, as
 * in the browser). Checks, against an in-process reference operator:
 *
 *   1. JS plant parity — N frames through the worker land on bit-identical
 *      SEG state, one frame late (the documented latency).
 *   2. Substeps issued while a batch is in flight queue up; no sim time lost.
 *   3. An operator action (STOP) while a batch is in flight drops its result
 *      and re-runs its substeps from the new state — the button press wins.
 *   4. Pause (dt = 0) posts nothing; `cancel()` discards the in-flight batch.
 *   5. `?wasmPhysics` without a loadable sim_core falls back with a reason.
 *   6. Packed plant snapshot round-trips (keys, mode index, NaN = absent).
 *
 * Golden JS ⇄ C++ parity stays in test-js-wasm-golden.mjs (in-process, native).
 *
 * Usage: node scripts/test-plant-worker.mjs   (exit 1 on failure)
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker as ThreadWorker } from 'node:worker_threads';
import * as esbuild from 'esbuild';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TMP = mkdtempSync(join(tmpdir(), 'plant-worker-'));

/**
 * `scientific-data.ts` pulls generated WGSL constants via Vite `?raw`; the
 * plant never reads that text, so stub it (as test-fdtd-slice.mjs does).
 */
const viteRawStub = {
  name: 'vite-raw-stub',
  setup(build) {
    build.onResolve({ filter: /\?raw$/ }, (args) => ({ path: args.path, namespace: 'raw-stub' }));
    build.onLoad({ filter: /.*/, namespace: 'raw-stub' }, () => ({ contents: 'export default "";', loader: 'js' }));
  }
};

async function bundle(opts) {
  const built = await esbuild.build({
    bundle: true,
    plugins: [viteRawStub],
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    write: false,
    logLevel: 'warning',
    ...opts
  });
  return built.outputFiles[0].text;
}

// ── Worker thread: the production entry, with `self` shimmed onto parentPort ──
const workerBundle = join(TMP, 'plant-worker.mjs');
writeFileSync(workerBundle, await bundle({ entryPoints: [join(ROOT, 'src/workers/plant-worker.ts')] }));
const bootstrap = join(TMP, 'bootstrap.mjs');
writeFileSync(bootstrap, `
import { parentPort } from 'node:worker_threads';
globalThis.self = globalThis;
globalThis.postMessage = (msg, transfer) => parentPort.postMessage(msg, transfer);
parentPort.on('message', (data) => globalThis.onmessage?.({ data }));
console.info = () => {};
console.log = () => {};
await import(${JSON.stringify(pathToFileURL(workerBundle).href)});
`);

/** Browser `Worker` facade over worker_threads for the host. */
const threads = [];
globalThis.Worker = class {
  constructor() {
    this.onmessage = null;
    this.onerror = null;
    this._t = new ThreadWorker(bootstrap);
    this._t.on('message', (data) => this.onmessage?.({ data }));
    this._t.on('error', (err) => this.onerror?.({ message: err.message }));
    threads.push(this._t);
  }
  postMessage(msg, transfer) { this._t.postMessage(msg, transfer); }
  terminate() { this._t.terminate(); }
};

const hostCode = await bundle({
  stdin: {
    contents: `
      export { PlantWorkerHost } from './src/session/plant-worker-host';
      export { segOperator, SEGOperatorState } from './src/seg-operator-state';
      export { packModePlant, unpackModePlant, PLANT_PACK_ROLLER_OFFSET } from './src/session/plant-worker-protocol';
      export { WASM_DEVICE_IDS } from './generated/device-catalog';
    `,
    resolveDir: ROOT,
    sourcefile: 'plant-worker-host-harness.ts',
    loader: 'ts'
  }
});
const {
  PlantWorkerHost, segOperator, SEGOperatorState, packModePlant, unpackModePlant,
  PLANT_PACK_ROLLER_OFFSET, WASM_DEVICE_IDS
} = await (async () => {
  // A file URL, not data: — src/wasm/index.ts resolves sim_core against import.meta.url.
  const hostBundle = join(TMP, 'host.mjs');
  writeFileSync(hostBundle, hostCode);
  return import(pathToFileURL(hostBundle).href);
})();

// ── helpers ──────────────────────────────────────────────────────────────
const failures = [];
const ok = [];
function check(label, condition, detail = '') {
  if (condition) ok.push(label);
  else failures.push(`${label}${detail ? `: ${detail}` : ''}`);
}

const tick = () => new Promise((r) => setTimeout(r, 1));
async function until(fn, label, timeoutMs = 10_000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await tick();
  }
}
/** Wait for the in-flight batch (if any) to come back. */
const settle = (host) => until(() => !host.inFlight, 'worker result');

function frame(host, steps, extra = {}) {
  host.step({ devices: {}, focus: 'seg', simSteps: steps, drive: segOperator.getDrive(), useWasm: false, ...extra });
}

function resetBoth(ref) {
  segOperator.reset();
  ref.reset();
}

/** Jittered frame schedule — variable-length single steps like speed ≤ 3×. */
const SCHEDULE = Array.from({ length: 240 }, (_, i) => (1 / 60) * (0.75 + 0.5 * ((i * 7919) % 97) / 97));

try {
  const host = PlantWorkerHost.create();
  check('host created with Worker present', !!host);
  await until(() => host.unavailableReason(false) === null, 'worker ready');

  const ref = new SEGOperatorState();

  // 1. JS plant parity + one-frame latency ─────────────────────────────────
  resetBoth(ref);
  segOperator.start(); ref.start();
  segOperator.targetDrive = ref.targetDrive = 0.7;
  frame(host, [SCHEDULE[0]]);
  check('latency: first frame leaves state untouched', segOperator.physics.segOmega === 0);
  ref.step(SCHEDULE[0]);
  await settle(host);
  for (let i = 1; i < SCHEDULE.length; i++) {
    frame(host, [SCHEDULE[i]]);
    ref.step(SCHEDULE[i]);
    await settle(host);
  }
  frame(host, []);
  check(
    'parity: segOmega bit-identical after 240 worker frames',
    segOperator.physics.segOmega === ref.physics.segOmega && ref.physics.segOmega > 0,
    `${segOperator.physics.segOmega} vs ${ref.physics.segOmega}`
  );
  check('parity: corona', segOperator.physics.corona === ref.physics.corona);
  check('parity: status', segOperator.status === ref.status, `${segOperator.status} vs ${ref.status}`);

  // 2. Queue behind an in-flight batch ─────────────────────────────────────
  resetBoth(ref);
  segOperator.start(); ref.start();
  const burst = [1 / 60, 1 / 50, 1 / 45];
  for (const dt of burst) { frame(host, [dt]); ref.step(dt); }
  check('queue: later substeps wait for the in-flight batch', host.stats().pendingSteps === 2,
    `pending=${host.stats().pendingSteps}`);
  await settle(host); frame(host, []);
  await settle(host); frame(host, []);
  check('queue: no sim time lost', segOperator.physics.segOmega === ref.physics.segOmega,
    `${segOperator.physics.segOmega} vs ${ref.physics.segOmega}`);

  // 3. Operator action while in flight ─────────────────────────────────────
  resetBoth(ref);
  segOperator.start(); ref.start();
  for (let i = 0; i < 60; i++) { frame(host, [1 / 60]); ref.step(1 / 60); await settle(host); }
  frame(host, []);
  const droppedBefore = host.stats().droppedResults;
  frame(host, [1 / 60]);            // batch posted under the running epoch
  segOperator.stop(); ref.stop();   // STOP lands while it is in flight
  ref.step(1 / 60);
  await settle(host); frame(host, []);   // stale result dropped, substep re-queued
  await settle(host); frame(host, []);
  check('epoch: stale result dropped', host.stats().droppedResults === droppedBefore + 1);
  check('epoch: STOP survives the in-flight batch', segOperator.status === 'stopping' && !segOperator.isRunning,
    segOperator.status);
  check('epoch: re-queued substep ran from the stopped state',
    segOperator.physics.segOmega === ref.physics.segOmega,
    `${segOperator.physics.segOmega} vs ${ref.physics.segOmega}`);

  // 4. Pause + cancel ──────────────────────────────────────────────────────
  const frozen = segOperator.physics.segOmega;
  frame(host, [0]);
  check('pause: dt = 0 posts nothing', !host.inFlight);
  await tick(); frame(host, [0]);
  check('pause: state frozen', segOperator.physics.segOmega === frozen);
  frame(host, [1 / 60]);
  host.cancel();
  await settle(host); frame(host, []);
  check('cancel: in-flight result discarded', segOperator.physics.segOmega === frozen);

  // 5. ?wasmPhysics without a loadable sim_core (Node cannot fetch file:) ──
  host.unavailableReason(true);
  await until(() => host.unavailableReason(true) !== 'worker starting', 'wasm init reply', 30_000);
  check('wasm: falls back in-loop with a reason',
    host.unavailableReason(true) === 'sim_core unavailable in worker', host.unavailableReason(true));
  check('wasm: JS frames still use the worker', host.unavailableReason(false) === null);

  host.dispose();

  // 6. Packed snapshot round-trip ──────────────────────────────────────────
  const plant = { mode: 'hall', voltage: 0.125, current: 2, fieldT: 0.5, coeff: -1e-4, energyLevel: 0.25 };
  const rollers = new Float32Array([0.1, 2, 0.3, 0.4, 1.1, 2.5, 0.3, 0.4]);
  const packed = packModePlant(plant, true, WASM_DEVICE_IDS, rollers);
  const back = unpackModePlant(packed, WASM_DEVICE_IDS);
  check('pack: mode index round-trips', back?.mode === 'hall', back?.mode);
  check('pack: keys round-trip (float32-exact values)',
    ['voltage', 'current', 'fieldT', 'energyLevel'].every((k) => back?.[k] === plant[k])
      && Math.fround(plant.coeff) === back?.coeff);
  check('pack: absent keys stay absent', !('head' in back) && !('rpm' in back));
  check('pack: roller tail at stride 4',
    packed.length - PLANT_PACK_ROLLER_OFFSET === 8 && packed[PLANT_PACK_ROLLER_OFFSET + 5] === 2.5);
  check('pack: no mode plant → null', unpackModePlant(packModePlant(null, false, WASM_DEVICE_IDS, null), WASM_DEVICE_IDS) === null);
} catch (err) {
  failures.push(`threw: ${err?.stack || err}`);
} finally {
  await Promise.all(threads.map((t) => t.terminate()));
  rmSync(TMP, { recursive: true, force: true });
}

for (const label of ok) console.log(`  ✓ ${label}`);
if (failures.length) {
  for (const f of failures) console.error(`  ✗ ${f}`);
  console.error(`[plant-worker] ${failures.length} failure(s)`);
  process.exit(1);
}
console.log(`[plant-worker] OK — ${ok.length} checks`);
