/**
 * plant-worker — LabSession plant worker contract (no browser).
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
 *   7. Snapshot `plantSave` / `plantLoad` calls reply by id, around a batch
 *      in flight (the C++ round trip itself is snapshots.test.mjs).
 *
 * Golden JS ⇄ C++ parity stays in tests/golden.test.mjs (in-process, native).
 *
 * Usage: npm run test:plant-worker   (node --test scripts/tests/plant-worker.test.mjs)
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { Worker as ThreadWorker } from 'node:worker_threads';
import { bundleTs, bundleTsFile } from '../test-harness.mjs';

// `scientific-data.ts` pulls generated WGSL constants via Vite `?raw`; the
// plant never reads that text, and the harness stubs it.

const HOST_ENTRY = `
  export { PlantWorkerHost } from './src/session/plant-worker-host';
  export { segOperator, SEGOperatorState } from './src/seg-operator-state';
  export { packModePlant, unpackModePlant, PLANT_PACK_ROLLER_OFFSET } from './src/session/plant-worker-protocol';
  export { WASM_DEVICE_IDS } from './generated/device-catalog';
  export { workerSavePlantState, workerLoadPlantState } from './src/session/plant-worker-snapshot';
`;

let TMP;
const threads = [];
let PlantWorkerHost, segOperator, SEGOperatorState, packModePlant, unpackModePlant;
let PLANT_PACK_ROLLER_OFFSET, WASM_DEVICE_IDS, workerSavePlantState, workerLoadPlantState;

before(async () => {
  TMP = mkdtempSync(join(tmpdir(), 'plant-worker-'));
  // ── Worker thread: the production entry, with `self` shimmed onto parentPort ──
  const workerBundle = await bundleTsFile('src/workers/plant-worker.ts');
  const bootstrap = join(TMP, 'bootstrap.mjs');
  writeFileSync(bootstrap, `
import { parentPort } from 'node:worker_threads';
globalThis.self = globalThis;
globalThis.postMessage = (msg, transfer) => parentPort.postMessage(msg, transfer);
// A browser Worker queues messages until its script has run; without this the
// host's 'init' can land before the bundle sets onmessage (seen on Node 20).
const queued = [];
let deliver = (data) => queued.push(data);
parentPort.on('message', (data) => deliver(data));
console.info = () => {};
console.log = () => {};
await import(${JSON.stringify(pathToFileURL(workerBundle).href)});
deliver = (data) => globalThis.onmessage?.({ data });
for (const data of queued.splice(0)) deliver(data);
`);

  /** Browser `Worker` facade over worker_threads for the host. */
  globalThis.Worker = class {
    constructor() {
      this.onmessage = null;
      this.onerror = null;
      this._listeners = new Set();
      this._t = new ThreadWorker(bootstrap);
      this._t.on('message', (data) => {
        this.onmessage?.({ data });
        for (const fn of this._listeners) fn({ data });
      });
      this._t.on('error', (err) => this.onerror?.({ message: err.message }));
      threads.push(this._t);
    }
    postMessage(msg, transfer) { this._t.postMessage(msg, transfer); }
    addEventListener(type, fn) { if (type === 'message') this._listeners.add(fn); }
    removeEventListener(type, fn) { this._listeners.delete(fn); }
    terminate() { this._t.terminate(); }
  };

  ({
    PlantWorkerHost, segOperator, SEGOperatorState, packModePlant, unpackModePlant,
    PLANT_PACK_ROLLER_OFFSET, WASM_DEVICE_IDS, workerSavePlantState, workerLoadPlantState
  } = await bundleTs({ contents: HOST_ENTRY, sourcefile: 'plant-worker-host-harness.ts' }));
});

after(async () => {
  await Promise.all(threads.map((t) => t.terminate()));
  if (TMP) rmSync(TMP, { recursive: true, force: true });
});

// ── helpers ──────────────────────────────────────────────────────────────
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

// Sequential: every `it` drives the same host and the same reference operator.
describe('plant worker host', () => {
  let host, ref;

  it('host created with Worker present', async () => {
    host = PlantWorkerHost.create();
    assert.ok(!!host, 'host created with Worker present');
    await until(() => host.unavailableReason(false) === null, 'worker ready');
    ref = new SEGOperatorState();
  });

  it('JS plant parity + one-frame latency', async () => {
    resetBoth(ref);
    segOperator.start(); ref.start();
    segOperator.targetDrive = ref.targetDrive = 0.7;
    frame(host, [SCHEDULE[0]]);
    assert.ok(segOperator.physics.segOmega === 0, 'latency: first frame leaves state untouched');
    ref.step(SCHEDULE[0]);
    await settle(host);
    for (let i = 1; i < SCHEDULE.length; i++) {
      frame(host, [SCHEDULE[i]]);
      ref.step(SCHEDULE[i]);
      await settle(host);
    }
    frame(host, []);
    assert.ok(segOperator.physics.segOmega === ref.physics.segOmega && ref.physics.segOmega > 0,
      `parity: segOmega bit-identical after 240 worker frames: ${segOperator.physics.segOmega} vs ${ref.physics.segOmega}`);
    assert.ok(segOperator.physics.corona === ref.physics.corona, 'parity: corona');
    assert.ok(segOperator.status === ref.status, `parity: status: ${segOperator.status} vs ${ref.status}`);
  });

  it('substeps queue behind an in-flight batch; no sim time lost', async () => {
    resetBoth(ref);
    segOperator.start(); ref.start();
    const burst = [1 / 60, 1 / 50, 1 / 45];
    for (const dt of burst) { frame(host, [dt]); ref.step(dt); }
    assert.ok(host.stats().pendingSteps === 2,
      `queue: later substeps wait for the in-flight batch: pending=${host.stats().pendingSteps}`);
    await settle(host); frame(host, []);
    await settle(host); frame(host, []);
    assert.ok(segOperator.physics.segOmega === ref.physics.segOmega,
      `queue: no sim time lost: ${segOperator.physics.segOmega} vs ${ref.physics.segOmega}`);
  });

  it('an operator action while in flight wins (epoch)', async () => {
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
    assert.ok(host.stats().droppedResults === droppedBefore + 1, 'epoch: stale result dropped');
    assert.ok(segOperator.status === 'stopping' && !segOperator.isRunning,
      `epoch: STOP survives the in-flight batch: ${segOperator.status}`);
    assert.ok(segOperator.physics.segOmega === ref.physics.segOmega,
      `epoch: re-queued substep ran from the stopped state: ${segOperator.physics.segOmega} vs ${ref.physics.segOmega}`);
  });

  it('pause posts nothing; cancel discards the in-flight batch', async () => {
    const frozen = segOperator.physics.segOmega;
    frame(host, [0]);
    assert.ok(!host.inFlight, 'pause: dt = 0 posts nothing');
    await tick(); frame(host, [0]);
    assert.ok(segOperator.physics.segOmega === frozen, 'pause: state frozen');
    frame(host, [1 / 60]);
    host.cancel();
    await settle(host); frame(host, []);
    assert.ok(segOperator.physics.segOmega === frozen, 'cancel: in-flight result discarded');
  });

  it('?wasmPhysics without a loadable sim_core falls back with a reason', async () => {
    // Node cannot fetch file:, so sim_core never loads in the worker.
    host.unavailableReason(true);
    await until(() => host.unavailableReason(true) !== 'worker starting', 'wasm init reply', 30_000);
    assert.ok(host.unavailableReason(true) === 'sim_core unavailable in worker',
      `wasm: falls back in-loop with a reason: ${host.unavailableReason(true)}`);
    assert.ok(host.unavailableReason(false) === null, 'wasm: JS frames still use the worker');
  });

  // Snapshot calls (#224 §2). No sim_core here, so the host hands out no
  // port; forcing one runs the worker's plantSave / plantLoad replies,
  // which must route by call id around a step batch the host ignores.
  it('snapshot calls reply by id around a batch in flight', async () => {
    assert.ok(host.snapshotPort() === null, 'snapshot: no sim_core → no snapshot port');
    host.wasmAvailable = true;
    const port = host.snapshotPort();
    const before = segOperator.physics.segOmega;
    const droppedPrior = host.stats().droppedResults;
    segOperator.start();
    frame(host, [1 / 60]);
    const t0 = Date.now();
    const [saved, loaded] = await Promise.all([
      workerSavePlantState(port, 1),
      workerLoadPlantState(port, 1, [0, 0], 0)
    ]);
    // A missing reply would also resolve null — but only after the 5 s timeout.
    const ms = Date.now() - t0;
    assert.ok(ms < 4000, `snapshot: the worker answered (not the call timeout): ${ms} ms`);
    assert.ok(saved === null, 'snapshot: worker plantSave reply routed by id (null: no plant)');
    assert.ok(loaded === false, 'snapshot: worker plantLoad reply routed by id (false: refused)');
    await settle(host); frame(host, []);
    assert.ok(segOperator.physics.segOmega > before && host.stats().droppedResults === droppedPrior,
      `snapshot: a call does not disturb the batch in flight: ${segOperator.physics.segOmega} vs ${before}`);
    host.wasmAvailable = false;

    host.dispose();
    assert.ok(host.snapshotPort() === null, 'snapshot: no port after dispose');
  });
});

describe('packed plant snapshot', () => {
  const plant = { mode: 'hall', voltage: 0.125, current: 2, fieldT: 0.5, coeff: -1e-4, energyLevel: 0.25 };
  const rollers = new Float32Array([0.1, 2, 0.3, 0.4, 1.1, 2.5, 0.3, 0.4]);
  let packed, back;
  before(() => {
    packed = packModePlant(plant, true, WASM_DEVICE_IDS, rollers);
    back = unpackModePlant(packed, WASM_DEVICE_IDS);
  });

  it('pack: mode index round-trips', () => {
    assert.ok(back?.mode === 'hall', `pack: mode index round-trips: ${back?.mode}`);
  });
  it('pack: keys round-trip (float32-exact values)', () => {
    assert.ok(['voltage', 'current', 'fieldT', 'energyLevel'].every((k) => back?.[k] === plant[k])
      && Math.fround(plant.coeff) === back?.coeff, 'pack: keys round-trip (float32-exact values)');
  });
  it('pack: absent keys stay absent', () => {
    assert.ok(!('head' in back) && !('rpm' in back), 'pack: absent keys stay absent');
  });
  it('pack: roller tail at stride 4', () => {
    assert.ok(packed.length - PLANT_PACK_ROLLER_OFFSET === 8 && packed[PLANT_PACK_ROLLER_OFFSET + 5] === 2.5,
      'pack: roller tail at stride 4');
  });
  it('pack: no mode plant → null', () => {
    assert.ok(unpackModePlant(packModePlant(null, false, WASM_DEVICE_IDS, null), WASM_DEVICE_IDS) === null,
      'pack: no mode plant → null');
  });
});
