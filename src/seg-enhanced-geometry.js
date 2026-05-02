// ============================================================================
// SEG Enhanced Geometry Module
// ============================================================================
// Drop-in enhancements for the Searl Effect Generator visualization.
// Import the functions you need and call them during setupGeometry() to replace
// or augment the basic primitives with detailed, photo-realistic counterparts.
//
// Based on analysis of real SEG device photographs including:
//   - Roschin & Godin replica (2025 demo)
//   - Bharath tabletop prototype  
//   - Searl original historical photographs
//   - Prof. John Searl's documented 4-layer material composition
//
// USAGE:
//   import {
//     generateBearingShaft, generatePoleBandedRoller, generatePlateWithCutouts,
//     generateSupportStand, generateWireHarness, generateCoilWithWindings,
//     SEGMaterialPresets, EnhancedSEGGeometry
//   } from './seg-enhanced-geometry.js';
//
//   // In your setupGeometry(), replace simple shapes with detailed ones:
//   const shaft = generateBearingShaft(device, { shaftRadius: 0.6, ... });
//   const roller = generatePoleBandedRoller(device, { bands: 4, ... });
// ============================================================================

// ----------------------------------------------------------------------------
// Material Presets - based on real SEG 4-layer composition
// ----------------------------------------------------------------------------
export const SEGMaterialPresets = {
  // Layer 1: Neodymium (rare earth magnetic core) - silver metallic
  neodymium: {
    baseColor: [0.72, 0.74, 0.76],
    metallic: 0.92,
    roughness: 0.25,
    emissive: 0.0
  },
  // Layer 2: Copper (conductor) - warm reddish with oxidation variation
  copper: {
    baseColor: [0.85, 0.48, 0.22],
    metallic: 0.95,
    roughness: 0.30,
    emissive: 0.0
  },
  // Layer 3: Brass (structural plates) - gold-yellow
  brass: {
    baseColor: [0.78, 0.58, 0.22],
    metallic: 0.90,
    roughness: 0.22,
    emissive: 0.0
  },
  // Layer 4: Insulation/nylon (separator plates) - off-white/cream
  insulation: {
    baseColor: [0.92, 0.90, 0.82],
    metallic: 0.0,
    roughness: 0.85,
    emissive: 0.0
  },
  // Steel shaft - cold metallic
  steel: {
    baseColor: [0.65, 0.67, 0.70],
    metallic: 0.95,
    roughness: 0.18,
    emissive: 0.0
  },
  // Winding copper (for electromagnets) - brighter, fresher copper
  windingCopper: {
    baseColor: [0.90, 0.52, 0.18],
    metallic: 0.88,
    roughness: 0.40,
    emissive: 0.0
  },
  // Copper oxide (darker patina bands on aged rollers)
  copperOxide: {
    baseColor: [0.55, 0.30, 0.15],
    metallic: 0.70,
    roughness: 0.55,
    emissive: 0.0
  },
  // Plastic/nylon spacer (cream colored, seen in prototypes)
  nylonSpacer: {
    baseColor: [0.95, 0.93, 0.85],
    metallic: 0.0,
    roughness: 0.75,
    emissive: 0.0
  },
  // PCB/electronics (green circuit boards visible in prototypes)
  pcbGreen: {
    baseColor: [0.15, 0.55, 0.20],
    metallic: 0.1,
    roughness: 0.60,
    emissive: 0.05
  },
  // Bolt/fastener steel
  boltSteel: {
    baseColor: [0.70, 0.72, 0.74],
    metallic: 0.98,
    roughness: 0.15,
    emissive: 0.0
  }
};

// ----------------------------------------------------------------------------
// Helper: Create GPU vertex + index buffer pair
// ----------------------------------------------------------------------------
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

// ----------------------------------------------------------------------------
// 1. CENTRAL BEARING SHAFT (replaces simple sphere hub)
// ----------------------------------------------------------------------------
// Real SEG devices have a central bearing assembly with:
//   - Vertical shaft extending through center
//   - Flange/base plate at bottom
//   - Upper retaining ring
//   - Hollow center (not solid)
//
// Options:
//   shaftRadius: 0.4-0.8 (main shaft radius)
//   shaftHeight: 2.0-4.0 (total height of shaft)
//   flangeRadius: 1.2-2.0 (base flange radius)
//   flangeThickness: 0.15-0.30
//   topRingRadius: 0.8-1.5 (upper retaining ring)
//   segments: 32-64 (smoothness)
// ----------------------------------------------------------------------------
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
// Real SEG rollers have visible magnetic pole bands:
//   - Alternating N/S magnetic segments appear as different colored bands
//   - Neodymium core shows as silver-gray sections
//   - Copper cladding shows as reddish-brown sections  
//   - Some prototypes show 4-6 distinct bands per roller
//
// This generator creates a roller with latitudinal bands that can be
// colored differently in the shader via the UV y-coordinate.
//
// Options:
//   radius: 0.4-1.0 (roller radius)
//   height: 1.5-4.0 (roller length)
//   bands: 4-8 (number of pole bands)
//   bandSpacing: 0.02-0.05 (gap between bands)
//   segments: 24-48 (radial smoothness)
// ----------------------------------------------------------------------------
export function generatePoleBandedRoller(device, options = {}) {
  const {
    radius = 0.8,
    height = 2.5,
    bands = 6,
    bandSpacing = 0.03,
    segments = 32
  } = options;

  const vertices = [];
  const indices = [];
  const normals = [];
  const uvs = [];

  const bandHeight = (height - bandSpacing * (bands - 1)) / bands;
  let yStart = -height / 2;

  // For each band, create a cylinder section
  for (let b = 0; b < bands; b++) {
    const yBottom = yStart + b * (bandHeight + bandSpacing);
    const yTop = yBottom + bandHeight;
    const vBase = b / bands;       // UV y-start for this band
    const vScale = 1.0 / bands;    // UV y-range for this band

    const baseVertex = vertices.length / 3;

    // Top cap center for this band section
    vertices.push(0, yTop, 0);
    normals.push(0, 1, 0);
    uvs.push(0.5, vBase + vScale);

    // Bottom cap center
    vertices.push(0, yBottom, 0);
    normals.push(0, -1, 0);
    uvs.push(0.5, vBase);

    // Rim vertices for this band
    for (let i = 0; i <= segments; i++) {
      const theta = (i / segments) * Math.PI * 2;
      const c = Math.cos(theta), s = Math.sin(theta);

      // Top face vertex
      vertices.push(c * radius, yTop, s * radius);
      normals.push(0, 1, 0);
      uvs.push(i / segments, vBase + vScale);

      // Bottom face vertex
      vertices.push(c * radius, yBottom, s * radius);
      normals.push(0, -1, 0);
      uvs.push(i / segments, vBase);

      // Side top vertex
      vertices.push(c * radius, yTop, s * radius);
      normals.push(c, 0, s);
      uvs.push(i / segments, vBase + vScale);

      // Side bottom vertex
      vertices.push(c * radius, yBottom, s * radius);
      normals.push(c, 0, s);
      uvs.push(i / segments, vBase);
    }

    const capTopCenter = baseVertex;
    const capBotCenter = baseVertex + 1;
    const rimStart = baseVertex + 2;

    // Generate indices for this band
    for (let i = 0; i < segments; i++) {
      const curr = rimStart + i * 4;
      const next = rimStart + ((i + 1) % (segments + 1)) * 4;

      // Top cap triangle
      indices.push(capTopCenter, curr, next);
      // Bottom cap triangle
      indices.push(capBotCenter, next + 1, curr + 1);
      // Side quads
      indices.push(curr + 2, curr + 3, next + 2);
      indices.push(next + 2, curr + 3, next + 3);
    }
  }

  // Spacer rings (slightly smaller radius) between bands
  const spacerRadius = radius * 0.92;
  for (let b = 0; b < bands - 1; b++) {
    const ySpacer = -height / 2 + (b + 1) * (bandHeight + bandSpacing) - bandSpacing / 2;
    const spacerThick = bandSpacing * 0.8;
    const baseIdx = vertices.length / 3;

    for (let i = 0; i <= segments; i++) {
      const theta = (i / segments) * Math.PI * 2;
      const c = Math.cos(theta), s = Math.sin(theta);
      vertices.push(c * spacerRadius, ySpacer + spacerThick / 2, s * spacerRadius);
      normals.push(c, 0, s);
      uvs.push(i / segments, 0.5);
      vertices.push(c * spacerRadius, ySpacer - spacerThick / 2, s * spacerRadius);
      normals.push(c, 0, s);
      uvs.push(i / segments, 0.5);
    }
    for (let i = 0; i < segments; i++) {
      const b = baseIdx + i * 2;
      const n = baseIdx + ((i + 1) % (segments + 1)) * 2;
      indices.push(b, n, b + 1, b + 1, n, n + 1);
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

  // Bolt holes (simple cylinders subtracted visually - represented as small raised rings)
  if (boltHoles > 0) {
    const boltCircleRadius = outerRadius * 0.92;
    for (let b = 0; b < boltHoles; b++) {
      const angle = (b / boltHoles) * Math.PI * 2;
      const bx = Math.cos(angle) * boltCircleRadius;
      const bz = Math.sin(angle) * boltCircleRadius;
      const boltSegs = 12;
      const boltBase = vOff;

      // Raised bolt head
      for (let i = 0; i <= boltSegs; i++) {
        const t = (i / boltSegs) * Math.PI * 2;
        vertices.push(bx + Math.cos(t) * boltRadius, h2 + 0.06, bz + Math.sin(t) * boltRadius);
        normals.push(0, 1, 0);
        uvs.push(i / boltSegs, 1);
        vertices.push(bx + Math.cos(t) * boltRadius, h2, bz + Math.sin(t) * boltRadius);
        normals.push(Math.cos(t), 0.3, Math.sin(t));
        uvs.push(i / boltSegs, 0);
        vOff += 2;
      }
      for (let i = 0; i < boltSegs; i++) {
        const curr = boltBase + i * 2;
        const next = boltBase + ((i + 1) % (boltSegs + 1)) * 2;
        indices.push(curr, next, curr + 1, curr + 1, next, next + 1);
      }
    }
  }

  // Radial reinforcement ribs
  if (hasRibs) {
    for (let r = 0; r < ribCount; r++) {
      const angle = (r / ribCount) * Math.PI * 2;
      const c = Math.cos(angle), s = Math.sin(angle);
      const ribBase = vOff;
      const ribWidth = (outerRadius - innerRadius) * 0.06;
      const rStart = innerRadius + (outerRadius - innerRadius) * 0.15;
      const rEnd = outerRadius * 0.88;

      // Rib cross-section: a thin raised strip
      for (let step = 0; step <= 8; step++) {
        const t = step / 8;
        const rad = rStart + t * (rEnd - rStart);
        const perpC = -s;  // perpendicular direction
        const perpS = c;
        const w2 = ribWidth / 2 * (1 - Math.abs(t - 0.5) * 0.3); // Slight taper

        vertices.push(
          (c * rad + perpC * w2), h2 + ribHeight, (s * rad + perpS * w2)
        );
        normals.push(0, 1, 0);
        uvs.push(t, 1);

        vertices.push(
          (c * rad - perpC * w2), h2 + ribHeight, (s * rad - perpS * w2)
        );
        normals.push(0, 1, 0);
        uvs.push(t, 0);
        vOff += 2;
      }
      for (let i = 0; i < 8; i++) {
        const b = ribBase + i * 2;
        const n = ribBase + (i + 1) * 2;
        indices.push(b, b + 1, n, n, b + 1, n + 1);
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
export class EnhancedSEGGeometry {
  constructor(device, config) {
    this.device = device;
    this.config = config;
    this.buffers = {};
  }

  async init() {
    // Central bearing shaft (replaces sphere)
    this.buffers.shaft = generateBearingShaft(this.device, {
      shaftRadius: 0.5,
      shaftHeight: 3.5,
      flangeRadius: 1.8,
      topRingRadius: 1.3,
      segments: 48
    });

    // Pole-banded roller (replaces smooth cylinder)
    this.buffers.roller = generatePoleBandedRoller(this.device, {
      radius: 0.75,
      height: 2.8,
      bands: 6,
      segments: 32
    });

    // Upper plate with cutouts
    const rings = this.config.rings || [
      { count: 8, radius: 2.5 },
      { count: 12, radius: 4.0 },
      { count: 16, radius: 5.5 }
    ];
    const rollerCutouts = [];
    for (const ring of rings) {
      for (let i = 0; i < ring.count; i++) {
        rollerCutouts.push({
          angle: (i / ring.count) * Math.PI * 2,
          radius: ring.radius,
          size: 0.85
        });
      }
    }

    this.buffers.upperPlate = generatePlateWithCutouts(this.device, {
      innerRadius: 0.8,
      outerRadius: 6.5,
      thickness: 0.25,
      rollerCutouts,
      boltHoles: 16,
      hasRibs: true,
      ribCount: 8,
      segments: 96
    });

    this.buffers.lowerPlate = generatePlateWithCutouts(this.device, {
      innerRadius: 0.8,
      outerRadius: 6.5,
      thickness: 0.25,
      rollerCutouts,
      boltHoles: 16,
      hasRibs: true,
      ribCount: 8,
      segments: 96
    });

    // Support stand
    this.buffers.stand = generateSupportStand(this.device, {
      legCount: 4,
      legLength: 5.0,
      baseRadius: 3.0,
      height: 3.0,
      segments: 24
    });

    // Coil with visible windings
    this.buffers.coil = generateCoilWithWindings(this.device, {
      majorRadius: 7.5,
      minorRadius: 0.6,
      turns: 60,
      majorSegments: 96
    });

    // Wire harness between coils (8 connections)
    this.buffers.wires = [];
    const coilCount = 8;
    const coilRadius = 7.5;
    for (let i = 0; i < coilCount; i++) {
      const angle1 = (i / coilCount) * Math.PI * 2;
      const angle2 = ((i + 1) / coilCount) * Math.PI * 2;
      this.buffers.wires.push(generateWireHarness(this.device, {
        start: [Math.cos(angle1) * coilRadius, 0.8, Math.sin(angle1) * coilRadius],
        end: [Math.cos(angle2) * coilRadius, 0.8, Math.sin(angle2) * coilRadius],
        radius: 0.035,
        sag: 0.4,
        segments: 16
      }));
    }
  }

  destroy() {
    for (const key of Object.keys(this.buffers)) {
      if (key === 'wires') {
        for (const w of this.buffers.wires) {
          w.vertexBuffer?.destroy();
          w.indexBuffer?.destroy();
        }
      } else {
        this.buffers[key]?.vertexBuffer?.destroy();
        this.buffers[key]?.indexBuffer?.destroy();
      }
    }
  }
}

// ----------------------------------------------------------------------------
// Default export
// ----------------------------------------------------------------------------
export default {
  SEGMaterialPresets,
  generateBearingShaft,
  generatePoleBandedRoller,
  generatePlateWithCutouts,
  generateSupportStand,
  generateWireHarness,
  generateCoilWithWindings,
  generateBandedRollerInstances,
  EnhancedSEGGeometry
};
