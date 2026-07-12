import { makeGeomBuffers } from './helpers.js';

// ----------------------------------------------------------------------------
// 4. SUPPORT STAND / LEGS
// ----------------------------------------------------------------------------
// Real SEG devices sit on a base with support legs or mounting brackets.
// This generates a tripod/quadropod stand with a circular base plate.
//
// Options:
//   legCount: 3-6 (number of support legs)
//   legRadius: 0.08-0.2 (leg tube radius)
//   legLength: 3-6 (leg length from center)
//   baseRadius: 2-4 (base plate radius)
//   baseThickness: 0.15-0.3
//   height: 1-3 (vertical height of stand)
//   footRadius: 0.3-0.6 (foot pad radius)
//   segments: 16-32
// ----------------------------------------------------------------------------
export function generateSupportStand(device, options = {}) {
  const {
    legCount = 4,
    legRadius = 0.12,
    legLength = 4.0,
    baseRadius = 2.5,
    baseThickness = 0.20,
    height = 2.0,
    footRadius = 0.4,
    segments = 24,
    // When set, the annular platform sits at platformY and legs drop to platformY - height.
    platformY = null
  } = options;

  const yShift = platformY !== null ? platformY + height : 0;

  const vertices = [];
  const indices = [];
  const normals = [];
  const uvs = [];
  let vOff = 0;

  // Central base plate (annulus)
  const h2 = baseThickness / 2;
  for (let i = 0; i <= segments; i++) {
    const theta = (i / segments) * Math.PI * 2;
    const c = Math.cos(theta), s = Math.sin(theta);
    // Top inner, top outer, bottom inner, bottom outer, outer wall
    const rIn = baseRadius * 0.2;
    const rOut = baseRadius;

    vertices.push(c * rIn, -height + h2 + yShift, s * rIn);
    normals.push(0, 1, 0);
    uvs.push(0, i / segments);

    vertices.push(c * rOut, -height + h2 + yShift, s * rOut);
    normals.push(0, 1, 0);
    uvs.push(1, i / segments);

    vertices.push(c * rIn, -height - h2 + yShift, s * rIn);
    normals.push(0, -1, 0);
    uvs.push(0, i / segments);

    vertices.push(c * rOut, -height - h2 + yShift, s * rOut);
    normals.push(0, -1, 0);
    uvs.push(1, i / segments);

    vertices.push(c * rOut, -height + h2 + yShift, s * rOut);
    normals.push(c, 0, s);
    uvs.push(i / segments, 1);

    vertices.push(c * rOut, -height - h2 + yShift, s * rOut);
    normals.push(c, 0, s);
    uvs.push(i / segments, 0);
    vOff += 6;
  }
  const baseStart = 0;
  for (let i = 0; i < segments; i++) {
    const b = baseStart + i * 6;
    const n = baseStart + ((i + 1) % (segments + 1)) * 6;
    indices.push(b, n, b + 1, b + 1, n, n + 1);         // top
    indices.push(b + 2, b + 3, n + 2, n + 2, b + 3, n + 3); // bottom
    indices.push(b + 4, b + 5, n + 4, n + 4, b + 5, n + 5); // outer wall
  }

  // Legs angled outward
  for (let l = 0; l < legCount; l++) {
    const angle = (l / legCount) * Math.PI * 2 + Math.PI / legCount;
    const c = Math.cos(angle), s = Math.sin(angle);

    // Leg goes from center-bottom to outer edge at a slight angle
    const startX = c * baseRadius * 0.3;
    const startZ = s * baseRadius * 0.3;
    const startY = -height + baseThickness + yShift;

    const endX = c * legLength;
    const endZ = s * legLength;
    const endY = -height - legLength * 0.4 + yShift; // Angled downward

    // Build leg as a tapered cylinder
    const legSegs = 8;
    const legStartIdx = vOff;
    const topR = legRadius * 1.2;
    const botR = legRadius * 0.8;

    // Build leg in segments
    const legSteps = 6;
    for (let step = 0; step <= legSteps; step++) {
      const t = step / legSteps;
      const lx = startX + (endX - startX) * t;
      const ly = startY + (endY - startY) * t;
      const lz = startZ + (endZ - startZ) * t;
      const r = topR + (botR - topR) * t;

      // Tangent vector for orientation
      const tx = endX - startX;
      const ty = endY - startY;
      const tz = endZ - startZ;
      const tlen = Math.sqrt(tx * tx + ty * ty + tz * tz);
      const tnx = tx / tlen, tny = ty / tlen, tnz = tz / tlen;

      for (let i = 0; i <= legSegs; i++) {
        const phi = (i / legSegs) * Math.PI * 2;
        // Perpendicular vectors
        let px, py, pz;
        if (Math.abs(tny) < 0.9) {
          px = tnz; py = 0; pz = -tnx;
        } else {
          px = 1; py = 0; pz = 0;
        }
        const plen = Math.sqrt(px * px + py * py + pz * pz);
        px /= plen; py /= plen; pz /= plen;
        // Cross product for second perpendicular
        const qx = tny * pz - tnz * py;
        const qy = tnz * px - tnx * pz;
        const qz = tnx * py - tny * px;

        const nx2 = Math.cos(phi) * px + Math.sin(phi) * qx;
        const ny2 = Math.cos(phi) * py + Math.sin(phi) * qy;
        const nz2 = Math.cos(phi) * pz + Math.sin(phi) * qz;

        vertices.push(lx + nx2 * r, ly + ny2 * r, lz + nz2 * r);
        normals.push(nx2, ny2, nz2);
        uvs.push(i / legSegs, t);
        vOff++;
      }
    }

    // Indices for leg tube
    for (let step = 0; step < legSteps; step++) {
      for (let i = 0; i < legSegs; i++) {
        const a = legStartIdx + step * (legSegs + 1) + i;
        const b = a + legSegs + 1;
        const an = a + 1;
        const bn = b + 1;
        indices.push(a, b, an, an, b, bn);
      }
    }

    // Foot pad at end of each leg
    const footIdx = vOff;
    const footY = endY;
    for (let i = 0; i <= segments; i++) {
      const theta = (i / segments) * Math.PI * 2;
      const fc = Math.cos(theta), fs = Math.sin(theta);
      vertices.push(endX + fc * footRadius, footY, endZ + fs * footRadius);
      normals.push(0, -1, 0);
      uvs.push((fc + 1) * 0.5, (fs + 1) * 0.5);
      vOff++;
    }
    // Foot center
    vertices.push(endX, footY - 0.05, endZ);
    normals.push(0, -1, 0);
    uvs.push(0.5, 0.5);
    const footCenter = vOff;
    vOff++;
    for (let i = 0; i < segments; i++) {
      indices.push(footCenter, footIdx + i, footIdx + i + 1);
    }
  }

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
