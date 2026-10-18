// =============================================================
// types.ts  –  TypeScript declarations for the sim_core WASM module
// =============================================================
//
// Mirrors cpp/src/sim_core_embind.cpp exactly. No binding takes or returns a
// std::vector: array input goes through emscripten::val (setNetworkEdges) or a
// C++-owned scratch written via HEAPF32 (get*ScratchPtr → *FromScratch).
// `npm run test:wasm-abi` calls every binding on the shipped .wasm.
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

export interface ChoresReduceRaw {
  sum: number;
  min: number;
  max: number;
  sumSq: number;
  count: number;
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
  getKelvinVbreak?(): number;
  getKelvinSeedV?(): number;
  setKelvinSeedV?(seedV: number): void;
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
  setHallFieldCoupledT?(fieldT: number): void;
  getLorentzSledVms?(): number;
  getLorentzCurrentA?(): number;
  getLorentzFieldT?(): number;
  getLorentzForceN?(): number;
  getLorentzPositionM?(): number;
  setLorentzFieldT?(fieldT: number): void;
  getRingHeightM?(): number;
  getRingCurrentA?(): number;
  getRingPrimaryIA?(): number;
  getRingForceN?(): number;
  getRingCouplingK?(): number;
  getRingVelocityMps?(): number;
  getEnergyLevel?(): number;
  /** Low-rate: emscripten::val, so any JS array / typed array is accepted. */
  setNetworkEdges?(flatEdges: ArrayLike<number>): void;
  getNetworkEdgeCount?(): number;
  /** Byte offset of a C++-owned scratch of ≥ count floats. Re-read HEAPF32 after (may grow). */
  getScratchPtr?(count: number): number;
  /**
   * Per-frame energy bus: levels at scratch[0, modeCount), enabled flags (0/1)
   * at scratch[modeCount, 2·modeCount) — see getScratchPtr.
   */
  updateEnergyNetworkFromScratch?(
    couplingEnabled: boolean,
    segPowerW: number,
    segEfficiencyPct: number,
    modeCount: number
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
  /** Byte offset of the chores scratch (≥ count floats). Re-read HEAPF32 after (may grow). */
  chores_scratch_ptr?(count: number): number;
  chores_reduce_f32_scratch?(count: number): ChoresReduceRaw;
  /** In place over the first `count` scratch floats. */
  chores_map_scale_f32_scratch?(count: number, scale: number, bias: number): void;
}

export type SimCoreFactory = (opts?: Record<string, unknown>) => Promise<SimCoreModule>;
