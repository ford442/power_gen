/**
 * The MHD duct's mean flow: the gap-averaged momentum balance and the circuit
 * (docs/FLUIDS.md → MHD duct). TS twin of `namespace mhd_duct` in
 * cpp/src/plant/mhd_plant.h; `test:golden` holds the two plants together.
 *
 *   dŪ/dt = drive·pump − (friction(Ha) + braking(B))·Ū
 *
 * Nothing in it is tuned:
 *
 * - **friction** is the Hartmann profile's own shear on the two walls, per
 *   unit mass of the slot: (ν/a²)·Φ(Ha), Φ = Ha²·tanh Ha / (Ha − tanh Ha)
 *   ({@link hartmannWallShear}). 3ν/a² at B = 0, ν·Ha/a² for thin layers.
 * - **braking** is the force B·I·w on the current the circuit draws, per unit
 *   mass between the electrodes: (σB²/ρ)·R_i/(R_i + R_load), with the fluid's
 *   resistance R_i = w/(σ·2a·L) from the geometry.
 *
 * Averaging σ(E + u×B)×B over the gap gives the braking for any profile, and
 * the profile keeps its Hartmann shape whatever the load (a uniform E only
 * shifts the driving term), so both rates hold at any current. What they
 * assume is that the profile is fully developed: a start-up has more wall
 * shear than this until the profile has formed (a²/ν ≈ 0.3 s at B = 0).
 *
 * Pure: no DOM, no GPU.
 */
import { MHD } from '../../generated/physics-constants.js';
import { hartmannWallShear } from './hartmann.js';

export interface MhdDuctParams {
  /** Pressure drop the pump holds across the generator at full drive, per unit mass and length, m/s². */
  pumpAccelMs2: number;
  flowUMaxMps: number;
  /** Electrode spacing, m. */
  widthM: number;
  /** Half the gap between the Hartmann walls, m. */
  halfGapM: number;
  /** Electrode length along the flow, m. */
  lengthM: number;
  sigmaSm: number;
  rhoKgM3: number;
  nuM2s: number;
  rLoadOhm: number;
  bFieldBaseT: number;
  bFieldSpanT: number;
}

/** The bench's field at a drive setting, T. */
export function mhdFieldT(drive: number, p: MhdDuctParams = MHD): number {
  return p.bFieldBaseT + p.bFieldSpanT * drive;
}

/** Hartmann number, B·a·√(σ/ρν). */
export function mhdHartmannNumber(bFieldT: number, p: MhdDuctParams = MHD): number {
  return bFieldT * p.halfGapM * Math.sqrt(p.sigmaSm / (p.rhoKgM3 * p.nuM2s));
}

/** The fluid's resistance between the electrodes, w / (σ·2a·L), Ω. */
export function mhdInternalOhm(p: MhdDuctParams = MHD): number {
  return p.widthM / (p.sigmaSm * 2 * p.halfGapM * p.lengthM);
}

/** Wall friction, 1/s: (ν/a²)·Φ(Ha). */
export function mhdFrictionRate(hartmann: number, p: MhdDuctParams = MHD): number {
  return (p.nuM2s / (p.halfGapM * p.halfGapM)) * hartmannWallShear(hartmann);
}

/** Lorentz braking, 1/s: (σB²/ρ)·R_i/(R_i + R_load). Zero on open circuit, σB²/ρ on a short. */
export function mhdBrakingRate(bFieldT: number, p: MhdDuctParams = MHD): number {
  const ri = mhdInternalOhm(p);
  return ((p.sigmaSm * bFieldT * bFieldT) / p.rhoKgM3) * (ri / (ri + p.rLoadOhm));
}

/** Friction + braking at a field, 1/s. */
export function mhdDecayRate(bFieldT: number, p: MhdDuctParams = MHD): number {
  return mhdFrictionRate(mhdHartmannNumber(bFieldT, p), p) + mhdBrakingRate(bFieldT, p);
}

/** The mean speed the duct settles at for a drive setting, m/s. */
export function mhdSettledSpeed(drive: number, p: MhdDuctParams = MHD): number {
  return (drive * p.pumpAccelMs2) / mhdDecayRate(mhdFieldT(drive, p), p);
}

/**
 * One plant step of the mean speed. The equation is linear with rates of
 * 44–640 /s, so it is stepped exactly — Ū relaxes to the settled speed by
 * e^(−rate·dt) — rather than by Euler, which a 60 Hz step would blow up.
 */
export function mhdStepSpeed(flowU: number, dt: number, drive: number, p: MhdDuctParams = MHD): number {
  const rate = mhdDecayRate(mhdFieldT(drive, p), p);
  const settled = (drive * p.pumpAccelMs2) / rate;
  const next = settled + (flowU - settled) * Math.exp(-rate * Math.max(dt, 0));
  return Math.max(0, Math.min(p.flowUMaxMps * 2, next));
}

export interface MhdOutputs {
  /** Open-circuit voltage B·Ū·w, V. */
  openV: number;
  currentA: number;
  /** Voltage on the load, V. */
  voltageV: number;
  /** Power in the load, W. */
  powerW: number;
}

/** The circuit: V_oc = B·Ū·w across the fluid's resistance and the load. */
export function mhdOutputs(flowU: number, bFieldT: number, p: MhdDuctParams = MHD): MhdOutputs {
  const openV = bFieldT * flowU * p.widthM;
  const currentA = openV / (mhdInternalOhm(p) + p.rLoadOhm);
  const voltageV = currentA * p.rLoadOhm;
  return { openV, currentA, voltageV, powerW: currentA * voltageV };
}

/** Mass of fluid between the electrodes, ρ·2a·w·L, kg — what the rates are per unit of. */
export function mhdFluidMassKg(p: MhdDuctParams = MHD): number {
  return p.rhoKgM3 * 2 * p.halfGapM * p.widthM * p.lengthM;
}
