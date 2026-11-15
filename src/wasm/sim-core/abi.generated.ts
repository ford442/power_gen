/**
 * AUTO-GENERATED from cpp/abi.json — do not edit.
 * Regenerate: npm run codegen:wasm-abi   (scripts/codegen-wasm-abi.mjs)
 *
 * The only JS ⇄ WASM surface of sim_core (#254 §3): `SimCoreExports` types
 * the instance's exports (the flat C ABI in cpp/src/sim_core_abi.cpp) and
 * `bindSimCore` wraps them into the `SimCoreModule` the app uses. No
 * Embind, no ccall / cwrap: each method is one direct call into the export.
 */

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

export interface ChoresReduceResult {
  sum: number;
  min: number;
  max: number;
  sumSq: number;
  count: number;
}

export interface EnergyNetworkSummary {
  couplingEnabled: boolean;
  labBudgetW: number;
  totalAllocatedW: number;
  residualW: number;
}

export interface EnergyNetworkDevicePower {
  powerInW: number;
  powerOutW: number;
  efficiency: number;
}

/** `WebAssembly.Instance.exports` of sim_core.wasm, as cpp/abi.json declares them. */
export interface SimCoreExports {
  memory: WebAssembly.Memory;
  sc_magneticDipoleField(r_x: number, r_y: number, r_z: number, m_x: number, m_y: number, m_z: number): number;
  sc_magneticDipoleForce(pos1_x: number, pos1_y: number, pos1_z: number, m1_x: number, m1_y: number, m1_z: number, pos2_x: number, pos2_y: number, pos2_z: number, m2_x: number, m2_y: number, m2_z: number): number;
  sc_axialBField(z: number, radius: number, height: number, Br: number): number;
  sc_estimateHalbachFieldT(gapM: number, remanenceT: number): number;
  sc_sim_core_version(): number;
  sc_sim_core_source_hash(): number;
  sc_chores_scratch_ptr(count: number): number;
  sc_chores_reduce_f32_scratch(count: number): number;
  sc_chores_map_scale_f32_scratch(count: number, scale: number, bias: number): void;
  sc_chores_fft_db_scratch(count: number, hann: number, floorDb: number): number;
  sc_plant_state_layout_hash(): number;
  seg_new(): number;
  seg_delete(self: number): void;
  seg_version(): number;
  seg_step(self: number, dt: number, loadTorque: number): void;
  seg_seedParticles(self: number, count: number): void;
  seg_stepParticles(self: number, dt: number): void;
  seg_getOmega(self: number): number;
  seg_getRPM(self: number): number;
  seg_getOmegaF64(self: number): number;
  seg_getRPMF64(self: number): number;
  seg_getAngle(self: number, i: number): number;
  seg_numRollers(self: number): number;
  seg_numParticles(self: number): number;
  seg_getTime(self: number): number;
  seg_sampleBField(self: number, worldPos_x: number, worldPos_y: number, worldPos_z: number): number;
  seg_rollerWorldPos(self: number, i: number): number;
  seg_estimatePower(self: number, loadTorque: number): number;
  seg_magneticEnergyDensity(self: number): number;
  seg_getParticle(self: number, i: number): number;
  seg_setRingLoadTorque(self: number, ring: number, torque: number): void;
  seg_setRingLoadTorques(self: number, tInner: number, tMiddle: number, tOuter: number): void;
  seg_stepWithPerRingTorques(self: number, dt: number): void;
  seg_setMode(self: number, mode: number): void;
  seg_getMode(self: number): number;
  seg_setDrive(self: number, drive: number): void;
  seg_getDrive(self: number): number;
  seg_getHeronHead(self: number): number;
  seg_getHeronVExit(self: number): number;
  seg_getHeronFlowLmin(self: number): number;
  seg_getHeronPressureKPa(self: number): number;
  seg_getKelvinVoltage(self: number): number;
  seg_getKelvinVoltageN(self: number): number;
  seg_getKelvinE(self: number): number;
  seg_getKelvinSparkTimer(self: number): number;
  seg_getKelvinVbreak(self: number): number;
  seg_getKelvinSeedV(self: number): number;
  seg_setKelvinSeedV(self: number, seedV: number): void;
  seg_getSolarBattery(self: number): number;
  seg_getPeltierHotK(self: number): number;
  seg_getPeltierColdK(self: number): number;
  seg_getPeltierDeltaT(self: number): number;
  seg_getPeltierVoltage(self: number): number;
  seg_getPeltierCurrent(self: number): number;
  seg_getPeltierPowerW(self: number): number;
  seg_getPeltierCOP(self: number): number;
  seg_getMhdFlowU(self: number): number;
  seg_getMhdBFieldT(self: number): number;
  seg_getMhdHartmann(self: number): number;
  seg_getMhdVoltage(self: number): number;
  seg_getMhdCurrent(self: number): number;
  seg_getMhdPowerW(self: number): number;
  seg_getMaglevGap(self: number): number;
  seg_getMaglevGapVel(self: number): number;
  seg_getMaglevGapMm(self: number): number;
  seg_getMaglevFieldT(self: number): number;
  seg_getMaglevLiftN(self: number): number;
  seg_getMaglevRpm(self: number): number;
  seg_getHomopolarOmega(self: number): number;
  seg_getHomopolarAngle(self: number): number;
  seg_getHomopolarRpm(self: number): number;
  seg_getHomopolarEmfV(self: number): number;
  seg_getHomopolarCurrentA(self: number): number;
  seg_getHomopolarFieldT(self: number): number;
  seg_getTransformerI1(self: number): number;
  seg_getTransformerI2(self: number): number;
  seg_getTransformerV1(self: number): number;
  seg_getTransformerV2(self: number): number;
  seg_getTransformerK(self: number): number;
  seg_getTransformerFluxN(self: number): number;
  seg_getTransformerLeakage(self: number): number;
  seg_setTransformerLeakage(self: number, enabled: number): void;
  seg_getVdgVoltage(self: number): number;
  seg_getVdgBeltMps(self: number): number;
  seg_getVdgChargeC(self: number): number;
  seg_getVdgSparkHz(self: number): number;
  seg_getHallVoltage(self: number): number;
  seg_getHallCurrent(self: number): number;
  seg_getHallFieldT(self: number): number;
  seg_getHallCoeff(self: number): number;
  seg_getHallCarrierMetal(self: number): number;
  seg_setHallCarrierMetal(self: number, metal: number): void;
  seg_setHallFieldCoupledT(self: number, fieldT: number): void;
  seg_getLorentzSledVms(self: number): number;
  seg_getLorentzCurrentA(self: number): number;
  seg_getLorentzFieldT(self: number): number;
  seg_getLorentzForceN(self: number): number;
  seg_getLorentzPositionM(self: number): number;
  seg_setLorentzFieldT(self: number, fieldT: number): void;
  seg_getRingHeightM(self: number): number;
  seg_getRingCurrentA(self: number): number;
  seg_getRingPrimaryIA(self: number): number;
  seg_getRingForceN(self: number): number;
  seg_getRingCouplingK(self: number): number;
  seg_getRingVelocityMps(self: number): number;
  seg_getEnergyLevel(self: number): number;
  seg_setNetworkEdges(self: number, flatEdges: number, flatEdgesCount: number): void;
  seg_getNetworkEdgeCount(self: number): number;
  seg_getScratchPtr(self: number, count: number): number;
  seg_updateEnergyNetworkFromScratch(self: number, couplingEnabled: number, segPowerW: number, segEfficiencyPct: number, modeCount: number): void;
  seg_plantStateSize(self: number, mode: number): number;
  seg_plantSave(self: number, mode: number): number;
  seg_plantLoad(self: number, mode: number, count: number, layoutHash: number): number;
  seg_getNetworkSummary(self: number): number;
  seg_getNetworkEdgeAllocatedW(self: number, edgeIndex: number): number;
  seg_getNetworkDevicePower(self: number, mode: number): number;
  seg_getParticleBufferPtr(self: number): number;
  seg_getParticleFloatCount(self: number): number;
  seg_getRollerStatePtr(self: number): number;
  seg_getRollerStateFloatCount(self: number): number;
  seg_packRollerState(self: number): void;
  seg_setIntegrator(self: number, method: number): void;
  seg_getIntegrator(self: number): number;
  seg_getOdeRhsEvals(self: number): number;
  seg_getOdeSteps(self: number): number;
  seg_getOdeRejected(self: number): number;
  seg_resetOdeStats(self: number): void;
}

/** Every function export the manifest declares, sorted (test:wasm-abi diffs the binary against it). */
export const SIM_CORE_ABI_EXPORTS: readonly string[] = [
  'sc_axialBField',
  'sc_chores_fft_db_scratch',
  'sc_chores_map_scale_f32_scratch',
  'sc_chores_reduce_f32_scratch',
  'sc_chores_scratch_ptr',
  'sc_estimateHalbachFieldT',
  'sc_magneticDipoleField',
  'sc_magneticDipoleForce',
  'sc_plant_state_layout_hash',
  'sc_sim_core_source_hash',
  'sc_sim_core_version',
  'seg_delete',
  'seg_estimatePower',
  'seg_getAngle',
  'seg_getDrive',
  'seg_getEnergyLevel',
  'seg_getHallCarrierMetal',
  'seg_getHallCoeff',
  'seg_getHallCurrent',
  'seg_getHallFieldT',
  'seg_getHallVoltage',
  'seg_getHeronFlowLmin',
  'seg_getHeronHead',
  'seg_getHeronPressureKPa',
  'seg_getHeronVExit',
  'seg_getHomopolarAngle',
  'seg_getHomopolarCurrentA',
  'seg_getHomopolarEmfV',
  'seg_getHomopolarFieldT',
  'seg_getHomopolarOmega',
  'seg_getHomopolarRpm',
  'seg_getIntegrator',
  'seg_getKelvinE',
  'seg_getKelvinSeedV',
  'seg_getKelvinSparkTimer',
  'seg_getKelvinVbreak',
  'seg_getKelvinVoltage',
  'seg_getKelvinVoltageN',
  'seg_getLorentzCurrentA',
  'seg_getLorentzFieldT',
  'seg_getLorentzForceN',
  'seg_getLorentzPositionM',
  'seg_getLorentzSledVms',
  'seg_getMaglevFieldT',
  'seg_getMaglevGap',
  'seg_getMaglevGapMm',
  'seg_getMaglevGapVel',
  'seg_getMaglevLiftN',
  'seg_getMaglevRpm',
  'seg_getMhdBFieldT',
  'seg_getMhdCurrent',
  'seg_getMhdFlowU',
  'seg_getMhdHartmann',
  'seg_getMhdPowerW',
  'seg_getMhdVoltage',
  'seg_getMode',
  'seg_getNetworkDevicePower',
  'seg_getNetworkEdgeAllocatedW',
  'seg_getNetworkEdgeCount',
  'seg_getNetworkSummary',
  'seg_getOdeRejected',
  'seg_getOdeRhsEvals',
  'seg_getOdeSteps',
  'seg_getOmega',
  'seg_getOmegaF64',
  'seg_getParticle',
  'seg_getParticleBufferPtr',
  'seg_getParticleFloatCount',
  'seg_getPeltierCOP',
  'seg_getPeltierColdK',
  'seg_getPeltierCurrent',
  'seg_getPeltierDeltaT',
  'seg_getPeltierHotK',
  'seg_getPeltierPowerW',
  'seg_getPeltierVoltage',
  'seg_getRPM',
  'seg_getRPMF64',
  'seg_getRingCouplingK',
  'seg_getRingCurrentA',
  'seg_getRingForceN',
  'seg_getRingHeightM',
  'seg_getRingPrimaryIA',
  'seg_getRingVelocityMps',
  'seg_getRollerStateFloatCount',
  'seg_getRollerStatePtr',
  'seg_getScratchPtr',
  'seg_getSolarBattery',
  'seg_getTime',
  'seg_getTransformerFluxN',
  'seg_getTransformerI1',
  'seg_getTransformerI2',
  'seg_getTransformerK',
  'seg_getTransformerLeakage',
  'seg_getTransformerV1',
  'seg_getTransformerV2',
  'seg_getVdgBeltMps',
  'seg_getVdgChargeC',
  'seg_getVdgSparkHz',
  'seg_getVdgVoltage',
  'seg_magneticEnergyDensity',
  'seg_new',
  'seg_numParticles',
  'seg_numRollers',
  'seg_packRollerState',
  'seg_plantLoad',
  'seg_plantSave',
  'seg_plantStateSize',
  'seg_resetOdeStats',
  'seg_rollerWorldPos',
  'seg_sampleBField',
  'seg_seedParticles',
  'seg_setDrive',
  'seg_setHallCarrierMetal',
  'seg_setHallFieldCoupledT',
  'seg_setIntegrator',
  'seg_setKelvinSeedV',
  'seg_setLorentzFieldT',
  'seg_setMode',
  'seg_setNetworkEdges',
  'seg_setRingLoadTorque',
  'seg_setRingLoadTorques',
  'seg_setTransformerLeakage',
  'seg_step',
  'seg_stepParticles',
  'seg_stepWithPerRingTorques',
  'seg_updateEnergyNetworkFromScratch',
  'seg_version'
];

export interface SEGSimulatorInstance {
  /** Address of the C++ object (for diagnostics). */
  readonly ptr: number;
  step(dt: number, loadTorque: number): void;
  seedParticles(count: number): void;
  stepParticles(dt: number): void;
  getOmega(): number;
  getRPM(): number;
  getOmegaF64(): number;
  getRPMF64(): number;
  getAngle(i: number): number;
  numRollers(): number;
  numParticles(): number;
  getTime(): number;
  sampleBField(worldPos: Vec3): Vec3;
  rollerWorldPos(i: number): Vec3;
  estimatePower(loadTorque: number): number;
  magneticEnergyDensity(): number;
  getParticle(i: number): SimParticle;
  setRingLoadTorque(ring: number, torque: number): void;
  setRingLoadTorques(tInner: number, tMiddle: number, tOuter: number): void;
  stepWithPerRingTorques(dt: number): void;
  setMode(mode: number): void;
  getMode(): number;
  setDrive(drive: number): void;
  getDrive(): number;
  getHeronHead(): number;
  getHeronVExit(): number;
  getHeronFlowLmin(): number;
  getHeronPressureKPa(): number;
  getKelvinVoltage(): number;
  getKelvinVoltageN(): number;
  getKelvinE(): number;
  getKelvinSparkTimer(): number;
  getKelvinVbreak(): number;
  getKelvinSeedV(): number;
  setKelvinSeedV(seedV: number): void;
  getSolarBattery(): number;
  getPeltierHotK(): number;
  getPeltierColdK(): number;
  getPeltierDeltaT(): number;
  getPeltierVoltage(): number;
  getPeltierCurrent(): number;
  getPeltierPowerW(): number;
  getPeltierCOP(): number;
  getMhdFlowU(): number;
  getMhdBFieldT(): number;
  getMhdHartmann(): number;
  getMhdVoltage(): number;
  getMhdCurrent(): number;
  getMhdPowerW(): number;
  getMaglevGap(): number;
  getMaglevGapVel(): number;
  getMaglevGapMm(): number;
  getMaglevFieldT(): number;
  getMaglevLiftN(): number;
  getMaglevRpm(): number;
  getHomopolarOmega(): number;
  getHomopolarAngle(): number;
  getHomopolarRpm(): number;
  getHomopolarEmfV(): number;
  getHomopolarCurrentA(): number;
  getHomopolarFieldT(): number;
  getTransformerI1(): number;
  getTransformerI2(): number;
  getTransformerV1(): number;
  getTransformerV2(): number;
  getTransformerK(): number;
  getTransformerFluxN(): number;
  getTransformerLeakage(): boolean;
  setTransformerLeakage(enabled: boolean): void;
  getVdgVoltage(): number;
  getVdgBeltMps(): number;
  getVdgChargeC(): number;
  getVdgSparkHz(): number;
  getHallVoltage(): number;
  getHallCurrent(): number;
  getHallFieldT(): number;
  getHallCoeff(): number;
  getHallCarrierMetal(): boolean;
  setHallCarrierMetal(metal: boolean): void;
  setHallFieldCoupledT(fieldT: number): void;
  getLorentzSledVms(): number;
  getLorentzCurrentA(): number;
  getLorentzFieldT(): number;
  getLorentzForceN(): number;
  getLorentzPositionM(): number;
  setLorentzFieldT(fieldT: number): void;
  getRingHeightM(): number;
  getRingCurrentA(): number;
  getRingPrimaryIA(): number;
  getRingForceN(): number;
  getRingCouplingK(): number;
  getRingVelocityMps(): number;
  getEnergyLevel(): number;
  setNetworkEdges(flatEdges: ArrayLike<number>): void;
  getNetworkEdgeCount(): number;
  getScratchPtr(count: number): number;
  updateEnergyNetworkFromScratch(couplingEnabled: boolean, segPowerW: number, segEfficiencyPct: number, modeCount: number): void;
  plantStateSize(mode: number): number;
  plantSave(mode: number): number;
  plantLoad(mode: number, count: number, layoutHash: number): boolean;
  getNetworkSummary(): EnergyNetworkSummary;
  getNetworkEdgeAllocatedW(edgeIndex: number): number;
  getNetworkDevicePower(mode: number): EnergyNetworkDevicePower;
  getParticleBufferPtr(): number;
  getParticleFloatCount(): number;
  getRollerStatePtr(): number;
  getRollerStateFloatCount(): number;
  packRollerState(): void;
  setIntegrator(method: number): void;
  getIntegrator(): number;
  getOdeRhsEvals(): number;
  getOdeSteps(): number;
  getOdeRejected(): number;
  resetOdeStats(): void;
  /** Free the C++ object. Idempotent; the instance is dead afterwards. */
  delete(): void;
}

export interface SEGSimulatorConstructor {
  new (): SEGSimulatorInstance;
  version(): string;
}

export interface SimCoreModule {
  SEGSimulator: SEGSimulatorConstructor;
  /** View over the instance memory; re-read after any call that may grow the heap. */
  readonly HEAPF32: Float32Array;
  magneticDipoleField(r: Vec3, m: Vec3): Vec3;
  magneticDipoleForce(pos1: Vec3, m1: Vec3, pos2: Vec3, m2: Vec3): Vec3;
  axialBField(z: number, radius: number, height: number, Br: number): number;
  estimateHalbachFieldT(gapM: number, remanenceT?: number): number;
  sim_core_version(): string;
  sim_core_source_hash(): string;
  chores_scratch_ptr(count: number): number;
  chores_reduce_f32_scratch(count: number): ChoresReduceResult;
  chores_map_scale_f32_scratch(count: number, scale: number, bias: number): void;
  chores_fft_db_scratch(count: number, hann: boolean, floorDb: number): number;
  plant_state_layout_hash(): number;
}

/** Wrap an instantiated sim_core.wasm. */
export function bindSimCore(ex: SimCoreExports): SimCoreModule {
  let f32 = new Float32Array(ex.memory.buffer);
  let u8 = new Uint8Array(ex.memory.buffer);
  // memory.grow detaches the old buffer: rebuild the views lazily.
  const heapF32 = (): Float32Array => (f32.buffer === ex.memory.buffer ? f32 : (f32 = new Float32Array(ex.memory.buffer)));
  const heapU8 = (): Uint8Array => (u8.buffer === ex.memory.buffer ? u8 : (u8 = new Uint8Array(ex.memory.buffer)));
  const decoder = new TextDecoder();
  const cstr = (ptr: number): string => {
    const h = heapU8();
    const start = ptr >>> 0;
    let end = start;
    while (end < h.length && h[end] !== 0) end++;
    return decoder.decode(h.subarray(start, end));
  };
  const readVec3 = (ptr: number): Vec3 => {
    const h = heapF32();
    const b = (ptr >>> 0) >> 2;
    return { x: h[b + 0], y: h[b + 1], z: h[b + 2] };
  };
  const readSimParticle = (ptr: number): SimParticle => {
    const h = heapF32();
    const b = (ptr >>> 0) >> 2;
    return { x: h[b + 0], y: h[b + 1], z: h[b + 2], phase: h[b + 3], vx: h[b + 4], vy: h[b + 5], vz: h[b + 6], aux: h[b + 7] };
  };
  const readChoresReduceResult = (ptr: number): ChoresReduceResult => {
    const h = heapF32();
    const b = (ptr >>> 0) >> 2;
    return { sum: h[b + 0], min: h[b + 1], max: h[b + 2], sumSq: h[b + 3], count: h[b + 4] };
  };
  const readEnergyNetworkSummary = (ptr: number): EnergyNetworkSummary => {
    const h = heapF32();
    const b = (ptr >>> 0) >> 2;
    return { couplingEnabled: h[b + 0] !== 0, labBudgetW: h[b + 1], totalAllocatedW: h[b + 2], residualW: h[b + 3] };
  };
  const readEnergyNetworkDevicePower = (ptr: number): EnergyNetworkDevicePower => {
    const h = heapF32();
    const b = (ptr >>> 0) >> 2;
    return { powerInW: h[b + 0], powerOutW: h[b + 1], efficiency: h[b + 2] };
  };

  class SEGSimulatorImpl implements SEGSimulatorInstance {
    ptr: number;
    constructor() {
      this.ptr = ex.seg_new() >>> 0;
      if (this.ptr === 0) throw new Error('sim_core: SEGSimulator allocation failed');
    }
    static version(): string {
      return cstr(ex.seg_version());
    }
    delete(): void {
      if (this.ptr !== 0) ex.seg_delete(this.ptr);
      this.ptr = 0;
    }
    step(dt: number, loadTorque: number): void {
      ex.seg_step(this.ptr, dt, loadTorque);
    }
    seedParticles(count: number): void {
      ex.seg_seedParticles(this.ptr, count);
    }
    stepParticles(dt: number): void {
      ex.seg_stepParticles(this.ptr, dt);
    }
    getOmega(): number {
      return ex.seg_getOmega(this.ptr);
    }
    getRPM(): number {
      return ex.seg_getRPM(this.ptr);
    }
    getOmegaF64(): number {
      return ex.seg_getOmegaF64(this.ptr);
    }
    getRPMF64(): number {
      return ex.seg_getRPMF64(this.ptr);
    }
    getAngle(i: number): number {
      return ex.seg_getAngle(this.ptr, i);
    }
    numRollers(): number {
      return ex.seg_numRollers(this.ptr);
    }
    numParticles(): number {
      return ex.seg_numParticles(this.ptr);
    }
    getTime(): number {
      return ex.seg_getTime(this.ptr);
    }
    sampleBField(worldPos: Vec3): Vec3 {
      return readVec3(ex.seg_sampleBField(this.ptr, worldPos.x, worldPos.y, worldPos.z));
    }
    rollerWorldPos(i: number): Vec3 {
      return readVec3(ex.seg_rollerWorldPos(this.ptr, i));
    }
    estimatePower(loadTorque: number): number {
      return ex.seg_estimatePower(this.ptr, loadTorque);
    }
    magneticEnergyDensity(): number {
      return ex.seg_magneticEnergyDensity(this.ptr);
    }
    getParticle(i: number): SimParticle {
      return readSimParticle(ex.seg_getParticle(this.ptr, i));
    }
    setRingLoadTorque(ring: number, torque: number): void {
      ex.seg_setRingLoadTorque(this.ptr, ring, torque);
    }
    setRingLoadTorques(tInner: number, tMiddle: number, tOuter: number): void {
      ex.seg_setRingLoadTorques(this.ptr, tInner, tMiddle, tOuter);
    }
    stepWithPerRingTorques(dt: number): void {
      ex.seg_stepWithPerRingTorques(this.ptr, dt);
    }
    setMode(mode: number): void {
      ex.seg_setMode(this.ptr, mode);
    }
    getMode(): number {
      return ex.seg_getMode(this.ptr);
    }
    setDrive(drive: number): void {
      ex.seg_setDrive(this.ptr, drive);
    }
    getDrive(): number {
      return ex.seg_getDrive(this.ptr);
    }
    getHeronHead(): number {
      return ex.seg_getHeronHead(this.ptr);
    }
    getHeronVExit(): number {
      return ex.seg_getHeronVExit(this.ptr);
    }
    getHeronFlowLmin(): number {
      return ex.seg_getHeronFlowLmin(this.ptr);
    }
    getHeronPressureKPa(): number {
      return ex.seg_getHeronPressureKPa(this.ptr);
    }
    getKelvinVoltage(): number {
      return ex.seg_getKelvinVoltage(this.ptr);
    }
    getKelvinVoltageN(): number {
      return ex.seg_getKelvinVoltageN(this.ptr);
    }
    getKelvinE(): number {
      return ex.seg_getKelvinE(this.ptr);
    }
    getKelvinSparkTimer(): number {
      return ex.seg_getKelvinSparkTimer(this.ptr);
    }
    getKelvinVbreak(): number {
      return ex.seg_getKelvinVbreak(this.ptr);
    }
    getKelvinSeedV(): number {
      return ex.seg_getKelvinSeedV(this.ptr);
    }
    setKelvinSeedV(seedV: number): void {
      ex.seg_setKelvinSeedV(this.ptr, seedV);
    }
    getSolarBattery(): number {
      return ex.seg_getSolarBattery(this.ptr);
    }
    getPeltierHotK(): number {
      return ex.seg_getPeltierHotK(this.ptr);
    }
    getPeltierColdK(): number {
      return ex.seg_getPeltierColdK(this.ptr);
    }
    getPeltierDeltaT(): number {
      return ex.seg_getPeltierDeltaT(this.ptr);
    }
    getPeltierVoltage(): number {
      return ex.seg_getPeltierVoltage(this.ptr);
    }
    getPeltierCurrent(): number {
      return ex.seg_getPeltierCurrent(this.ptr);
    }
    getPeltierPowerW(): number {
      return ex.seg_getPeltierPowerW(this.ptr);
    }
    getPeltierCOP(): number {
      return ex.seg_getPeltierCOP(this.ptr);
    }
    getMhdFlowU(): number {
      return ex.seg_getMhdFlowU(this.ptr);
    }
    getMhdBFieldT(): number {
      return ex.seg_getMhdBFieldT(this.ptr);
    }
    getMhdHartmann(): number {
      return ex.seg_getMhdHartmann(this.ptr);
    }
    getMhdVoltage(): number {
      return ex.seg_getMhdVoltage(this.ptr);
    }
    getMhdCurrent(): number {
      return ex.seg_getMhdCurrent(this.ptr);
    }
    getMhdPowerW(): number {
      return ex.seg_getMhdPowerW(this.ptr);
    }
    getMaglevGap(): number {
      return ex.seg_getMaglevGap(this.ptr);
    }
    getMaglevGapVel(): number {
      return ex.seg_getMaglevGapVel(this.ptr);
    }
    getMaglevGapMm(): number {
      return ex.seg_getMaglevGapMm(this.ptr);
    }
    getMaglevFieldT(): number {
      return ex.seg_getMaglevFieldT(this.ptr);
    }
    getMaglevLiftN(): number {
      return ex.seg_getMaglevLiftN(this.ptr);
    }
    getMaglevRpm(): number {
      return ex.seg_getMaglevRpm(this.ptr);
    }
    getHomopolarOmega(): number {
      return ex.seg_getHomopolarOmega(this.ptr);
    }
    getHomopolarAngle(): number {
      return ex.seg_getHomopolarAngle(this.ptr);
    }
    getHomopolarRpm(): number {
      return ex.seg_getHomopolarRpm(this.ptr);
    }
    getHomopolarEmfV(): number {
      return ex.seg_getHomopolarEmfV(this.ptr);
    }
    getHomopolarCurrentA(): number {
      return ex.seg_getHomopolarCurrentA(this.ptr);
    }
    getHomopolarFieldT(): number {
      return ex.seg_getHomopolarFieldT(this.ptr);
    }
    getTransformerI1(): number {
      return ex.seg_getTransformerI1(this.ptr);
    }
    getTransformerI2(): number {
      return ex.seg_getTransformerI2(this.ptr);
    }
    getTransformerV1(): number {
      return ex.seg_getTransformerV1(this.ptr);
    }
    getTransformerV2(): number {
      return ex.seg_getTransformerV2(this.ptr);
    }
    getTransformerK(): number {
      return ex.seg_getTransformerK(this.ptr);
    }
    getTransformerFluxN(): number {
      return ex.seg_getTransformerFluxN(this.ptr);
    }
    getTransformerLeakage(): boolean {
      return ex.seg_getTransformerLeakage(this.ptr) !== 0;
    }
    setTransformerLeakage(enabled: boolean): void {
      ex.seg_setTransformerLeakage(this.ptr, enabled ? 1 : 0);
    }
    getVdgVoltage(): number {
      return ex.seg_getVdgVoltage(this.ptr);
    }
    getVdgBeltMps(): number {
      return ex.seg_getVdgBeltMps(this.ptr);
    }
    getVdgChargeC(): number {
      return ex.seg_getVdgChargeC(this.ptr);
    }
    getVdgSparkHz(): number {
      return ex.seg_getVdgSparkHz(this.ptr);
    }
    getHallVoltage(): number {
      return ex.seg_getHallVoltage(this.ptr);
    }
    getHallCurrent(): number {
      return ex.seg_getHallCurrent(this.ptr);
    }
    getHallFieldT(): number {
      return ex.seg_getHallFieldT(this.ptr);
    }
    getHallCoeff(): number {
      return ex.seg_getHallCoeff(this.ptr);
    }
    getHallCarrierMetal(): boolean {
      return ex.seg_getHallCarrierMetal(this.ptr) !== 0;
    }
    setHallCarrierMetal(metal: boolean): void {
      ex.seg_setHallCarrierMetal(this.ptr, metal ? 1 : 0);
    }
    setHallFieldCoupledT(fieldT: number): void {
      ex.seg_setHallFieldCoupledT(this.ptr, fieldT);
    }
    getLorentzSledVms(): number {
      return ex.seg_getLorentzSledVms(this.ptr);
    }
    getLorentzCurrentA(): number {
      return ex.seg_getLorentzCurrentA(this.ptr);
    }
    getLorentzFieldT(): number {
      return ex.seg_getLorentzFieldT(this.ptr);
    }
    getLorentzForceN(): number {
      return ex.seg_getLorentzForceN(this.ptr);
    }
    getLorentzPositionM(): number {
      return ex.seg_getLorentzPositionM(this.ptr);
    }
    setLorentzFieldT(fieldT: number): void {
      ex.seg_setLorentzFieldT(this.ptr, fieldT);
    }
    getRingHeightM(): number {
      return ex.seg_getRingHeightM(this.ptr);
    }
    getRingCurrentA(): number {
      return ex.seg_getRingCurrentA(this.ptr);
    }
    getRingPrimaryIA(): number {
      return ex.seg_getRingPrimaryIA(this.ptr);
    }
    getRingForceN(): number {
      return ex.seg_getRingForceN(this.ptr);
    }
    getRingCouplingK(): number {
      return ex.seg_getRingCouplingK(this.ptr);
    }
    getRingVelocityMps(): number {
      return ex.seg_getRingVelocityMps(this.ptr);
    }
    getEnergyLevel(): number {
      return ex.seg_getEnergyLevel(this.ptr);
    }
    setNetworkEdges(flatEdges: ArrayLike<number>): void {
      const flatEdgesPtr = this.getScratchPtr(flatEdges.length);
      heapF32().set(flatEdges, flatEdgesPtr >> 2);
      ex.seg_setNetworkEdges(this.ptr, flatEdgesPtr, flatEdges.length);
    }
    getNetworkEdgeCount(): number {
      return ex.seg_getNetworkEdgeCount(this.ptr);
    }
    getScratchPtr(count: number): number {
      return ex.seg_getScratchPtr(this.ptr, count) >>> 0;
    }
    updateEnergyNetworkFromScratch(couplingEnabled: boolean, segPowerW: number, segEfficiencyPct: number, modeCount: number): void {
      ex.seg_updateEnergyNetworkFromScratch(this.ptr, couplingEnabled ? 1 : 0, segPowerW, segEfficiencyPct, modeCount);
    }
    plantStateSize(mode: number): number {
      return ex.seg_plantStateSize(this.ptr, mode);
    }
    plantSave(mode: number): number {
      return ex.seg_plantSave(this.ptr, mode);
    }
    plantLoad(mode: number, count: number, layoutHash: number): boolean {
      return ex.seg_plantLoad(this.ptr, mode, count, layoutHash) !== 0;
    }
    getNetworkSummary(): EnergyNetworkSummary {
      return readEnergyNetworkSummary(ex.seg_getNetworkSummary(this.ptr));
    }
    getNetworkEdgeAllocatedW(edgeIndex: number): number {
      return ex.seg_getNetworkEdgeAllocatedW(this.ptr, edgeIndex);
    }
    getNetworkDevicePower(mode: number): EnergyNetworkDevicePower {
      return readEnergyNetworkDevicePower(ex.seg_getNetworkDevicePower(this.ptr, mode));
    }
    getParticleBufferPtr(): number {
      return ex.seg_getParticleBufferPtr(this.ptr) >>> 0;
    }
    getParticleFloatCount(): number {
      return ex.seg_getParticleFloatCount(this.ptr);
    }
    getRollerStatePtr(): number {
      return ex.seg_getRollerStatePtr(this.ptr) >>> 0;
    }
    getRollerStateFloatCount(): number {
      return ex.seg_getRollerStateFloatCount(this.ptr);
    }
    packRollerState(): void {
      ex.seg_packRollerState(this.ptr);
    }
    setIntegrator(method: number): void {
      ex.seg_setIntegrator(this.ptr, method);
    }
    getIntegrator(): number {
      return ex.seg_getIntegrator(this.ptr);
    }
    getOdeRhsEvals(): number {
      return ex.seg_getOdeRhsEvals(this.ptr);
    }
    getOdeSteps(): number {
      return ex.seg_getOdeSteps(this.ptr);
    }
    getOdeRejected(): number {
      return ex.seg_getOdeRejected(this.ptr);
    }
    resetOdeStats(): void {
      ex.seg_resetOdeStats(this.ptr);
    }
  }

  return {
    SEGSimulator: SEGSimulatorImpl,
    get HEAPF32(): Float32Array {
      return heapF32();
    },
    magneticDipoleField(r: Vec3, m: Vec3): Vec3 {
      return readVec3(ex.sc_magneticDipoleField(r.x, r.y, r.z, m.x, m.y, m.z));
    },
    magneticDipoleForce(pos1: Vec3, m1: Vec3, pos2: Vec3, m2: Vec3): Vec3 {
      return readVec3(ex.sc_magneticDipoleForce(pos1.x, pos1.y, pos1.z, m1.x, m1.y, m1.z, pos2.x, pos2.y, pos2.z, m2.x, m2.y, m2.z));
    },
    axialBField(z: number, radius: number, height: number, Br: number): number {
      return ex.sc_axialBField(z, radius, height, Br);
    },
    estimateHalbachFieldT(gapM: number, remanenceT?: number): number {
      return ex.sc_estimateHalbachFieldT(gapM, (remanenceT ?? 0));
    },
    sim_core_version(): string {
      return cstr(ex.sc_sim_core_version());
    },
    sim_core_source_hash(): string {
      return cstr(ex.sc_sim_core_source_hash());
    },
    chores_scratch_ptr(count: number): number {
      return ex.sc_chores_scratch_ptr(count) >>> 0;
    },
    chores_reduce_f32_scratch(count: number): ChoresReduceResult {
      return readChoresReduceResult(ex.sc_chores_reduce_f32_scratch(count));
    },
    chores_map_scale_f32_scratch(count: number, scale: number, bias: number): void {
      ex.sc_chores_map_scale_f32_scratch(count, scale, bias);
    },
    chores_fft_db_scratch(count: number, hann: boolean, floorDb: number): number {
      return ex.sc_chores_fft_db_scratch(count, hann ? 1 : 0, floorDb);
    },
    plant_state_layout_hash(): number {
      return ex.sc_plant_state_layout_hash() >>> 0;
    },
  };
}
