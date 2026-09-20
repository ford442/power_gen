// =============================================================
// seg-physics-bridge.ts  –  Drop-in bridge for C++ WASM physics
//
// Enable: ?wasmPhysics=1  or  localStorage useWasmPhysics=true
// =============================================================

import {
  SEGSim,
  type SEGBenchmarkResult,
  type JsVsWasmBenchmark,
  type SEGNetworkEdgeInput,
  type SEGNetworkSummary,
  type SEGNetworkUpdateInput,
  type SEGDevicePower,
  type SEGStepResult
} from './sim';
import { wasmModeForDevice } from '../../generated/device-catalog';

let _instance: SEGSim | null = null;
let _enabled = false;
/** Last zero-copy roller view used as a live metric */
let _lastRollerMeanOmega = 0;

function isWasmEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  const params = new URLSearchParams(window.location.search);
  if (params.get('wasmPhysics') === '1') return true;
  if (params.get('wasm') === '1') return true;
  return localStorage.getItem('useWasmPhysics') === 'true';
}

export interface SegWasmStepResult extends SEGStepResult {
  wasm: boolean;
  meanOmega?: number;
}

export interface SegWasmBridge {
  readonly available: boolean;
  readonly enabled: boolean;
  readonly lastRollerMeanOmega: number;

  init(): Promise<SEGSim | null>;
  dispose(): void;
  setEnabled(enabled: boolean): void;
  getVersion(): Promise<string>;

  step(dt: number, loadTorque?: number, drive?: number): SegWasmStepResult | SEGStepResult;
  getRollerState(loadTorque?: number): Promise<SegWasmStepResult | SEGStepResult>;
  runBenchmark(steps?: number, loadTorque?: number): Promise<SEGBenchmarkResult>;
  runJsVsWasmBenchmark(steps?: number): Promise<JsVsWasmBenchmark>;

  setRingLoadTorque(ring: number, torque: number): void;
  setRingLoadTorques(t0: number, t1: number, t2: number): void;
  stepWithPerRingTorques(dt?: number): Promise<SegWasmStepResult | SEGStepResult>;

  setMode(deviceId: string): void;
  getMode(): number;
  setDrive(drive: number): void;
  setTransformerLeakage(enabled: boolean): void;
  setHallCarrierMetal(metal: boolean): void;
  setHallFieldCoupledT(fieldT: number): boolean;
  setLorentzFieldT(fieldT: number): void;
  getModePlant(): unknown;

  getParticles(maxCount?: number): unknown[];
  getParticleFloatView(): Float32Array | null;
  getRollerStateFloatView(): Float32Array | null;
  meanParticleRadius(sample?: number): number;
  seedParticles(count: number): void;
  stepParticles(dt: number): void;

  setNetworkEdges(edges: SEGNetworkEdgeInput[] | null | undefined): void;
  updateEnergyNetwork(opts: {
    couplingEnabled?: boolean;
    segPowerW?: number;
    segEfficiencyPct?: number;
    energyByDevice?: Record<string, number>;
    enabledByDevice?: Record<string, boolean>;
  }): SEGNetworkSummary;
  getNetworkSummary(): SEGNetworkSummary;
  getNetworkEdgeAllocatedW(edgeIndex: number): number;
  getNetworkDevicePower(deviceId: string): SEGDevicePower;
}

const idleStep = (): SegWasmStepResult => ({
  omega: 0,
  rpm: 0,
  powerW: 0,
  energyDensityJm3: 0,
  simTimeS: 0,
  wasm: false
});

export const segWasm: SegWasmBridge = {
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
  step(dt: number, loadTorque = 0.01, drive = 0.5) {
    if (!this.enabled || !_instance) {
      return idleStep();
    }
    _instance.setDrive?.(drive);
    const res = _instance.step(dt, loadTorque);
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

  setEnabled(enabled: boolean) {
    _enabled = !!enabled;
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('useWasmPhysics', _enabled ? 'true' : 'false');
    }
    console.log(`[seg-physics-bridge] WASM physics ${_enabled ? 'ENABLED' : 'disabled'}`);
  },

  async getVersion() {
    if (!_instance) await this.init();
    return _instance ? await SEGSim.getVersion() : 'WASM not available';
  },

  dispose() {
    _instance?.dispose();
    _instance = null;
  },

  setRingLoadTorque(ring: number, torque: number) {
    _instance?.setRingLoadTorque?.(ring, torque);
  },

  setRingLoadTorques(t0: number, t1: number, t2: number) {
    _instance?.setRingLoadTorques?.(t0, t1, t2);
  },

  async stepWithPerRingTorques(dt = 1 / 60) {
    if (!this.enabled || !_instance) {
      return idleStep();
    }
    const res = _instance.stepWithPerRingTorques(dt);
    return { ...res, wasm: true };
  },

  setMode(deviceId: string) {
    const m = wasmModeForDevice(deviceId);
    if (m == null) return;
    _instance?.setMode?.(m);
  },

  getMode() {
    return _instance?.getMode?.() ?? 0;
  },

  setDrive(drive: number) {
    _instance?.setDrive?.(drive);
  },

  setTransformerLeakage(enabled: boolean) {
    _instance?.setTransformerLeakage?.(!!enabled);
  },

  setLorentzFieldT(fieldT: number) {
    _instance?.setLorentzFieldT?.(Number(fieldT) || 0);
  },

  setHallCarrierMetal(metal: boolean) {
    _instance?.setHallCarrierMetal?.(!!metal);
  },

  /**
   * Lab field coupling (ADR-0011). Pass a negative T to clear the coupling.
   *
   * Returns whether the loaded binary actually took the setpoint. `src/public/
   * wasm/sim_core.wasm` is a CI artefact committed on main, so a checkout can
   * run a binary older than this knob; callers use the result to hand the frame
   * back to the JS plant rather than report a coupled B the C++ plant ignored.
   */
  setHallFieldCoupledT(fieldT: number): boolean {
    // SEGSim reports whether the *embind* object carries the knob — checking
    // `_instance` here would only confirm our own TS wrapper has the method.
    const t = Number(fieldT);
    return _instance?.setHallFieldCoupledT(Number.isFinite(t) ? t : -1) ?? false;
  },

  getModePlant() {
    return _instance?.getModePlant?.() ?? null;
  },

  getParticles(maxCount = -1) {
    if (!this.enabled || !_instance) return [];
    return _instance.getParticles(maxCount) || [];
  },

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

  seedParticles(count: number) {
    _instance?.seedParticles?.(count);
  },

  stepParticles(dt: number) {
    _instance?.stepParticles?.(dt);
  },

  setNetworkEdges(edges: SEGNetworkEdgeInput[] | null | undefined) {
    _instance?.setNetworkEdges?.(edges ?? []);
  },

  updateEnergyNetwork({
    couplingEnabled,
    segPowerW,
    segEfficiencyPct,
    energyByDevice,
    enabledByDevice
  }: {
    couplingEnabled?: boolean;
    segPowerW?: number;
    segEfficiencyPct?: number;
    energyByDevice?: Record<string, number>;
    enabledByDevice?: Record<string, boolean>;
  }) {
    if (!this.enabled || !_instance) {
      return { couplingEnabled: false, labBudgetW: 0, totalAllocatedW: 0, residualW: 0 };
    }
    const input: SEGNetworkUpdateInput = {
      couplingEnabled: !!couplingEnabled,
      segPowerW: segPowerW ?? 0,
      segEfficiencyPct: segEfficiencyPct ?? 0,
      energyByDevice: energyByDevice ?? {},
      enabledByDevice: enabledByDevice ?? {}
    };
    return _instance.updateEnergyNetwork(input);
  },

  getNetworkSummary() {
    if (!this.enabled || !_instance) {
      return { couplingEnabled: false, labBudgetW: 0, totalAllocatedW: 0, residualW: 0 };
    }
    return _instance.getNetworkSummary();
  },

  getNetworkEdgeAllocatedW(edgeIndex: number) {
    if (!this.enabled || !_instance) return 0;
    return _instance.getNetworkEdgeAllocatedW(edgeIndex) ?? 0;
  },

  getNetworkDevicePower(deviceId: string) {
    if (!this.enabled || !_instance) {
      return { powerInW: 0, powerOutW: 0, efficiency: 0 };
    }
    return _instance.getNetworkDevicePowerById(deviceId);
  }
};

if (typeof window !== 'undefined') {
  segWasm.init().catch(() => {});
  window.segWasm = segWasm;
}

export default segWasm;
