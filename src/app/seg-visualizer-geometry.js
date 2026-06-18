// Generated Geometry Methods for SEGVisualizer
export const SEGVisualizerGeometry = {
  generateCylinder: function (radius, height, segments) {
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

  generateSphere: function (radius, segments, rings) {
    const vertices = [], indices = [], normals = [];

    for (let ring = 0; ring <= rings; ring++) {
      const phi = (ring / rings) * Math.PI;
      for (let seg = 0; seg <= segments; seg++) {
        const theta = (seg / segments) * Math.PI * 2;
        const x = Math.sin(phi) * Math.cos(theta) * radius;
        const y = Math.cos(phi) * radius;
        const z = Math.sin(phi) * Math.sin(theta) * radius;

        vertices.push(x, y, z);
        const len = Math.sqrt(x*x + y*y + z*z);
        normals.push(x/len, y/len, z/len);
      }
    }

    for (let ring = 0; ring < rings; ring++) {
      for (let seg = 0; seg < segments; seg++) {
        const a = ring * (segments + 1) + seg;
        const b = a + 1;
        const c = a + segments + 1;
        const d = c + 1;

        indices.push(a, c, b);
        indices.push(b, c, d);
      }
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

  generateTorus: function (majorRadius, minorRadius, majorSegments, minorSegments) {
    const vertices = [], indices = [], normals = [];

    for (let major = 0; major <= majorSegments; major++) {
      const theta = (major / majorSegments) * Math.PI * 2;
      const cx = Math.cos(theta) * majorRadius;
      const cz = Math.sin(theta) * majorRadius;

      for (let minor = 0; minor <= minorSegments; minor++) {
        const phi = (minor / minorSegments) * Math.PI * 2;
        const x = cx + Math.cos(phi) * Math.cos(theta) * minorRadius;
        const y = Math.sin(phi) * minorRadius;
        const z = cz + Math.cos(phi) * Math.sin(theta) * minorRadius;

        vertices.push(x, y, z);
        const nx = Math.cos(phi) * Math.cos(theta);
        const ny = Math.sin(phi);
        const nz = Math.cos(phi) * Math.sin(theta);
        normals.push(nx, ny, nz);
      }
    }

    for (let major = 0; major < majorSegments; major++) {
      for (let minor = 0; minor < minorSegments; minor++) {
        const a = major * (minorSegments + 1) + minor;
        const b = a + 1;
        const c = a + minorSegments + 1;
        const d = c + 1;

        indices.push(a, c, b);
        indices.push(b, c, d);
      }
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

  generateRingDisc: function (innerRadius, outerRadius, segments = 64, thickness = 0.10) {
    const verts = [];
    const inds  = [];
    const h = thickness / 2;
    const inner = Math.max(innerRadius, 0.01);

    for (let i = 0; i <= segments; i++) {
      const theta = (i / segments) * Math.PI * 2;
      const c = Math.cos(theta), s = Math.sin(theta);
      // top face (normal up)
      verts.push(c * inner,  h, s * inner,  0, 1, 0);
      verts.push(c * outerRadius, h, s * outerRadius, 0, 1, 0);
      // bottom face (normal down)
      verts.push(c * inner, -h, s * inner,  0, -1, 0);
      verts.push(c * outerRadius, -h, s * outerRadius, 0, -1, 0);
      // outer side (normal outward)
      verts.push(c * outerRadius,  h, s * outerRadius, c, 0, s);
      verts.push(c * outerRadius, -h, s * outerRadius, c, 0, s);
      // inner side (normal inward)
      verts.push(c * inner,  h, s * inner, -c, 0, -s);
      verts.push(c * inner, -h, s * inner, -c, 0, -s);
    }
    // 8 vertices per angular step
    for (let i = 0; i < segments; i++) {
      const b = i * 8, n = (i + 1) * 8;
      // top quad
      inds.push(b,     n,     b + 1, b + 1, n,     n + 1);
      // bottom quad (reversed winding)
      inds.push(b + 2, b + 3, n + 2, n + 2, b + 3, n + 3);
      // outer side
      inds.push(b + 4, b + 5, n + 4, n + 4, b + 5, n + 5);
      // inner side (reversed)
      inds.push(b + 6, n + 6, b + 7, b + 7, n + 6, n + 7);
    }
    return { vertices: new Float32Array(verts), indices: new Uint16Array(inds) };
  },

  _makeGeomBuffers: function (data) {
    const vb = this.device.createBuffer({
      size: data.vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
    });
    this.device.queue.writeBuffer(vb, 0, data.vertices);
    const ib = this.device.createBuffer({
      size: data.indices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST
    });
    this.device.queue.writeBuffer(ib, 0, data.indices);
    return { vb, ib, count: data.indices.length };
  },

};
