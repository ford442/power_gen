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
  getMaglevGap?(): number;
  getMaglevGapVel?(): number;
  getMaglevGapMm?(): number;
  getMaglevFieldT?(): number;
  getMaglevLiftN?(): number;
  getMaglevRpm?(): number;
  getHomopolarOmega?(): number;
  getHomopolarAngle?(): number;
  getHomopolarRpm?(): number;
  getHomopolarEmfV?(): number;
  getHomopolarCurrentA?(): number;
  getHomopolarFieldT?(): number;
  getTransformerI1?(): number;
  getTransformerI2?(): number;
  getTransformerV1?(): number;
  getTransformerV2?(): number;
  getTransformerK?(): number;
  getTransformerFluxN?(): number;
  getTransformerLeakage?(): boolean;
  setTransformerLeakage?(enabled: boolean): void;
  getVdgVoltage?(): number;
  getVdgBeltMps?(): number;
  getVdgChargeC?(): number;
  getVdgSparkHz?(): number;
  getHallVoltage?(): number;
  getHallCurrent?(): number;
  getHallFieldT?(): number;
  getHallCoeff?(): number;
  getHallCarrierMetal?(): boolean;
  setHallCarrierMetal?(metal: boolean): void;
  getLorentzSledVms?(): number;
  getLorentzCurrentA?(): number;
  getLorentzFieldT?(): number;
  getLorentzForceN?(): number;
  getLorentzPositionM?(): number;
  setLorentzFieldT?(fieldT: number): void;
  getEnergyLevel?(): number;
  setNetworkEdges?(flatEdges: number[] | Float32Array): void;
  getNetworkEdgeCount?(): number;
  updateEnergyNetwork?(
    couplingEnabled: boolean,
    segPowerW: number,
    segEfficiencyPct: number,
    energyLevels: number[] | Float32Array,
    enabledFlags: number[] | Int32Array
  ): void;
  getNetworkSummary?(): {
    couplingEnabled: boolean;
    labBudgetW: number;
    totalAllocatedW: number;
    residualW: number;
  };
  getNetworkEdgeAllocatedW?(edgeIndex: number): number;
  getNetworkDevicePower?(mode: number): {
    powerInW: number;
    powerOutW: number;
    efficiency: number;
  };
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
  estimateHalbachFieldT?(gapM: number, remanenceT?: number): number;
  sim_core_version(): string;
  chores_reduce_f32?(data: number[] | Float32Array): number[] | { size: () => number; get: (i: number) => number };
  chores_map_scale_f32?(
    data: number[] | Float32Array,
    scale: number,
    bias: number
  ): number[] | { size: () => number; get: (i: number) => number };
}

export type SimCoreFactory = (opts?: Record<string, unknown>) => Promise<SimCoreModule>;
