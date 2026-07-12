// CPU primitive mesh builders (pos+normal or pos+normal+uv).

export const primitiveMethods = {
  generateCylinder(radius, height, segments) {
    const vertices = [], indices = [], normals = [];

    for (let i = 0; i <= segments; i++) {
      const theta = (i / segments) * Math.PI * 2;
      const x = Math.cos(theta) * radius;
      const z = Math.sin(theta) * radius;

      vertices.push(x, height / 2, z);
      normals.push(0, 1, 0);

      vertices.push(x, -height / 2, z);
      normals.push(0, -1, 0);

      vertices.push(x, height / 2, z);
      normals.push(Math.cos(theta), 0, Math.sin(theta));

      vertices.push(x, -height / 2, z);
      normals.push(Math.cos(theta), 0, Math.sin(theta));
    }

    for (let i = 0; i < segments; i++) {
      const base = i * 4;
      const next = ((i + 1) % (segments + 1)) * 4;

      indices.push(base, next, base + 2, base + 2, next, next + 2);
      indices.push(base + 1, base + 3, next + 1, next + 1, base + 3, next + 3);
      indices.push(base + 2, next + 2, base + 3, base + 3, next + 2, next + 3);
    }

    const vertexData = new Float32Array(vertices.length / 3 * 6);
    for (let i = 0; i < vertices.length / 3; i++) {
      vertexData[i * 6] = vertices[i * 3];
      vertexData[i * 6 + 1] = vertices[i * 3 + 1];
      vertexData[i * 6 + 2] = vertices[i * 3 + 2];
      vertexData[i * 6 + 3] = normals[i * 3];
      vertexData[i * 6 + 4] = normals[i * 3 + 1];
      vertexData[i * 6 + 5] = normals[i * 3 + 2];
    }

    return { vertices: vertexData, indices: new Uint16Array(indices) };
  },

  generateDisc(innerRadius, outerRadius, thickness, segments) {
    const vertices = [], indices = [], normals = [];
    const h2 = thickness / 2;

    for (let i = 0; i <= segments; i++) {
      const theta = (i / segments) * Math.PI * 2;
      const c = Math.cos(theta), s = Math.sin(theta);

      vertices.push(c * innerRadius, h2, s * innerRadius);
      normals.push(0, 1, 0);

      vertices.push(c * outerRadius, h2, s * outerRadius);
      normals.push(0, 1, 0);

      vertices.push(c * outerRadius, -h2, s * outerRadius);
      normals.push(0, -1, 0);

      vertices.push(c * innerRadius, -h2, s * innerRadius);
      normals.push(0, -1, 0);

      vertices.push(c * outerRadius, h2, s * outerRadius);
      normals.push(c, 0, s);

      vertices.push(c * outerRadius, -h2, s * outerRadius);
      normals.push(c, 0, s);

      vertices.push(c * innerRadius, h2, s * innerRadius);
      normals.push(-c, 0, -s);

      vertices.push(c * innerRadius, -h2, s * innerRadius);
      normals.push(-c, 0, -s);
    }

    for (let i = 0; i < segments; i++) {
      const b = i * 8;
      const n = ((i + 1) % (segments + 1)) * 8;
      // Top face
      indices.push(b, n, b + 1, b + 1, n, n + 1);
      // Bottom face
      indices.push(b + 2, b + 3, n + 2, n + 2, b + 3, n + 3);
      // Outer wall
      indices.push(b + 4, b + 5, n + 4, n + 4, b + 5, n + 5);
      // Inner wall
      indices.push(b + 6, n + 6, b + 7, b + 7, n + 6, n + 7);
    }

    const vertexData = new Float32Array(vertices.length / 3 * 6);
    for (let i = 0; i < vertices.length / 3; i++) {
      vertexData[i * 6] = vertices[i * 3];
      vertexData[i * 6 + 1] = vertices[i * 3 + 1];
      vertexData[i * 6 + 2] = vertices[i * 3 + 2];
      vertexData[i * 6 + 3] = normals[i * 3];
      vertexData[i * 6 + 4] = normals[i * 3 + 1];
      vertexData[i * 6 + 5] = normals[i * 3 + 2];
    }
    return { vertices: vertexData, indices: new Uint16Array(indices) };
  },

  generateCylinderWithUVs(radius, height, segments) {
    const vertices = [], indices = [], normals = [], uvs = [];
    for (let i = 0; i <= segments; i++) {
      const theta = (i / segments) * Math.PI * 2;
      const x = Math.cos(theta) * radius;
      const z = Math.sin(theta) * radius;
      const u = i / segments;

      vertices.push(x, height / 2, z);
      normals.push(0, 1, 0);
      uvs.push(u, 1);

      vertices.push(x, -height / 2, z);
      normals.push(0, -1, 0);
      uvs.push(u, 0);

      vertices.push(x, height / 2, z);
      normals.push(Math.cos(theta), 0, Math.sin(theta));
      uvs.push(u, 1);

      vertices.push(x, -height / 2, z);
      normals.push(Math.cos(theta), 0, Math.sin(theta));
      uvs.push(u, 0);
    }

    for (let i = 0; i < segments; i++) {
      const base = i * 4;
      const next = ((i + 1) % (segments + 1)) * 4;
      indices.push(base, next, base + 2, base + 2, next, next + 2);
      indices.push(base + 1, base + 3, next + 1, next + 1, base + 3, next + 3);
      indices.push(base + 2, next + 2, base + 3, base + 3, next + 2, next + 3);
    }

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
    return { vertices: vertexData, indices: new Uint16Array(indices) };
  },

  generateDiscWithUVs(innerRadius, outerRadius, thickness, segments) {
    const vertices = [], indices = [], normals = [], uvs = [];
    const h2 = thickness / 2;

    for (let i = 0; i <= segments; i++) {
      const theta = (i / segments) * Math.PI * 2;
      const c = Math.cos(theta), s = Math.sin(theta);
      const u = i / segments;

      vertices.push(c * innerRadius, h2, s * innerRadius);
      normals.push(0, 1, 0);
      uvs.push(0, u);

      vertices.push(c * outerRadius, h2, s * outerRadius);
      normals.push(0, 1, 0);
      uvs.push(1, u);

      vertices.push(c * outerRadius, -h2, s * outerRadius);
      normals.push(0, -1, 0);
      uvs.push(1, u);

      vertices.push(c * innerRadius, -h2, s * innerRadius);
      normals.push(0, -1, 0);
      uvs.push(0, u);

      vertices.push(c * outerRadius, h2, s * outerRadius);
      normals.push(c, 0, s);
      uvs.push(u, 1);

      vertices.push(c * outerRadius, -h2, s * outerRadius);
      normals.push(c, 0, s);
      uvs.push(u, 0);

      vertices.push(c * innerRadius, h2, s * innerRadius);
      normals.push(-c, 0, -s);
      uvs.push(u, 1);

      vertices.push(c * innerRadius, -h2, s * innerRadius);
      normals.push(-c, 0, -s);
      uvs.push(u, 0);
    }

    for (let i = 0; i < segments; i++) {
      const b = i * 8;
      const n = ((i + 1) % (segments + 1)) * 8;
      indices.push(b, n, b + 1, b + 1, n, n + 1);
      indices.push(b + 2, b + 3, n + 2, n + 2, b + 3, n + 3);
      indices.push(b + 4, b + 5, n + 4, n + 4, b + 5, n + 5);
      indices.push(b + 6, n + 6, b + 7, b + 7, n + 6, n + 7);
    }

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
    return { vertices: vertexData, indices: new Uint16Array(indices) };
  },

  generateBoxWithUVs(width, height, depth) {
    const w = width / 2;
    const h = height / 2;
    const d = depth / 2;
    const vertices = new Float32Array([
      // front (+z)
      -w, -h,  d,  0, 0, 1,  0, 0,
       w, -h,  d,  0, 0, 1,  1, 0,
       w,  h,  d,  0, 0, 1,  1, 1,
      -w,  h,  d,  0, 0, 1,  0, 1,
      // back (-z)
       w, -h, -d,  0, 0, -1,  0, 0,
      -w, -h, -d,  0, 0, -1,  1, 0,
      -w,  h, -d,  0, 0, -1,  1, 1,
       w,  h, -d,  0, 0, -1,  0, 1,
      // top (+y)
      -w,  h,  d,  0, 1, 0,  0, 0,
       w,  h,  d,  0, 1, 0,  1, 0,
       w,  h, -d,  0, 1, 0,  1, 1,
      -w,  h, -d,  0, 1, 0,  0, 1,
      // bottom (-y)
       w, -h,  d,  0, -1, 0,  0, 0,
      -w, -h,  d,  0, -1, 0,  1, 0,
      -w, -h, -d,  0, -1, 0,  1, 1,
       w, -h, -d,  0, -1, 0,  0, 1,
      // right (+x)
       w, -h,  d,  1, 0, 0,  0, 0,
       w, -h, -d,  1, 0, 0,  1, 0,
       w,  h, -d,  1, 0, 0,  1, 1,
       w,  h,  d,  1, 0, 0,  0, 1,
      // left (-x)
      -w, -h, -d,  -1, 0, 0,  0, 0,
      -w, -h,  d,  -1, 0, 0,  1, 0,
      -w,  h,  d,  -1, 0, 0,  1, 1,
      -w,  h, -d,  -1, 0, 0,  0, 1,
    ]);
    const indices = new Uint16Array([
      0, 1, 2,  0, 2, 3,
      4, 5, 6,  4, 6, 7,
      8, 9, 10,  8, 10, 11,
      12, 13, 14,  12, 14, 15,
      16, 17, 18,  16, 18, 19,
      20, 21, 22,  20, 22, 23
    ]);
    return { vertices, indices };
  }
};
