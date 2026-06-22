// =============================================================
// seg-physics-bridge.js  –  Drop-in bridge for C++ WASM SEG physics
// 
// Provides the exact metrics your dashboard already displays:
// rpm, omega, powerW, energyDensityJm3, stepsPerSecond, finalRPM
//
// Usage:
//   import { segWasm } from './wasm/seg-physics-bridge.js';
//   
//   await segWasm.init();
//   const state = await segWasm.getRollerState(0.01);
//   const bench = await segWasm.runBenchmark(2000);
// =============================================================

import { SEGSim } from './sim.ts';

let _instance = null;
let _enabled = false;

function isWasmEnabled() {
  if (typeof window === 'undefined') return false;
  const params = new URLSearchParams(window.location.search);
  if (params.get('wasmPhysics') === '1') return true;
  if (params.get('wasm') === '1') return true;
  return localStorage.getItem('useWasmPhysics') === 'true';
}

export const segWasm = {
  /** Whether the C++ WASM physics engine is available and enabled */
  get available() {
    return _instance?.wasmAvailable ?? false;
  },

  /** Current enabled state (respects ?wasmPhysics=1 and localStorage) */
  get enabled() {
    return _enabled && this.available;
  },

  /**
   * Initialize (or re-initialize) the SEGSim WASM instance.
   * Call once at app startup or when toggling.
   */
  async init() {
    if (_instance) return _instance;

    _enabled = isWasmEnabled();

    try {
      _instance = await SEGSim.create();
      if (_instance.wasmAvailable) {
        console.log('[seg-physics-bridge] C++ WASM physics ready (RK4)');
      } else {
        console.log('[seg-physics-bridge] WASM not built — using JS fallback');
      }
    } catch (err) {
      console.warn('[seg-physics-bridge] Failed to load SEGSim WASM:', err);
      _instance = null;
    }
    return _instance;
  },

  /**
   * Advance rollers + return the metrics your dashboard already shows.
   * @param {number} loadTorque - braking torque (N·m, scene scaled)
   */
  async getRollerState(loadTorque = 0.01) {
    if (!this.enabled) {
      return { omega: 0, rpm: 0, powerW: 0, energyDensityJm3: 0, simTimeS: 0, wasm: false };
    }
    const res = _instance.step(1 / 60, loadTorque);
    return { ...res, wasm: true };
  },

  /**
   * Run a benchmark using the exact same path as your live metrics.
   * Perfect for the debug / scientific panel.
   */
  async runBenchmark(steps = 2000, loadTorque = 0.01) {
    if (!this.enabled || !_instance) {
      return {
        stepsPerSecond: 0,
        durationMs: 0,
        finalOmega: 0,
        finalRPM: 0,
        wasmAvailable: false,
      };
    }
    return _instance.benchmark(steps, loadTorque);
  },

  /** Enable/disable at runtime (also persists to localStorage) */
  setEnabled(enabled) {
    _enabled = !!enabled;
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('useWasmPhysics', _enabled ? 'true' : 'false');
    }
    console.log(`[seg-physics-bridge] WASM physics ${_enabled ? 'ENABLED' : 'disabled'}`);
  },

  /** Quick helper for version display */
  async getVersion() {
    if (!_instance) await this.init();
    return _instance ? SEGSim.getVersion() : 'WASM not available';
  },

  /** Dispose when unloading */
  dispose() {
    _instance?.dispose();
    _instance = null;
  },

  // ── Thin wrappers for new C++ expansions (safe when unavailable) ──

  setRingLoadTorque(ring, torque) {
    _instance?.setRingLoadTorque?.(ring, torque);
  },

  setRingLoadTorques(t0, t1, t2) {
    _instance?.setRingLoadTorques?.(t0, t1, t2);
  },

  /**
   * Step rollers using the per-ring torques (if previously set).
   * Returns the same metric shape as getRollerState().
   */
  async stepWithPerRingTorques(dt = 1 / 60) {
    if (!this.enabled || !_instance) {
      return { omega: 0, rpm: 0, powerW: 0, energyDensityJm3: 0, simTimeS: 0, wasm: false };
    }
    if (typeof _instance.stepWithPerRingTorques === 'function') {
      const res = _instance.stepWithPerRingTorques(dt);
      return { ...res, wasm: true };
    }
    // Fallback to global-0 path
    const res = _instance.step(dt, 0);
    return { ...res, wasm: true };
  },

  setMode(mode) {
    _instance?.setMode?.(mode);
  },

  getMode() {
    return _instance?.getMode?.() ?? 0;
  },

  /**
   * Bulk particle array (or subset). Returns [] when unavailable.
   */
  getParticles(maxCount = -1) {
    if (!this.enabled || !_instance) return [];
    if (typeof _instance.getParticles === 'function') {
      return _instance.getParticles(maxCount) || [];
    }
    return [];
  }
};

// Auto-init on import (non-blocking)
if (typeof window !== 'undefined') {
  segWasm.init().catch(() => {});
}

export default segWasm;