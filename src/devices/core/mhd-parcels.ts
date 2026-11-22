/**
 * MHD duct parcels — the picture of the Hartmann profile, shared by both
 * renderers.
 *
 * The parcels are **timelines**, the hydrogen-bubble technique: a line of
 * markers is released across the gap at the inlet, and because each marker
 * moves at the local speed u(y) the line bends into the velocity profile as it
 * travels. A parabola at Ha → 0, a flat front with two thin tails at large Ha.
 * {@link MHD_DUCT.timelines} lines are in the duct at once, staggered, and each
 * is re-released at the inlet when its centre reaches the outlet.
 *
 * Closed form, so the GPU pass stays stateless:
 *
 *   x(η) = xIn + L · τ · u(η)/u(0),   τ = fract(travel + line / timelines)
 *
 * `travel` counts centre-line transits. It is integrated here from the plant's
 * mean speed — ∫ Ū·(u(0)/Ū) / lengthM dt, slowed by
 * {@link MHD_PARCEL_SLOWDOWN} — rather than computed as time × rate, so a
 * change of flow speed changes how fast the lines move and never where they
 * are. Only its fractional part matters.
 *
 * Twins: `posMhd` in passes/particle-compute.wgsl (WebGPU, held to
 * {@link mhdParcelPosition} by the Dawn golden) and `mhd_particle_step` in
 * cpp/src/plant/mhd_plant.cpp (stateful, same lanes and speeds).
 *
 * The drawn duct is not to scale: the real gap is 1 mm across a 0.1 m × 0.4 m
 * slot, drawn here {@link MHD_DUCT.halfGapU} tall so the profile is legible.
 */

import { MHD } from '../../../generated/physics-constants';
import { hartmannCentre, hartmannShape } from '../../physics/hartmann';

/** Drawn duct, device-local render units. Mirrored as literals in WGSL and C++. */
export const MHD_DUCT = Object.freeze({
  /** Inlet x. */
  xIn: -2.1,
  /** Inlet → outlet. */
  lengthU: 4.2,
  /** Half the drawn gap between the Hartmann walls (along B, y). */
  halfGapU: 0.42,
  /**
   * Half-width (z) of the marker sheet. Thin on purpose: the markers sit about
   * the duct's mid-plane, like bubbles off a wire, so each timeline reads as
   * a curve rather than a wall. The 1-D solution has no variation in z anyway.
   */
  halfWidthU: 0.12,
  /** Timelines in the duct at once. */
  timelines: 8
});

/**
 * The picture runs this many times slower than the plant: a real centre-line
 * transit of the 0.4 m duct takes about 0.2 s, too fast to read a profile off.
 * Speeds stay proportional to u(y); only the clock is stretched.
 */
export const MHD_PARCEL_SLOWDOWN = 6;

/** Longest scene-time step integrated in one go — a backgrounded tab resumes, it does not leap. */
const MAX_TRAVEL_DT = 0.1;

/** R2 low-discrepancy steps: lanes fill the cross-section evenly at any particle count. */
const LANE_ETA = Math.fround(0.7548777);
const LANE_ZETA = Math.fround(0.5698403);

const F = Math.fround;
const fract32 = (v: number): number => F(v - Math.floor(v));

/** Centre-line transits per second on the slowed display clock. */
export function mhdCentreTransitHz(flowU: number, hartmann: number): number {
  const u = Number.isFinite(flowU) ? Math.max(0, flowU) : 0;
  return (u * hartmannCentre(hartmann)) / MHD.lengthM / MHD_PARCEL_SLOWDOWN;
}

/** The view-side fields {@link advanceMhdTravel} keeps on a physics state. */
export interface MhdTravelState {
  mhdFlowU?: number;
  mhdHartmann?: number;
  /** Centre-line transits so far, fractional part. Not plant state, not snapshotted. */
  _mhdTravel?: number;
  /** Scene time `_mhdTravel` was last advanced to. */
  _mhdTravelClock?: number;
}

/**
 * Advance the parcel travel to scene time `time` and return it (0..1).
 * Idempotent within a frame: a second call at the same `time` adds nothing,
 * so the compute uniforms and the effect sprites can both ask.
 */
export function advanceMhdTravel(state: MhdTravelState, time: number): number {
  let travel = state._mhdTravel ?? 0;
  const last = state._mhdTravelClock;
  if (last !== undefined && Number.isFinite(time)) {
    const dt = Math.min(MAX_TRAVEL_DT, time - last);
    if (dt > 0) {
      travel += mhdCentreTransitHz(state.mhdFlowU ?? 0, state.mhdHartmann ?? 0) * dt;
      travel -= Math.floor(travel);
    }
  }
  if (Number.isFinite(time)) state._mhdTravelClock = time;
  state._mhdTravel = travel;
  return travel;
}

/** Lane of parcel `idx`: η across the gap and ζ across the electrode spacing, both −1..1. */
export function mhdParcelLane(idx: number): { line: number; eta: number; zeta: number } {
  const k = MHD_DUCT.timelines;
  const lane = F(Math.floor(idx / k) + 0.5);
  return {
    line: idx % k,
    eta: F(fract32(F(lane * LANE_ETA)) * 2 - 1),
    zeta: F(fract32(F(lane * LANE_ZETA)) * 2 - 1)
  };
}

/** [x, y, z, u/u(0)] — device-local position and the parcel's speed over the centre-line speed. */
export type MhdParcel = [number, number, number, number];

/**
 * Device-local position of parcel `idx` — the CPU twin of `posMhd` — and, in
 * the fourth slot, its speed as a fraction of the centre line's. Lane
 * arithmetic is rounded to f32 exactly as the shader does it, so the two agree
 * to the precision of `exp`.
 */
export function mhdParcelPosition(
  idx: number,
  travel: number,
  hartmann: number,
  out: MhdParcel = [0, 0, 0, 0]
): MhdParcel {
  const d = MHD_DUCT;
  // mhdParcelLane, inlined: this runs per particle per frame on WebGL2.
  const lane = F(Math.floor(idx / d.timelines) + 0.5);
  const eta = F(fract32(F(lane * LANE_ETA)) * 2 - 1);
  const zeta = F(fract32(F(lane * LANE_ZETA)) * 2 - 1);
  const tau = fract32(F(F(travel) + (idx % d.timelines) / d.timelines));
  const shape = hartmannShape(eta, hartmann);
  out[0] = d.xIn + d.lengthU * tau * shape;
  out[1] = eta * d.halfGapU;
  out[2] = zeta * d.halfWidthU;
  out[3] = shape;
  return out;
}
