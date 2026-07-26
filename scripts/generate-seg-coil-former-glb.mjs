#!/usr/bin/env node
/**
 * Generates src/public/assets/seg/coil-former.glb — second CAD prop for SEG focus
 * (bobbin / coil former at the tour "coil" callout). Run:
 *   npm run generate:coil-former-glb
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'src', 'public', 'assets', 'seg', 'coil-former.glb');

function box(cx, cy, cz, w, h, d) {
  const hw = w * 0.5;
  const hh = h * 0.5;
  const hd = d * 0.5;
  const corners = [
    [cx - hw, cy - hh, cz - hd], [cx + hw, cy - hh, cz - hd],
    [cx + hw, cy + hh, cz - hd], [cx - hw, cy + hh, cz - hd],
    [cx - hw, cy - hh, cz + hd], [cx + hw, cy - hh, cz + hd],
    [cx + hw, cy + hh, cz + hd], [cx - hw, cy + hh, cz + hd]
  ];
  const faces = [
    { n: [0, 0, -1], idx: [0, 1, 2, 3] },
    { n: [0, 0, 1], idx: [5, 4, 7, 6] },
    { n: [0, -1, 0], idx: [0, 4, 5, 1] },
    { n: [0, 1, 0], idx: [3, 2, 6, 7] },
    { n: [-1, 0, 0], idx: [0, 3, 7, 4] },
    { n: [1, 0, 0], idx: [1, 5, 6, 2] }
  ];
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  let base = 0;
  for (const f of faces) {
    for (let i = 0; i < 4; i++) {
      const p = corners[f.idx[i]];
      positions.push(p[0], p[1], p[2]);
      normals.push(f.n[0], f.n[1], f.n[2]);
      uvs.push(i < 2 ? 0 : 1, i % 3 === 0 || i === 3 ? 0 : 1);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    base += 4;
  }
  return { positions, normals, uvs, indices };
}

/** Low-poly cylinder (axis Y) approximated with N side boxes is overkill — use prism. */
function cylinderY(cx, cy, cz, radius, height, segments = 12) {
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  const hh = height * 0.5;
  const ring = (y, ny) => {
    const start = positions.length / 3;
    for (let i = 0; i < segments; i++) {
      const a0 = (i / segments) * Math.PI * 2;
      const a1 = ((i + 1) / segments) * Math.PI * 2;
      const x0 = cx + Math.cos(a0) * radius;
      const z0 = cz + Math.sin(a0) * radius;
      const x1 = cx + Math.cos(a1) * radius;
      const z1 = cz + Math.sin(a1) * radius;
      // side quad as two tris via four verts
      const base = positions.length / 3;
      const nx0 = Math.cos(a0);
      const nz0 = Math.sin(a0);
      const nx1 = Math.cos(a1);
      const nz1 = Math.sin(a1);
      positions.push(x0, cy - hh, z0, x1, cy - hh, z1, x1, cy + hh, z1, x0, cy + hh, z0);
      normals.push(nx0, 0, nz0, nx1, 0, nz1, nx1, 0, nz1, nx0, 0, nz0);
      uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
      void start;
      void ny;
    }
  };
  ring(cy, 0);
  // top / bottom caps (fan)
  const addCap = (y, ny) => {
    const center = positions.length / 3;
    positions.push(cx, y, cz);
    normals.push(0, ny, 0);
    uvs.push(0.5, 0.5);
    for (let i = 0; i < segments; i++) {
      const a0 = (i / segments) * Math.PI * 2;
      const a1 = ((i + 1) / segments) * Math.PI * 2;
      const i0 = positions.length / 3;
      positions.push(
        cx + Math.cos(a0) * radius, y, cz + Math.sin(a0) * radius,
        cx + Math.cos(a1) * radius, y, cz + Math.sin(a1) * radius
      );
      normals.push(0, ny, 0, 0, ny, 0);
      uvs.push(0, 0, 1, 0);
      if (ny > 0) indices.push(center, i0, i0 + 1);
      else indices.push(center, i0 + 1, i0);
    }
  };
  addCap(cy + hh, 1);
  addCap(cy - hh, -1);
  return { positions, normals, uvs, indices };
}

function merge(parts) {
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  for (const p of parts) {
    const base = positions.length / 3;
    positions.push(...p.positions);
    normals.push(...p.normals);
    uvs.push(...p.uvs);
    for (const i of p.indices) indices.push(i + base);
  }
  return { positions, normals, uvs, indices };
}

// Local metres; placed near coil annotation ([5.4, 0.15, 0.2] in housing).
const formerMesh = merge([
  cylinderY(0, 0, 0, 0.42, 0.95, 14),
  // flanges
  cylinderY(0, 0.52, 0, 0.62, 0.08, 14),
  cylinderY(0, -0.52, 0, 0.62, 0.08, 14),
  // mount stub toward assembly
  box(-0.55, 0, 0, 0.35, 0.18, 0.18)
]);

function packInterleaved(mesh) {
  const vertexCount = mesh.positions.length / 3;
  const interleaved = new Float32Array(vertexCount * 8);
  for (let i = 0; i < vertexCount; i++) {
    const o = i * 8;
    interleaved[o] = mesh.positions[i * 3];
    interleaved[o + 1] = mesh.positions[i * 3 + 1];
    interleaved[o + 2] = mesh.positions[i * 3 + 2];
    interleaved[o + 3] = mesh.normals[i * 3];
    interleaved[o + 4] = mesh.normals[i * 3 + 1];
    interleaved[o + 5] = mesh.normals[i * 3 + 2];
    interleaved[o + 6] = mesh.uvs[i * 2];
    interleaved[o + 7] = mesh.uvs[i * 2 + 1];
  }
  return { interleaved, indices: new Uint16Array(mesh.indices), vertexCount };
}

function packStride32(interleaved) {
  const vertexCount = interleaved.length / 8;
  const packed = new ArrayBuffer(vertexCount * 32);
  const packView = new DataView(packed);
  for (let i = 0; i < vertexCount; i++) {
    const src = i * 8;
    const dst = i * 32;
    for (let j = 0; j < 8; j++) {
      packView.setFloat32(dst + j * 4, interleaved[src + j], true);
    }
  }
  return packed;
}

const packedMesh = packInterleaved(formerMesh);
const packedBytes = new Uint8Array(packStride32(packedMesh.interleaved));
const idxBytes = new Uint8Array(packedMesh.indices.buffer);
const vertBytes = packedBytes.byteLength;
const idxOffset = vertBytes;

const finalBin = new ArrayBuffer(idxOffset + idxBytes.byteLength);
const outBytes = new Uint8Array(finalBin);
outBytes.set(packedBytes, 0);
outBytes.set(idxBytes, idxOffset);

let posMin = [Infinity, Infinity, Infinity];
let posMax = [-Infinity, -Infinity, -Infinity];
for (let i = 0; i < formerMesh.positions.length; i += 3) {
  for (let k = 0; k < 3; k++) {
    posMin[k] = Math.min(posMin[k], formerMesh.positions[i + k]);
    posMax[k] = Math.max(posMax[k], formerMesh.positions[i + k]);
  }
}

const gltf = {
  asset: { version: '2.0', generator: 'power_gen generate-seg-coil-former-glb' },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [
    {
      name: 'seg_coil_former_root',
      children: [1],
      translation: [5.4, 0.15, 0.2],
      extras: {
        power_gen: {
          role: 'coil_former',
          anchors: [
            { name: 'coil_axis', position: [0, 0, 0] },
            { name: 'coil_mount', position: [-0.55, 0, 0] }
          ]
        }
      }
    },
    {
      name: 'coil_former',
      mesh: 0,
      extras: {
        power_gen: {
          role: 'coil_former',
          materialRingIndex: 12.0
        }
      }
    }
  ],
  meshes: [
    {
      name: 'coil_former',
      primitives: [{
        attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 },
        indices: 3,
        mode: 4
      }]
    }
  ],
  accessors: [
    { bufferView: 0, componentType: 5126, count: packedMesh.vertexCount, type: 'VEC3', min: posMin, max: posMax },
    { bufferView: 1, componentType: 5126, count: packedMesh.vertexCount, type: 'VEC3' },
    { bufferView: 2, componentType: 5126, count: packedMesh.vertexCount, type: 'VEC2' },
    { bufferView: 3, componentType: 5123, count: packedMesh.indices.length, type: 'SCALAR' }
  ],
  bufferViews: [
    { buffer: 0, byteOffset: 0, byteLength: packedMesh.vertexCount * 12, byteStride: 32, target: 34962 },
    { buffer: 0, byteOffset: 12, byteLength: packedMesh.vertexCount * 12, byteStride: 32, target: 34962 },
    { buffer: 0, byteOffset: 24, byteLength: packedMesh.vertexCount * 8, byteStride: 32, target: 34962 },
    { buffer: 0, byteOffset: idxOffset, byteLength: idxBytes.byteLength, target: 34963 }
  ],
  buffers: [{ byteLength: finalBin.byteLength }]
};

const jsonText = JSON.stringify(gltf);
const jsonPad = (4 - (jsonText.length % 4)) % 4;
const jsonChunk = jsonText + ' '.repeat(jsonPad);
const jsonBytes = new TextEncoder().encode(jsonChunk);

const totalLength = 12 + 8 + jsonBytes.length + 8 + finalBin.byteLength;
const out = new ArrayBuffer(totalLength);
const dv = new DataView(out);
let o = 0;
dv.setUint32(o, 0x46546c67, true); o += 4;
dv.setUint32(o, 2, true); o += 4;
dv.setUint32(o, totalLength, true); o += 4;
dv.setUint32(o, jsonBytes.length, true); o += 4;
dv.setUint32(o, 0x4e4f534a, true); o += 4;
new Uint8Array(out, o, jsonBytes.length).set(jsonBytes);
o += jsonBytes.length;
dv.setUint32(o, finalBin.byteLength, true); o += 4;
dv.setUint32(o, 0x004e4942, true); o += 4;
new Uint8Array(out, o, finalBin.byteLength).set(new Uint8Array(finalBin));

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, Buffer.from(out));
console.log(
  `[generate-seg-coil-former-glb] wrote ${OUT} (${packedMesh.vertexCount} verts)`
);
