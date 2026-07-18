// =============================================================
// types.ts  –  TypeScript declarations for the sim_core WASM module
// =============================================================

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface SimParticle {
  x: number;
  y: number;
  z: number;
  phase: number;
  vx: number;
  vy: number;
  vz: number;
  aux: number;
}

export interface SEGSimulatorInstance {
  step(dt: number, loadTorque: number): void;
  seedParticles(count: number): void;
  stepParticles(dt: number): void;
  getOmega(): number;
  getRPM(): number;
  getOmegaF64?(): number;
  getRPMF64?(): number;
  getAngle(i: number): number;
  numRollers(): number;
  numParticles(): number;
  getTime?(): number;
  sampleBField(pos: Vec3): Vec3;
  rollerWorldPos(i: number): Vec3;
  estimatePower(loadTorque: number): number;
  magneticEnergyDensity(): number;
  getParticle(i: number): SimParticle;
  getParticles(maxCount?: number): SimParticle[];
  setRingLoadTorque(ring: number, torque: number): void;
  setRingLoadTorques(t0: number, t1: number, t2: number): void;
  stepWithPerRingTorques(dt: number): void;
  setMode(mode: number): void;
  getMode(): number;
  setDrive?(drive: number): void;
  getDrive?(): number;
  getHeronHead?(): number;
  getHeronVExit?(): number;
  getHeronFlowLmin?(): number;
  getHeronPressureKPa?(): number;
  getKelvinVoltage?(): number;
  getKelvinVoltageN?(): number;
  getKelvinE?(): number;
  getKelvinSparkTimer?(): number;
  getSolarBattery?(): number;
  getPeltierHotK?(): number;
  getPeltierColdK?(): number;
  getPeltierDeltaT?(): number;
  getPeltierVoltage?(): number;
  getPeltierCurrent?(): number;
  getPeltierPowerW?(): number;
  getPeltierCOP?(): number;
  getMhdFlowU?(): number;
  getMhdBFieldT?(): number;
  getMhdHartmann?(): number;
  getMhdVoltage?(): number;
  getMhdCurrent?(): number;
  getMhdPowerW?(): number;
  getEnergyLevel?(): number;
  /** Byte offset into WASM heap (use with HEAPF32) */
  getParticleBufferPtr?(): number;
  getParticleFloatCount?(): number;
  getRollerStatePtr?(): number;
  getRollerStateFloatCount?(): number;
  packRollerState?(): void;
  delete(): void;
}

export interface SEGSimulatorConstructor {
  new (): SEGSimulatorInstance;
  version(): string;
}

export interface SimCoreModule {
  SEGSimulator: SEGSimulatorConstructor;
  HEAPF32?: Float32Array;
  HEAPU8?: Uint8Array;
  magneticDipoleField(r: Vec3, m: Vec3): Vec3;
  magneticDipoleForce(pos1: Vec3, m1: Vec3, pos2: Vec3, m2: Vec3): Vec3;
  axialBField(z: number, radius: number, height: number, Br: number): number;
  sim_core_version(): string;
}

export type SimCoreFactory = (opts?: Record<string, unknown>) => Promise<SimCoreModule>;
