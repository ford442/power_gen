/**
 * A headless live lab for Node tests: the real `LabSession`, every device
 * plant, the real window API (`src/bench-window-api.ts`) over a stub DOM, and
 * a frame loop in the WebGL2 backend's order —
 *
 *   session.stepPlant(dt, 1)   → cut batch, buses, operator, C++ focus plant
 *   stepJsDevicePlant(…)       → every simulated JS plant over that batch
 *   session.syncHardwareTwin   → the hardware twin, as the render loop does
 *   session.publishFrame(dt)   → TelemetryHub, then a live run's samples
 *
 * Used by tests/experiments-live.test.mjs and tests/twin-snapshot.test.mjs. Call once per
 * process: the app's singletons (segOperator, segWasm, TelemetryHub) are
 * module state, so a second backend needs its own process.
 *
 *   const lab = await bootLiveLab({ backend: 'js' | 'wasm', search: '?mockHardware=1' });
 *   lab.frame(1 / 60);
 *   await lab.driveUntil(promise, 1 / 60, 10_000);
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bundleTs, ROOT } from '../test-harness.mjs';
import { simCoreShim } from './sim-core-shim.mjs';

const WASM_DIR = join(ROOT, 'src/wasm/sim-core');
export const REF_DIR = join(ROOT, 'src/experiments/reference');

/**
 * `import.meta.glob` is Vite's; give the registry the reference files from disk.
 * Its output depends on files esbuild never reads, so they go in the cache key.
 */
function referenceGlob() {
  const files = readdirSync(REF_DIR).filter((f) => f.endsWith('.experiment.json')).sort();
  const hash = createHash('sha256');
  for (const f of files) hash.update(f).update('\0').update(readFileSync(join(REF_DIR, f))).update('\0');
  const plugin = {
    name: 'reference-glob',
    setup(build) {
      build.onLoad({ filter: /src[\\/]experiments[\\/]registry\.ts$/ }, () => {
        const src = readFileSync(join(ROOT, 'src/experiments/registry.ts'), 'utf8');
        const table = `{${files.map((f) => `${JSON.stringify(`./reference/${f}`)}: () => Promise.resolve(${readFileSync(join(REF_DIR, f), 'utf8')})`).join(',')}}`;
        const out = src.replace(/import\.meta\.glob\([^)]*\)/, table);
        if (out === src) throw new Error('registry.ts: import.meta.glob call not found');
        return { contents: out, loader: 'ts' };
      });
    }
  };
  // test-harness.mjs cache key (the harness strips it before esbuild sees the plugin).
  plugin.cacheKey = hash.digest('hex');
  return plugin;
}

/** Browser surface the session, the window API and the loaders touch. */
function installBrowserStubs(search) {
  const storage = new Map();
  const noop = () => {};
  const classList = { add: noop, remove: noop, toggle: noop, contains: () => false };
  globalThis.window = globalThis;
  globalThis.localStorage = {
    getItem: (k) => storage.get(k) ?? null,
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k)
  };
  globalThis.location = { search, hash: '', href: `http://localhost/${search}` };
  globalThis.history = { replaceState: noop };
  globalThis.document = {
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ style: {}, classList, setAttribute: noop, appendChild: noop, addEventListener: noop }),
    addEventListener: noop,
    body: { classList, appendChild: noop },
    documentElement: { classList, setAttribute: noop, removeAttribute: noop }
  };
  globalThis.addEventListener = noop;
  globalThis.fetch = async () => ({ ok: false, status: 404 });
}

export async function bootLiveLab({ backend = 'js', search = '' } = {}) {
  const query = backend === 'wasm'
    ? `?wasmPhysics=1&plantWorker=0${search ? `&${search.replace(/^\?/, '')}` : ''}`
    : search;
  installBrowserStubs(query);

  // The app logs its boot (WASM ready, bridge connected); keep test output readable.
  const say = console.log.bind(console);
  console.info = () => {};
  console.debug = () => {};
  console.log = () => {};
  const X = await bundleTs({
    contents: `
        import './src/devices/register-plugins';
        import './src/bench-window-api';
        export { LabSession } from './src/session/lab-session';
        export { runExperimentDetailed } from './src/experiments/run';
        export { referenceExperimentIds } from './src/experiments/registry';
        export { captureLabSnapshot, restoreLabSnapshot } from './src/session/lab-snapshot';
        export { createDevicePhysicsState } from './src/renderers/shared/device-physics';
        export { shouldSimulateDevice } from './src/renderers/shared/device-view';
        export { getAllSimDeviceIds } from './src/devices/device-registry';
        export { stepJsDevicePlant } from './src/session/apply-wasm-plant';
        export { TWIN_MODES, HardwareBridge } from './src/hardware-bridge';
        export { segOperator } from './src/seg-operator-state';
        export { segWasm } from './src/wasm/seg-physics-bridge';
        export { telemetryHub } from './src/telemetry-hub';
    `,
    sourcefile: 'live-lab-harness.ts'
  }, {
    plugins: [referenceGlob(), simCoreShim(WASM_DIR)]
  });

  if (backend === 'wasm') await X.segWasm.init();

  const session = new X.LabSession();
  session.rendererId = 'webgl2';
  for (const id of X.getAllSimDeviceIds()) {
    const physicsState = X.createDevicePhysicsState(id);
    // WebGL2 devices keep `.physics` as an alias of `physicsState`.
    session.devices[id] = { id, physicsState, physics: physicsState };
  }
  window.segOperator = X.segOperator;
  window.multiVisualizer = {
    session,
    get devices() { return session.devices; },
    get currentView() { return session.currentView; },
    get fieldNetwork() { return session.fieldNetwork; },
    get chargeNetwork() { return session.chargeNetwork; },
    get energyNetwork() { return session.energyNetwork; },
    onModeChange: (mode) => session.setMode(mode)
  };

  /** One frame, in the order WebGL2's `_stepSimulation` + `render` run it. */
  function frame(dt) {
    const batch = session.stepPlant(dt, 1, {});
    const focus = session.plantFocus();
    for (const device of Object.values(session.devices)) {
      if (!X.shouldSimulateDevice(session.currentView, session.devicesEnabled, device.id, null, null)) continue;
      const phys = device.physicsState;
      if (device.id === 'seg') {
        phys.segOmega = X.segOperator.physics.segOmega;
        phys.corona = X.segOperator.physics.corona;
        phys.energyLevel = X.segOperator.physics.segOmega;
      } else {
        X.stepJsDevicePlant(device.id, phys, focus, batch, {});
      }
    }
    session.syncHardwareTwin(dt);
    session.publishFrame(dt, 0);
  }

  /**
   * Drive frames while a live experiment holds the session clock, until
   * `promise` settles; the runner's own awaits settle between frames.
   */
  async function driveUntil(promise, dt, maxFrames) {
    let state = 'pending';
    let value;
    promise.then((v) => { state = 'ok'; value = v; }, (e) => { state = 'err'; value = e; });
    let frames = 0;
    while (state === 'pending') {
      if (frames >= maxFrames) throw new Error(`still running after ${maxFrames} frames`);
      for (let i = 0; i < 4; i++) await Promise.resolve();
      await new Promise((r) => setImmediate(r));
      if (state !== 'pending') break;
      if (session.experimentClock) {
        frame(dt);
        frames++;
      }
    }
    if (state === 'err') throw value;
    return { value, frames };
  }

  return { X, session, frame, driveUntil, say };
}
