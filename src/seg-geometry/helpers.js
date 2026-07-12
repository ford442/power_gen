// Shared buffer + box builders for SEG geometry generators.

export function makeGeomBuffers(device, data) {
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
export function _dot3(a, b) {
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
  return makeGeomBuffers(device, {
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
  return makeGeomBuffers(device, {
    vertices: vertexData,
    indices: new Uint16Array(indices)
  });
}
