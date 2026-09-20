/**
 * Shared WASM plant apply — one focus ladder for WebGPU and WebGL2.
 * A new wasmMode device edits this file once (not both orchestrators).
 */
import { segOperator } from '../seg-operator-state';
import { segWasm } from '../wasm/seg-physics-bridge';
import type { DevicePhysicsState } from '../renderers/shared/device-physics';
import { DEVICE_CATALOG, WASM_DEVICE_IDS } from '../../generated/device-catalog';

/** Every device with a `wasmMode` in physics/devices.json (ADR-0008). */
export const WASM_PLANT_MODES = WASM_DEVICE_IDS;

export type WasmPlantMode = (typeof WASM_PLANT_MODES)[number];

/**
 * Core wasm plants (excluding `seg`, handled separately via segOperator)
 * always own JS device physics once their focus is active. Quanta wasm
 * plants only take over once the C++ plant reports it stepped this mode
 * (`_wasmPlantActive`) — derived from `category`, not hand-listed.
 */
const CORE_WASM_OWNED_IDS = new Set<string>(
  DEVICE_CATALOG.filter((d) => d.category === 'core' && d.wasmMode != null && d.id !== 'seg').map((d) => d.id)
);
const QUANTA_WASM_OWNED_IDS = new Set<string>(
  DEVICE_CATALOG.filter((d) => d.category === 'quanta' && d.wasmMode != null).map((d) => d.id)
);

/** Plant-facing device shell (GPU DeviceInstance or WebGL2DeviceState). */
export interface SessionDevice {
  id?: string;
  physicsState?: DevicePhysicsState;
  physics?: DevicePhysicsState;
  batteryCharge?: number;
  energyLevel?: number;
  resetForModeEntry?: () => void;
  scaledParticleCount?: number;
  particleCount?: number;
}

export type SessionDeviceMap = Record<string, SessionDevice>;

export interface WasmModePlant {
  mode?: string;
  meanOmega?: number;
  omega?: number;
  head?: number;
  vExit?: number;
  flowLmin?: number;
  pressureKPa?: number;
  voltage?: number;
  voltageN?: number;
  E?: number;
  sparkTimer?: number;
  battery?: number;
  hotK?: number;
  coldK?: number;
  deltaT?: number;
  current?: number;
  powerW?: number;
  cop?: number;
  energyLevel?: number;
  flowU?: number;
  bFieldT?: number;
  hartmann?: number;
  gap?: number;
  gapVel?: number;
  gapMm?: number;
  fieldT?: number;
  liftN?: number;
  rpm?: number;
  angle?: number;
  emfV?: number;
  currentA?: number;
  i1?: number;
  i2?: number;
  v1?: number;
  v2?: number;
  k?: number;
  fluxN?: number;
  beltMps?: number;
  chargeC?: number;
  sparkHz?: number;
  coeff?: number;
  sledVms?: number;
  forceN?: number;
  positionM?: number;
}

/**
 * True when field coupling is on for `hall` but the loaded `sim_core.wasm`
 * predates `setHallFieldCoupledT` (the artefact is committed by CI on main, so
 * a branch checkout can lag the C++ source). The JS plant then keeps the frame.
 */
let _hallCouplingIgnoredByWasm = false;
let _warnedHallCouplingUnsupported = false;

export function devicePhysics(device: SessionDevice | undefined | null): DevicePhysicsState | null {
  return device?.physicsState ?? device?.physics ?? null;
}

export function isWasmPlantMode(id: string): id is WasmPlantMode {
  return (WASM_PLANT_MODES as readonly string[]).includes(id);
}

/**
 * Skip JS `stepDevicePhysics` when the C++ plant already owns this focus device.
 */
export function wasmOwnsJsDevicePhysics(
  deviceId: string,
  focus: string,
  useWasm: boolean,
  physics: { _wasmPlantActive?: boolean } | null | undefined
): boolean {
  if (!useWasm || deviceId !== focus) return false;
  if (CORE_WASM_OWNED_IDS.has(deviceId)) return true;
  return QUANTA_WASM_OWNED_IDS.has(deviceId) && !!physics?._wasmPlantActive;
}

function applyPlantToPhysics(
  focus: string,
  devices: SessionDeviceMap,
  wr: WasmModePlant
): void {
  if (focus === 'seg' || focus === 'overview') {
    const wNorm = Math.min(1, Math.abs(wr.meanOmega ?? wr.omega ?? 0) / 50);
    segOperator.physics.segOmega = Math.max(segOperator.physics.segOmega * 0.2, wNorm);
    segOperator.physics.corona = Math.max(0, Math.min(1, (wNorm - 0.6) / 0.4));
    return;
  }

  const plant = segWasm.getModePlant() as WasmModePlant | null;
  if (!plant) return;

  if (focus === 'heron') {
    const heron = devicePhysics(devices.heron);
    if (!heron) return;
    heron.heronHead = plant.head ?? heron.heronHead;
    heron.heronVExit = plant.vExit ?? heron.heronVExit;
    heron.heronFlowRateLmin = plant.flowLmin ?? 0;
    heron.heronPressureKPa = plant.pressureKPa ?? 0;
    heron.energyLevel = Math.min(1, heron.heronVExit / 4);
    return;
  }
  if (focus === 'kelvin') {
    const kelvin = devicePhysics(devices.kelvin);
    if (!kelvin) return;
    kelvin.kelvinV = plant.voltage ?? 0;
    kelvin.kelvinVoltageN = plant.voltageN ?? 0;
    kelvin.kelvinE = plant.E ?? 0;
    kelvin.kelvinSparkTimer = plant.sparkTimer ?? 0;
    kelvin.energyLevel = kelvin.kelvinVoltageN;
    return;
  }
  if (focus === 'solar') {
    const solarDev = devices.solar;
    const solar = devicePhysics(solarDev);
    if (!solarDev || typeof plant.battery !== 'number') return;
    solarDev.batteryCharge = plant.battery;
    if (solar) {
      solar.batteryCharge = plant.battery;
      solar.energyLevel = plant.battery;
    }
    return;
  }
  if (focus === 'peltier') {
    const peltier = devicePhysics(devices.peltier);
    if (!peltier) return;
    peltier.peltierHotK = plant.hotK ?? peltier.peltierHotK;
    peltier.peltierColdK = plant.coldK ?? peltier.peltierColdK;
    peltier.peltierDeltaT = plant.deltaT ?? 0;
    peltier.peltierVoltage = plant.voltage ?? 0;
    peltier.peltierCurrent = plant.current ?? 0;
    peltier.peltierPowerW = plant.powerW ?? 0;
    peltier.peltierCOP = plant.cop ?? 0;
    peltier.energyLevel = plant.energyLevel ?? 0;
    peltier._wasmPlantActive = true;
    return;
  }
  if (focus === 'mhd') {
    const mhd = devicePhysics(devices.mhd);
    if (!mhd) return;
    mhd.mhdFlowU = plant.flowU ?? 0;
    mhd.mhdBFieldT = plant.bFieldT ?? 0;
    mhd.mhdHartmann = plant.hartmann ?? 0;
    mhd.mhdVoltage = plant.voltage ?? 0;
    mhd.mhdCurrent = plant.current ?? 0;
    mhd.mhdPowerW = plant.powerW ?? 0;
    mhd.energyLevel = plant.energyLevel ?? 0;
    mhd._wasmPlantActive = true;
    return;
  }
  if (focus === 'maglev' && plant.mode === 'maglev') {
    const maglev = devicePhysics(devices.maglev);
    if (!maglev) return;
    maglev.maglevGap = plant.gap ?? maglev.maglevGap;
    maglev.maglevGapVel = plant.gapVel ?? maglev.maglevGapVel;
    maglev.maglevGapMm = plant.gapMm ?? 0;
    maglev.maglevFieldT = plant.fieldT ?? 0;
    maglev.maglevLiftN = plant.liftN ?? 0;
    maglev.maglevRpm = plant.rpm ?? 0;
    maglev.energyLevel = plant.energyLevel ?? 0;
    maglev._wasmPlantActive = true;
    return;
  }
  if (focus === 'homopolar' && plant.mode === 'homopolar') {
    const homo = devicePhysics(devices.homopolar);
    if (!homo) return;
    homo.homopolarOmega = plant.omega ?? 0;
    homo.homopolarAngle = plant.angle ?? 0;
    homo.homopolarRpm = plant.rpm ?? 0;
    homo.homopolarEmfV = plant.emfV ?? 0;
    homo.homopolarCurrentA = plant.currentA ?? 0;
    homo.homopolarCurrent = plant.currentA ?? 0;
    homo.homopolarFieldT = plant.fieldT ?? 0;
    homo.energyLevel = plant.energyLevel ?? 0;
    homo._wasmPlantActive = true;
    return;
  }
  if (focus === 'transformer' && plant.mode === 'transformer') {
    const xfmr = devicePhysics(devices.transformer);
    if (!xfmr) return;
    xfmr.transformerIpA = plant.i1 ?? 0;
    xfmr.transformerIsA = plant.i2 ?? 0;
    xfmr.transformerVp = plant.v1 ?? 0;
    xfmr.transformerVs = plant.v2 ?? 0;
    xfmr.transformerK = plant.k ?? xfmr.transformerK;
    xfmr.transformerFluxN = plant.fluxN ?? 0;
    xfmr.energyLevel = plant.energyLevel ?? 0;
    xfmr._wasmPlantActive = true;
    return;
  }
  if (focus === 'vdg' && plant.mode === 'vdg') {
    const vdg = devicePhysics(devices.vdg);
    if (!vdg) return;
    vdg.vdgVoltage = plant.voltage ?? 0;
    vdg.vdgBeltMps = plant.beltMps ?? 0;
    vdg.vdgChargeC = plant.chargeC ?? 0;
    vdg.vdgSparkHz = plant.sparkHz ?? 0;
    vdg.energyLevel = plant.energyLevel ?? 0;
    vdg._wasmPlantActive = true;
    return;
  }
  if (focus === 'hall' && plant.mode === 'hall') {
    // A binary too old for setHallFieldCoupledT would report its own
    // drive-derived B while the panel names a coupled source — a visible lie.
    // Leave the frame to the JS plant instead, which does honor the setpoint.
    if (_hallCouplingIgnoredByWasm) return;
    const hall = devicePhysics(devices.hall);
    if (!hall) return;
    hall.hallVoltage = plant.voltage ?? 0;
    hall.hallCurrent = plant.current ?? 0;
    hall.hallFieldT = plant.fieldT ?? 0;
    hall.hallCoeff = plant.coeff ?? 0;
    hall.energyLevel = plant.energyLevel ?? 0;
    hall._wasmPlantActive = true;
    return;
  }
  if (focus === 'lorentz-sled' && plant.mode === 'lorentz-sled') {
    const sled = devicePhysics(devices['lorentz-sled']);
    if (!sled) return;
    sled.lorentzSledVms = plant.sledVms ?? 0;
    sled.lorentzCurrentA = plant.currentA ?? 0;
    sled.lorentzFieldT = plant.fieldT ?? 0;
    sled.lorentzForceN = plant.forceN ?? 0;
    sled.lorentzPositionM = plant.positionM ?? 0;
    sled.energyLevel = plant.energyLevel ?? 0;
    sled._wasmPlantActive = true;
  }
}

export function syncWasmFocusKnobs(devices: SessionDeviceMap, focus: string): void {
  if (isWasmPlantMode(focus)) {
    segWasm.setMode(focus);
  }
  if (focus === 'transformer') {
    const leak = !!devicePhysics(devices.transformer)?.transformerLeakage;
    segWasm.setTransformerLeakage?.(leak);
  }
  if (focus === 'hall') {
    const hall = devicePhysics(devices.hall);
    segWasm.setHallCarrierMetal?.(hall?.hallCarrierType === 'metal');
    // FieldNetwork already wrote this (null when uncoupled); a negative T tells
    // the C++ plant to fall back to its own drive-derived B (ADR-0011).
    const coupledT = hall?.hallFieldCoupledT;
    const wantsCoupling = typeof coupledT === 'number' && Number.isFinite(coupledT);
    const accepted = segWasm.setHallFieldCoupledT?.(wantsCoupling ? coupledT : -1) ?? false;
    _hallCouplingIgnoredByWasm = wantsCoupling && !accepted;
    if (_hallCouplingIgnoredByWasm && !_warnedHallCouplingUnsupported) {
      _warnedHallCouplingUnsupported = true;
      console.warn(
        '[LabSession] sim_core.wasm predates setHallFieldCoupledT — keeping the JS Hall '
        + 'plant while field coupling is on, so the reported B matches the coupled setpoint. '
        + 'Rebuild the WASM artefact (npm run wasm:build) to run the C++ plant coupled.'
      );
    }
  } else {
    _hallCouplingIgnoredByWasm = false;
  }
  if (focus === 'lorentz-sled') {
    // Local bench slider or FieldNetwork setpoint — both land in lorentzFieldT,
    // so the C++ plant and the JS fallback step from the same B either way.
    const fieldT = devicePhysics(devices['lorentz-sled'])?.lorentzFieldT;
    if (fieldT != null) segWasm.setLorentzFieldT?.(fieldT);
  }
}

/**
 * Operator substeps + optional C++ plant write-back into session devices.
 */
export function applyWasmPlant(opts: {
  devices: SessionDeviceMap;
  focus: string;
  simSteps: number[];
  drive: number;
}): void {
  const { devices, focus, simSteps, drive } = opts;
  const loadT = 0.01 * (1 - drive * 0.5);
  syncWasmFocusKnobs(devices, focus);
  for (const subDt of simSteps) {
    if (subDt <= 0) continue;
    segOperator.step(subDt);
    const wr = segWasm.step(subDt, loadT, drive) as WasmModePlant;
    applyPlantToPhysics(focus, devices, wr);
  }
}
