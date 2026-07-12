import { makeGeomBuffers } from './helpers.js';

// ----------------------------------------------------------------------------
// 5. WIRE HARNESS / CABLE BETWEEN POINTS
// ----------------------------------------------------------------------------
// Generates a curved wire/cable connecting two points with a natural sag.
// Used for wiring between electromagnets and external connections.
//
// Options:
//   start: [x, y, z] - wire start point
//   end: [x, y, z] - wire end point
//   control: [x, y, z] - bezier control point (for curve)
//   radius: 0.02-0.08 - wire thickness
//   segments: 16-32 (along length) / 8-12 (radial)
//   sag: 0.0-1.0 - amount of natural droop (auto-computed if control not given)
// ----------------------------------------------------------------------------
export function generateWireHarness(device, options = {}) {
  const {
    start = [0, 0, 0],
    end = [5, 0, 0],
    control = null,
    radius = 0.04,
    segments = 24,
    radialSegs = 8,
    sag = 0.3
  } = options;

  // Compute control point with sag if not provided
  let ctrl = control;
  if (!ctrl) {
    const midX = (start[0] + end[0]) / 2;
    const midY = Math.min(start[1], end[1]) - sag * Math.sqrt(
      (end[0] - start[0]) ** 2 +
      (end[2] - start[2]) ** 2
    ) * 0.15;
    const midZ = (start[2] + end[2]) / 2;
    ctrl = [midX, midY, midZ];
  }

  // Quadratic bezier evaluation
  function bezier(t) {
    const omt = 1 - t;
    return [
      omt * omt * start[0] + 2 * omt * t * ctrl[0] + t * t * end[0],
      omt * omt * start[1] + 2 * omt * t * ctrl[1] + t * t * end[1],
      omt * omt * start[2] + 2 * omt * t * ctrl[2] + t * t * end[2]
    ];
  }

  function bezierTangent(t) {
    const omt = 1 - t;
    const dx = 2 * omt * (ctrl[0] - start[0]) + 2 * t * (end[0] - ctrl[0]);
    const dy = 2 * omt * (ctrl[1] - start[1]) + 2 * t * (end[1] - ctrl[1]);
    const dz = 2 * omt * (ctrl[2] - start[2]) + 2 * t * (end[2] - ctrl[2]);
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    return [dx / len, dy / len, dz / len];
  }

  const vertices = [];
  const indices = [];
  const normals = [];
  const uvs = [];

  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const pos = bezier(t);
    const tangent = bezierTangent(t);

    // Build perpendicular frame
    let px, py, pz;
    if (Math.abs(tangent[1]) < 0.9) {
      px = tangent[2]; py = 0; pz = -tangent[0];
    } else {
      px = 1; py = 0; pz = 0;
    }
    const plen = Math.sqrt(px * px + py * py + pz * pz);
    px /= plen; py /= plen; pz /= plen;

    const qx = tangent[1] * pz - tangent[2] * py;
    const qy = tangent[2] * px - tangent[0] * pz;
    const qz = tangent[0] * py - tangent[1] * px;

    for (let j = 0; j <= radialSegs; j++) {
      const phi = (j / radialSegs) * Math.PI * 2;
      const c = Math.cos(phi), s = Math.sin(phi);
      const nx2 = c * px + s * qx;
      const ny2 = c * py + s * qy;
      const nz2 = c * pz + s * qz;

      vertices.push(pos[0] + nx2 * radius, pos[1] + ny2 * radius, pos[2] + nz2 * radius);
      normals.push(nx2, ny2, nz2);
      uvs.push(j / radialSegs, t);
    }
  }

  for (let i = 0; i < segments; i++) {
    for (let j = 0; j < radialSegs; j++) {
      const a = i * (radialSegs + 1) + j;
      const b = a + radialSegs + 1;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }

  // Pack: position(3) + normal(3) + uv(2)
  const vCount = vertices.length / 3;
  const vertexData = new Float32Array(vCount * 8);
  for (let i = 0; i < vCount; i++) {
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
