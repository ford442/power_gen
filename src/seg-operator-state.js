/**
 * Shared SEG operator / plant state — drive setpoint, excitation, telemetry.
 * Used by the operator panel and both WebGPU / WebGL2 render paths.
 */

import { createDevicePhysicsState, stepDevicePhysics } from './renderers/shared/device-physics.js';

/** Literature reference values (Wolfram-validated, see scientific-data.js) */
export const SEG_SPEC = {
  B_SURFACE_T: 0.7048,
  CLAIMED_INNER_RPM: 2850,
  CLAIMED_OUTPUT_KW: 15,
  NdFeB_REMANENCE_T: 1.48,
  ROLLER_COUNT_SEARL: '10 / 25 / 35',
};

const STATUS = {
  STANDBY: 'standby',
  SPINUP: 'spinup',
  OPERATIONAL: 'operational',
  STOPPING: 'stopping',
  ESTOP: 'estop',
};

export class SEGOperatorState {
  constructor() {
    this.status = STATUS.STANDBY;
    this.isRunning = false;
    /** Drive setpoint 0–1 (operator throttle, not sim time dilation) */
    this.targetDrive = 0.5;
    this.magneticFieldStrength = 0.5;
    this.loadResistance = 100;
    this.totalEnergy = 0;
    this._efficiency = 0;
    this.physics = createDevicePhysicsState('seg');
    this.physics.magneticFieldStrength = this.magneticFieldStrength;

    /** Smoothed display values */
    this._displayRpm = 0;
    this._displayField = 0;
  }

  start() {
    if (this.status === STATUS.ESTOP) return;
    this.isRunning = true;
    this.status = STATUS.SPINUP;
  }

  stop() {
    if (this.status === STATUS.ESTOP) return;
    this.isRunning = false;
    this.status = STATUS.STOPPING;
  }

  estop() {
    this.isRunning = false;
    this.status = STATUS.ESTOP;
    this.physics.segOmega = 0;
    this.physics.corona = 0;
  }

  reset() {
    this.isRunning = false;
    this.status = STATUS.STANDBY;
    this.totalEnergy = 0;
    this._efficiency = 0;
    this.physics = createDevicePhysicsState('seg');
    this.physics.magneticFieldStrength = this.magneticFieldStrength;
    this._displayRpm = 0;
    this._displayField = 0;
  }

  clearEstop() {
    if (this.status === STATUS.ESTOP) {
      this.status = STATUS.STANDBY;
    }
  }

  getDrive() {
    if (this.status === STATUS.ESTOP || !this.isRunning) return 0;
    return this.targetDrive;
  }

  /**
   * @param {number} dt  Physics step in seconds
   * @param {number} [substeps=1]
   */
  step(dt, substeps = 1) {
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
  get rotationSpeed() {
    return Math.min(120, this.physics.segOmega * 100);
  }

  /** Inner ring RPM derived from integrated angular velocity */
  get innerRpm() {
    return Math.round(this.rotationSpeed * 30);
  }

  /** Terminal RPM scale (inner ring at segOmega = 1) */
  get terminalInnerRpm() {
    return 3000;
  }

  computeTelemetry(deltaTime = 0.016) {
    const rotationSpeed = this.rotationSpeed;
    const segOmega = this.physics.segOmega;
    const corona = this.physics.corona;

    // Electrical output model (simulated — not claimed SEG performance)
    const voltage = rotationSpeed * this.magneticFieldStrength * 2.5;
    const current = this.loadResistance > 0 ? voltage / this.loadResistance : 0;
    const power = voltage * current;

    // Field rises with spin (reluctance reduction); scale toward literature B_surface at full speed
    const fieldSim = this.magneticFieldStrength * (1 + rotationSpeed / 200) * SEG_SPEC.B_SURFACE_T;
    const fieldClaimedRef = SEG_SPEC.B_SURFACE_T * this.magneticFieldStrength;

    const tempBase = 25;
    const temp = tempBase + rotationSpeed * 0.3 + corona * 12;

    if (this.isRunning && rotationSpeed > 0) {
      const target = 85 + (rotationSpeed / 100) * 10;
      if (this._efficiency === undefined) this._efficiency = target;
      this._efficiency += (target - this._efficiency) * deltaTime * 2;
      this._efficiency = Math.max(80, Math.min(95, this._efficiency));
    } else {
      this._efficiency = rotationSpeed > 0.5 ? this._efficiency * 0.98 : 0;
    }

    if (this.isRunning && rotationSpeed > 0 && deltaTime > 0) {
      this.totalEnergy += power * deltaTime / 3600000;
    }

    // Smooth gauge needles
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
