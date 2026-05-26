// =============================================================
// types.ts  –  TypeScript declarations for the sim_core WASM module
//
// These mirror the Embind bindings defined in cpp/src/sim_core.cpp.
// The actual runtime types are provided by the Emscripten Module
// object; these interfaces describe what is exposed to TypeScript.
// =============================================================

/** 3-component float vector (passed by value via Embind value_object). */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * Single particle state (32 bytes, matching compute.wgsl Particle struct).
 * Passed by value via Embind value_object.
 */
export interface SimParticle {
  x: number;
  y: number;
  z: number;
  phase: number; // per-particle random seed
  vx: number;
  vy: number;
  vz: number;
  aux: number;   // mode scalar (Kelvin: charge; Solar: reflected flag)
}

/** High-level SEG simulator exposed via Embind class_. */
export interface SEGSimulatorInstance {
  /** Advance all rollers by dt (seconds) with the given load torque (N·m). */
  step(dt: number, loadTorque: number): void;

  /** Seed the internal CPU particle array for SEG mode. */
  seedParticles(count: number): void;

  /** Advance all particles by dt (SEG kinematics). */
  stepParticles(dt: number): void;

  /** Angular velocity of ring 0 (rad s⁻¹). */
  getOmega(): number;

  /** RPM of ring 0. */
  getRPM(): number;

  /** Azimuthal angle of roller i (rad). */
  getAngle(i: number): number;

  /** Total number of rollers (12+22+32 = 66). */
  numRollers(): number;

  /** Number of seeded particles. */
  numParticles(): number;

  /** Sample the net B-field vector at a world position from all rollers. */
  sampleBField(pos: Vec3): Vec3;

  /** World position of roller i. */
  rollerWorldPos(i: number): Vec3;

  /** Instantaneous power estimate (W, scene-scaled) for a given load torque. */
  estimatePower(loadTorque: number): number;

  /** Magnetic energy density (J m⁻³) at the average ring radius. */
  magneticEnergyDensity(): number;

  /** Read particle state at index i. */
  getParticle(i: number): SimParticle;

  /** Free Emscripten heap memory held by this instance. */
  delete(): void;
}

/** Constructor for SEGSimulatorInstance (Embind class). */
export interface SEGSimulatorConstructor {
  new (): SEGSimulatorInstance;
  version(): string;
}

/**
 * The Emscripten Module object returned by `await SimCore()`.
 * Only the symbols bound via Embind are listed here.
 */
export interface SimCoreModule {
  // ── Bound class ──────────────────────────────────────────────
  SEGSimulator: SEGSimulatorConstructor;

  // ── Free functions ────────────────────────────────────────────
  magneticDipoleField(r: Vec3, m: Vec3): Vec3;
  magneticDipoleForce(pos1: Vec3, m1: Vec3, pos2: Vec3, m2: Vec3): Vec3;
  axialBField(z: number, radius: number, height: number, Br: number): number;
  sim_core_version(): string;
}

/** Factory function type produced by Emscripten MODULARIZE=1 output. */
export type SimCoreFactory = (opts?: Record<string, unknown>) => Promise<SimCoreModule>;
