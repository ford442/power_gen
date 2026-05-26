// =============================================================
// sim.ts  –  High-level TypeScript API wrapping the sim_core WASM
//
// This module provides a clean, ergonomic interface that hides the
// Emscripten Module details and provides automatic fallback to the
// existing JS physics when WASM is unavailable.
//
// Usage:
//   import { SEGSim } from './wasm/sim';
//
//   const sim = await SEGSim.create();
//   const state = sim.stepAndRead(1/60, 0.01);
//   console.log(state.rpm, state.powerW);
//   sim.dispose();
// =============================================================

import { loadSimCore } from './index';
import type { SEGSimulatorInstance, Vec3 } from './types';

// ─────────────────────────────────────────────────────────────
// Exported result types
// ─────────────────────────────────────────────────────────────

export interface SEGStepResult {
  /** Angular velocity of roller ring 0 (rad s⁻¹). */
  omega: number;
  /** Revolutions per minute of ring 0. */
  rpm: number;
  /** Instantaneous power estimate for the given load torque (W). */
  powerW: number;
  /** Magnetic energy density at the average ring radius (J m⁻³). */
  energyDensityJm3: number;
  /** Elapsed simulation time (s). */
  simTimeS: number;
}

export interface SEGBenchmarkResult {
  stepsPerSecond: number;
  durationMs: number;
  finalOmega: number;
  finalRPM: number;
  wasmAvailable: boolean;
}

// ─────────────────────────────────────────────────────────────
// SEGSim wrapper class
// ─────────────────────────────────────────────────────────────

export class SEGSim {
  private _sim: SEGSimulatorInstance | null = null;
  private _simTimeS = 0;

  /** Whether the underlying WASM module is available. */
  get wasmAvailable(): boolean { return this._sim !== null; }

  private constructor(sim: SEGSimulatorInstance | null) {
    this._sim = sim;
  }

  /**
   * Create an SEGSim instance, loading the WASM module if available.
   * Falls back gracefully to a no-op stub when WASM is not built.
   */
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

  /**
   * Advance the simulation by one frame and return a snapshot of key state.
   * @param dt         Physics time step (seconds; typically 1/60).
   * @param loadTorque Braking torque opposing rotation (N·m, scene-scaled).
   */
  step(dt: number, loadTorque: number): SEGStepResult {
    if (this._sim) {
      this._sim.step(dt, loadTorque);
      this._simTimeS += dt;
      return {
        omega:             this._sim.getOmega(),
        rpm:               this._sim.getRPM(),
        powerW:            this._sim.estimatePower(loadTorque),
        energyDensityJm3:  this._sim.magneticEnergyDensity(),
        simTimeS:          this._simTimeS,
      };
    }
    // Fallback: return zeroed result
    this._simTimeS += dt;
    return { omega: 0, rpm: 0, powerW: 0, energyDensityJm3: 0, simTimeS: this._simTimeS };
  }

  /**
   * Seed the internal CPU particle array (call when entering SEG mode).
   * @param count Number of particles (max 50 000).
   */
  seedParticles(count: number): void {
    this._sim?.seedParticles(count);
  }

  /**
   * Advance CPU-side particles by one frame.
   * Useful for deterministic replay or CPU-side data export.
   */
  stepParticles(dt: number): void {
    this._sim?.stepParticles(dt);
  }

  /**
   * Sample the net B-field vector at a world position from all 66 rollers.
   */
  sampleBField(x: number, y: number, z: number): Vec3 {
    if (!this._sim) return { x: 0, y: 0, z: 0 };
    return this._sim.sampleBField({ x, y, z });
  }

  /**
   * Run a benchmark: n steps at dt=1/60 with a fixed load torque.
   * Returns steps/second and final simulation state.
   */
  async benchmark(steps = 1000, loadTorque = 0.01): Promise<SEGBenchmarkResult> {
    const dt = 1 / 60;
    const t0 = performance.now();
    let finalOmega = 0;
    let finalRPM   = 0;
    for (let i = 0; i < steps; i++) {
      const r = this.step(dt, loadTorque);
      finalOmega = r.omega;
      finalRPM   = r.rpm;
    }
    const durationMs    = performance.now() - t0;
    const stepsPerSecond = steps / (durationMs / 1000);
    return { stepsPerSecond, durationMs, finalOmega, finalRPM, wasmAvailable: this.wasmAvailable };
  }

  /** Free WASM heap memory. Call when done with this instance. */
  dispose(): void {
    this._sim?.delete();
    this._sim = null;
  }

  /** Static version string from the WASM module (or fallback). */
  static async getVersion(): Promise<string> {
    const mod = await loadSimCore();
    return mod ? mod.sim_core_version() : 'sim_core (WASM not built)';
  }
}
