/**
 * The IR view (`?thermal=1`, docs/FLUIDS.md → IR view, ADR-0021): every bench
 * drawn in false colour by temperature, the way a thermal camera would show
 * it. Shared by both renderers. Pure: no DOM, no GPU.
 *
 * Where a temperature comes from:
 *
 * - **Peltier** — the plant's own 28 nodes: the heat sink, the module between
 *   its plates, the cold block.
 * - **Pulse coil** — one lumped winding heated by I²R, the copper's mass
 *   worked out from the coil's resistance, turns and radius.
 * - **Drop tube** — the tube wall heated by what the eddy brake dissipates,
 *   F·v. A whole drop is m·g·h, about 50 mJ into a third of a kilogram of
 *   copper: tenths of a millikelvin. The model says so and the picture shows
 *   nothing, which is the honest answer.
 * - **Every other bench** — the room. They have no thermal model, and the
 *   view does not invent one.
 *
 * The two lumped bodies are view-side state (`_irBodyK`), like the MHD
 * timelines' travel: integrated here from what the plant publishes, not plant
 * state, not in a snapshot, and only while the view is on.
 */
import { DROP_TUBE, PELTIER, PULSE_COIL_CORE } from '../../generated/physics-constants.js';

/** The room, K. */
export const IR_AMBIENT_K: number = PELTIER.ambientK;
/** The fixed scale of the ramp, K: −40 °C … +80 °C, the room near the middle. */
export const IR_SCALE = Object.freeze({ minK: 233.15, maxK: 353.15 });

/**
 * The ramp, cold to hot, in linear working space: an "iron" palette. Mirrored
 * as `IR_RAMP` in shaders/common/ir-view.wgsl and renderers/webgl2/shaders.js
 * (scripts/tests/ir-view.test.mjs holds the three together).
 */
export const IR_RAMP: readonly (readonly [number, number, number])[] = Object.freeze([
  [0.0, 0.0, 0.1],
  [0.35, 0.02, 0.5],
  [0.78, 0.12, 0.36],
  [0.98, 0.48, 0.08],
  [1.0, 0.85, 0.25],
  [1.0, 1.0, 0.95]
]);

/** A temperature on the ramp's 0…1. */
export function irNormalise(kelvin: number): number {
  if (!Number.isFinite(kelvin)) return irNormalise(IR_AMBIENT_K);
  return Math.min(1, Math.max(0, (kelvin - IR_SCALE.minK) / (IR_SCALE.maxK - IR_SCALE.minK)));
}

/** The ramp's colour at t in 0…1 (piecewise linear between the control points). */
export function irRamp(t: number, out: [number, number, number] = [0, 0, 0]): [number, number, number] {
  const last = IR_RAMP.length - 1;
  const x = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0)) * last;
  const i = Math.min(last - 1, Math.floor(x));
  const f = x - i;
  for (let k = 0; k < 3; k++) out[k] = IR_RAMP[i][k] + (IR_RAMP[i + 1][k] - IR_RAMP[i][k]) * f;
  return out;
}

/** The ramp's colour for a temperature. */
export function irColour(kelvin: number, out?: [number, number, number]): [number, number, number] {
  return irRamp(irNormalise(kelvin), out);
}

/**
 * What a renderer is told per bench (the material block's `thermal.x`, the
 * WebGL2 `u_thermal`): 0 — the view is off; 1 + t — the whole bench at t on
 * the ramp; {@link IR_CODE_INSTANCE} — each instance's own colour is already
 * its ramp colour (Peltier's three bodies).
 */
export const IR_CODE_OFF = 0;
export const IR_CODE_INSTANCE = 3;
export function irCode(kelvin: number): number {
  return 1 + irNormalise(kelvin);
}

// ---------------------------------------------------------------------------
// Lumped bodies.
// ---------------------------------------------------------------------------

export interface LumpedBody {
  /** Heat capacity, J/K. */
  capacityJK: number;
  /** Loss to the room, W/K. */
  lossWK: number;
}

const COPPER = Object.freeze({ resistivityOhmM: 1.68e-8, densityKgM3: 8960, specificHeatJKgK: 385 });
/** Natural convection off a bare metal surface in still air, W/(m²·K). A round number, not a measurement. */
export const IR_FREE_CONVECTION_WM2K = 10;

/**
 * The pulse coil's winding. Its copper follows from what the catalog already
 * says: the wire is turns × 2π·r long, and its cross-section is what gives the
 * coil's resistance. It loses heat from the bundle's outer surface.
 */
export function pulseCoilWinding(p: { rOhm: number; turns: number; coilRadiusM: number } = PULSE_COIL_CORE): LumpedBody & { wireM: number; massKg: number } {
  const wireM = p.turns * 2 * Math.PI * p.coilRadiusM;
  const areaM2 = (COPPER.resistivityOhmM * wireM) / p.rOhm;
  const massKg = COPPER.densityKgM3 * wireM * areaM2;
  // A bundle as long as it is wide: its outer cylinder, 2π·r × 2r.
  const surfaceM2 = 2 * Math.PI * p.coilRadiusM * (2 * p.coilRadiusM);
  return { wireM, massKg, capacityJK: massKg * COPPER.specificHeatJKgK, lossWK: IR_FREE_CONVECTION_WM2K * surfaceM2 };
}

/** The drop tube's wall: a copper tube of the catalog's radius, wall and length, losing heat from its outside. */
export function dropTubeWall(p: { tubeMeanRadiusM: number; tubeWallM: number; tubeLengthM: number } = DROP_TUBE): LumpedBody & { massKg: number } {
  const massKg = COPPER.densityKgM3 * 2 * Math.PI * p.tubeMeanRadiusM * p.tubeWallM * p.tubeLengthM;
  const surfaceM2 = 2 * Math.PI * (p.tubeMeanRadiusM + p.tubeWallM / 2) * p.tubeLengthM;
  return { massKg, capacityJK: massKg * COPPER.specificHeatJKgK, lossWK: IR_FREE_CONVECTION_WM2K * surfaceM2 };
}

/**
 * One step of a lumped body heated by `powerW`: C·dT/dt = P − h·(T − T_room),
 * stepped exactly (the power is taken as constant over the step).
 */
export function stepLumped(kelvin: number, powerW: number, dt: number, body: LumpedBody, ambientK: number = IR_AMBIENT_K): number {
  const t = Number.isFinite(kelvin) ? kelvin : ambientK;
  const p = Number.isFinite(powerW) ? Math.max(0, powerW) : 0;
  const settled = ambientK + p / body.lossWK;
  return settled + (t - settled) * Math.exp((-body.lossWK * Math.max(0, dt)) / body.capacityJK);
}

// ---------------------------------------------------------------------------
// Per bench.
// ---------------------------------------------------------------------------

/** The fields of a physics state the view reads, and the one it keeps. */
export interface IrViewState {
  peltierNodesK?: readonly number[] | null;
  peltierHotK?: number;
  peltierColdK?: number;
  pulseCoilCurrentA?: number;
  dropTubeDragN?: number;
  dropTubeVMps?: number;
  /** View-side: the bench's lumped body, K. Not plant state. */
  _irBodyK?: number;
}

/** Heat going into a bench's lumped body right now, W; null for a bench without one. */
export function irHeatingW(id: string, s: IrViewState | null | undefined): number | null {
  if (id === 'pulse-coil') {
    const i = s?.pulseCoilCurrentA ?? 0;
    return i * i * PULSE_COIL_CORE.rOhm;
  }
  if (id === 'drop-tube') return Math.abs((s?.dropTubeDragN ?? 0) * (s?.dropTubeVMps ?? 0));
  return null;
}

const BODIES: Record<string, () => LumpedBody> = { 'pulse-coil': pulseCoilWinding, 'drop-tube': dropTubeWall };

/** Advance a bench's lumped body by `dt` of plant time. A no-op for a bench without one. */
export function stepIrView(id: string, s: IrViewState | null | undefined, dt: number): void {
  const body = BODIES[id];
  const heat = irHeatingW(id, s);
  if (!s || !body || heat === null) return;
  s._irBodyK = stepLumped(s._irBodyK ?? IR_AMBIENT_K, heat, dt, body());
}

/** The temperature a bench is drawn at, K: its model's, or the room's. */
export function irDeviceTemperatureK(id: string, s: IrViewState | null | undefined): number {
  if (id === 'peltier') {
    const hot = s?.peltierHotK ?? IR_AMBIENT_K;
    const cold = s?.peltierColdK ?? IR_AMBIENT_K;
    return 0.5 * (hot + cold);
  }
  if (BODIES[id]) return s?._irBodyK ?? IR_AMBIENT_K;
  return IR_AMBIENT_K;
}

/** The renderer's code for a bench: its own instances' colours for Peltier, one temperature otherwise. */
export function irDeviceCode(id: string, s: IrViewState | null | undefined): number {
  return id === 'peltier' ? IR_CODE_INSTANCE : irCode(irDeviceTemperatureK(id, s));
}

/** True for a bench whose temperature comes from a model rather than the room. */
export function irHasModel(id: string): boolean {
  return id === 'peltier' || !!BODIES[id];
}
