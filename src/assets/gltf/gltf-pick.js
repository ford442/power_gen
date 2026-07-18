/**
 * CPU ray picking for annotated glTF housing meshes (WebGPU path).
 */

/** @typedef {{ annotationId: string, vertices: Float32Array, indices: Uint16Array, worldMatrix: Float32Array }} GltfPickable */

/**
 * Invert a 4×4 column-major matrix (affine; sufficient for glTF node transforms).
 * @param {Float32Array|number[]} m
 * @returns {Float32Array|null}
 */
export function invertMat4(m) {
  const out = new Float32Array(16);
  const a00 = m[0]; const a01 = m[1]; const a02 = m[2]; const a03 = m[3];
  const a10 = m[4]; const a11 = m[5]; const a12 = m[6]; const a13 = m[7];
  const a20 = m[8]; const a21 = m[9]; const a22 = m[10]; const a23 = m[11];
  const a30 = m[12]; const a31 = m[13]; const a32 = m[14]; const a33 = m[15];

  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;

  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (Math.abs(det) < 1e-12) return null;
  det = 1 / det;

  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
  return out;
}

function transformPoint(m, p) {
  const x = p[0]; const y = p[1]; const z = p[2];
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14]
  ];
}

function transformDirection(m, d) {
  const x = d[0]; const y = d[1]; const z = d[2];
  return [
    m[0] * x + m[4] * y + m[8] * z,
    m[1] * x + m[5] * y + m[9] * z,
    m[2] * x + m[6] * y + m[10] * z
  ];
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {number} clientX
 * @param {number} clientY
 * @param {Float32Array} invViewProj column-major
 * @param {number[]} cameraPos
 */
export function rayFromScreen(canvas, clientX, clientY, invViewProj, cameraPos) {
  const rect = canvas.getBoundingClientRect();
  const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
  const ndcY = -(((clientY - rect.top) / rect.height) * 2 - 1);

  const near = transformPoint(invViewProj, [ndcX, ndcY, -1]);
  const far = transformPoint(invViewProj, [ndcX, ndcY, 1]);
  const dir = [
    far[0] - near[0],
    far[1] - near[1],
    far[2] - near[2]
  ];
  const len = Math.hypot(dir[0], dir[1], dir[2]) || 1;
  return {
    origin: cameraPos,
    direction: [dir[0] / len, dir[1] / len, dir[2] / len]
  };
}

/**
 * Möller–Trumbore ray/triangle in local space.
 * @param {number[]} origin
 * @param {number[]} dir
 * @param {Float32Array} vertices 8-float interleaved
 * @param {number} i0 i1 i2 vertex indices
 */
function intersectTriangleLocal(origin, dir, vertices, i0, i1, i2) {
  const o = (i) => i * 8;
  const v0 = [vertices[o(i0)], vertices[o(i0) + 1], vertices[o(i0) + 2]];
  const v1 = [vertices[o(i1)], vertices[o(i1) + 1], vertices[o(i1) + 2]];
  const v2 = [vertices[o(i2)], vertices[o(i2) + 1], vertices[o(i2) + 2]];

  const e1 = [v1[0] - v0[0], v1[1] - v0[1], v1[2] - v0[2]];
  const e2 = [v2[0] - v0[0], v2[1] - v0[1], v2[2] - v0[2]];
  const p = [
    dir[1] * e2[2] - dir[2] * e2[1],
    dir[2] * e2[0] - dir[0] * e2[2],
    dir[0] * e2[1] - dir[1] * e2[0]
  ];
  const det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2];
  if (Math.abs(det) < 1e-8) return null;
  const invDet = 1 / det;
  const tvec = [origin[0] - v0[0], origin[1] - v0[1], origin[2] - v0[2]];
  const u = (tvec[0] * p[0] + tvec[1] * p[1] + tvec[2] * p[2]) * invDet;
  if (u < 0 || u > 1) return null;
  const q = [
    tvec[1] * e1[2] - tvec[2] * e1[1],
    tvec[2] * e1[0] - tvec[0] * e1[2],
    tvec[0] * e1[1] - tvec[1] * e1[0]
  ];
  const v = (dir[0] * q[0] + dir[1] * q[1] + dir[2] * q[2]) * invDet;
  if (v < 0 || u + v > 1) return null;
  const t = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) * invDet;
  return t > 1e-4 ? t : null;
}

/**
 * @param {number[]} worldOrigin
 * @param {number[]} worldDir
 * @param {GltfPickable} pickable
 * @returns {number|null} distance along ray
 */
export function intersectPickable(worldOrigin, worldDir, pickable) {
  const inv = invertMat4(pickable.worldMatrix);
  if (!inv) return null;
  const origin = transformPoint(inv, worldOrigin);
  const dir = transformDirection(inv, worldDir);
  const dLen = Math.hypot(dir[0], dir[1], dir[2]) || 1;
  const lDir = [dir[0] / dLen, dir[1] / dLen, dir[2] / dLen];

  let best = null;
  const { vertices, indices } = pickable;
  for (let i = 0; i < indices.length; i += 3) {
    const t = intersectTriangleLocal(origin, lDir, vertices, indices[i], indices[i + 1], indices[i + 2]);
    if (t != null && (best == null || t < best)) best = t;
  }
  return best;
}

/**
 * @param {GltfPickable[]} pickables
 * @param {HTMLCanvasElement} canvas
 * @param {number} clientX
 * @param {number} clientY
 * @param {Float32Array} viewProj
 * @param {number[]} cameraPos
 * @returns {{ annotationId: string, distance: number }|null}
 */
export function pickGltfAnnotations(pickables, canvas, clientX, clientY, viewProj, cameraPos) {
  if (!pickables?.length) return null;
  const inv = invertMat4(viewProj);
  if (!inv) return null;
  const { origin, direction } = rayFromScreen(canvas, clientX, clientY, inv, cameraPos);

  let hit = null;
  for (const p of pickables) {
    const t = intersectPickable(origin, direction, p);
    if (t == null) continue;
    const dist = t;
    if (!hit || dist < hit.distance) hit = { annotationId: p.annotationId, distance: dist };
  }
  return hit;
}
