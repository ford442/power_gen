import type { DevicePhysicsState } from '../renderers/shared/device-physics.ts';
import type { SegOperatorTelemetry } from './telemetry/types.ts';

export const SEG_SPEC: {
  B_SURFACE_T: number;
  ENERGY_DENSITY_SURFACE_JM3: number;
  CLAIMED_INNER_RPM: number;
  CLAIMED_OUTPUT_KW: number;
  NdFeB_REMANENCE_T: number;
  ROLLER_COUNT_SEARL: string;
  B_SURFACE_UNCERTAINTY: number;
  B_SURFACE_VALIDATED: boolean;
};

export class SEGOperatorState {
  status: string;
  isRunning: boolean;
  targetDrive: number;
  magneticFieldStrength: number;
  loadResistance: number;
  totalEnergy: number;
  physics: DevicePhysicsState;
  start(): void;
  stop(): void;
  estop(): void;
  reset(): void;
  clearEstop(): void;
  getDrive(): number;
  step(dt: number, substeps?: number): void;
  get rotationSpeed(): number;
  get innerRpm(): number;
  get terminalInnerRpm(): number;
  computeTelemetry(deltaTime?: number): SegOperatorTelemetry;
}

export const segOperator: SEGOperatorState;
