/**
 * Kelvin's water dropper — where its parts are, bench-local scene units.
 *
 * One table for the drawn meshes (device-mesh-layouts.ts), the focus camera
 * and the liquid scene (fluids/kelvin-liquid.ts), so the drops fall where the
 * apparatus is drawn. `KELVIN_CONSTANTS.METRES_PER_SCENE_UNIT` turns it into
 * metres: 0.38 m from drip tip to collector mouth, columns 0.24 m apart.
 *
 * The dropper, top to bottom on each side: a drip tip hanging from the supply
 * beam, the induction ring just under it (a drop forms at the ring's centre,
 * which is where it takes its charge), a clear fall, and the collector can.
 * Each ring is wired to the opposite collector.
 */
import { KELVIN_CONSTANTS } from '../generated/physics-constants.js';

export const KELVIN_APPARATUS = Object.freeze({
  /** The two columns are at x = ± this. */
  columnX: 2.5,
  /** Supply beam the drip tips hang from. */
  beamY: 6.4,
  /** Mouth of a drip tip: 0.13 above the ring's wire, where the CAD prop's tips end (generate-kelvin-jars-glb.mjs). */
  tipY: 5.87,
  /** Induction ring: centre height, major radius, wire radius (the torus mesh, setup-geometry.ts). */
  ringY: 5.6,
  ringRadius: 1.0,
  ringWire: 0.14,
  /** Collector can: centre height, half height, radius (the shared cylinder mesh). */
  collectorY: -3.4,
  collectorHalfHeight: 1.25,
  collectorRadius: 0.8,
  /** Half-thickness of the cross wires' lane in z. */
  wireZ: 0.55
});

/** Height of a collector's mouth: where a drop lands. */
export const KELVIN_COLLECTOR_MOUTH_Y: number = KELVIN_APPARATUS.collectorY + KELVIN_APPARATUS.collectorHalfHeight;

/** Fall from a drip tip to a collector's mouth, m. */
export const KELVIN_FALL_M: number = (KELVIN_APPARATUS.tipY - KELVIN_COLLECTOR_MOUTH_Y) * KELVIN_CONSTANTS.METRES_PER_SCENE_UNIT;

/**
 * Where the focus camera stands, bench-local: far enough back to hold the
 * dropper from the collectors' feet to the supply beam, aimed at its middle.
 * The fixed view this replaces looked at the floor of the bench and showed
 * the lower half only.
 */
export function kelvinFocusCamera(): { cameraOffset: [number, number, number]; cameraTarget: [number, number, number] } {
  const a = KELVIN_APPARATUS;
  const bottom = a.collectorY - a.collectorHalfHeight;
  const top = a.beamY + 0.6;
  const halfWidth = a.columnX + a.ringRadius + 0.4;
  const centre = (top + bottom) / 2;
  // 45° vertical field of view: half the span over tan(22.5°), plus a margin.
  const span = Math.max(top - bottom, 2 * halfWidth);
  const distance = ((0.5 * span) / Math.tan(Math.PI / 8)) * 1.12;
  return { cameraOffset: [0, centre + 0.12 * distance, distance], cameraTarget: [0, centre, 0] };
}
