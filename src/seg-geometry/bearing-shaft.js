import { makeGeomBuffers } from './helpers.js';

export function generateBearingShaft(device, options = {}) {
  const {
    shaftRadius = 0.6,
    shaftHeight = 3.0,
    flangeRadius = 1.5,
    flangeThickness = 0.20,
    topRingRadius = 1.1,
    topRingThickness = 0.15,
    segments = 48
  } = options;

  const vertices = [];
  const indices = [];
  const normals = [];
  const uvs = [];  // UV for material mapping
  let vOffset = 0;

  // Helper: add cylinder section (vertical shaft)
  function addCylinder(radius, height, yCenter, segs) {
    const baseIdx = vOffset;
    const h2 = height / 2;
    // Top face
    vertices.push(0, yCenter + h2, 0);
    normals.push(0, 1, 0);
    uvs.push(0.5, 0.5);
    // Bottom face center
    vertices.push(0, yCenter - h2, 0);
    normals.push(0, -1, 0);
    uvs.push(0.5, 0.5);
    vOffset += 2;

    // Rim vertices
    for (let i = 0; i <= segs; i++) {
      const theta = (i / segs) * Math.PI * 2;
      const c = Math.cos(theta), s = Math.sin(theta);
      // Top rim
      vertices.push(c * radius, yCenter + h2, s * radius);
      normals.push(0, 1, 0);
      uvs.push((c + 1) * 0.5, (s + 1) * 0.5);
      // Bottom rim
      vertices.push(c * radius, yCenter - h2, s * radius);
      normals.push(0, -1, 0);
      uvs.push((c + 1) * 0.5, (s + 1) * 0.5);
      // Side top
      vertices.push(c * radius, yCenter + h2, s * radius);
      normals.push(c, 0, s);
      uvs.push(i / segs, 1);
      // Side bottom
      vertices.push(c * radius, yCenter - h2, s * radius);
      normals.push(c, 0, s);
      uvs.push(i / segs, 0);
      vOffset += 4;
    }

    // Indices for top and bottom caps + side
    for (let i = 0; i < segs; i++) {
      const rim = 2 + i * 4;
      const next = 2 + ((i + 1) % (segs + 1)) * 4;
      // Top cap
      indices.push(baseIdx, next, rim);
      // Bottom cap
      indices.push(baseIdx + 1, rim + 1, next + 1);
      // Side (two triangles)
      indices.push(rim + 2, next + 2, rim + 3);
      indices.push(rim + 3, next + 2, next + 3);
    }
  }

  // Helper: add annular ring (flange or retaining ring)
  function addAnnulus(innerR, outerR, thickness, yCenter, segs) {
    const baseIdx = vOffset;
    const h2 = thickness / 2;
    for (let i = 0; i <= segs; i++) {
      const theta = (i / segs) * Math.PI * 2;
      const c = Math.cos(theta), s = Math.sin(theta);
      // Top inner, top outer, bottom inner, bottom outer, outer side top, outer side bottom
      vertices.push(c * innerR, yCenter + h2, s * innerR);
      normals.push(0, 1, 0);
      uvs.push(0, i / segs);

      vertices.push(c * outerR, yCenter + h2, s * outerR);
      normals.push(0, 1, 0);
      uvs.push(1, i / segs);

      vertices.push(c * innerR, yCenter - h2, s * innerR);
      normals.push(0, -1, 0);
      uvs.push(0, i / segs);

      vertices.push(c * outerR, yCenter - h2, s * outerR);
      normals.push(0, -1, 0);
      uvs.push(1, i / segs);

      vertices.push(c * outerR, yCenter + h2, s * outerR);
      normals.push(c, 0, s);
      uvs.push(i / segs, 1);

      vertices.push(c * outerR, yCenter - h2, s * outerR);
      normals.push(c, 0, s);
      uvs.push(i / segs, 0);

      vertices.push(c * innerR, yCenter + h2, s * innerR);
      normals.push(-c, 0, -s);
      uvs.push(i / segs, 1);

      vertices.push(c * innerR, yCenter - h2, s * innerR);
      normals.push(-c, 0, -s);
      uvs.push(i / segs, 0);
      vOffset += 8;
    }
    for (let i = 0; i < segs; i++) {
      const b = baseIdx + i * 8;
      const n = baseIdx + ((i + 1) % (segs + 1)) * 8;
      // Top face
      indices.push(b, n, b + 1, b + 1, n, n + 1);
      // Bottom face
      indices.push(b + 2, b + 3, n + 2, n + 2, b + 3, n + 3);
      // Outer side
      indices.push(b + 4, b + 5, n + 4, n + 4, b + 5, n + 5);
      // Inner side
      indices.push(b + 6, n + 6, b + 7, b + 7, n + 6, n + 7);
    }
  }

  // Build the shaft assembly
  // Main vertical shaft
  addCylinder(shaftRadius, shaftHeight, 0, segments);
  // Bottom flange
  addAnnulus(shaftRadius * 1.1, flangeRadius, flangeThickness, -shaftHeight / 2 - flangeThickness / 2, segments);
  // Top retaining ring
  addAnnulus(shaftRadius * 1.05, topRingRadius, topRingThickness, shaftHeight / 2 + topRingThickness / 2, segments);

  // Pack into interleaved vertex format: position(3) + normal(3) + uv(2)
  const vertexData = new Float32Array(vertices.length / 3 * 8);
  for (let i = 0; i < vertices.length / 3; i++) {
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
