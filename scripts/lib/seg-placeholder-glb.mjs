/**
 * Shared procedural GLB packer + tiny GPU-native KTX2 blobs for SEG placeholders.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  write,
  VK_FORMAT_R8G8B8A8_UNORM,
  VK_FORMAT_BC1_RGBA_UNORM_BLOCK,
  VK_FORMAT_ETC2_R8G8B8_UNORM_BLOCK,
  VK_FORMAT_ASTC_4x4_UNORM_BLOCK,
  KHR_SUPERCOMPRESSION_NONE,
  KHR_DF_VENDORID_KHRONOS,
  KHR_DF_KHR_DESCRIPTORTYPE_BASICFORMAT,
  KHR_DF_VERSION,
  KHR_DF_MODEL_UNSPECIFIED,
  KHR_DF_MODEL_RGBSDA,
  KHR_DF_MODEL_ETC2,
  KHR_DF_MODEL_ASTC,
  KHR_DF_PRIMARIES_BT709,
  KHR_DF_TRANSFER_LINEAR,
  KHR_DF_FLAG_ALPHA_STRAIGHT
} from 'ktx-parse';

export function box(cx, cy, cz, w, h, d) {
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

/**
 * Low-poly cylinder (optionally capped) about the Y or X axis. Quads on the
 * side, a triangle fan per cap — enough for a coil bobbin or a VDG column
 * without spending the placeholder byte budget on smoothness nobody will see
 * from focus distance.
 */
export function cylinder(cx, cy, cz, radius, height, segments = 16, opts = {}) {
  const { caps = true, axis = 'y' } = opts;
  const seg = Math.max(3, Math.floor(segments));
  const half = height * 0.5;
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];

  // Map (radial u, radial v, axial) → world, so one body of code covers both axes.
  const place = (ru, rv, ax) => (axis === 'x'
    ? [cx + ax, cy + ru, cz + rv]
    : [cx + ru, cy + ax, cz + rv]);
  const axisNormal = axis === 'x' ? [1, 0, 0] : [0, 1, 0];

  let base = 0;
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2;
    const a1 = ((i + 1) / seg) * Math.PI * 2;
    const c0 = Math.cos(a0);
    const s0 = Math.sin(a0);
    const c1 = Math.cos(a1);
    const s1 = Math.sin(a1);
    const ring = [
      { p: place(c0 * radius, s0 * radius, -half), n: place(c0, s0, 0), u: i / seg, v: 0 },
      { p: place(c1 * radius, s1 * radius, -half), n: place(c1, s1, 0), u: (i + 1) / seg, v: 0 },
      { p: place(c1 * radius, s1 * radius, half), n: place(c1, s1, 0), u: (i + 1) / seg, v: 1 },
      { p: place(c0 * radius, s0 * radius, half), n: place(c0, s0, 0), u: i / seg, v: 1 }
    ];
    for (const vert of ring) {
      positions.push(vert.p[0], vert.p[1], vert.p[2]);
      // `place` returns a translated point; subtract the centre for the normal.
      normals.push(vert.n[0] - cx, vert.n[1] - cy, vert.n[2] - cz);
      uvs.push(vert.u, vert.v);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    base += 4;

    if (caps) {
      for (const [ax, sign] of [[half, 1], [-half, -1]]) {
        const centre = place(0, 0, ax);
        const p0 = place(c0 * radius, s0 * radius, ax);
        const p1 = place(c1 * radius, s1 * radius, ax);
        const n = [axisNormal[0] * sign, axisNormal[1] * sign, axisNormal[2] * sign];
        // Wind the far cap the other way so both faces point outward.
        const tri = sign > 0 ? [centre, p0, p1] : [centre, p1, p0];
        for (const p of tri) {
          positions.push(p[0], p[1], p[2]);
          normals.push(n[0], n[1], n[2]);
          uvs.push(0.5, 0.5);
        }
        indices.push(base, base + 1, base + 2);
        base += 3;
      }
    }
  }
  return { positions, normals, uvs, indices };
}

/**
 * Low-poly lat/long sphere. Default 16×8 is ~512 verts — a recognisable dome
 * for a Van de Graaff at a fraction of the placeholder budget.
 */
export function sphere(cx, cy, cz, radius, segU = 16, segV = 8) {
  const u = Math.max(3, Math.floor(segU));
  const v = Math.max(2, Math.floor(segV));
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  const at = (i, j) => {
    const theta = (i / u) * Math.PI * 2;
    const phi = (j / v) * Math.PI;
    const n = [
      Math.sin(phi) * Math.cos(theta),
      Math.cos(phi),
      Math.sin(phi) * Math.sin(theta)
    ];
    return { n, p: [cx + n[0] * radius, cy + n[1] * radius, cz + n[2] * radius], u: i / u, v: j / v };
  };
  let base = 0;
  for (let j = 0; j < v; j++) {
    for (let i = 0; i < u; i++) {
      const quad = [at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)];
      for (const vert of quad) {
        positions.push(vert.p[0], vert.p[1], vert.p[2]);
        normals.push(vert.n[0], vert.n[1], vert.n[2]);
        uvs.push(vert.u, vert.v);
      }
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
      base += 4;
    }
  }
  return { positions, normals, uvs, indices };
}

export function merge(parts) {
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

export function bounds(positions) {
  const posMin = [Infinity, Infinity, Infinity];
  const posMax = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      posMin[k] = Math.min(posMin[k], positions[i + k]);
      posMax[k] = Math.max(posMax[k], positions[i + k]);
    }
  }
  return { posMin, posMax };
}

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

function rgb565(r, g, b) {
  return ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
}

/** 4×4 BC1 (DXT1) solid color — opaque 4-color mode (c0 > c1), all indices 0. */
export function encodeBc1Solid(r, g, b) {
  let c0 = rgb565(r, g, b);
  let c1 = c0 === 0 ? 1 : c0 - 1;
  if (c0 <= c1) {
    const tmp = c0;
    c0 = c1;
    c1 = tmp;
  }
  const out = new Uint8Array(8);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, c0, true);
  dv.setUint16(2, c1, true);
  dv.setUint32(4, 0, true);
  return out;
}

/** 4×4 ETC2 RGB (ETC1 individual mode) solid-ish color. */
export function encodeEtc2RgbSolid(r, g, b) {
  const r4 = Math.min(15, Math.round(r / 17));
  const g4 = Math.min(15, Math.round(g / 17));
  const b4 = Math.min(15, Math.round(b / 17));
  const bytes = new Uint8Array(8);
  bytes[0] = (r4 << 4) | r4;
  bytes[1] = (g4 << 4) | g4;
  bytes[2] = (b4 << 4) | b4;
  bytes[3] = 0;
  bytes[4] = 0xff;
  bytes[5] = 0xff;
  bytes[6] = 0;
  bytes[7] = 0;
  return bytes;
}

/** 4×4 ASTC LDR void-extent constant color. */
export function encodeAstc4Solid(r, g, b, a = 255) {
  const block = new Uint8Array(16);
  block[0] = 0xfc;
  block[1] = 0xfd;
  block[2] = 0xff;
  block[3] = 0xff;
  block[4] = 0xff;
  block[5] = 0xff;
  block[6] = 0xff;
  block[7] = 0xff;
  const R = r | (r << 8);
  const G = g | (g << 8);
  const B = b | (b << 8);
  const A = a | (a << 8);
  block[8] = R & 0xff;
  block[9] = R >> 8;
  block[10] = G & 0xff;
  block[11] = G >> 8;
  block[12] = B & 0xff;
  block[13] = B >> 8;
  block[14] = A & 0xff;
  block[15] = A >> 8;
  return block;
}

function dfd(colorModel, blockW, blockH, bytesPlane0) {
  return {
    vendorId: KHR_DF_VENDORID_KHRONOS,
    descriptorType: KHR_DF_KHR_DESCRIPTORTYPE_BASICFORMAT,
    versionNumber: KHR_DF_VERSION,
    colorModel,
    colorPrimaries: KHR_DF_PRIMARIES_BT709,
    transferFunction: KHR_DF_TRANSFER_LINEAR,
    flags: KHR_DF_FLAG_ALPHA_STRAIGHT,
    texelBlockDimension: [Math.max(0, blockW - 1), Math.max(0, blockH - 1), 0, 0],
    bytesPlane: [bytesPlane0, 0, 0, 0, 0, 0, 0, 0],
    samples: []
  };
}

function ktx2Container(vkFormat, colorModel, blockW, blockH, bytesPlane0, levelData) {
  return {
    vkFormat,
    typeSize: 1,
    pixelWidth: 4,
    pixelHeight: 4,
    pixelDepth: 0,
    layerCount: 0,
    faceCount: 1,
    levelCount: 1,
    supercompressionScheme: KHR_SUPERCOMPRESSION_NONE,
    levels: [{ levelData, uncompressedByteLength: levelData.byteLength }],
    dataFormatDescriptor: [dfd(colorModel, blockW, blockH, bytesPlane0)],
    keyValue: { KTXorientation: 'rd' },
    globalData: null
  };
}

export function encodeRgba8Solid(r, g, b, a = 255) {
  const pix = new Uint8Array(4 * 4 * 4);
  for (let i = 0; i < 16; i++) {
    const o = i * 4;
    pix[o] = r;
    pix[o + 1] = g;
    pix[o + 2] = b;
    pix[o + 3] = a;
  }
  return pix;
}

/** Tiny 4×4 albedo set: uncompressed + BC1 + ETC2 + ASTC KTX2. */
export function makeAlbedoKtx2Set(r, g, b) {
  const rgba = write(ktx2Container(
    VK_FORMAT_R8G8B8A8_UNORM,
    KHR_DF_MODEL_RGBSDA,
    1,
    1,
    4,
    encodeRgba8Solid(r, g, b)
  ));
  const bc = write(ktx2Container(
    VK_FORMAT_BC1_RGBA_UNORM_BLOCK,
    KHR_DF_MODEL_UNSPECIFIED,
    4,
    4,
    8,
    encodeBc1Solid(r, g, b)
  ));
  const etc2 = write(ktx2Container(
    VK_FORMAT_ETC2_R8G8B8_UNORM_BLOCK,
    KHR_DF_MODEL_ETC2,
    4,
    4,
    8,
    encodeEtc2RgbSolid(r, g, b)
  ));
  const astc = write(ktx2Container(
    VK_FORMAT_ASTC_4x4_UNORM_BLOCK,
    KHR_DF_MODEL_ASTC,
    4,
    4,
    16,
    encodeAstc4Solid(r, g, b)
  ));
  return { rgba, bc, etc2, astc };
}

function concatChunks(chunks) {
  const aligned = [];
  let total = 0;
  for (const c of chunks) {
    const pad = (4 - (c.byteLength % 4)) % 4;
    aligned.push({ bytes: c, pad });
    total += c.byteLength + pad;
  }
  const bin = new Uint8Array(total);
  let o = 0;
  const offsets = [];
  for (const { bytes, pad } of aligned) {
    offsets.push({ byteOffset: o, byteLength: bytes.byteLength });
    bin.set(bytes, o);
    o += bytes.byteLength + pad;
  }
  return { bin, offsets };
}

export function writePlaceholderGlb(outPath, opts) {
  const {
    generator,
    rootName,
    meshName,
    mesh,
    extras,
    includeKtx2 = false,
    albedoRgb = [90, 92, 97]
  } = opts;

  const packedMesh = packInterleaved(mesh);
  const vertBytes = new Uint8Array(packStride32(packedMesh.interleaved));
  const idxBytes = new Uint8Array(packedMesh.indices.buffer, packedMesh.indices.byteOffset, packedMesh.indices.byteLength);
  const { posMin, posMax } = bounds(mesh.positions);

  const chunks = [vertBytes, idxBytes];
  let ktxSet = null;
  if (includeKtx2) {
    ktxSet = makeAlbedoKtx2Set(albedoRgb[0], albedoRgb[1], albedoRgb[2]);
    chunks.push(ktxSet.rgba, ktxSet.bc, ktxSet.etc2, ktxSet.astc);
  }

  const { bin, offsets } = concatChunks(chunks);
  const vertOff = offsets[0];
  const idxOff = offsets[1];

  const images = [];
  const imageViews = [];
  let compressedAlbedo = null;
  if (ktxSet) {
    const keys = ['none', 'bc', 'etc2', 'astc'];
    compressedAlbedo = {};
    for (let i = 0; i < 4; i++) {
      const off = offsets[2 + i];
      imageViews.push({
        buffer: 0,
        byteOffset: off.byteOffset,
        byteLength: off.byteLength
      });
      images.push({
        mimeType: 'image/ktx2',
        bufferView: 4 + i,
        name: `albedo_${keys[i]}`
      });
      compressedAlbedo[keys[i]] = i;
    }
  }

  const rootExtras = {
    power_gen: {
      ...extras.power_gen,
      ...(compressedAlbedo ? { compressedAlbedo } : {})
    }
  };

  const gltf = {
    asset: { version: '2.0', generator },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [
      {
        name: rootName,
        children: [1],
        extras: rootExtras
      },
      {
        name: meshName,
        mesh: 0,
        extras: { power_gen: extras.power_gen }
      }
    ],
    meshes: [
      {
        name: meshName,
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
      { buffer: 0, byteOffset: vertOff.byteOffset, byteLength: packedMesh.vertexCount * 12, byteStride: 32, target: 34962 },
      { buffer: 0, byteOffset: vertOff.byteOffset + 12, byteLength: packedMesh.vertexCount * 12, byteStride: 32, target: 34962 },
      { buffer: 0, byteOffset: vertOff.byteOffset + 24, byteLength: packedMesh.vertexCount * 8, byteStride: 32, target: 34962 },
      { buffer: 0, byteOffset: idxOff.byteOffset, byteLength: idxOff.byteLength, target: 34963 },
      ...imageViews
    ],
    buffers: [{ byteLength: bin.byteLength }]
  };
  if (images.length) gltf.images = images;

  const jsonText = JSON.stringify(gltf);
  const jsonPad = (4 - (jsonText.length % 4)) % 4;
  const jsonBytes = new TextEncoder().encode(jsonText + ' '.repeat(jsonPad));

  const totalLength = 12 + 8 + jsonBytes.length + 8 + bin.byteLength;
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
  dv.setUint32(o, bin.byteLength, true); o += 4;
  dv.setUint32(o, 0x004e4942, true); o += 4;
  new Uint8Array(out, o, bin.byteLength).set(bin);

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, Buffer.from(out));
  return {
    bytes: totalLength,
    vertexCount: packedMesh.vertexCount,
    ktx2: !!includeKtx2
  };
}
