/**
 * Per-device instanced mesh layouts for the multi-device roller pipeline.
 * Instance record: position(3) + ringIndex(1) + rotation quat(4) + color(3) + emissive(1) = 12 floats.
 */

import {
  buildHeronMesh,
  HERON_LAYOUT_PRESETS,
  TUBE_MESH_HEIGHT,
  TUBE_MESH_RADIUS
} from './heron-layout.js';

export { TUBE_MESH_HEIGHT, TUBE_MESH_RADIUS };

const INSTANCE_FLOATS = 12;

export function packInstance(pos, ringIndex, rot = [0, 0, 0, 1], color = [0.7, 0.7, 0.75], emissive = 0) {
  return [
    pos[0], pos[1], pos[2], ringIndex,
    rot[0], rot[1], rot[2], rot[3],
    color[0], color[1], color[2], emissive
  ];
}

function quatFromAxisAngle(axis, angle) {
  const half = angle * 0.5;
  const s = Math.sin(half);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(half)];
}

/** Quaternion rotating the +Y axis onto direction `dir` (not necessarily unit). */
function quatFromYTo(dir) {
  const len = Math.hypot(dir[0], dir[1], dir[2]) || 1;
  const d = [dir[0] / len, dir[1] / len, dir[2] / len];
  const dot = d[1];
  if (dot > 0.9999) return [0, 0, 0, 1];
  if (dot < -0.9999) return [1, 0, 0, 0];
  const axis = [d[2], 0, -d[0]];
  const axisLen = Math.hypot(axis[0], axis[1], axis[2]) || 1;
  const angle = Math.acos(Math.max(-1, Math.min(1, dot)));
  const s = Math.sin(angle / 2);
  return [
    (axis[0] / axisLen) * s,
    (axis[1] / axisLen) * s,
    (axis[2] / axisLen) * s,
    Math.cos(angle / 2)
  ];
}

/**
 * Straight run of tube-mesh instances from `from` to `to`, rotated to lie
 * along the segment. Consecutive instances overlap slightly so no gaps show.
 */
export function tubeSegments(from, to, color = [0.62, 0.66, 0.72], emissive = 0.06, ringIndex = 12) {
  const dir = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
  const len = Math.hypot(dir[0], dir[1], dir[2]);
  if (len < 1e-4) return [];
  const rot = quatFromYTo(dir);
  const n = Math.max(1, Math.ceil(len / (TUBE_MESH_HEIGHT * 0.95)));
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    out.push(packInstance(
      [from[0] + dir[0] * t, from[1] + dir[1] * t, from[2] + dir[2] * t],
      ringIndex, rot, color, emissive
    ));
  }
  return out;
}

/** @deprecated Use buildHeronMesh(presetId) from heron-layout.js */
export function buildHeronInstances(presetId = HERON_LAYOUT_PRESETS.classic) {
  return buildHeronMesh(presetId).layout.vessels;
}

export function buildHeronPlatformInstances(presetId = HERON_LAYOUT_PRESETS.classic) {
  return buildHeronMesh(presetId).layout.platform;
}

export function buildHeronTubeInstances(presetId = HERON_LAYOUT_PRESETS.classic) {
  return buildHeronMesh(presetId).tubes;
}

/** Kelvin's Thunderstorm: 6 drip-can cylinders (3 per side). */
export function buildKelvinInstances() {
  const copper = [0.82, 0.50, 0.28];
  const can = [0.70, 0.74, 0.80];
  const leftX = -2.5;
  const rightX = 2.5;
  return [
    packInstance([leftX, 4.8, 0], 0, [0, 0, 0, 1], can, 0.08),
    packInstance([leftX, 1.5, 0], 0, [0, 0, 0, 1], copper, 0.12),
    packInstance([leftX, -2.5, 0], 0, [0, 0, 0, 1], copper, 0.18),
    packInstance([rightX, 4.8, 0], 0, [0, 0, 0, 1], can, 0.08),
    packInstance([rightX, 1.5, 0], 0, [0, 0, 0, 1], copper, 0.12),
    packInstance([rightX, -2.5, 0], 0, [0, 0, 0, 1], copper, 0.18)
  ];
}

/** Kelvin induction rings (torus instances). ringIndex 100 signals ring geometry in fragment shader. */
export function buildKelvinRingInstances() {
  const ringColor = [0.90, 0.55, 0.20];
  return [
    packInstance([-2.5, 5.6, 0], 100, [0, 0, 0, 1], ringColor, 0.25),
    packInstance([2.5, 5.6, 0], 100, [0, 0, 0, 1], ringColor, 0.25)
  ];
}

/** Collection buckets at base of Kelvin columns. */
export function buildKelvinBucketInstances() {
  const bucket = [0.55, 0.58, 0.64];
  return [
    packInstance([-2.5, -3.4, 0], 0, [0, 0, 0, 1], bucket, 0.1),
    packInstance([2.5, -3.4, 0], 0, [0, 0, 0, 1], bucket, 0.1)
  ];
}

/**
 * Kelvin wiring: the signature CROSS connection — each induction ring is wired
 * to the OPPOSITE collection bucket (positive feedback loop), plus drip
 * nozzles under the header tank and a top support beam.
 */
export function buildKelvinTubeInstances() {
  const copperWire = [0.85, 0.52, 0.24];
  const steel = [0.60, 0.63, 0.68];
  return [
    // Cross wires: left ring → right bucket, right ring → left bucket
    ...tubeSegments([-2.5, 5.2, 0.55], [2.5, -3.0, 0.55], copperWire, 0.16),
    ...tubeSegments([2.5, 5.2, -0.55], [-2.5, -3.0, -0.55], copperWire, 0.16),
    // Drip nozzles from header cans down through the induction rings
    ...tubeSegments([-2.5, 4.2, 0], [-2.5, 3.0, 0], steel, 0.05),
    ...tubeSegments([2.5, 4.2, 0], [2.5, 3.0, 0], steel, 0.05),
    // Top support beam joining the two columns
    ...tubeSegments([-2.5, 6.4, 0], [2.5, 6.4, 0], steel, 0.03)
  ];
}

/** Solar: 6 LEDs in hex + central battery cylinder. */
export function buildSolarLedInstances() {
  const ledColors = [
    [0.95, 0.15, 0.12], // red
    [0.95, 0.15, 0.12],
    [0.15, 0.90, 0.25], // green
    [0.15, 0.90, 0.25],
    [0.20, 0.35, 0.95], // blue
    [0.95, 0.92, 0.85]  // white
  ];
  const instances = [];
  for (let i = 0; i < 6; i++) {
    const angle = (i / 6) * Math.PI * 2;
    const r = 3.0;
    instances.push(packInstance(
      [Math.cos(angle) * r, 3.5, Math.sin(angle) * r],
      i,
      [0, 0, 0, 1],
      ledColors[i],
      0.35
    ));
  }
  return instances;
}

export function buildSolarBatteryInstance() {
  return [packInstance([0, 3.5, 0], 6, [0, 0, 0, 1], [0.55, 0.58, 0.62], 0.1)];
}

/** Solar panel disc. ringIndex 200 matches legacy shader convention. */
export function buildSolarPanelInstance() {
  return [packInstance([0, 0.05, 0], 200, [0, 0, 0, 1], [0.08, 0.12, 0.22], 0.05)];
}

/** Mount pedestal under LED hex array. */
export function buildSolarMountInstances() {
  const mount = [0.45, 0.48, 0.52];
  return [packInstance([0, 1.8, 0], 11, [0, 0, 0, 1], mount, 0.06)];
}

/** Support posts under each LED plus the central battery riser. */
export function buildSolarTubeInstances() {
  const post = [0.42, 0.45, 0.50];
  const out = [];
  for (let i = 0; i < 6; i++) {
    const angle = (i / 6) * Math.PI * 2;
    const x = Math.cos(angle) * 3.0;
    const z = Math.sin(angle) * 3.0;
    out.push(...tubeSegments([x, 0.1, z], [x, 2.6, z], post, 0.03));
  }
  out.push(...tubeSegments([0, 0.1, 0], [0, 2.4, 0], post, 0.03));
  return out;
}

export function instancesToBufferData(instanceArrays) {
  const flat = instanceArrays.flat(Infinity);
  return new Float32Array(flat);
}

export function countInstances(data) {
  return data.length / INSTANCE_FLOATS;
}

export const DEVICE_MESH_LAYOUTS = {
  heron: {
    build: (presetId) => buildHeronMesh(presetId ?? HERON_LAYOUT_PRESETS.classic),
    cylinders: () => buildHeronMesh(HERON_LAYOUT_PRESETS.classic).cylinders,
    tubes: () => buildHeronMesh(HERON_LAYOUT_PRESETS.classic).tubes
  },
  kelvin: {
    cylinders: () => [...buildKelvinInstances(), ...buildKelvinBucketInstances()],
    rings: buildKelvinRingInstances,
    tubes: buildKelvinTubeInstances
  },
  solar: {
    cylinders: () => [...buildSolarLedInstances(), ...buildSolarBatteryInstance()],
    panel: buildSolarPanelInstance,
    platform: buildSolarMountInstances,
    tubes: buildSolarTubeInstances
  }
};
