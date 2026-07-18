// =============================================================
// sim.ts  –  High-level TypeScript API wrapping the sim_core WASM
// =============================================================

import { loadSimCore, getSimCore } from './index';
import type { SEGSimulatorInstance, Vec3, SimParticle } from './types';

export interface SEGStepResult {
  omega: number;
  rpm: number;
  powerW: number;
  energyDensityJm3: number;
  simTimeS: number;
  energyLevel?: number;
  mode?: number;
}

export interface SEGBenchmarkResult {
  stepsPerSecond: number;
  durationMs: number;
  finalOmega: number;
  finalRPM: number;
  wasmAvailable: boolean;
}

export interface JsVsWasmBenchmark {
  wasmStepsPerSecond: number;
  jsStepsPerSecond: number;
  ratio: number;
  wasmAvailable: boolean;
  durationMs: number;
}

export class SEGSim {
  private _sim: SEGSimulatorInstance | null = null;
  private _simTimeS = 0;
  private _heapF32: Float32Array | null = null;

  get wasmAvailable(): boolean {
    return this._sim !== null;
  }

  private constructor(sim: SEGSimulatorInstance | null) {
    this._sim = sim;
    this._refreshHeap();
  }

  private _refreshHeap() {
    const mod = getSimCore() as { HEAPF32?: Float32Array } | null;
    this._heapF32 = mod?.HEAPF32 ?? null;
  }

  static async create(): Promise<SEGSim> {
    const mod = await loadSimCore();
    let sim: SEGSimulatorInstance | null = null;
    if (mod) {
      try {
        sim = new mod.SEGSimulator();
      } catch (err) {
        console.warn('[SEGSim] Could not instantiate SEGSimulator:', err);
      }
    }
    return new SEGSim(sim);
  }

  step(dt: number, loadTorque: number): SEGStepResult {
    if (this._sim) {
      this._sim.step(dt, loadTorque);
      this._simTimeS += dt;
      return {
        omega: this._sim.getOmega(),
        rpm: this._sim.getRPM(),
        powerW: this._sim.estimatePower(loadTorque),
        energyDensityJm3: this._sim.magneticEnergyDensity(),
        simTimeS: this._simTimeS,
        energyLevel: this._sim.getEnergyLevel?.() ?? 0,
        mode: this._sim.getMode?.() ?? 0
      };
    }
    this._simTimeS += dt;
    return { omega: 0, rpm: 0, powerW: 0, energyDensityJm3: 0, simTimeS: this._simTimeS };
  }

  seedParticles(count: number): void {
    this._sim?.seedParticles(count);
  }

  stepParticles(dt: number): void {
    this._sim?.stepParticles(dt);
  }

  sampleBField(x: number, y: number, z: number): Vec3 {
    if (!this._sim) return { x: 0, y: 0, z: 0 };
    return this._sim.sampleBField({ x, y, z });
  }

  async benchmark(steps = 1000, loadTorque = 0.01): Promise<SEGBenchmarkResult> {
    const dt = 1 / 60;
    const t0 = performance.now();
    let finalOmega = 0;
    let finalRPM = 0;
    for (let i = 0; i < steps; i++) {
      const r = this.step(dt, loadTorque);
      finalOmega = r.omega;
      finalRPM = r.rpm;
    }
    const durationMs = performance.now() - t0;
    return {
      stepsPerSecond: steps / (durationMs / 1000),
      durationMs,
      finalOmega,
      finalRPM,
      wasmAvailable: this.wasmAvailable
    };
  }

  /**
   * Compare WASM step throughput vs a pure-JS plant-physics loop.
   */
  async benchmarkJsVsWasm(steps = 2000): Promise<JsVsWasmBenchmark> {
    const dt = 1 / 60;
    // JS micro-benchmark mirroring device-physics SEG step
    let w = 0;
    const tJs0 = performance.now();
    for (let i = 0; i < steps; i++) {
      const drive = 0.5;
      const field = 0.7;
      const tauDrive = drive * field;
      const wArm = 2.5, eddyK = 1.33, visc = 0.05, tScale = 2.5, heft = 1.0;
      const tauEddy = eddyK * w / (1 + w / wArm) + visc * w;
      w = Math.max(0, w + (tauDrive - tauEddy) / (heft * tScale) * dt);
    }
    const jsMs = performance.now() - tJs0;
    const jsStepsPerSecond = steps / (jsMs / 1000);

    let wasmStepsPerSecond = 0;
    if (this.wasmAvailable) {
      this.setMode(0);
      const tW0 = performance.now();
      for (let i = 0; i < steps; i++) {
        this.step(dt, 0.01);
      }
      const wasmMs = performance.now() - tW0;
      wasmStepsPerSecond = steps / (wasmMs / 1000);
    }

    return {
      wasmStepsPerSecond,
      jsStepsPerSecond,
      ratio: jsStepsPerSecond > 0 ? wasmStepsPerSecond / jsStepsPerSecond : 0,
      wasmAvailable: this.wasmAvailable,
      durationMs: jsMs
    };
  }

  dispose(): void {
    this._sim?.delete();
    this._sim = null;
    this._heapF32 = null;
  }

  setRingLoadTorque(ring: number, torque: number): void {
    this._sim?.setRingLoadTorque?.(ring, torque);
  }

  setRingLoadTorques(t0: number, t1: number, t2: number): void {
    this._sim?.setRingLoadTorques?.(t0, t1, t2);
  }

  stepWithPerRingTorques(dt: number): SEGStepResult {
    if (this._sim) {
      this._sim.stepWithPerRingTorques?.(dt);
      this._simTimeS += dt;
      return {
        omega: this._sim.getOmega(),
        rpm: this._sim.getRPM(),
        powerW: this._sim.estimatePower(0),
        energyDensityJm3: this._sim.magneticEnergyDensity(),
        simTimeS: this._simTimeS,
        energyLevel: this._sim.getEnergyLevel?.() ?? 0,
        mode: this._sim.getMode?.() ?? 0
      };
    }
    this._simTimeS += dt;
    return { omega: 0, rpm: 0, powerW: 0, energyDensityJm3: 0, simTimeS: this._simTimeS };
  }

  setMode(mode: number): void {
    this._sim?.setMode?.(mode);
  }

  getMode(): number {
    return this._sim?.getMode?.() ?? 0;
  }

  setDrive(drive: number): void {
    this._sim?.setDrive?.(drive);
  }

  getDrive(): number {
    return this._sim?.getDrive?.() ?? 0;
  }

  getModePlant() {
    if (!this._sim) return null;
    const m = this.getMode();
    if (m === 1) {
      return {
        mode: 'heron',
        head: this._sim.getHeronHead?.() ?? 0,
        vExit: this._sim.getHeronVExit?.() ?? 0,
        flowLmin: this._sim.getHeronFlowLmin?.() ?? 0,
        pressureKPa: this._sim.getHeronPressureKPa?.() ?? 0
      };
    }
    if (m === 2) {
      return {
        mode: 'kelvin',
        voltage: this._sim.getKelvinVoltage?.() ?? 0,
        voltageN: this._sim.getKelvinVoltageN?.() ?? 0,
        E: this._sim.getKelvinE?.() ?? 0,
        sparkTimer: this._sim.getKelvinSparkTimer?.() ?? 0
      };
    }
    if (m === 3) {
      return {
        mode: 'solar',
        battery: this._sim.getSolarBattery?.() ?? 0
      };
    }
    if (m === 4) {
      return {
        mode: 'peltier',
        hotK: this._sim.getPeltierHotK?.() ?? 0,
        coldK: this._sim.getPeltierColdK?.() ?? 0,
        deltaT: this._sim.getPeltierDeltaT?.() ?? 0,
        voltage: this._sim.getPeltierVoltage?.() ?? 0,
        current: this._sim.getPeltierCurrent?.() ?? 0,
        powerW: this._sim.getPeltierPowerW?.() ?? 0,
        cop: this._sim.getPeltierCOP?.() ?? 0,
        energyLevel: this._sim.getEnergyLevel?.() ?? 0
      };
    }
    if (m === 5) {
      return {
        mode: 'mhd',
        flowU: this._sim.getMhdFlowU?.() ?? 0,
        bFieldT: this._sim.getMhdBFieldT?.() ?? 0,
        hartmann: this._sim.getMhdHartmann?.() ?? 0,
        voltage: this._sim.getMhdVoltage?.() ?? 0,
        current: this._sim.getMhdCurrent?.() ?? 0,
        powerW: this._sim.getMhdPowerW?.() ?? 0,
        energyLevel: this._sim.getEnergyLevel?.() ?? 0
      };
    }
    return {
      mode: 'seg',
      omega: this._sim.getOmega(),
      rpm: this._sim.getRPM(),
      omegaF64: this._sim.getOmegaF64?.() ?? this._sim.getOmega()
    };
  }

  getParticles(maxCount = -1): SimParticle[] {
    if (!this._sim) return [];
    if (typeof this._sim.getParticles === 'function') {
      const arr = this._sim.getParticles(maxCount);
      return Array.isArray(arr) ? arr : [];
    }
    const total = this._sim.numParticles();
    const n = maxCount >= 0 && maxCount < total ? maxCount : total;
    const out: SimParticle[] = [];
    for (let i = 0; i < n; i++) out.push(this._sim.getParticle(i));
    return out;
  }

  /**
   * Zero-copy Float32Array view of particle buffer (x,y,z,phase,vx,vy,vz,aux).
   * Invalidated after next WASM heap growth — call again each frame.
   */
  getParticleFloatView(): Float32Array | null {
    if (!this._sim) return null;
    this._refreshHeap();
    if (!this._heapF32) return null;
    const ptr = Number(this._sim.getParticleBufferPtr?.() ?? 0);
    const floats = this._sim.getParticleFloatCount?.() ?? 0;
    if (!ptr || floats <= 0) return null;
    const byteOffset = ptr;
    const index = byteOffset / 4;
    if (!Number.isInteger(index)) return null;
    try {
      return this._heapF32.subarray(index, index + floats);
    } catch {
      return null;
    }
  }

  /**
   * Zero-copy view of packed roller state [angle, omega, radius, height] × N.
   */
  getRollerStateFloatView(): Float32Array | null {
    if (!this._sim) return null;
    this._sim.packRollerState?.();
    this._refreshHeap();
    if (!this._heapF32) return null;
    const ptr = Number(this._sim.getRollerStatePtr?.() ?? 0);
    const floats = this._sim.getRollerStateFloatCount?.() ?? 0;
    if (!ptr || floats <= 0) return null;
    const index = ptr / 4;
    if (!Number.isInteger(index)) return null;
    try {
      return this._heapF32.subarray(index, index + floats);
    } catch {
      return null;
    }
  }

  /** Mean particle |position| for WASM vs GPU diff metrics */
  meanParticleRadius(sample = 256): number {
    const view = this.getParticleFloatView();
    if (!view || view.length < 8) {
      const parts = this.getParticles(sample);
      if (!parts.length) return 0;
      let s = 0;
      for (const p of parts) s += Math.hypot(p.x, p.y, p.z);
      return s / parts.length;
    }
    const n = Math.min(sample, view.length / 8);
    let s = 0;
    for (let i = 0; i < n; i++) {
      const o = i * 8;
      s += Math.hypot(view[o], view[o + 1], view[o + 2]);
    }
    return s / Math.max(1, n);
  }

  static async getVersion(): Promise<string> {
    const mod = await loadSimCore();
    return mod ? mod.sim_core_version() : 'sim_core (WASM not built)';
  }
}
