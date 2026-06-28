// ============================================================================
// SEG Roller Model — centralized geometry, materials, and instance packing
// ============================================================================
// Single source of truth for detailed SEG magnetic rollers used by WebGPU and
// WebGL2 render paths. Geometry matches generatePoleBandedRoller() with added
// shaft, end bearings, and magnet-segment barrel detail.
//
// Shader constants duplicated in seg-enhanced-shaders.js must stay in sync.

import { REF_ROLLER_RADIUS, REF_ROLLER_HEIGHT } from './seg-layout.js';

/** Default mesh dimensions (reference units; per-ring scale applied in shader). */
export const ROLLER_DEFAULTS = {
  radius: REF_ROLLER_RADIUS,
  height: REF_ROLLER_HEIGHT,
  bands: 8,
  segments: 64,
  grooveDepth: 0.035,
  grooveWidth: 0.045,
  shaftRadius: 0.14,
  bearingOuterScale: 1.06,
  bearingThickness: 0.14,
  bearingInset: 0.04,
  magnetSegmentCount: 4
};

/** End-cap radial layer boundaries (fraction of outer radius). */
export const ROLLER_LAYER_R = [0.0, 0.30, 0.52, 0.74, 1.0];

/** N/S pole tints — warm copper (N) vs cool oxide (S), Lorentz-consistent alternation. */
export const POLE_COLORS = {
  north: [0.92, 0.58, 0.35],
  south: [0.38, 0.45, 0.68],
  northLab: [0.78, 0.80, 0.82],
  southLab: [0.48, 0.50, 0.54]
};

function _packInterleaved(positions, normals, uvs) {
  const n = positions.length / 3;
  const out = new Float32Array(n * 8);
  for (let i = 0; i < n; i++) {
    out[i * 8] = positions[i * 3];
    out[i * 8 + 1] = positions[i * 3 + 1];
    out[i * 8 + 2] = positions[i * 3 + 2];
    out[i * 8 + 3] = normals[i * 3];
    out[i * 8 + 4] = normals[i * 3 + 1];
    out[i * 8 + 5] = normals[i * 3 + 2];
    out[i * 8 + 6] = uvs[i * 2];
    out[i * 8 + 7] = uvs[i * 2 + 1];
  }
  return out;
}

function _mergeMeshes(parts) {
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  let vOffset = 0;

  for (const part of parts) {
    const base = vOffset;
    for (let i = 0; i < part.positions.length; i++) positions.push(part.positions[i]);
    for (let i = 0; i < part.normals.length; i++) normals.push(part.normals[i]);
    for (let i = 0; i < part.uvs.length; i++) uvs.push(part.uvs[i]);
    for (const idx of part.indices) indices.push(idx + base);
    vOffset += part.positions.length / 3;
  }

  return {
    vertices: _packInterleaved(positions, normals, uvs),
    indices: new Uint16Array(indices)
  };
}

/**
 * Build pole-banded barrel + caps + grooves (CPU arrays, no GPU).
 */
function _buildPoleBandedBarrel(opts) {
  const {
    radius, height, segments, bands, grooveDepth, grooveWidth
  } = opts;

  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  let vOffset = 0;

  function addVertex(px, py, pz, nx, ny, nz, u, v) {
    positions.push(px, py, pz);
    normals.push(nx, ny, nz);
    uvs.push(u, v);
    return vOffset++;
  }

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
      if (ny > 0.0) indices.push(centerIdx, next, curr);
      else indices.push(centerIdx, curr, next);
    }
  }

  addCap(height * 0.5, 1.0);
  addCap(-height * 0.5, -1.0);

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
      addVertex(c * radius, yTop, s * radius, c, 0.0, s, i / segments, vTop);
      addVertex(c * radius, yBottom, s * radius, c, 0.0, s, i / segments, vBottom);
    }
    for (let i = 0; i < segments; i++) {
      const curr = baseIdx + i * 2;
      const next = baseIdx + ((i + 1) % (segments + 1)) * 2;
      indices.push(curr, next, curr + 1);
      indices.push(next, next + 1, curr + 1);
    }
  }

  const grooveRadius = Math.max(radius - grooveDepth, 0.01);
  for (let b = 0; b < bands - 1; b++) {
    const yCenter = -height * 0.5 + (b + 1) * (bandHeight + grooveWidth) - grooveWidth * 0.5;
    const vCenter = (yCenter + height * 0.5) / height;
    const baseIdx = vOffset;
    for (let i = 0; i <= segments; i++) {
      const theta = (i / segments) * Math.PI * 2;
      const c = Math.cos(theta), s = Math.sin(theta);
      addVertex(c * grooveRadius, yCenter + grooveWidth * 0.5, s * grooveRadius, -c, 0.0, -s, i / segments, vCenter);
      addVertex(c * grooveRadius, yCenter - grooveWidth * 0.5, s * grooveRadius, -c, 0.0, -s, i / segments, vCenter);
      addVertex(c * radius, yCenter + grooveWidth * 0.5, s * radius, c, 0.0, s, i / segments, vCenter);
      addVertex(c * radius, yCenter - grooveWidth * 0.5, s * radius, c, 0.0, s, i / segments, vCenter);
    }
    for (let i = 0; i < segments; i++) {
      const curr = baseIdx + i * 4;
      const next = baseIdx + ((i + 1) % (segments + 1)) * 4;
      indices.push(curr + 2, next + 2, curr + 3, next + 2, next + 3, curr + 3);
      indices.push(curr, curr + 1, next, next, curr + 1, next + 1);
      indices.push(curr + 2, next + 2, curr, next + 2, next, curr);
      indices.push(curr + 3, curr + 1, next + 3, next + 3, curr + 1, next + 1);
    }
  }

  return { positions, normals, uvs, indices };
}

/** Central steel shaft through the roller axis. */
function _buildShaft(opts) {
  const { shaftRadius, height, segments } = opts;
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  const h2 = height * 0.5;

  for (let i = 0; i <= segments; i++) {
    const theta = (i / segments) * Math.PI * 2;
    const c = Math.cos(theta), s = Math.sin(theta);
    const base = positions.length / 3;
    positions.push(c * shaftRadius, h2, s * shaftRadius);
    normals.push(c, 0, s);
    uvs.push(i / segments, 1);
    positions.push(c * shaftRadius, -h2, s * shaftRadius);
    normals.push(c, 0, s);
    uvs.push(i / segments, 0);
    if (i < segments) {
      const next = base + 2;
      indices.push(base, next, base + 1, next, next + 1, base + 1);
    }
  }

  return { positions, normals, uvs, indices };
}

/** End bearing housings — short annular flanges at top and bottom. */
function _buildEndBearings(opts) {
  const {
    radius, height, segments, bearingOuterScale, bearingThickness, bearingInset
  } = opts;
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  const outerR = radius * bearingOuterScale;
  const innerR = radius * 0.88;
  const h2 = bearingThickness * 0.5;

  function addAnnulus(y, ny) {
    const base = positions.length / 3;
    for (let i = 0; i <= segments; i++) {
      const theta = (i / segments) * Math.PI * 2;
      const c = Math.cos(theta), s = Math.sin(theta);
      positions.push(c * innerR, y + h2 * ny, s * innerR);
      normals.push(0, ny, 0);
      uvs.push(i / segments, 0);
      positions.push(c * outerR, y + h2 * ny, s * outerR);
      normals.push(0, ny, 0);
      uvs.push(i / segments, 1);
      positions.push(c * outerR, y - h2 * ny, s * outerR);
      normals.push(c * 0.3, -ny * 0.7, s * 0.3);
      uvs.push(i / segments, 1);
      positions.push(c * innerR, y - h2 * ny, s * innerR);
      normals.push(-c * 0.3, -ny * 0.7, -s * 0.3);
      uvs.push(i / segments, 0);
    }
    for (let i = 0; i < segments; i++) {
      const b = base + i * 4;
      const n = base + ((i + 1) % (segments + 1)) * 4;
      indices.push(b, n, b + 1, b + 1, n, n + 1);
      indices.push(b + 2, b + 3, n + 2, n + 2, b + 3, n + 3);
      indices.push(b + 1, n + 1, b + 2, b + 2, n + 1, n + 2);
      indices.push(b, n, b + 3, b + 3, n, n + 3);
    }
  }

  addAnnulus(height * 0.5 - bearingInset, 1.0);
  addAnnulus(-height * 0.5 + bearingInset, -1.0);

  return { positions, normals, uvs, indices };
}

/** Raised magnet segment strips on the barrel (circumferential poles). */
function _buildMagnetSegments(opts) {
  const { radius, height, segments, magnetSegmentCount } = opts;
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  const stripWidth = (Math.PI * 2) / (magnetSegmentCount * 2);
  const stripHeight = height * 0.72;
  const yBottom = -stripHeight * 0.5;
  const yTop = stripHeight * 0.5;
  const bulge = 0.018;

  for (let seg = 0; seg < magnetSegmentCount * 2; seg++) {
    const theta0 = (seg / (magnetSegmentCount * 2)) * Math.PI * 2;
    const theta1 = theta0 + stripWidth * 0.85;
    const rOut = radius + bulge;
    const base = positions.length / 3;
    const steps = Math.max(4, Math.floor(segments / (magnetSegmentCount * 2)));

    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const theta = theta0 + (theta1 - theta0) * t;
      const c = Math.cos(theta), s = Math.sin(theta);
      positions.push(c * rOut, yTop, s * rOut);
      normals.push(c, 0, s);
      uvs.push(t, 1.0);
      positions.push(c * rOut, yBottom, s * rOut);
      normals.push(c, 0, s);
      uvs.push(t, 0.0);
    }
    for (let i = 0; i < steps; i++) {
      const curr = base + i * 2;
      const next = curr + 2;
      indices.push(curr, next, curr + 1, next, next + 1, curr + 1);
    }
  }

  return { positions, normals, uvs, indices };
}

/**
 * Build full detailed roller mesh (CPU-side).
 * @returns {{ vertices: Float32Array, indices: Uint16Array, indexCount: number }}
 */
export function buildDetailedRollerMesh(options = {}) {
  const opts = { ...ROLLER_DEFAULTS, ...options };
  const barrel = _buildPoleBandedBarrel(opts);
  const shaft = _buildShaft(opts);
  const bearings = _buildEndBearings(opts);
  const magnets = _buildMagnetSegments(opts);
  const merged = _mergeMeshes([barrel, shaft, bearings, magnets]);
  return {
    ...merged,
    indexCount: merged.indices.length
  };
}

/** WebGPU buffer pair from detailed roller mesh. */
export function createDetailedRollerBuffers(device, options = {}) {
  const data = buildDetailedRollerMesh(options);
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
  return { vertexBuffer: vb, indexBuffer: ib, indexCount: data.indexCount };
}

/**
 * Whether this roller carries north-leading magnetic polarity (alternates around ring).
 * Matches Lorentz moment sign used in flux-line shaders.
 */
export function isNorthPole(ringIndex, localIndex) {
  return ((localIndex + ringIndex) & 1) === 0;
}

/**
 * Pole tint for instance copperColor channel (fragment shader reads this).
 */
export function poleTintColor(ringIndex, localIndex, prototypePreset = 'showroom') {
  const north = prototypePreset === 'lab' ? POLE_COLORS.northLab : POLE_COLORS.north;
  const south = prototypePreset === 'lab' ? POLE_COLORS.southLab : POLE_COLORS.south;
  return isNorthPole(ringIndex, localIndex) ? north : south;
}

/**
 * Pack one roller instance record (12 floats) compatible with GPU InstanceData.
 */
export function packRollerInstance({
  position,
  ringIndex,
  rotation,
  poleColor,
  emissive = 0.0
}) {
  return new Float32Array([
    position[0], position[1], position[2],
    ringIndex,
    rotation[0], rotation[1], rotation[2], rotation[3],
    poleColor[0], poleColor[1], poleColor[2],
    emissive
  ]);
}

/**
 * Compute self-rotation quaternion for orbital rolling motion.
 */
export function computeRollerRotation(angle, orbitRadius, rollerRadius) {
  const gearRatio = orbitRadius / Math.max(rollerRadius, 0.01);
  const selfRotAngle = angle * gearRatio * 0.5;
  const tangentAngle = angle + Math.PI / 2;
  const rollAxisX = Math.cos(tangentAngle);
  const rollAxisZ = Math.sin(tangentAngle);
  const half = selfRotAngle / 2;
  return [
    rollAxisX * Math.sin(half),
    0,
    rollAxisZ * Math.sin(half),
    Math.cos(half)
  ];
}

/**
 * Build all roller instance records for a layout (CPU fallback / tests).
 */
export function buildAllRollerInstances(time, layout, options = {}) {
  const {
    useHardwarePhase = false,
    hardwarePhaseRad = 0,
    prototypePreset = 'showroom',
    speedMult = 1.0
  } = options;

  const out = new Float32Array(layout.totalRollers * 12);
  let flat = 0;

  for (const ring of layout.rings) {
    const orbitR = ring.orbitRadiusM * layout.worldScale;
    const rollerR = ring.rollerRadiusM * layout.worldScale;
    const startupRamp = Math.min(time * (0.25 + ring.index * 0.1), 1.0);

    for (let i = 0; i < ring.count; i++) {
      const jitterNoise = Math.sin(flat * 127.3 + ring.index * 53.7);
      const speedJitter = 1.0 + 0.04 * Math.sin(time * 1.3 + jitterNoise * 12.7);
      const baseAngle = (i / ring.count) * Math.PI * 2 + ring.index * 0.22;
      const angle = useHardware
        ? baseAngle + hardwarePhaseRad * ring.speed
        : baseAngle + time * 0.5 * ring.speed * speedJitter * startupRamp * speedMult;

      const poleColor = poleTintColor(ring.index, i, prototypePreset);
      const isNeo = isNorthPole(ring.index, i);
      const emissive = isNeo ? 0.08 : 0.0;

      out.set(
        packRollerInstance({
          position: [Math.cos(angle) * orbitR, 0, Math.sin(angle) * orbitR],
          ringIndex: ring.index,
          rotation: computeRollerRotation(angle, orbitR, rollerR),
          poleColor,
          emissive
        }),
        flat * 12
      );
      flat++;
    }
  }
  return out;
}

export default {
  ROLLER_DEFAULTS,
  ROLLER_LAYER_R,
  POLE_COLORS,
  buildDetailedRollerMesh,
  createDetailedRollerBuffers,
  isNorthPole,
  poleTintColor,
  packRollerInstance,
  computeRollerRotation,
  buildAllRollerInstances
};
