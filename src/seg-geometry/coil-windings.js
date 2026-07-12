import { makeGeomBuffers } from './helpers.js';

// ----------------------------------------------------------------------------
// 6. COIL WITH WINDINGS (replaces simple torus)
// ----------------------------------------------------------------------------
// Real SEG electromagnets show visible copper wire windings.
// This generates a coil with a winding pattern using a torus base
// with added helical wire detail.
//
// Options:
//   majorRadius: 5-10 (distance from center to coil center)
//   minorRadius: 0.3-0.8 (coil tube radius)
//   wireRadius: 0.01-0.03 (individual wire radius)
//   turns: 50-200 (number of winding turns)
//   majorSegments: 64-128
//   minorSegments: 12-24
// ----------------------------------------------------------------------------
export function generateCoilWithWindings(device, options = {}) {
  const {
    majorRadius = 9.0,
    minorRadius = 0.5,
    wireRadius = 0.02,
    turns = 80,
    majorSegments = 96,
    minorSegments = 16
  } = options;

  const vertices = [];
  const indices = [];
  const normals = [];
  const uvs = [];
  let vOff = 0;

  // Base torus (coil form/bobbin)
  for (let maj = 0; maj <= majorSegments; maj++) {
    const theta = (maj / majorSegments) * Math.PI * 2;
    const c = Math.cos(theta), s = Math.sin(theta);
    const cx = c * majorRadius;
    const cz = s * majorRadius;

    for (let min = 0; min <= minorSegments; min++) {
      const phi = (min / minorSegments) * Math.PI * 2;
      const nx = Math.cos(phi) * c;
      const ny = Math.sin(phi);
      const nz = Math.cos(phi) * s;

      vertices.push(cx + nx * minorRadius, ny * minorRadius, cz + nz * minorRadius);
      normals.push(nx, ny, nz);
      uvs.push(maj / majorSegments, min / minorSegments);
      vOff++;
    }
  }

  for (let maj = 0; maj < majorSegments; maj++) {
    for (let min = 0; min < minorSegments; min++) {
      const a = maj * (minorSegments + 1) + min;
      const b = a + minorSegments + 1;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }

  // Helical winding wire on surface
  const wireSegs = turns * 4;
  const wireBase = vOff;
  const coilOuterR = minorRadius + wireRadius * 1.5;

  for (let i = 0; i <= wireSegs; i++) {
    const t = i / wireSegs;
    const theta = t * Math.PI * 2 * (turns / majorSegments); // Winding progression
    const majT = t * majorSegments;
    const majAngle = majT / majorSegments * Math.PI * 2;

    const c = Math.cos(majAngle), s = Math.sin(majAngle);
    // Helical offset on torus surface
    const helixAngle = t * turns * Math.PI * 2;
    const hx = Math.cos(helixAngle) * wireRadius;
    const hy = Math.sin(helixAngle) * wireRadius;

    const worldX = c * majorRadius + c * (coilOuterR + hx);
    const worldY = hy;
    const worldZ = s * majorRadius + s * (coilOuterR + hx);

    // Normal points outward from wire center
    const nx = c * Math.cos(helixAngle);
    const ny = Math.sin(helixAngle);
    const nz = s * Math.cos(helixAngle);
    const nlen = Math.sqrt(nx * nx + ny * ny + nz * nz);

    vertices.push(worldX, worldY, worldZ);
    normals.push(nx / nlen, ny / nlen, nz / nlen);
    uvs.push(t, 0.5);
    vOff++;
  }

  // Wire tube indices
  const wireRadialSegs = 6;
  // (Simplified: just the helix centerline for now - can be expanded)

  // Pack: position(3) + normal(3) + uv(2)
  const vertexData = new Float32Array(vOff * 8);
  for (let i = 0; i < vOff; i++) {
    vertexData[i * 8] = vertices[i * 3];
    vertexData[i * 8 + 1] = vertices[i * 3 + 1];
    vertexData[i * 8 + 2] = vertices[i * 3 + 2];
    vertexData[i * 8 + 3] = normals[i * 3];
    vertexData[i * 8 + 4] = normals[i * 3 + 1];
    vertexData[i * 8 + 5] = normals[i * 3 + 2];
    vertexData[i * 8 + 6] = uvs[i * 2];
    vertexData[i * 8 + 7] = uvs[i * 2 + 1];
  }

  return makeGeomBuffers(device, {
    vertices: vertexData,
    indices: new Uint16Array(indices)
  });
}
