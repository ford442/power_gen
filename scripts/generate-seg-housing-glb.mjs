#!/usr/bin/env node
/**
 * Generates src/public/assets/seg/housing-shell.glb — minimal showroom housing
 * for the hybrid procedural + glTF pipeline. Run: npm run generate:housing-glb
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'src', 'public', 'assets', 'seg', 'housing-shell.glb');

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

// Reference metres — scaled at runtime via SEG layout worldScale.
const mesh = merge([
  box(0, -2.55, 0, 12.5, 0.38, 12.5),
  box(0, -0.95, -5.95, 12.2, 3.2, 0.22),
  box(-5.95, -0.95, 0, 0.22, 3.2, 11.6),
  box(5.95, -0.95, 0, 0.22, 3.2, 11.6),
  box(0, 0.72, 5.95, 12.2, 0.18, 0.22),
  box(0, -0.35, 0, 10.8, 0.12, 10.8)
]);

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

const indices = new Uint16Array(mesh.indices);
const bin = new ArrayBuffer(interleaved.byteLength + indices.byteLength);
new Uint8Array(bin).set(new Uint8Array(interleaved.buffer), 0);
new Uint8Array(bin).set(new Uint8Array(indices.buffer), interleaved.byteLength);

const posMin = [-6.5, -2.8, -6.5];
const posMax = [6.5, 1.0, 6.5];

const gltf = {
  asset: { version: '2.0', generator: 'power_gen generate-seg-housing-glb' },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{
    name: 'seg_housing_shell',
    mesh: 0,
    extras: {
      power_gen: {
        materialRingIndex: 11.0,
        anchors: [
          { name: 'assembly_origin', position: [0, 0, 0] },
          { name: 'telemetry_mount', position: [0, 1.1, 5.2] },
          { name: 'power_feed', position: [-5.2, 0.2, -5.2] }
        ]
      }
    }
  }],
  meshes: [{
    name: 'housing_shell',
    primitives: [{
      attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 },
      indices: 3,
      mode: 4
    }]
  }],
  accessors: [
    { bufferView: 0, componentType: 5126, count: vertexCount, type: 'VEC3', min: posMin, max: posMax },
    { bufferView: 1, componentType: 5126, count: vertexCount, type: 'VEC3' },
    { bufferView: 2, componentType: 5126, count: vertexCount, type: 'VEC2' },
    { bufferView: 3, componentType: 5123, count: indices.length, type: 'SCALAR' }
  ],
  bufferViews: [
    { buffer: 0, byteOffset: 0, byteLength: vertexCount * 12, byteStride: 32, target: 34962 },
    { buffer: 0, byteOffset: 12, byteLength: vertexCount * 12, byteStride: 32, target: 34962 },
    { buffer: 0, byteOffset: 24, byteLength: vertexCount * 8, byteStride: 32, target: 34962 },
    { buffer: 0, byteOffset: interleaved.byteLength, byteLength: indices.byteLength, target: 34963 }
  ],
  buffers: [{ byteLength: bin.byteLength }]
};

// Pack interleaved as 32-byte stride views (POSITION@0, NORMAL@12, TEXCOORD@24)
const packed = new ArrayBuffer(vertexCount * 32);
const packView = new DataView(packed);
for (let i = 0; i < vertexCount; i++) {
  const src = i * 8;
  const dst = i * 32;
  for (let j = 0; j < 8; j++) {
    packView.setFloat32(dst + j * 4, interleaved[src + j], true);
  }
}
const finalBin = new ArrayBuffer(packed.byteLength + indices.byteLength);
new Uint8Array(finalBin).set(new Uint8Array(packed), 0);
new Uint8Array(finalBin).set(new Uint8Array(indices.buffer), packed.byteLength);
gltf.buffers[0].byteLength = finalBin.byteLength;

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
console.log(`[generate-seg-housing-glb] wrote ${OUT} (${vertexCount} verts, ${indices.length} indices)`);
