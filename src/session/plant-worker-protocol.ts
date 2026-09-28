/**
 * LabSession ⇄ plant Worker message protocol.
 *
 * The worker steps exactly what `LabSession.stepPlant` stepped in-loop: the
 * SEG operator (JS) and, with `?wasmPhysics=1`, the C++ focus plant. Every
 * other device's visuals stay on the main thread with the GPU (ADR-0007).
 *
 * One step batch is in flight at a time. The main thread applies the last
 * completed result at the top of the next frame, so the plant the renderer
 * draws is **one frame behind** the step that was requested — see
 * docs/AGENTS.md → Plant worker.
 *
 * No SharedArrayBuffer: requests are structured-cloned, the plant result is a
 * transferred `Float32Array`. Default Pages / `file:` boot needs no COOP/COEP.
 */
import { PARTICLE_LAYOUTS } from '../../generated/physics-constants';
import type { DevicePhysicsState } from '../renderers/shared/device-physics';
import type { OperatorStatus } from '../seg-operator-state';
import type { WasmModePlant } from './apply-wasm-plant';

/**
 * Numeric `WasmModePlant` fields, in packed order. The C++ plants integrate in
 * `float`, so a float32 slot is lossless for them. Append only — the index is
 * the wire layout.
 */
export const PLANT_PACK_KEYS = [
  'meanOmega', 'omega', 'head', 'vExit', 'flowLmin', 'pressureKPa', 'voltage', 'voltageN',
  'E', 'sparkTimer', 'battery', 'hotK', 'coldK', 'deltaT', 'current', 'powerW', 'cop',
  'energyLevel', 'flowU', 'bFieldT', 'hartmann', 'gap', 'gapVel', 'gapMm', 'fieldT', 'liftN',
  'rpm', 'angle', 'emfV', 'currentA', 'i1', 'i2', 'v1', 'v2', 'k', 'fluxN', 'beltMps',
  'chargeC', 'sparkHz', 'coeff', 'sledVms', 'forceN', 'positionM', 'ringHeightM',
  'ringCurrentA', 'ringPrimaryIA', 'ringForceN', 'ringCouplingK'
] as const satisfies readonly (keyof WasmModePlant)[];

/**
 * Packed plant snapshot (`Float32Array`, transferred worker → main):
 *
 * | index            | value                                                  |
 * |------------------|--------------------------------------------------------|
 * | 0                | flags — bit0: C++ plant stepped, bit1: mode plant set  |
 * | 1                | mode-plant device index into `WASM_DEVICE_IDS` (−1)    |
 * | 2 … 2+K−1        | `PLANT_PACK_KEYS` values; NaN = key absent this mode   |
 * | 2+K …            | roller state `[angle, ω, radius, height]` × N (SEG)    |
 *
 * The roller tail uses the C++ `packRollerState` stride
 * (`PARTICLE_LAYOUTS.rollerExportStride`, see `SEGSim.getRollerStateFloatView`);
 * it is empty outside SEG focus. Particles never cross this boundary — see
 * docs/PHYSICS_CONSTANTS.md → Particle layouts.
 */
export const PLANT_PACK_HEADER = 2;
export const PLANT_PACK_ROLLER_STRIDE = PARTICLE_LAYOUTS.rollerExportStride;
export const PLANT_PACK_ROLLER_OFFSET = PLANT_PACK_HEADER + PLANT_PACK_KEYS.length;
export const PLANT_FLAG_WASM_STEPPED = 1;
export const PLANT_FLAG_MODE_PLANT = 2;

/** Operator inputs the worker's mirror adopts before every batch. */
export interface OperatorSnapshot {
  status: OperatorStatus;
  isRunning: boolean;
  targetDrive: number;
  magneticFieldStrength: number;
  loadResistance: number;
  /** Full SEG physics object — plain numbers, so no float32 round-trip drift. */
  physics: DevicePhysicsState;
}

/** Device-side knobs `syncWasmFocusKnobs` reads from session devices. */
export interface PlantKnobs {
  transformerLeakage?: boolean;
  hallCarrierType?: string;
  hallFieldCoupledT?: number | null;
  lorentzFieldT?: number;
  /** Kelvin charge-bus seed (V). Null clears it. Absent outside Kelvin focus. */
  kelvinSeedCoupledV?: number | null;
}

export interface PlantWorkerInit {
  type: 'init';
  /** Instantiate `sim_core.wasm` inside the worker. */
  wasm: boolean;
}

export interface PlantWorkerStep {
  type: 'step';
  seq: number;
  /** Sim-time substeps (s) — the session clock decides these, never the worker. */
  steps: number[];
  focus: string;
  useWasm: boolean;
  drive: number;
  operator: OperatorSnapshot;
  knobs: PlantKnobs;
}

export type PlantWorkerRequest = PlantWorkerInit | PlantWorkerStep;

export interface PlantWorkerReady {
  type: 'ready';
  wasmAvailable: boolean;
}

export interface PlantWorkerResult {
  type: 'result';
  seq: number;
  status: OperatorStatus;
  physics: DevicePhysicsState;
  /** Packed plant snapshot — layout above. */
  plant: Float32Array;
  /** Worker-side `syncWasmFocusKnobs` verdict (stale binary without Hall coupling). */
  hallCouplingIgnored: boolean;
  /** Same verdict for the Kelvin charge-bus seed (`setKelvinSeedV`). */
  kelvinSeedIgnored: boolean;
  /** Wall time the worker spent stepping this batch. */
  stepMs: number;
}

export interface PlantWorkerError {
  type: 'error';
  seq: number;
  error: string;
}

export type PlantWorkerResponse = PlantWorkerReady | PlantWorkerResult | PlantWorkerError;

/** Decode the mode-plant slice of a packed snapshot (null when none was set). */
export function unpackModePlant(
  packed: Float32Array,
  deviceIds: readonly string[]
): WasmModePlant | null {
  if (!(packed[0] & PLANT_FLAG_MODE_PLANT)) return null;
  const plant: WasmModePlant = {};
  const modeIndex = packed[1];
  if (modeIndex >= 0 && modeIndex < deviceIds.length) plant.mode = deviceIds[modeIndex];
  for (let i = 0; i < PLANT_PACK_KEYS.length; i++) {
    const v = packed[PLANT_PACK_HEADER + i];
    if (!Number.isNaN(v)) plant[PLANT_PACK_KEYS[i]] = v;
  }
  return plant;
}

/** Pack a mode plant (+ optional roller view) into a fresh transferable buffer. */
export function packModePlant(
  plant: WasmModePlant | null,
  wasmStepped: boolean,
  deviceIds: readonly string[],
  rollers: Float32Array | null
): Float32Array {
  const rollerFloats = rollers ? rollers.length : 0;
  const out = new Float32Array(PLANT_PACK_ROLLER_OFFSET + rollerFloats);
  out[0] = (wasmStepped ? PLANT_FLAG_WASM_STEPPED : 0) | (plant ? PLANT_FLAG_MODE_PLANT : 0);
  out[1] = plant?.mode ? deviceIds.indexOf(plant.mode) : -1;
  for (let i = 0; i < PLANT_PACK_KEYS.length; i++) {
    const v = plant?.[PLANT_PACK_KEYS[i]];
    out[PLANT_PACK_HEADER + i] = typeof v === 'number' ? v : NaN;
  }
  if (rollers) out.set(rollers, PLANT_PACK_ROLLER_OFFSET);
  return out;
}
