/**
 * Shared SEG operator / plant state — drive setpoint, excitation, physics step.
 * Live dashboard numbers flow through TelemetryHub (publishFrame → subscribers).
 * Used by the operator panel and both WebGPU / WebGL2 render paths.
 */

import { createDevicePhysicsState, stepDevicePhysics } from './renderers/shared/device-physics';
import type { DevicePhysicsState } from './renderers/shared/device-physics';
import { ValidatedConstants } from './ValidatedConstants';
import { SEG_DATA } from './scientific-data.js';
import type { SegOperatorTelemetry } from './telemetry/types';

/**
 * Literature reference values aligned with ValidatedConstants / scientific-data.
 * Prefer these (or TelemetryHub meta) over hardcoding in UI code.
 */
export const SEG_SPEC = {
  B_SURFACE_T: SEG_DATA?.B_FIELD?.surface
    ?? ValidatedConstants.SEG_PHYSICS.B_FIELD_SURFACE?.value
    ?? 0.7048,
  ENERGY_DENSITY_SURFACE_JM3: SEG_DATA?.ENERGY_DENSITY?.surface
    ?? ValidatedConstants.SEG_PHYSICS.ENERGY_DENSITY_SURFACE?.value
    ?? 1.976e6,
  CLAIMED_INNER_RPM: 2850,
  CLAIMED_OUTPUT_KW: 15,
  NdFeB_REMANENCE_T: SEG_DATA?.MAGNET?.Br
    ?? ValidatedConstants.SEG_MAGNET?.Br
    ?? 1.48,
  ROLLER_COUNT_SEARL: '10 / 25 / 35',
  B_SURFACE_UNCERTAINTY: ValidatedConstants.SEG_PHYSICS.B_FIELD_SURFACE?.uncertainty ?? 0.05,
  B_SURFACE_VALIDATED: ValidatedConstants.SEG_PHYSICS.B_FIELD_SURFACE?.isValidated ?? true,
} as const;

const STATUS = {
  STANDBY: 'standby',
  SPINUP: 'spinup',
  OPERATIONAL: 'operational',
  STOPPING: 'stopping',
  ESTOP: 'estop',
} as const;

export type OperatorStatus = (typeof STATUS)[keyof typeof STATUS];

export class SEGOperatorState {
  status: OperatorStatus = STATUS.STANDBY;
  isRunning = false;
  /** Drive setpoint 0–1 (operator throttle, not sim time dilation) */
  targetDrive = 0.5;
  magneticFieldStrength = 0.5;
  loadResistance = 100;
  totalEnergy = 0;
  private _efficiency = 0;
  physics: DevicePhysicsState;
  private _displayRpm = 0;
  private _displayField = 0;

  constructor() {
    this.physics = createDevicePhysicsState('seg');
    this.physics.magneticFieldStrength = this.magneticFieldStrength;
  }

  start(): void {
    if (this.status === STATUS.ESTOP) return;
    this.isRunning = true;
    this.status = STATUS.SPINUP;
  }

  stop(): void {
    if (this.status === STATUS.ESTOP) return;
    this.isRunning = false;
    this.status = STATUS.STOPPING;
  }

  estop(): void {
    this.isRunning = false;
    this.status = STATUS.ESTOP;
    this.physics.segOmega = 0;
    this.physics.corona = 0;
  }

  reset(): void {
    this.isRunning = false;
    this.status = STATUS.STANDBY;
    this.totalEnergy = 0;
    this._efficiency = 0;
    this.physics = createDevicePhysicsState('seg');
    this.physics.magneticFieldStrength = this.magneticFieldStrength;
    this._displayRpm = 0;
    this._displayField = 0;
  }

  clearEstop(): void {
    if (this.status === STATUS.ESTOP) {
      this.status = STATUS.STANDBY;
    }
  }

  getDrive(): number {
    if (this.status === STATUS.ESTOP || !this.isRunning) return 0;
    return this.targetDrive;
  }

  step(dt: number, substeps = 1): void {
    if (dt <= 0) return;

    this.physics.magneticFieldStrength = this.magneticFieldStrength;
    const subDt = dt / Math.max(1, substeps);
    const drive = this.getDrive();

    for (let i = 0; i < substeps; i++) {
      stepDevicePhysics(this.physics, subDt, drive);
    }

    const w = this.physics.segOmega;

    if (this.status === STATUS.ESTOP) {
      // locked out
    } else if (this.isRunning) {
      if (w > 0.85 && this.status !== STATUS.OPERATIONAL) {
        this.status = STATUS.OPERATIONAL;
      } else if (w <= 0.85 && this.status !== STATUS.OPERATIONAL) {
        this.status = STATUS.SPINUP;
      }
    } else if (this.status === STATUS.STOPPING && w < 0.02) {
      this.status = STATUS.STANDBY;
    }
  }

  /** Normalised rotation 0–120 used by legacy telemetry formulas */
  get rotationSpeed(): number {
    return Math.min(120, this.physics.segOmega * 100);
  }

  /** Inner ring RPM derived from integrated angular velocity */
  get innerRpm(): number {
    return Math.round(this.rotationSpeed * 30);
  }

  /** Terminal RPM scale (inner ring at segOmega = 1) */
  get terminalInnerRpm(): number {
    return 3000;
  }

  computeTelemetry(deltaTime = 0.016): SegOperatorTelemetry {
    const rotationSpeed = this.rotationSpeed;
    const segOmega = this.physics.segOmega;
    const corona = this.physics.corona;

    const voltage = rotationSpeed * this.magneticFieldStrength * 2.5;
    const current = this.loadResistance > 0 ? voltage / this.loadResistance : 0;
    const power = voltage * current;

    const fieldSim = this.magneticFieldStrength * (1 + rotationSpeed / 200) * SEG_SPEC.B_SURFACE_T;
    const fieldClaimedRef = SEG_SPEC.B_SURFACE_T * this.magneticFieldStrength;

    const tempBase = 25;
    const temp = tempBase + rotationSpeed * 0.3 + corona * 12;

    if (this.isRunning && rotationSpeed > 0) {
      const target = 85 + (rotationSpeed / 100) * 10;
      this._efficiency += (target - this._efficiency) * deltaTime * 2;
      this._efficiency = Math.max(80, Math.min(95, this._efficiency));
    } else {
      this._efficiency = rotationSpeed > 0.5 ? this._efficiency * 0.98 : 0;
    }

    if (this.isRunning && rotationSpeed > 0 && deltaTime > 0) {
      this.totalEnergy += power * deltaTime / 3600000;
    }

    const smooth = 1 - Math.exp(-deltaTime * 8);
    this._displayRpm += (this.innerRpm - this._displayRpm) * smooth;
    this._displayField += (fieldSim - this._displayField) * smooth;

    return {
      status: this.status,
      segOmega,
      corona,
      rpmInner: this.innerRpm,
      rpmDisplay: Math.round(this._displayRpm),
      rpmPct: Math.min(100, (segOmega / 1.0) * 100),
      voltage,
      current,
      power,
      fieldSim,
      fieldClaimedRef,
      temperature: temp,
      efficiency: this._efficiency,
      totalEnergy: this.totalEnergy,
      drive: this.getDrive(),
      excitationPct: Math.round(this.magneticFieldStrength * 100),
    };
  }
}

/** Singleton used across the dashboard */
export const segOperator = new SEGOperatorState();
export { STATUS as OPERATOR_STATUS };

if (typeof window !== 'undefined') {
  window.segOperator = segOperator;
}
