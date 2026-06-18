/**
 * CPU-side primitive mesh generators shared by WebGPU and WebGL2 paths.
 * Layout: interleaved position (3) + normal (3) per vertex = 6 floats.
 */

export function generateCylinder(radius, height, segments = 24) {
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

  const vertexData = new Float32Array((vertices.length / 3) * 6);
  for (let i = 0; i < vertices.length / 3; i++) {
    vertexData[i * 6] = vertices[i * 3];
    vertexData[i * 6 + 1] = vertices[i * 3 + 1];
    vertexData[i * 6 + 2] = vertices[i * 3 + 2];
    vertexData[i * 6 + 3] = normals[i * 3];
    vertexData[i * 6 + 4] = normals[i * 3 + 1];
    vertexData[i * 6 + 5] = normals[i * 3 + 2];
  }

  return { vertices: vertexData, indices: new Uint16Array(indices) };
}

export function generateDisc(innerRadius, outerRadius, thickness, segments = 48) {
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
    indices.push(b, n, b + 1, b + 1, n, n + 1);
    indices.push(b + 2, b + 3, n + 2, n + 2, b + 3, n + 3);
    indices.push(b + 4, b + 5, n + 4, n + 4, b + 5, n + 5);
    indices.push(b + 6, n + 6, b + 7, b + 7, n + 6, n + 7);
  }

  const vertexData = new Float32Array((vertices.length / 3) * 6);
  for (let i = 0; i < vertices.length / 3; i++) {
    vertexData[i * 6] = vertices[i * 3];
    vertexData[i * 6 + 1] = vertices[i * 3 + 1];
    vertexData[i * 6 + 2] = vertices[i * 3 + 2];
    vertexData[i * 6 + 3] = normals[i * 3];
    vertexData[i * 6 + 4] = normals[i * 3 + 1];
    vertexData[i * 6 + 5] = normals[i * 3 + 2];
  }
  return { vertices: vertexData, indices: new Uint16Array(indices) };
}

/**
 * Upload interleaved pos+normal mesh to WebGL2 buffers.
 * @returns {{ vao: WebGLVertexArrayObject, indexCount: number }}
 */
export function uploadMesh(gl, mesh) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);

  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, mesh.vertices, gl.STATIC_DRAW);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
  gl.enableVertexAttribArray(1);

  const ibo = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);

  gl.bindVertexArray(null);
  return { vao, indexCount: mesh.indices.length, vbo, ibo };
}
