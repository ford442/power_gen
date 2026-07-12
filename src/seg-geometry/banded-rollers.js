import {
  poleTintColor,
  computeRollerRotation,
  isNorthPole
} from '../seg-roller-model.js';

// ----------------------------------------------------------------------------
// 7. ENHANCED ROLLER INSTANCE DATA (for use in update loop)
// ----------------------------------------------------------------------------
// Generates per-roller instance data with material variation for the
// pole banding effect. Each roller gets alternating magnetic pole colors.
//
// Call this inside your update() loop to populate the instance buffer
// with banded roller data instead of uniform copper.
//
// Returns: Float32Array of instance data compatible with existing shader
// Format per instance: position(3) + ringIndex(1) + rotation(4) + color(3) + emissive(1)
// ----------------------------------------------------------------------------
export function generateBandedRollerInstances(time, rings, options = {}) {
  const {
    useHardwarePhase = false,
    hardwarePhaseRad = 0,
    prototypePreset = 'showroom'
  } = options;

  const totalRollers = rings.reduce((sum, r) => sum + r.count, 0);
  const instanceData = new Float32Array(totalRollers * 12);
  let rollerOffset = 0;

  for (const ring of rings) {
    for (let i = 0; i < ring.count; i++) {
      const idx = rollerOffset * 12;
      let angle;
      if (useHardwarePhase) {
        angle = (i / ring.count) * Math.PI * 2 + hardwarePhaseRad * ring.speed;
      } else {
        angle = (i / ring.count) * Math.PI * 2 + time * 0.5 * ring.speed;
      }

      instanceData[idx] = Math.cos(angle) * ring.radius;
      instanceData[idx + 1] = 0;
      instanceData[idx + 2] = Math.sin(angle) * ring.radius;
      instanceData[idx + 3] = ring.index;

      const rot = computeRollerRotation(angle, ring.radius, ring.scale || ring.radius * 0.3);
      instanceData[idx + 4] = rot[0];
      instanceData[idx + 5] = rot[1];
      instanceData[idx + 6] = rot[2];
      instanceData[idx + 7] = rot[3];

      const color = poleTintColor(ring.index, i, prototypePreset);
      instanceData[idx + 8] = color[0];
      instanceData[idx + 9] = color[1];
      instanceData[idx + 10] = color[2];
      instanceData[idx + 11] = isNorthPole(ring.index, i) ? 0.08 : 0.0;

      rollerOffset++;
    }
  }

  return instanceData;
}
