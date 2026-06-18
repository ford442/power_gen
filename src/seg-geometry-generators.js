// ============================================================================
// SEG Geometry Generators
// ============================================================================
// Generator functions for creating detailed, photo-realistic SEG geometry.
// Used for enhancing the basic primitives with detailed 3D models.
//
// WebGL2 path: basic cylinders/discs live in src/renderers/shared/primitive-geometry.js
// (CPU Float32Array output, uploaded to GL buffers). Enhanced PBR meshes here remain
// WebGPU-first; port to WebGL2 by reusing the same vertex/index arrays.

import { SEGMaterialPresets } from './seg-materials.js';

// Helper: Create GPU vertex + index buffer pair
function _makeGeomBuffers(device, data) {
  const vb = device.createBuffer({
    size: data.vertices.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
  });
  device.queue.writeBuffer(vb, 0, data.vertices);
  const ib = device.createBuffer({
    size: data.indices.byteLength,
    usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST
  });
  device.queue.writeBuffer(ib, 0, data.indices);
  return { vertexBuffer: vb, indexBuffer: ib, indexCount: data.indices.length };
}

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

  return _makeGeomBuffers(device, {
    vertices: vertexData,
    indices: new Uint16Array(indices)
  });
}

// ----------------------------------------------------------------------------
// 2. POLE-BANDED ROLLER (replaces smooth cylinder)
// ----------------------------------------------------------------------------
// Prototype-accurate SEG roller geometry.
//
// Reference grounding (rexresearch.com/searl4, Roschin-Godin reports):
//   - Real rollers are 8 stacked segments held together magnetically
//     (~34 g each, machined to ±0.05 g), separated by fine seam grooves.
//   - The visible barrel is the outer copper/aluminum sleeve; axial seams are
//     darkened/oxidized grooves.
//   - The radial layer composition (visible on the flat end faces) is:
//       1. Neodymium core          — electron reservoir, silver-gray
//       2. Nylon 66 / Teflon       — electron flow regulator, off-white/ivory
//       3. Iron or Nickel          — magnetized accelerator, bright nickel
//       4. Copper or Aluminum      — outer paramagnetic sleeve
//
// This generator builds:
//   - A single top and bottom end-cap disk (shader draws concentric rings).
//   - 8 axial barrel segments of the outer sleeve.
//   - 7 recessed groove rings between segments.
//
// Shader UV convention:
//   - End caps:   uv.x = angle/2π,  uv.y = radial fraction (0 center -> 1 edge)
//   - Barrel:     uv.x = angle/2π,  uv.y = height fraction (0 bottom -> 1 top)
//   - Grooves:    uv.x = angle/2π,  uv.y = height fraction at groove center
// ----------------------------------------------------------------------------
export function generatePoleBandedRoller(device, options = {}) {
  const {
    radius = 0.75,
    height = 2.8,
    segments = 64,
    bands = 8,
    grooveDepth = 0.035,
    grooveWidth = 0.045
  } = options;

  const vertices = [];
  const indices = [];
  const normals = [];
  const uvs = [];
  let vOffset = 0;

  function addVertex(px, py, pz, nx, ny, nz, u, v) {
    vertices.push(px, py, pz);
    normals.push(nx, ny, nz);
    uvs.push(u, v);
    return vOffset++;
  }

  // --- End caps (single disks; shader colors concentric rings by radius) ---
  function addCap(y, ny) {
    const centerIdx = addVertex(0, y, 0, 0, ny, 0, 0.5, 0.0);
    const rimStart = vOffset;
    for (let i = 0; i <= segments; i++) {
      const theta = (i / segments) * Math.PI * 2;
      const c = Math.cos(theta), s = Math.sin(theta);
      addVertex(c * radius, y, s * radius, 0, ny, 0, i / segments, 1.0);
    }
    for (let i = 0; i < segments; i++) {
      const curr = rimStart + i;
      const next = rimStart + ((i + 1) % (segments + 1));
      // Winding order depends on cap normal
      if (ny > 0.0) {
        indices.push(centerIdx, next, curr);
      } else {
        indices.push(centerIdx, curr, next);
      }
    }
  }

  addCap(height * 0.5, 1.0);
  addCap(-height * 0.5, -1.0);

  // --- Barrel segments (outer sleeve) ---
  const bandHeight = (height - grooveWidth * (bands - 1)) / bands;
  for (let b = 0; b < bands; b++) {
    const yBottom = -height * 0.5 + b * (bandHeight + grooveWidth);
    const yTop = yBottom + bandHeight;
    const vBottom = (yBottom + height * 0.5) / height;
    const vTop = (yTop + height * 0.5) / height;

    const baseIdx = vOffset;
    for (let i = 0; i <= segments; i++) {
      const theta = (i / segments) * Math.PI * 2;
      const c = Math.cos(theta), s = Math.sin(theta);
      // Top rim
      addVertex(c * radius, yTop, s * radius, c, 0.0, s, i / segments, vTop);
      // Bottom rim
      addVertex(c * radius, yBottom, s * radius, c, 0.0, s, i / segments, vBottom);
    }
    for (let i = 0; i < segments; i++) {
      const curr = baseIdx + i * 2;
      const next = baseIdx + ((i + 1) % (segments + 1)) * 2;
      indices.push(curr, next, curr + 1);
      indices.push(next, next + 1, curr + 1);
    }
  }

  // --- Groove rings between segments (recessed, with inward-facing normals) ---
  const grooveRadius = Math.max(radius - grooveDepth, 0.01);
  for (let b = 0; b < bands - 1; b++) {
    const yCenter = -height * 0.5 + (b + 1) * (bandHeight + grooveWidth) - grooveWidth * 0.5;
    const vCenter = (yCenter + height * 0.5) / height;
    const baseIdx = vOffset;

    for (let i = 0; i <= segments; i++) {
      const theta = (i / segments) * Math.PI * 2;
      const c = Math.cos(theta), s = Math.sin(theta);
      // Inner wall top/bottom (faces inward, normal points toward axis)
      addVertex(c * grooveRadius, yCenter + grooveWidth * 0.5, s * grooveRadius, -c, 0.0, -s, i / segments, vCenter);
      addVertex(c * grooveRadius, yCenter - grooveWidth * 0.5, s * grooveRadius, -c, 0.0, -s, i / segments, vCenter);
      // Outer wall top/bottom (flush with barrel, normal points outward)
      addVertex(c * radius, yCenter + grooveWidth * 0.5, s * radius, c, 0.0, s, i / segments, vCenter);
      addVertex(c * radius, yCenter - grooveWidth * 0.5, s * radius, c, 0.0, s, i / segments, vCenter);
    }

    for (let i = 0; i < segments; i++) {
      const curr = baseIdx + i * 4;
      const next = baseIdx + ((i + 1) % (segments + 1)) * 4;
      // Outer wall
      indices.push(curr + 2, next + 2, curr + 3);
      indices.push(next + 2, next + 3, curr + 3);
      // Inner wall
      indices.push(curr, curr + 1, next);
      indices.push(next, curr + 1, next + 1);
      // Top wall (faces +y)
      indices.push(curr + 2, next + 2, curr);
      indices.push(next + 2, next, curr);
      // Bottom wall (faces -y)
      indices.push(curr + 3, curr + 1, next + 3);
      indices.push(next + 3, curr + 1, next + 1);
    }
  }

  // Pack interleaved: position(3) + normal(3) + uv(2)
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

  return _makeGeomBuffers(device, {
    vertices: vertexData,
    indices: new Uint16Array(indices)
  });
}

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

  return _makeGeomBuffers(device, {
    vertices: vertexData,
    indices: new Uint16Array(indices)
  });
}

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
    segments = 24
  } = options;

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

    vertices.push(c * rIn, -height + h2, s * rIn);
    normals.push(0, 1, 0);
    uvs.push(0, i / segments);

    vertices.push(c * rOut, -height + h2, s * rOut);
    normals.push(0, 1, 0);
    uvs.push(1, i / segments);

    vertices.push(c * rIn, -height - h2, s * rIn);
    normals.push(0, -1, 0);
    uvs.push(0, i / segments);

    vertices.push(c * rOut, -height - h2, s * rOut);
    normals.push(0, -1, 0);
    uvs.push(1, i / segments);

    vertices.push(c * rOut, -height + h2, s * rOut);
    normals.push(c, 0, s);
    uvs.push(i / segments, 1);

    vertices.push(c * rOut, -height - h2, s * rOut);
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
    const startY = -height + baseThickness;

    const endX = c * legLength;
    const endZ = s * legLength;
    const endY = -height - legLength * 0.4; // Angled downward

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

  return _makeGeomBuffers(device, {
    vertices: vertexData,
    indices: new Uint16Array(indices)
  });
}

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

  return _makeGeomBuffers(device, {
    vertices: vertexData,
    indices: new Uint16Array(indices)
  });
}

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

  return _makeGeomBuffers(device, {
    vertices: vertexData,
    indices: new Uint16Array(indices)
  });
}

// ----------------------------------------------------------------------------
// 6b. C-SHAPED PICKUP COIL (replaces floating torus/cylinder coils)
// ----------------------------------------------------------------------------
// Documented SEG prototypes show laminated C-core electromagnets straddling the
// outer roller ring. This generator produces three separate mesh parts that
// share one instance buffer: the laminated iron C-core, the enameled copper
// winding bundle on the core back, and a small mounting foot.
// ----------------------------------------------------------------------------

function _dot3(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function _appendBox(vertices, normals, uvs, indices, center, size, uvScale, baseIndex) {
  const [cx, cy, cz] = center;
  const [sx, sy, sz] = size;
  const [us, vs] = uvScale;
  const half = [sx / 2, sy / 2, sz / 2];

  // 8 corners
  const corners = [
    [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
    [-1, -1, 1],  [1, -1, 1],  [1, 1, 1],  [-1, 1, 1]
  ].map(([x, y, z]) => [cx + x * half[0], cy + y * half[1], cz + z * half[2]]);

  // 6 faces: normal, tangent, 4 corner indices, uv origin/scale axes
  const faces = [
    { n: [0, 0, -1], idx: [0, 1, 2, 3], uAxis: [1, 0, 0], vAxis: [0, 1, 0] },
    { n: [0, 0, 1],  idx: [5, 4, 7, 6], uAxis: [1, 0, 0], vAxis: [0, 1, 0] },
    { n: [0, -1, 0], idx: [0, 4, 5, 1], uAxis: [1, 0, 0], vAxis: [0, 0, 1] },
    { n: [0, 1, 0],  idx: [3, 2, 6, 7], uAxis: [1, 0, 0], vAxis: [0, 0, 1] },
    { n: [-1, 0, 0], idx: [0, 3, 7, 4], uAxis: [0, 0, 1], vAxis: [0, 1, 0] },
    { n: [1, 0, 0],  idx: [1, 5, 6, 2], uAxis: [0, 0, 1], vAxis: [0, 1, 0] }
  ];

  let vOff = baseIndex;
  for (const f of faces) {
    const p0 = corners[f.idx[0]];
    for (let i = 0; i < 4; i++) {
      const p = corners[f.idx[i]];
      vertices.push(p[0], p[1], p[2]);
      normals.push(f.n[0], f.n[1], f.n[2]);
      const du = _dot3([p[0] - p0[0], p[1] - p0[1], p[2] - p0[2]], f.uAxis);
      const dv = _dot3([p[0] - p0[0], p[1] - p0[1], p[2] - p0[2]], f.vAxis);
      uvs.push(du * us, dv * vs);
    }
    indices.push(vOff, vOff + 1, vOff + 2, vOff, vOff + 2, vOff + 3);
    vOff += 4;
  }
  return vOff;
}

function _buildBoxPart(device, boxes) {
  const vertices = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  let baseIndex = 0;
  for (const box of boxes) {
    baseIndex = _appendBox(vertices, normals, uvs, indices, box.center, box.size, box.uvScale, baseIndex);
  }

  const vertexData = new Float32Array(vertices.length / 3 * 8);
  const vCount = vertices.length / 3;
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
  return _makeGeomBuffers(device, {
    vertices: vertexData,
    indices: new Uint16Array(indices)
  });
}

function _buildWindingPart(device, options) {
  const { backZ = 0.5, width = 1.4, height = 0.9, thickness = 0.85, segments = 24 } = options;
  const vertices = [];
  const normals = [];
  const uvs = [];
  const indices = [];

  // Rounded rectangular winding bundle: a rounded box created from a grid.
  const rx = width / 2;
  const ry = height / 2;
  const rz = thickness / 2;
  const cx = 0, cy = 0, cz = backZ;

  // Build a rounded-box shell from a 3D grid of points
  const nx = 6, ny = 4, nz = 4;
  const indexMap = new Map();
  let vCount = 0;

  function getVertex(gx, gy, gz) {
    const key = `${gx},${gy},${gz}`;
    if (indexMap.has(key)) return indexMap.get(key);

    const lx = (gx / (nx - 1)) * 2 - 1;
    const ly = (gy / (ny - 1)) * 2 - 1;
    const lz = (gz / (nz - 1)) * 2 - 1;

    // Round the box: normalize corner direction and lerp toward sphere
    const len = Math.sqrt(lx * lx + ly * ly + lz * lz) || 1;
    const round = 0.35;
    const ux = lx / len * (1 - round) + lx * round;
    const uy = ly / len * (1 - round) + ly * round;
    const uz = lz / len * (1 - round) + lz * round;

    const px = cx + ux * rx;
    const py = cy + uy * ry;
    const pz = cz + uz * rz;

    // Normal is the direction from box center
    const nlen = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1;
    normals.push(ux / nlen, uy / nlen, uz / nlen);
    vertices.push(px, py, pz);
    // Helical UV around the back limb
    uvs.push((Math.atan2(ux, uz) / (2 * Math.PI) + 0.5) * 8, (py + ry) / height * 20);

    indexMap.set(key, vCount);
    return vCount++;
  }

  for (let gy = 0; gy < ny - 1; gy++) {
    for (let gx = 0; gx < nx - 1; gx++) {
      // Front and back faces
      for (const gz of [0, nz - 1]) {
        const a = getVertex(gx, gy, gz);
        const b = getVertex(gx + 1, gy, gz);
        const c = getVertex(gx + 1, gy + 1, gz);
        const d = getVertex(gx, gy + 1, gz);
        if (gz === 0) indices.push(a, c, b, a, d, c);
        else indices.push(a, b, c, a, c, d);
      }
    }
    for (let gz = 0; gz < nz - 1; gz++) {
      // Left and right faces
      for (const gx of [0, nx - 1]) {
        const a = getVertex(gx, gy, gz);
        const b = getVertex(gx, gy, gz + 1);
        const c = getVertex(gx, gy + 1, gz + 1);
        const d = getVertex(gx, gy + 1, gz);
        if (gx === 0) indices.push(a, b, c, a, c, d);
        else indices.push(a, c, b, a, d, c);
      }
    }
  }
  for (let gx = 0; gx < nx - 1; gx++) {
    for (let gz = 0; gz < nz - 1; gz++) {
      // Top and bottom faces
      for (const gy of [0, ny - 1]) {
        const a = getVertex(gx, gy, gz);
        const b = getVertex(gx + 1, gy, gz);
        const c = getVertex(gx + 1, gy, gz + 1);
        const d = getVertex(gx, gy, gz + 1);
        if (gy === 0) indices.push(a, c, b, a, d, c);
        else indices.push(a, b, c, a, c, d);
      }
    }
  }

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
  return _makeGeomBuffers(device, {
    vertices: vertexData,
    indices: new Uint16Array(indices)
  });
}

export function generateCCorePickupCoil(device, options = {}) {
  const {
    coilRadius = 7.2,
    jawReach = 1.7,
    coreWidth = 1.8,
    coreHeight = 0.70,
    coreThickness = 0.45,
    armWidth = 0.45,
    windingWidth = 1.4,
    windingHeight = 0.9,
    windingThickness = 0.85
  } = options;

  // Local-space C-core: opening faces -Z, back at +Z.
  const backZ = jawReach * 0.35; // back bar sits slightly outward
  const jawZ = -jawReach;
  const sideX = coreWidth / 2;
  const halfH = coreHeight / 2;

  // Core = back bar + two side arms.
  const coreBoxes = [
    {
      center: [0, 0, backZ],
      size: [coreWidth, coreHeight, coreThickness],
      uvScale: [1 / coreWidth, 1 / coreHeight]
    },
    {
      center: [sideX, 0, (backZ + jawZ) / 2],
      size: [armWidth, coreHeight, backZ - jawZ + coreThickness],
      uvScale: [1 / armWidth, 1 / coreHeight]
    },
    {
      center: [-sideX, 0, (backZ + jawZ) / 2],
      size: [armWidth, coreHeight, backZ - jawZ + coreThickness],
      uvScale: [1 / armWidth, 1 / coreHeight]
    }
  ];

  // Mounting foot: small tab extending from core back down to base plate.
  const footBoxes = [
    {
      center: [0, -halfH - 0.25, backZ + 0.05],
      size: [0.6, 0.5, 0.3],
      uvScale: [2, 2]
    },
    {
      center: [0, -halfH - 0.45, backZ + 0.25],
      size: [0.9, 0.15, 0.7],
      uvScale: [2, 2]
    }
  ];

  return {
    core: _buildBoxPart(device, coreBoxes),
    winding: _buildWindingPart(device, {
      backZ: backZ + coreThickness * 0.5 + windingThickness * 0.1,
      width: windingWidth,
      height: windingHeight,
      thickness: windingThickness
    }),
    foot: _buildBoxPart(device, footBoxes)
  };
}

// ----------------------------------------------------------------------------
// 6c. MAGNETIC WALL SHELLS (Roschin–Godin anomalous environmental effect)
// ----------------------------------------------------------------------------
// Generates N open-ended concentric cylindrical shells used as extremely faint
// refractive/shimmer markers for zones of increased magnetic flux. The shells
// are drawn double-sided with depth-write disabled so they act as a pure
// atmospheric overlay around the SEG device.
// ----------------------------------------------------------------------------

export function generateMagneticWallShells(device, options = {}) {
  const {
    innerRadius = 1.6,
    spacing = 0.55,
    shellThickness = 0.06,
    height = 8.0,
    maxShells = 5,
    segments = 96
  } = options;

  const vertices = [];
  const indices = [];
  let baseVertex = 0;

  for (let s = 0; s < maxShells; s++) {
    const radius = innerRadius + s * spacing;
    const halfH = height / 2;

    // Each shell has two rings of vertices: inner surface and outer surface.
    // We build side quads only (no caps) so the shell is open-ended.
    for (let i = 0; i <= segments; i++) {
      const theta = (i / segments) * Math.PI * 2;
      const c = Math.cos(theta);
      const sn = Math.sin(theta);

      // Outer surface vertex
      vertices.push(
        c * (radius + shellThickness * 0.5), -halfH, sn * (radius + shellThickness * 0.5),
        c, 0.0, sn,
        i / segments, 0.0
      );
      vertices.push(
        c * (radius + shellThickness * 0.5),  halfH, sn * (radius + shellThickness * 0.5),
        c, 0.0, sn,
        i / segments, 1.0
      );

      // Inner surface vertex (normal inverted)
      vertices.push(
        c * (radius - shellThickness * 0.5), -halfH, sn * (radius - shellThickness * 0.5),
        -c, 0.0, -sn,
        i / segments, 0.0
      );
      vertices.push(
        c * (radius - shellThickness * 0.5),  halfH, sn * (radius - shellThickness * 0.5),
        -c, 0.0, -sn,
        i / segments, 1.0
      );
    }

    // Indices for outer and inner side strips.
    for (let i = 0; i < segments; i++) {
      const outerBase = baseVertex + i * 4;
      const nextOuter = baseVertex + (i + 1) * 4;
      // Outer side: two triangles
      indices.push(outerBase, nextOuter, outerBase + 1);
      indices.push(outerBase + 1, nextOuter, nextOuter + 1);
      // Inner side: two triangles (winding reversed for inward normal)
      indices.push(outerBase + 2, outerBase + 3, nextOuter + 2);
      indices.push(outerBase + 3, nextOuter + 3, nextOuter + 2);
    }

    baseVertex += (segments + 1) * 4;
  }

  const vertexData = new Float32Array(vertices.length);
  vertexData.set(vertices);
  const indexData = new Uint16Array(indices);

  return _makeGeomBuffers(device, { vertices: vertexData, indices: indexData });
}

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
    poleColors = [
      [0.85, 0.48, 0.22], // Fresh copper (N pole)
      [0.55, 0.30, 0.15], // Copper oxide (S pole)
      [0.72, 0.74, 0.76], // Neodymium silver
      [0.78, 0.58, 0.22], // Brass
    ]
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

      // Position
      instanceData[idx] = Math.cos(angle) * ring.radius;
      instanceData[idx + 1] = 0;
      instanceData[idx + 2] = Math.sin(angle) * ring.radius;

      // Ring index (encoded as band offset for shader)
      instanceData[idx + 3] = ring.index;

      // Self-rotation quaternion (rolling motion)
      const gearRatio = ring.radius / (ring.scale || 0.8);
      const selfRotAngle = angle * gearRatio * 0.5;
      const tangentAngle = angle + Math.PI / 2;
      const rollAxisX = Math.cos(tangentAngle);
      const rollAxisZ = Math.sin(tangentAngle);
      instanceData[idx + 4] = rollAxisX * Math.sin(selfRotAngle / 2);
      instanceData[idx + 5] = 0;
      instanceData[idx + 6] = rollAxisZ * Math.sin(selfRotAngle / 2);
      instanceData[idx + 7] = Math.cos(selfRotAngle / 2);

      // Alternating pole color based on roller index and ring
      const colorIdx = (i + ring.index * 3) % poleColors.length;
      const color = poleColors[colorIdx];
      instanceData[idx + 8] = color[0];
      instanceData[idx + 9] = color[1];
      instanceData[idx + 10] = color[2];
      // emissive: neodymium parts get slight glow
      instanceData[idx + 11] = colorIdx === 2 ? 0.3 : 0.0;

      rollerOffset++;
    }
  }

  return instanceData;
}

// ----------------------------------------------------------------------------
// 8. ENHANCED SEG GEOMETRY CLASS
// ----------------------------------------------------------------------------
// Convenience class that wraps all the enhanced geometry generators
// and provides a drop-in replacement for DeviceGeometry.setup().
// ----------------------------------------------------------------------------
