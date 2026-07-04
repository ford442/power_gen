/**
 * Per-device instanced mesh layouts for the multi-device roller pipeline.
 * Instance record: position(3) + ringIndex(1) + rotation quat(4) + color(3) + emissive(1) = 12 floats.
 */

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

/** Heron's Fountain: 6 stacked vessels and siphon tubes. */
export function buildHeronInstances() {
  const steel = [0.62, 0.66, 0.72];
  const water = [0.35, 0.55, 0.72];
  return [
    packInstance([0, -2.2, 0], 0, [0, 0, 0, 1], steel, 0.05),          // lower basin
    packInstance([0, -0.4, 0], 0, [0, 0, 0, 1], steel, 0.04),          // sump
    packInstance([0, 2.0, 0], 0, [0, 0, 0, 1], water, 0.12),         // middle chamber
    packInstance([0, 4.8, 0], 0, [0, 0, 0, 1], water, 0.15),         // upper reservoir
    packInstance([-1.1, 3.2, 0], 0, quatFromAxisAngle([0, 0, 1], Math.PI / 2), steel, 0.06), // siphon L
    packInstance([1.1, 3.2, 0], 0, quatFromAxisAngle([0, 0, 1], Math.PI / 2), steel, 0.06)   // siphon R
  ];
}

/** Wide support platform under Heron vessels. ringIndex 11 = structural plate. */
export function buildHeronPlatformInstances() {
  const slate = [0.38, 0.42, 0.48];
  return [packInstance([0, -2.65, 0], 11, quatFromAxisAngle([1, 0, 0], Math.PI / 2), slate, 0.03)];
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

export function instancesToBufferData(instanceArrays) {
  const flat = instanceArrays.flat(Infinity);
  return new Float32Array(flat);
}

export function countInstances(data) {
  return data.length / INSTANCE_FLOATS;
}

export const DEVICE_MESH_LAYOUTS = {
  heron: { cylinders: buildHeronInstances, platform: buildHeronPlatformInstances },
  kelvin: {
    cylinders: () => [...buildKelvinInstances(), ...buildKelvinBucketInstances()],
    rings: buildKelvinRingInstances
  },
  solar: {
    cylinders: () => [...buildSolarLedInstances(), ...buildSolarBatteryInstance()],
    panel: buildSolarPanelInstance,
    platform: buildSolarMountInstances
  }
};
