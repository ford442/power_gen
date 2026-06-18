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

// Served from src/public/wasm/ → dist/wasm/ at build time.
// Use import.meta.url so bundled paths resolve correctly on GitHub Pages subpaths.
const WASM_JS_URL   = new URL('../public/wasm/sim_core.js', import.meta.url).href;
const WASM_WASM_URL = new URL('../public/wasm/sim_core.wasm', import.meta.url).href;

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

    // 2. Load Emscripten MODULARIZE factory via dynamic import (works in Vite bundles
    //    and avoids classic-script global leakage issues on GitHub Pages).
    const factory = await loadSimCoreFactory();
    if (!factory) {
      console.info('[sim_core] SimCore factory not found – WASM benchmark unavailable.');
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

async function loadSimCoreFactory(): Promise<SimCoreFactory | null> {
  try {
    const mod = await import(/* @vite-ignore */ WASM_JS_URL);
    const factory = (mod as { default?: SimCoreFactory }).default
      ?? (mod as { SimCore?: SimCoreFactory }).SimCore
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ?? (globalThis as any)['SimCore'] as SimCoreFactory | undefined;
    return typeof factory === 'function' ? factory : null;
  } catch {
    return null;
  }
}
