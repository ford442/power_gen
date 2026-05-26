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

// The WASM JS-glue is served as a static asset from public/wasm/.
// The path is relative to the Vite root (src/) so Vite serves it at /wasm/sim_core.js.
const WASM_JS_URL   = '/wasm/sim_core.js';
const WASM_WASM_URL = '/wasm/sim_core.wasm';

let _module: SimCoreModule | null = null;
let _loading: Promise<SimCoreModule | null> | null = null;

/**
 * Load and initialise the sim_core WASM module.
 *
 * The function is idempotent – subsequent calls return the cached module.
 * Returns `null` (with a console warning) if the WASM artefacts have not
 * been built yet or cannot be fetched (e.g. during development before
 * running `make wasm` / the CI pipeline has produced them).
 */
export async function loadSimCore(): Promise<SimCoreModule | null> {
  if (_module) return _module;
  if (_loading) return _loading;

  _loading = (async () => {
    // 1. Check that the WASM binary is reachable before injecting the script.
    try {
      const probe = await fetch(WASM_WASM_URL, { method: 'HEAD' });
      if (!probe.ok) {
        console.info(
          '[sim_core] WASM artefacts not found at', WASM_WASM_URL,
          '– run `make wasm` in cpp/ to build them.',
          'Falling back to JS-only physics.'
        );
        return null;
      }
    } catch {
      console.info(
        '[sim_core] Could not reach WASM binary – falling back to JS-only physics.'
      );
      return null;
    }

    // 2. Dynamically inject the Emscripten JS glue as a module script.
    //    Emscripten's MODULARIZE=1 output exports a factory function under
    //    the name specified by EXPORT_NAME (SimCore).
    await injectScript(WASM_JS_URL);

    // 3. The glue attaches the factory to globalThis.SimCore.
    const factory = (globalThis as unknown as Record<string, unknown>)['SimCore'] as
      SimCoreFactory | undefined;

    if (typeof factory !== 'function') {
      console.error('[sim_core] SimCore factory not found after script injection.');
      return null;
    }

    // 4. Instantiate the module, pointing Emscripten at the correct .wasm URL.
    try {
      _module = await factory({ locateFile: () => WASM_WASM_URL });
      console.info('[sim_core] WASM module loaded –', _module.sim_core_version());
      return _module;
    } catch (err) {
      console.error('[sim_core] Failed to instantiate WASM module:', err);
      return null;
    }
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

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function injectScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Avoid double-injection
    if (document.querySelector(`script[src="${src}"]`)) {
      resolve();
      return;
    }
    const s = document.createElement('script');
    s.type  = 'module';   // Emscripten -s ENVIRONMENT=web output is an ES module
    s.src   = src;
    s.onload  = () => resolve();
    s.onerror = () => reject(new Error(`[sim_core] Failed to load script: ${src}`));
    document.head.appendChild(s);
  });
}
