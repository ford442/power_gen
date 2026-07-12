import { makeGeomBuffers } from './helpers.js';

// ----------------------------------------------------------------------------
// 3. PLATE WITH CUTOUTS (replaces flat annulus)
// ----------------------------------------------------------------------------
// Real SEG upper/lower plates have:
//   - Circular cutouts where rollers sit (like a colander)
//   - Bolt holes around the perimeter
//   - Radial reinforcement ribs
//   - 4-material-layer visible at edges
//
// Options:
//   innerRadius, outerRadius: plate dimensions
//   thickness: plate thickness
//   rollerCutouts: array of {angle, radius, size} for roller holes
//   boltHoles: number of bolt holes around perimeter
//   boltRadius: radius of each bolt hole
//   hasRibs: whether to add radial reinforcement ribs
//   ribCount: number of ribs
//   ribHeight: height of ribs above plate surface
//   segments: 64-128 (smoothness)
// ----------------------------------------------------------------------------
export function generatePlateWithCutouts(device, options = {}) {
  const {
    innerRadius = 0.3,
    outerRadius = 6.0,
    thickness = 0.25,
    rollerCutouts = [],  // e.g., [{angle: 0, radius: 2.5, size: 0.9}, ...]
    boltHoles = 12,
    boltRadius = 0.12,
    hasRibs = true,
    ribCount = 8,
    ribHeight = 0.08,
    segments = 96
  } = options;

  const vertices = [];
  const indices = [];
  const normals = [];
  const uvs = [];
  let vOff = 0;

  const h2 = thickness / 2;

  // Build the main plate as a series of arc segments, skipping cutout regions
  // For simplicity with cutouts, we use a radial stepping approach
  const radialSteps = 4; // inner, near-inner, near-outer, outer
  const ringRadii = [
    innerRadius,
    innerRadius + (outerRadius - innerRadius) * 0.25,
    innerRadius + (outerRadius - innerRadius) * 0.6,
    outerRadius
  ];

  function addRingVertices(radius, y, nx, ny, nz, vBase) {
    for (let i = 0; i <= segments; i++) {
      const theta = (i / segments) * Math.PI * 2;
      const c = Math.cos(theta), s = Math.sin(theta);
      // Check if this angle is in a cutout region
      let inCutout = false;
      for (const cut of rollerCutouts) {
        const angleDiff = Math.atan2(Math.sin(theta - cut.angle), Math.cos(theta - cut.angle));
        if (Math.abs(angleDiff) < cut.size / radius && Math.abs(radius - cut.radius) < cut.size) {
          inCutout = true;
          break;
        }
      }
      const r = inCutout ? radius * 0.3 : radius; // Taper in for cutouts (visual approximation)
      vertices.push(c * r, y, s * r);
      normals.push(nx, ny, nz);
      uvs.push((c + 1) * 0.5, (s + 1) * 0.5);
    }
    return segments + 1;
  }

  // Generate plate body as concentric rings
  for (let ring = 0; ring < radialSteps - 1; ring++) {
    const rInner = ringRadii[ring];
    const rOuter = ringRadii[ring + 1];

    const topInnerBase = vOff;
    addRingVertices(rInner, h2, 0, 1, 0, 0);
    vOff += segments + 1;

    const topOuterBase = vOff;
    addRingVertices(rOuter, h2, 0, 1, 0, 0);
    vOff += segments + 1;

    // Top face quads between rings
    for (let i = 0; i < segments; i++) {
      const a = topInnerBase + i;
      const b = topOuterBase + i;
      const an = topInnerBase + i + 1;
      const bn = topOuterBase + i + 1;
      indices.push(a, b, an, an, b, bn);
    }

    // Bottom face
    const botInnerBase = vOff;
    addRingVertices(rInner, -h2, 0, -1, 0, 0);
    vOff += segments + 1;

    const botOuterBase = vOff;
    addRingVertices(rOuter, -h2, 0, -1, 0, 0);
    vOff += segments + 1;

    for (let i = 0; i < segments; i++) {
      const a = botInnerBase + i;
      const b = botOuterBase + i;
      const an = botInnerBase + i + 1;
      const bn = botOuterBase + i + 1;
      indices.push(a, an, b, b, an, bn);
    }

    // Outer rim wall
    const rimBase = vOff;
    for (let i = 0; i <= segments; i++) {
      const theta = (i / segments) * Math.PI * 2;
      const c = Math.cos(theta), s = Math.sin(theta);
      vertices.push(c * rOuter, h2, s * rOuter);
      normals.push(c, 0, s);
      uvs.push(i / segments, 1);
      vertices.push(c * rOuter, -h2, s * rOuter);
      normals.push(c, 0, s);
      uvs.push(i / segments, 0);
      vOff += 2;
    }
    for (let i = 0; i < segments; i++) {
      const b = rimBase + i * 2;
      const n = rimBase + ((i + 1) % (segments + 1)) * 2;
      indices.push(b, n, b + 1, b + 1, n, n + 1);
    }
  }

  // Bolt heads with hexagonal caps and washers around the plate perimeter.
  if (boltHoles > 0) {
    const boltCircleRadius = outerRadius * 0.92;
    for (let b = 0; b < boltHoles; b++) {
      const angle = (b / boltHoles) * Math.PI * 2;
      const bx = Math.cos(angle) * boltCircleRadius;
      const bz = Math.sin(angle) * boltCircleRadius;

      const headHeight = 0.07;
      const headRadius = boltRadius * 0.95;
      const washerInner = boltRadius * 1.05;
      const washerOuter = boltRadius * 1.65;
      const hexBase = vOff;

      // Hexagonal bolt head: top rim + bottom rim.
      for (let i = 0; i < 6; i++) {
        const t = (i / 6) * Math.PI * 2;
        const c = Math.cos(t), s = Math.sin(t);
        vertices.push(bx + c * headRadius, h2 + headHeight, bz + s * headRadius);
        normals.push(0, 1, 0);
        uvs.push(i / 6, 1);

        vertices.push(bx + c * headRadius, h2, bz + s * headRadius);
        normals.push(c * 0.85, 0.35, s * 0.85); // bevelled side wall normal
        uvs.push(i / 6, 0);
        vOff += 2;
      }
      // Hex cap centre.
      const hexCenter = vOff;
      vertices.push(bx, h2 + headHeight, bz);
      normals.push(0, 1, 0);
      uvs.push(0.5, 0.5);
      vOff += 1;

      // Top hex cap (6 triangles).
      for (let i = 0; i < 6; i++) {
        const curr = hexBase + i * 2;
        const next = hexBase + ((i + 1) % 6) * 2;
        indices.push(hexCenter, next, curr);
      }
      // Hex side walls (2 triangles per face).
      for (let i = 0; i < 6; i++) {
        const curr = hexBase + i * 2;
        const next = hexBase + ((i + 1) % 6) * 2;
        indices.push(curr, next, curr + 1);
        indices.push(next, next + 1, curr + 1);
      }

      // Washer ring at the base of the bolt.
      const washerBase = vOff;
      const washerSegs = 16;
      for (let i = 0; i <= washerSegs; i++) {
        const t = (i / washerSegs) * Math.PI * 2;
        const c = Math.cos(t), s = Math.sin(t);
        vertices.push(bx + c * washerInner, h2 + 0.005, bz + s * washerInner);
        normals.push(0, 1, 0);
        uvs.push(i / washerSegs, 0);

        vertices.push(bx + c * washerOuter, h2 + 0.005, bz + s * washerOuter);
        normals.push(0, 1, 0);
        uvs.push(i / washerSegs, 1);
        vOff += 2;
      }
      for (let i = 0; i < washerSegs; i++) {
        const curr = washerBase + i * 2;
        const next = washerBase + ((i + 1) % (washerSegs + 1)) * 2;
        indices.push(curr, next, curr + 1);
        indices.push(next, next + 1, curr + 1);
      }
    }
  }

  // Radial reinforcement ribs with side walls so they read as raised structural webs.
  if (hasRibs) {
    for (let r = 0; r < ribCount; r++) {
      const angle = (r / ribCount) * Math.PI * 2;
      const c = Math.cos(angle), s = Math.sin(angle);
      const ribBase = vOff;
      const ribWidth = (outerRadius - innerRadius) * 0.07;
      const rStart = innerRadius + (outerRadius - innerRadius) * 0.15;
      const rEnd = outerRadius * 0.86;

      for (let step = 0; step <= 8; step++) {
        const t = step / 8;
        const rad = rStart + t * (rEnd - rStart);
        const w2 = ribWidth / 2 * (1 - Math.abs(t - 0.5) * 0.25); // slight taper

        // Rib centre at plate height.
        const cx = c * rad;
        const cz = s * rad;

        // Side normals point tangentially outward from the rib direction.
        const nlx = -s, nlz = c; // left wall outward
        const nrx = s, nrz = -c; // right wall outward

        // Left bottom, right bottom, left top, right top.
        vertices.push(cx - s * w2, h2, cz + c * w2);
        normals.push(nlx, 0, nlz);
        uvs.push(t, 0);

        vertices.push(cx + s * w2, h2, cz - c * w2);
        normals.push(nrx, 0, nrz);
        uvs.push(t, 0);

        vertices.push(cx - s * w2, h2 + ribHeight, cz + c * w2);
        normals.push(0, 1, 0);
        uvs.push(t, 1);

        vertices.push(cx + s * w2, h2 + ribHeight, cz - c * w2);
        normals.push(0, 1, 0);
        uvs.push(t, 1);
        vOff += 4;
      }

      for (let i = 0; i < 8; i++) {
        const b = ribBase + i * 4;
        const n = ribBase + (i + 1) * 4;
        // Top face
        indices.push(b + 2, n + 2, n + 3, b + 2, n + 3, b + 3);
        // Left side wall
        indices.push(b, n, n + 2, b, n + 2, b + 2);
        // Right side wall
        indices.push(b + 1, b + 3, n + 1, n + 1, b + 3, n + 3);
      }
    }
  }

  // Pack: position(3) + normal(3) + uv(2)
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
