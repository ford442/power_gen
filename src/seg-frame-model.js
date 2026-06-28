// ============================================================================
// SEG Frame / Support Structure Model
// ============================================================================
// Layout-scaled mechanical housing: lab bench, mounting stand, radial columns,
// outer stator collars, control box, cable glands, cooling vents, safety cage.
//
// Toggle via URL ?frame=full|minimal|off or debug panel "SEG frame" select.

/** @typedef {'off'|'minimal'|'full'} SegFrameLevel */

export const SEG_FRAME_LEVELS = {
  off: 0,
  minimal: 1,
  full: 2
};

/**
 * Parse frame visibility from URL / window override.
 * @param {URLSearchParams} [params]
 * @returns {SegFrameLevel}
 */
export function parseSegFrameLevel(params = new URLSearchParams(typeof location !== 'undefined' ? location.search : '')) {
  const raw = params.get('frame');
  if (raw === 'off' || raw === '0' || raw === 'false') return 'off';
  if (raw === 'minimal' || raw === 'min' || raw === '1') return 'minimal';
  if (raw === 'full' || raw === '2') return 'full';
  if (typeof window !== 'undefined' && window.SEG_FRAME_LEVEL) {
    const w = String(window.SEG_FRAME_LEVEL).toLowerCase();
    if (w in SEG_FRAME_LEVELS) return w;
  }
  return 'full';
}

/**
 * Layout-derived anchor points for frame placement (device-local space).
 * @param {import('./seg-layout.js').SEGLayout} layout
 */
export function computeFrameDimensions(layout) {
  const ws = layout.worldScale;
  const statorH = layout.statorHeightM * ws;
  const outerR = layout.outerRadiusM * ws;
  const basePlateRadius = layout.basePlateRadiusM * ws;
  const baseHeight = statorH * 0.45;
  const baseCenterY = -statorH * 0.35;
  const baseBottomY = baseCenterY - baseHeight * 0.5;
  const baseTopY = baseCenterY + baseHeight * 0.5;
  const statorY = statorH * 0.5;
  const benchTopY = baseBottomY - outerR * 0.55;
  const benchThickness = statorH * 0.35;
  const standHeight = baseBottomY - benchTopY;
  const plateY = Math.max(statorH * 3.2, outerR * 0.85);

  return {
    ws,
    statorH,
    outerR,
    innerR: layout.innerRadiusM * ws,
    basePlateRadius,
    baseHeight,
    baseCenterY,
    baseBottomY,
    baseTopY,
    statorY,
    benchTopY,
    benchThickness,
    standHeight,
    plateY,
    ringOrbits: layout.rings.map((r) => ({
      orbit: r.orbitRadiusM * ws,
      statorOuter: r.statorOuterM * ws,
      statorInner: r.statorInnerM * ws
    }))
  };
}

// ---------------------------------------------------------------------------
// Mesh builder (position + normal + uv, 8 floats per vertex)
// ---------------------------------------------------------------------------

class MeshBuilder {
  constructor() {
    /** @type {number[]} */
    this.positions = [];
    /** @type {number[]} */
    this.normals = [];
    /** @type {number[]} */
    this.uvs = [];
    /** @type {number[]} */
    this.indices = [];
  }

  /** @param {Float32Array} verts @param {Uint16Array} idx */
  appendMesh(verts, idx) {
    const base = this.positions.length / 3;
    for (let i = 0; i < verts.length; i += 8) {
      this.positions.push(verts[i], verts[i + 1], verts[i + 2]);
      this.normals.push(verts[i + 3], verts[i + 4], verts[i + 5]);
      this.uvs.push(verts[i + 6], verts[i + 7]);
    }
    for (let i = 0; i < idx.length; i++) {
      this.indices.push(idx[i] + base);
    }
  }

  appendBox(cx, cy, cz, width, height, depth) {
    const w = width * 0.5;
    const h = height * 0.5;
    const d = depth * 0.5;
    const faces = [
      // +Z front
      [[-w, -h, d], [w, -h, d], [w, h, d], [-w, h, d], [0, 0, 1]],
      // -Z back
      [[w, -h, -d], [-w, -h, -d], [-w, h, -d], [w, h, -d], [0, 0, -1]],
      // +Y top
      [[-w, h, d], [w, h, d], [w, h, -d], [-w, h, -d], [0, 1, 0]],
      // -Y bottom
      [[w, -h, d], [-w, -h, d], [-w, -h, -d], [w, -h, -d], [0, -1, 0]],
      // +X right
      [[w, -h, d], [w, -h, -d], [w, h, -d], [w, h, d], [1, 0, 0]],
      // -X left
      [[-w, -h, -d], [-w, -h, d], [-w, h, d], [-w, h, -d], [-1, 0, 0]]
    ];
    for (const face of faces) {
      const base = this.positions.length / 3;
      const [a, b, c, e, n] = face;
      const corners = [a, b, c, e];
      const uvs = [[0, 0], [1, 0], [1, 1], [0, 1]];
      for (let i = 0; i < 4; i++) {
        this.positions.push(cx + corners[i][0], cy + corners[i][1], cz + corners[i][2]);
        this.normals.push(n[0], n[1], n[2]);
        this.uvs.push(uvs[i][0], uvs[i][1]);
      }
      this.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }

  appendCylinder(cx, cy, cz, radius, height, segments = 12, axis = 'y') {
    const h2 = height * 0.5;
    const rings = [];
    for (const t of [-1, 1]) {
      const ring = [];
      for (let i = 0; i <= segments; i++) {
        const theta = (i / segments) * Math.PI * 2;
        const c = Math.cos(theta);
        const s = Math.sin(theta);
        let px, py, pz, nx, ny, nz;
        if (axis === 'y') {
          px = cx + c * radius;
          py = cy + t * h2;
          pz = cz + s * radius;
          nx = c; ny = 0; nz = s;
        } else {
          px = cx + t * h2;
          py = cy + c * radius;
          pz = cz + s * radius;
          nx = t; ny = c; nz = s;
        }
        const base = this.positions.length / 3;
        this.positions.push(px, py, pz);
        this.normals.push(nx, ny, nz);
        this.uvs.push(i / segments, t > 0 ? 1 : 0);
        ring.push(base);
      }
      rings.push(ring);
    }
    for (let i = 0; i < segments; i++) {
      const a = rings[0][i];
      const b = rings[1][i];
      const an = rings[0][i + 1];
      const bn = rings[1][i + 1];
      this.indices.push(a, b, an, an, b, bn);
    }
  }

  appendAnnulus(y, innerR, outerR, thickness, segments = 48) {
    const h2 = thickness * 0.5;
    for (let i = 0; i <= segments; i++) {
      const theta = (i / segments) * Math.PI * 2;
      const c = Math.cos(theta);
      const s = Math.sin(theta);
      const u = i / segments;

      const push = (r, ny, v) => {
        this.positions.push(c * r, y + v, s * r);
        this.normals.push(c * (v === 0 ? 0 : 0), ny, s * (v === 0 ? 0 : 0));
        if (ny === 0) {
          this.normals[this.normals.length - 3] = c;
          this.normals[this.normals.length - 1] = s;
        }
        this.uvs.push(u, v > 0 ? 1 : 0);
      };

      const topIn = this.positions.length / 3;
      push(innerR, 1, h2);
      const topOut = this.positions.length / 3;
      push(outerR, 1, h2);
      const botOut = this.positions.length / 3;
      push(outerR, -1, -h2);
      const botIn = this.positions.length / 3;
      push(innerR, -1, -h2);

      if (i < segments) {
        this.indices.push(topIn, topOut, topIn + 4, topIn + 4, topOut, topOut + 4);
        this.indices.push(botIn, botIn + 4, botOut, botOut, botIn + 4, botOut + 4);
        const wallOutA = topOut;
        const wallOutB = botOut;
        const wallOutAn = topOut + 4;
        const wallOutBn = botOut + 4;
        this.indices.push(wallOutA, wallOutB, wallOutAn, wallOutAn, wallOutB, wallOutBn);
      }
    }
  }

  appendRadialColumn(x1, y1, z1, x2, y2, z2, radius, segments = 8) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const dz = z2 - z1;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    const tx = dx / len;
    const ty = dy / len;
    const tz = dz / len;
    let px, py, pz;
    if (Math.abs(ty) < 0.9) {
      px = tz; py = 0; pz = -tx;
    } else {
      px = 1; py = 0; pz = 0;
    }
    const plen = Math.sqrt(px * px + py * py + pz * pz);
    px /= plen; py /= plen; pz /= plen;
    const qx = ty * pz - tz * py;
    const qy = tz * px - tx * pz;
    const qz = tx * py - ty * px;

    const steps = 4;
    const ringStarts = [];
    for (let step = 0; step <= steps; step++) {
      const t = step / steps;
      const lx = x1 + dx * t;
      const ly = y1 + dy * t;
      const lz = z1 + dz * t;
      ringStarts.push(this.positions.length / 3);
      for (let i = 0; i <= segments; i++) {
        const phi = (i / segments) * Math.PI * 2;
        const nx = Math.cos(phi) * px + Math.sin(phi) * qx;
        const ny = Math.cos(phi) * py + Math.sin(phi) * qy;
        const nz = Math.cos(phi) * pz + Math.sin(phi) * qz;
        this.positions.push(lx + nx * radius, ly + ny * radius, lz + nz * radius);
        this.normals.push(nx, ny, nz);
        this.uvs.push(i / segments, t);
      }
    }
    for (let step = 0; step < steps; step++) {
      for (let i = 0; i < segments; i++) {
        const a = ringStarts[step] + i;
        const b = ringStarts[step + 1] + i;
        this.indices.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
  }

  build() {
    const count = this.positions.length / 3;
    const vertices = new Float32Array(count * 8);
    for (let i = 0; i < count; i++) {
      vertices[i * 8] = this.positions[i * 3];
      vertices[i * 8 + 1] = this.positions[i * 3 + 1];
      vertices[i * 8 + 2] = this.positions[i * 3 + 2];
      vertices[i * 8 + 3] = this.normals[i * 3];
      vertices[i * 8 + 4] = this.normals[i * 3 + 1];
      vertices[i * 8 + 5] = this.normals[i * 3 + 2];
      vertices[i * 8 + 6] = this.uvs[i * 2];
      vertices[i * 8 + 7] = this.uvs[i * 2 + 1];
    }
    return { vertices, indices: new Uint16Array(this.indices) };
  }
}

function _upload(device, data) {
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

/**
 * Build lab bench slab geometry.
 * @param {ReturnType<typeof computeFrameDimensions>} dims
 */
export function buildLabBenchMesh(dims) {
  const mb = new MeshBuilder();
  const pad = dims.basePlateRadius * 1.15;
  mb.appendBox(0, dims.benchTopY - dims.benchThickness * 0.5, 0, pad * 2, dims.benchThickness, pad * 1.35);
  // Front lip / edge trim
  mb.appendBox(0, dims.benchTopY + dims.benchThickness * 0.15, dims.basePlateRadius * 0.85, pad * 2, dims.benchThickness * 0.12, dims.benchThickness * 0.8);
  return mb.build();
}

/**
 * Radial alignment columns + outer stator collars + tie ring.
 * @param {ReturnType<typeof computeFrameDimensions>} dims
 * @param {SegFrameLevel} level
 */
export function buildStructuralFrameMesh(dims, level) {
  const mb = new MeshBuilder();
  const colR = dims.statorH * 0.14;
  const colCount = 8;

  for (let i = 0; i < colCount; i++) {
    const angle = (i / colCount) * Math.PI * 2;
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const r = dims.outerR * 1.04;
    mb.appendRadialColumn(
      c * r * 0.55, dims.baseTopY, s * r * 0.55,
      c * r, dims.statorY + dims.statorH * 0.35, s * r,
      colR, 10
    );
    // Foot bracket pad
    mb.appendBox(c * r * 0.55, dims.baseTopY - dims.statorH * 0.08, s * r * 0.55,
      colR * 4, dims.statorH * 0.12, colR * 4);
  }

  // Outer stator collar per ring
  for (const ring of dims.ringOrbits) {
    mb.appendAnnulus(
      dims.statorY,
      ring.statorOuter * 1.02,
      ring.statorOuter * 1.08,
      dims.statorH * 0.22,
      48
    );
  }

  // Mid-height tie ring
  mb.appendAnnulus(
    dims.statorY * 0.55,
    dims.outerR * 0.92,
    dims.outerR * 1.02,
    dims.statorH * 0.18,
    64
  );

  if (level === 'full') {
    // Access panel hatches on base perimeter
    for (let i = 0; i < 4; i++) {
      const angle = (i / 4) * Math.PI * 2 + Math.PI * 0.25;
      const c = Math.cos(angle);
      const s = Math.sin(angle);
      const pr = dims.basePlateRadius * 0.78;
      mb.appendBox(c * pr, dims.baseCenterY, s * pr, dims.statorH * 1.6, dims.baseHeight * 0.55, dims.statorH * 0.9);
    }
  }

  return mb.build();
}

/**
 * Control box + terminal strip + cooling vent fins.
 * @param {ReturnType<typeof computeFrameDimensions>} dims
 */
export function buildControlBoxMesh(dims) {
  const mb = new MeshBuilder();
  const bx = dims.outerR * 1.12;
  const by = dims.baseCenterY + dims.baseHeight * 0.35;
  const bz = dims.basePlateRadius * 0.35;
  const bw = dims.statorH * 2.8;
  const bh = dims.statorH * 2.2;
  const bd = dims.statorH * 1.9;

  mb.appendBox(bx, by, bz, bw, bh, bd);

  // Terminal strip (green PCB face)
  mb.appendBox(bx + bw * 0.42, by + bh * 0.15, bz + bd * 0.52, bw * 0.35, bh * 0.55, dims.statorH * 0.08);

  // Screw terminals
  for (let i = 0; i < 6; i++) {
    mb.appendCylinder(bx + bw * 0.42, by + bh * (0.05 + i * 0.12), bz + bd * 0.58,
      dims.statorH * 0.045, dims.statorH * 0.06, 6);
  }

  // Cooling vent fins on side
  for (let i = 0; i < 7; i++) {
    mb.appendBox(bx - bw * 0.52, by - bh * 0.25 + i * dims.statorH * 0.22, bz,
      dims.statorH * 0.04, dims.statorH * 0.55, bd * 0.85);
  }

  // Cable gland ports on base edge
  for (let i = 0; i < 4; i++) {
    const angle = (i / 4) * Math.PI * 2;
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const gr = dims.basePlateRadius * 0.88;
    mb.appendCylinder(c * gr, dims.baseCenterY - dims.baseHeight * 0.15, s * gr,
      dims.statorH * 0.12, dims.statorH * 0.35, 10);
  }

  return mb.build();
}

/**
 * Wireframe-style safety cage (vertical bars + horizontal rings).
 * @param {ReturnType<typeof computeFrameDimensions>} dims
 */
export function buildSafetyCageMesh(dims) {
  const mb = new MeshBuilder();
  const bars = 12;
  const barR = dims.statorH * 0.045;
  const cageR = dims.outerR * 1.14;
  const yBot = dims.baseTopY;
  const yTop = dims.plateY + dims.statorH * 0.4;

  for (let i = 0; i < bars; i++) {
    const angle = (i / bars) * Math.PI * 2;
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    mb.appendRadialColumn(
      c * cageR, yBot, s * cageR,
      c * cageR, yTop, s * cageR,
      barR, 6
    );
  }

  for (const y of [yBot + (yTop - yBot) * 0.15, yTop - dims.statorH * 0.15]) {
    mb.appendAnnulus(y, cageR * 0.98, cageR * 1.02, barR * 1.6, 48);
  }

  // Top cap ring
  mb.appendAnnulus(yTop, cageR * 0.94, cageR * 1.06, barR * 2.2, 48);

  return mb.build();
}

/**
 * Create all GPU buffers for the SEG frame assembly.
 * @param {GPUDevice} device
 * @param {import('./seg-layout.js').SEGLayout} layout
 * @param {SegFrameLevel} level
 */
export function createSegFrameBuffers(device, layout, level = 'full') {
  if (level === 'off') {
    return { level, dims: computeFrameDimensions(layout) };
  }

  const dims = computeFrameDimensions(layout);
  const result = { level, dims };

  result.labBench = _upload(device, buildLabBenchMesh(dims));
  result.structural = _upload(device, buildStructuralFrameMesh(dims, level));

  if (level === 'full') {
    result.controlBox = _upload(device, buildControlBoxMesh(dims));
    result.safetyCage = _upload(device, buildSafetyCageMesh(dims));
  }

  return result;
}

/** Canonical instance record for frame parts (matches enhanced pipeline). */
export function makeFrameInstanceBuffer(device, ringIndex = 11.0, color = [0.72, 0.74, 0.78]) {
  const buf = device.createBuffer({
    size: 48,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
  });
  device.queue.writeBuffer(buf, 0, new Float32Array([
    0, 0, 0,
    ringIndex,
    0, 0, 0, 1,
    color[0], color[1], color[2],
    0.0
  ]));
  return buf;
}

/** Vibration offset from normalized SEG angular velocity. */
export function frameVibrationOffset(segOmega, statorH) {
  const amp = Math.min(1, Math.max(0, segOmega - 0.35)) * statorH * 0.012;
  const t = performance.now() * 0.001;
  return [
    Math.sin(t * 47.3) * amp,
    Math.sin(t * 61.7) * amp * 0.35,
    Math.cos(t * 53.1) * amp
  ];
}
