// =============================================================
// seg-physics-bridge.js  –  Drop-in bridge for C++ WASM physics
//
// Enable: ?wasmPhysics=1  or  localStorage useWasmPhysics=true
// =============================================================

import { SEGSim } from './sim.ts';

let _instance = null;
let _enabled = false;
/** Last zero-copy roller view used as a live metric */
let _lastRollerMeanOmega = 0;

function isWasmEnabled() {
  if (typeof window === 'undefined') return false;
  const params = new URLSearchParams(window.location.search);
  if (params.get('wasmPhysics') === '1') return true;
  if (params.get('wasm') === '1') return true;
  return localStorage.getItem('useWasmPhysics') === 'true';
}

const MODE_MAP = { seg: 0, heron: 1, kelvin: 2, solar: 3 };

export const segWasm = {
  get available() {
    return _instance?.wasmAvailable ?? false;
  },

  get enabled() {
    return _enabled && this.available;
  },

  /** Live metric from zero-copy roller buffer (mean |ω|) */
  get lastRollerMeanOmega() {
    return _lastRollerMeanOmega;
  },

  async init() {
    if (_instance) return _instance;
    _enabled = isWasmEnabled();
    try {
      _instance = await SEGSim.create();
      if (_instance.wasmAvailable) {
        console.log('[seg-physics-bridge] C++ WASM physics ready (v1.1 multi-mode + zero-copy)');
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
   * Step plant for current mode. Uses setDrive + step.
   * Updates zero-copy roller metric when in SEG mode.
   */
  step(dt, loadTorque = 0.01, drive = 0.5) {
    if (!this.enabled || !_instance) {
      return { omega: 0, rpm: 0, powerW: 0, energyDensityJm3: 0, simTimeS: 0, wasm: false };
    }
    _instance.setDrive?.(drive);
    const res = _instance.step(dt, loadTorque);
    // Zero-copy live metric: mean omega from packed roller buffer
    const rollers = _instance.getRollerStateFloatView?.();
    if (rollers && rollers.length >= 4) {
      let s = 0;
      const n = rollers.length / 4;
      for (let i = 0; i < n; i++) s += Math.abs(rollers[i * 4 + 1]);
      _lastRollerMeanOmega = s / n;
    } else {
      _lastRollerMeanOmega = Math.abs(res.omega || 0);
    }
    return { ...res, wasm: true, meanOmega: _lastRollerMeanOmega };
  },

  async getRollerState(loadTorque = 0.01) {
    return this.step(1 / 60, loadTorque, 0.5);
  },

  async runBenchmark(steps = 2000, loadTorque = 0.01) {
    if (!this.enabled || !_instance) {
      return {
        stepsPerSecond: 0,
        durationMs: 0,
        finalOmega: 0,
        finalRPM: 0,
        wasmAvailable: false
      };
    }
    return _instance.benchmark(steps, loadTorque);
  },

  async runJsVsWasmBenchmark(steps = 2000) {
    if (!_instance) await this.init();
    if (!_instance) {
      return {
        wasmStepsPerSecond: 0,
        jsStepsPerSecond: 0,
        ratio: 0,
        wasmAvailable: false,
        durationMs: 0
      };
    }
    return _instance.benchmarkJsVsWasm(steps);
  },

  setEnabled(enabled) {
    _enabled = !!enabled;
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('useWasmPhysics', _enabled ? 'true' : 'false');
    }
    console.log(`[seg-physics-bridge] WASM physics ${_enabled ? 'ENABLED' : 'disabled'}`);
  },

  async getVersion() {
    if (!_instance) await this.init();
    return _instance ? SEGSim.getVersion() : 'WASM not available';
  },

  dispose() {
    _instance?.dispose();
    _instance = null;
  },

  setRingLoadTorque(ring, torque) {
    _instance?.setRingLoadTorque?.(ring, torque);
  },

  setRingLoadTorques(t0, t1, t2) {
    _instance?.setRingLoadTorques?.(t0, t1, t2);
  },

  async stepWithPerRingTorques(dt = 1 / 60) {
    if (!this.enabled || !_instance) {
      return { omega: 0, rpm: 0, powerW: 0, energyDensityJm3: 0, simTimeS: 0, wasm: false };
    }
    const res = _instance.stepWithPerRingTorques(dt);
    return { ...res, wasm: true };
  },

  setMode(mode) {
    const m = typeof mode === 'string' ? (MODE_MAP[mode] ?? 0) : mode;
    _instance?.setMode?.(m);
  },

  getMode() {
    return _instance?.getMode?.() ?? 0;
  },

  setDrive(drive) {
    _instance?.setDrive?.(drive);
  },

  getModePlant() {
    return _instance?.getModePlant?.() ?? null;
  },

  getParticles(maxCount = -1) {
    if (!this.enabled || !_instance) return [];
    return _instance.getParticles(maxCount) || [];
  },

  /** Zero-copy particle Float32Array (or null) */
  getParticleFloatView() {
    if (!this.enabled || !_instance) return null;
    return _instance.getParticleFloatView?.() ?? null;
  },

  getRollerStateFloatView() {
    if (!this.enabled || !_instance) return null;
    return _instance.getRollerStateFloatView?.() ?? null;
  },

  meanParticleRadius(sample = 256) {
    if (!this.enabled || !_instance) return 0;
    return _instance.meanParticleRadius?.(sample) ?? 0;
  },

  seedParticles(count) {
    _instance?.seedParticles?.(count);
  },

  stepParticles(dt) {
    _instance?.stepParticles?.(dt);
  }
};

if (typeof window !== 'undefined') {
  segWasm.init().catch(() => {});
  window.segWasm = segWasm;
}

export default segWasm;
