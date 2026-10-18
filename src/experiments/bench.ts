/**
 * Headless experiment bench (#224 §3) — the plant half of `LabSession.stepPlant`
 * without a renderer, for the offline runner (worker or Node).
 *
 * One substep runs what a focused live frame runs, in the same order:
 *
 *   1. coupling sources into the focus, physics only (LabSession
 *      `stepOffFocusCouplingSources`), so a coupled value is never frozen;
 *   2. the charge then field bus write the focus device's setpoints;
 *   3. the SEG operator steps (it always does, whatever the focus);
 *   4. the focus plant: the C++ one (knobs synced like `syncWasmFocusKnobs`,
 *      result written back by the shared `applyModePlantToDevices`), or the
 *      JS fallback — which is every device without a `wasmMode`
 *      (pulse-coil, halbach-viz, drop-tube) and the whole run without WASM.
 *
 * Each bench owns its own operator, devices and buses — nothing touches the
 * page's singletons, so a sweep can run many benches side by side.
 */
import '../devices/register-plugins';
import { WASM_MODE_BY_ID } from '../../generated/device-catalog';
import { SEGOperatorState } from '../seg-operator-state';
import { applyModePlantToDevices, type SessionDeviceMap, type WasmModePlant } from '../session/apply-wasm-plant';
import { createDevicePhysicsState, stepDevicePhysics } from '../renderers/shared/device-physics';
import { ChargeNetwork } from '../renderers/shared/charge-network';
import { FieldNetwork } from '../renderers/shared/field-network';
import type { RunBackend } from '../analysis/run-types';
import type { SegOperatorTelemetry } from '../telemetry/types';
import type { PlantView } from './readers';

/** The slice of `SEGSim` a bench drives (one simulator per bench). */
export interface CppPlant {
  setMode(mode: number): void;
  setDrive(drive: number): void;
  step(dt: number, loadTorque: number): { omega: number };
  getModePlant(): unknown;
  setTransformerLeakage(enabled: boolean): void;
  setHallCarrierMetal(metal: boolean): void;
  setHallFieldCoupledT(fieldT: number): boolean;
  setKelvinSeedV(seedV: number): boolean;
  setLorentzFieldT(fieldT: number): void;
  getRollerStateFloatView?(): Float32Array | null;
}

export class ExperimentBench implements PlantView {
  readonly operator = new SEGOperatorState();
  readonly devices: SessionDeviceMap = {};
  readonly fieldNetwork: FieldNetwork;
  readonly chargeNetwork: ChargeNetwork;
  private readonly enabled: Record<string, boolean>;
  private readonly cppFocus: boolean;
  private seg: SegOperatorTelemetry | null = null;
  /** Set when the loaded binary could not take a coupled knob and JS stepped the focus. */
  private jsFallback = false;

  constructor(
    readonly focus: string,
    readonly deviceIds: readonly string[],
    config: Record<string, unknown>,
    private readonly cpp: CppPlant | null
  ) {
    const heronLayoutId = typeof config.heronLayout === 'string' ? config.heronLayout : undefined;
    for (const id of deviceIds) {
      if (id === 'seg') continue;
      const physicsState = createDevicePhysicsState(id, heronLayoutId ? { heronLayoutId } : {});
      if (id === 'halbach-viz') {
        physicsState.halbachLayout = config.halbachLinear === true ? 'linear' : 'ring';
        physicsState.halbachFieldLines = null;
      }
      this.devices[id] = { id, physicsState };
    }
    this.enabled = Object.fromEntries(deviceIds.map((id) => [id, true]));
    this.fieldNetwork = new FieldNetwork(config.fieldCoupling === true);
    this.chargeNetwork = new ChargeNetwork(config.chargeCoupling === true);
    this.cppFocus = !!cpp && WASM_MODE_BY_ID[focus] !== undefined;
    if (this.cppFocus) cpp!.setMode(WASM_MODE_BY_ID[focus]);
    // An experiment is a running plant: START, as the operator would.
    this.operator.start();
  }

  get operatorEpoch(): number {
    return this.operator.epoch;
  }

  get backend(): RunBackend {
    if (!this.cppFocus || this.jsFallback) return 'js';
    return this.deviceIds.some((id) => id !== this.focus && id !== 'seg') ? 'mixed' : 'wasm';
  }

  fieldCoupled(deviceId: string): boolean {
    return !!this.fieldNetwork.getLinkForDestination(deviceId)?.active;
  }

  segTelemetry(): SegOperatorTelemetry | null {
    return this.seg;
  }

  step(dt: number): void {
    const drive = this.operator.getDrive();
    for (const id of this.deviceIds) {
      const state = this.devices[id]?.physicsState;
      if (id !== this.focus && state) stepDevicePhysics(state, dt, drive);
    }
    this.chargeNetwork.update({ devices: this.devices, devicesEnabled: this.enabled });
    this.fieldNetwork.update({ devices: this.devices, devicesEnabled: this.enabled });

    this.operator.step(dt);
    const focusState = this.devices[this.focus]?.physicsState;
    let stepJs = !this.cppFocus;
    if (this.cppFocus) {
      const cpp = this.cpp!;
      const ignored = this.syncKnobs(cpp);
      cpp.setDrive(drive);
      const res = cpp.step(dt, 0.01 * (1 - drive * 0.5));
      if (this.focus === 'seg') {
        this.applySegRollers(cpp, res.omega);
      } else if (ignored) {
        stepJs = true;
        this.jsFallback = true;
      } else {
        applyModePlantToDevices(this.focus, this.devices, cpp.getModePlant() as WasmModePlant | null, false, false);
      }
    }
    if (stepJs && focusState) stepDevicePhysics(focusState, dt, drive);
    this.seg = this.operator.computeTelemetry(dt);
  }

  /** `syncWasmFocusKnobs` for this bench's simulator. True when the binary refused a coupled knob. */
  private syncKnobs(cpp: CppPlant): boolean {
    const phys = this.devices[this.focus]?.physicsState;
    switch (this.focus) {
      case 'transformer':
        cpp.setTransformerLeakage(!!phys?.transformerLeakage);
        return false;
      case 'hall': {
        cpp.setHallCarrierMetal(phys?.hallCarrierType === 'metal');
        const t = phys?.hallFieldCoupledT;
        const wants = typeof t === 'number' && Number.isFinite(t);
        return !cpp.setHallFieldCoupledT(wants ? t : -1) && wants;
      }
      case 'kelvin': {
        const v = phys?.kelvinSeedCoupledV;
        const wants = typeof v === 'number' && Number.isFinite(v);
        return !cpp.setKelvinSeedV(wants ? v : -1) && wants;
      }
      case 'lorentz-sled':
        if (phys?.lorentzFieldT != null) cpp.setLorentzFieldT(phys.lorentzFieldT);
        return false;
      default:
        return false;
    }
  }

  /** The C++ roller plant's display write-back (applyWasmPlant, SEG focus). */
  private applySegRollers(cpp: CppPlant, omega: number): void {
    const rollers = cpp.getRollerStateFloatView?.();
    let mean = Math.abs(omega || 0);
    if (rollers && rollers.length >= 4) {
      let s = 0;
      const n = rollers.length / 4;
      for (let i = 0; i < n; i++) s += Math.abs(rollers[i * 4 + 1]);
      mean = s / n;
    }
    const wNorm = Math.min(1, mean / 50);
    const p = this.operator.physics;
    p.segOmega = Math.max(p.segOmega * 0.2, wNorm);
    p.corona = Math.max(0, Math.min(1, (wNorm - 0.6) / 0.4));
  }
}
