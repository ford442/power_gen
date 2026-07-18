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
const housingMesh = merge([
  box(0, -2.55, 0, 12.5, 0.38, 12.5),
  box(0, -0.95, -5.95, 12.2, 3.2, 0.22),
  box(-5.95, -0.95, 0, 0.22, 3.2, 11.6),
  box(5.95, -0.95, 0, 0.22, 3.2, 11.6),
  box(0, 0.72, 5.95, 12.2, 0.18, 0.22),
  box(0, -0.35, 0, 10.8, 0.12, 10.8)
]);

/** Tour-linked housing callouts — `extras.annotationId` on pick-proxy nodes. */
const HOUSING_ANNOTATIONS = [
  { id: 'shaft', translation: [0, 0, 0] },
  { id: 'inner-ring', translation: [2.8, 0.35, 0] },
  { id: 'stator', translation: [4.2, 0.1, 0] },
  { id: 'separator', translation: [3.0, -0.5, 2.2] },
  { id: 'outer-ring', translation: [4.8, 0.25, 2.8] },
  { id: 'coil', translation: [5.4, 0.15, 0.2] }
];

const pickMesh = box(0, 0, 0, 0.75, 0.75, 0.75);

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

const housing = packInterleaved(housingMesh);
const pick = packInterleaved(pickMesh);
const housingPacked = packStride32(housing.interleaved);
const pickPacked = packStride32(pick.interleaved);
const housingPackedBytes = new Uint8Array(housingPacked);
const pickPackedBytes = new Uint8Array(pickPacked);
const housingIdxBytes = new Uint8Array(housing.indices.buffer);
const pickIdxBytes = new Uint8Array(pick.indices.buffer);

const housingVertBytes = housingPacked.byteLength;
const pickVertBytes = pickPacked.byteLength;
const housingIdxOffset = housingVertBytes + pickVertBytes;
const pickIdxOffset = housingIdxOffset + housingIdxBytes.byteLength;

const finalBin = new ArrayBuffer(pickIdxOffset + pickIdxBytes.byteLength);
const outBytes = new Uint8Array(finalBin);
outBytes.set(housingPackedBytes, 0);
outBytes.set(pickPackedBytes, housingVertBytes);
outBytes.set(housingIdxBytes, housingIdxOffset);
outBytes.set(pickIdxBytes, pickIdxOffset);

const posMin = [-6.5, -2.8, -6.5];
const posMax = [6.5, 1.0, 6.5];
const pickMin = [-0.5, -0.5, -0.5];
const pickMax = [0.5, 0.5, 0.5];

const annNodeStart = 2;
const annNodes = HOUSING_ANNOTATIONS.map((a, i) => ({
  name: `ann_${a.id}`,
  mesh: 1,
  translation: a.translation,
  extras: { annotationId: a.id }
}));

const gltf = {
  asset: { version: '2.0', generator: 'power_gen generate-seg-housing-glb' },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [
    {
      name: 'seg_housing_root',
      children: [1, ...HOUSING_ANNOTATIONS.map((_, i) => annNodeStart + i)],
      extras: {
        power_gen: {
          anchors: [
            { name: 'assembly_origin', position: [0, 0, 0] },
            { name: 'telemetry_mount', position: [0, 1.1, 5.2] },
            { name: 'power_feed', position: [-5.2, 0.2, -5.2] }
          ]
        }
      }
    },
    {
      name: 'housing_shell',
      mesh: 0,
      extras: { power_gen: { materialRingIndex: 11.0 } }
    },
    ...annNodes
  ],
  meshes: [
    {
      name: 'housing_shell',
      primitives: [{
        attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 },
        indices: 3,
        mode: 4
      }]
    },
    {
      name: 'annotation_pick_proxy',
      primitives: [{
        attributes: { POSITION: 4, NORMAL: 5, TEXCOORD_0: 6 },
        indices: 7,
        mode: 4
      }]
    }
  ],
  accessors: [
    { bufferView: 0, componentType: 5126, count: housing.vertexCount, type: 'VEC3', min: posMin, max: posMax },
    { bufferView: 1, componentType: 5126, count: housing.vertexCount, type: 'VEC3' },
    { bufferView: 2, componentType: 5126, count: housing.vertexCount, type: 'VEC2' },
    { bufferView: 3, componentType: 5123, count: housing.indices.length, type: 'SCALAR' },
    { bufferView: 4, componentType: 5126, count: pick.vertexCount, type: 'VEC3', min: pickMin, max: pickMax },
    { bufferView: 5, componentType: 5126, count: pick.vertexCount, type: 'VEC3' },
    { bufferView: 6, componentType: 5126, count: pick.vertexCount, type: 'VEC2' },
    { bufferView: 7, componentType: 5123, count: pick.indices.length, type: 'SCALAR' }
  ],
  bufferViews: [
    { buffer: 0, byteOffset: 0, byteLength: housing.vertexCount * 12, byteStride: 32, target: 34962 },
    { buffer: 0, byteOffset: 12, byteLength: housing.vertexCount * 12, byteStride: 32, target: 34962 },
    { buffer: 0, byteOffset: 24, byteLength: housing.vertexCount * 8, byteStride: 32, target: 34962 },
    { buffer: 0, byteOffset: housingIdxOffset, byteLength: housingIdxBytes.byteLength, target: 34963 },
    { buffer: 0, byteOffset: housingVertBytes, byteLength: pick.vertexCount * 12, byteStride: 32, target: 34962 },
    { buffer: 0, byteOffset: housingVertBytes + 12, byteLength: pick.vertexCount * 12, byteStride: 32, target: 34962 },
    { buffer: 0, byteOffset: housingVertBytes + 24, byteLength: pick.vertexCount * 8, byteStride: 32, target: 34962 },
    { buffer: 0, byteOffset: pickIdxOffset, byteLength: pickIdxBytes.byteLength, target: 34963 }
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
  `[generate-seg-housing-glb] wrote ${OUT} ` +
  `(${housing.vertexCount} housing verts, ${HOUSING_ANNOTATIONS.length} annotation nodes)`
);
