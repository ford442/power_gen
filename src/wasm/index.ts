// =============================================================
// index.ts  –  async loader for the sim_core WASM module
//
// Usage:
//   import { loadSimCore } from './wasm/index';
//   const mod = await loadSimCore();       // null if WASM unavailable
//   if (mod) {
//     const sim = new mod.SEGSimulator();
//     sim.step(1/60, 0.01);
//     console.log(sim.getRPM());
//     sim.delete();
//   }
// =============================================================

import type { SimCoreModule, SimCoreFactory } from './types';

// Built by `make -C cpp wasm` into ./sim-core/ (see its README). Vite emits the
// .wasm under a content-hashed name for this `new URL(…, import.meta.url)`
// pattern and bundles the ES-module glue as its own lazy chunk, so the page and
// every module worker load it with a plain `import()` — no `<script>`,
// `importScripts` or `new Function`, and a rebuilt plant busts the HTTP cache.
const WASM_WASM_URL = new URL('./sim-core/sim_core.wasm', import.meta.url).href;

/** Site-build hash of the C++ sources (vite.config.js); unset in Node harnesses. */
declare const __SIM_CORE_SOURCE_HASH__: string | undefined;
const EXPECTED_SOURCE_HASH: string | null =
  typeof __SIM_CORE_SOURCE_HASH__ === 'string' ? __SIM_CORE_SOURCE_HASH__ : null;

let _module: SimCoreModule | null = null;
let _loading: Promise<SimCoreModule | null> | null = null;

export interface SimCoreStatus {
  state: 'idle' | 'loading' | 'ready' | 'failed';
  /** Human-readable failure reason (set when `state === 'failed'`). */
  error: string | null;
  /**
   * Set when the loaded binary was built from different sources than this site
   * build (`sim_core_source_hash()` ≠ `__SIM_CORE_SOURCE_HASH__`) — e.g. Pages
   * deployed before CI committed the rebuild. The module still runs.
   */
  stale?: string | null;
}
let _status: SimCoreStatus = { state: 'idle', error: null };

/** Non-null when `mod` was built from other sources than this site build. */
export function staleBinaryReason(mod: Pick<SimCoreModule, 'sim_core_source_hash'>, expected = EXPECTED_SOURCE_HASH): string | null {
  if (!expected) return null;
  const got = typeof mod.sim_core_source_hash === 'function' ? mod.sim_core_source_hash() : 'none (pre-hash binary)';
  return got === expected ? null : `sim_core.wasm built from sources ${got}, site expects ${expected} — stale binary`;
}

/** Real load result: 'ready' only after the factory resolved (i.e. `WebAssembly.instantiate` succeeded). */
export function getSimCoreStatus(): SimCoreStatus {
  return _status;
}

function fail(msg: string): null {
  _status = { state: 'failed', error: msg };
  return null;
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Load and initialise the sim_core WASM module.
 *
 * The function is idempotent – subsequent calls return the cached module.
 * Returns `null` (with a console message) if the glue or the binary cannot be
 * loaded or instantiated; callers fall back to the JS plants.
 */
export async function loadSimCore(): Promise<SimCoreModule | null> {
  if (_module) return _module;
  if (_loading) return _loading;

  _status = { state: 'loading', error: null };
  _loading = (async () => {
    let factory: SimCoreFactory;
    try {
      factory = (await import('./sim-core/sim_core.js')).default;
    } catch (err) {
      console.info('[sim_core] sim_core.js glue failed to load – falling back to JS-only physics.', err);
      return fail(`sim_core.js glue failed to load: ${errText(err)}`);
    }
    if (typeof factory !== 'function') return fail('sim_core.js has no default-exported factory');

    try {
      _module = await factory({ locateFile: () => WASM_WASM_URL });
    } catch (err) {
      console.error('[sim_core] Failed to instantiate WASM module:', err);
      return fail(`Instantiate failed: ${errText(err)}`);
    }
    const stale = staleBinaryReason(_module);
    if (stale) console.warn(`[sim_core] ${stale}`);
    console.info('[sim_core] WASM module loaded –', _module.sim_core_version());
    _status = { state: 'ready', error: null, stale };
    return _module;
  })();

  return _loading;
}

/** Return the cached module (null if not yet loaded or unavailable). */
export function getSimCore(): SimCoreModule | null {
  return _module;
}

/** True once the module has been successfully initialised. */
export function isSimCoreReady(): boolean {
  return _module !== null;
}
