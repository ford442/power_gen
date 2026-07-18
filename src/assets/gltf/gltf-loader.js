/**
 * Minimal glTF 2.0 / GLB loader — no external dependencies.
 * Supports POSITION, NORMAL, TEXCOORD_0, indexed triangles, node TRS + mesh.
 */

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

const COMPONENT_ARRAY = {
  5120: Int8Array,
  5121: Uint8Array,
  5122: Int16Array,
  5123: Uint16Array,
  5125: Uint32Array,
  5126: Float32Array
};

const TYPE_COMPONENTS = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4
};

/**
 * @param {string} url
 * @returns {Promise<{ json: object, bin: ArrayBuffer }>}
 */
export async function loadGlb(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`[gltf] fetch failed ${url}: ${res.status}`);
  return parseGlb(await res.arrayBuffer());
}

/**
 * @param {ArrayBuffer} arrayBuffer
 */
export function parseGlb(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  if (view.getUint32(0, true) !== GLB_MAGIC) throw new Error('[gltf] invalid GLB magic');
  if (view.getUint32(4, true) !== 2) throw new Error('[gltf] GLB v2 only');
  const total = view.getUint32(8, true);

  let offset = 12;
  let json = null;
  let bin = null;

  while (offset < total) {
    const chunkLen = view.getUint32(offset, true);
    const chunkType = view.getUint32(offset + 4, true);
    offset += 8;
    const chunk = arrayBuffer.slice(offset, offset + chunkLen);
    if (chunkType === CHUNK_JSON) {
      json = JSON.parse(new TextDecoder().decode(chunk));
    } else if (chunkType === CHUNK_BIN) {
      bin = chunk;
    }
    offset += chunkLen;
  }

  if (!json || !bin) throw new Error('[gltf] GLB missing JSON or BIN chunk');
  return { json, bin };
}

function readAccessor(json, bin, accessorIndex) {
  const acc = json.accessors[accessorIndex];
  const bv = json.bufferViews[acc.bufferView];
  const byteOffset = (bv.byteOffset || 0) + (acc.byteOffset || 0);
  const Ctor = COMPONENT_ARRAY[acc.componentType];
  if (!Ctor) throw new Error(`[gltf] unsupported componentType ${acc.componentType}`);
  const comp = TYPE_COMPONENTS[acc.type];
  const stride = bv.byteStride || comp * Ctor.BYTES_PER_ELEMENT;
  const out = new Float32Array(acc.count * comp);

  if (stride === comp * Ctor.BYTES_PER_ELEMENT) {
    const src = new Ctor(bin, byteOffset, acc.count * comp);
    for (let i = 0; i < src.length; i++) out[i] = src[i];
    return { data: out, components: comp, count: acc.count };
  }

  const view = new DataView(bin);
  for (let i = 0; i < acc.count; i++) {
    const base = byteOffset + i * stride;
    for (let c = 0; c < comp; c++) {
      out[i * comp + c] = view.getFloat32(base + c * 4, true);
    }
  }
  return { data: out, components: comp, count: acc.count };
}

function readIndices(json, bin, accessorIndex) {
  const acc = json.accessors[accessorIndex];
  const bv = json.bufferViews[acc.bufferView];
  const byteOffset = (bv.byteOffset || 0) + (acc.byteOffset || 0);
  const Ctor = COMPONENT_ARRAY[acc.componentType];
  const src = new Ctor(bin, byteOffset, acc.count);
  if (acc.componentType === 5123) return new Uint16Array(src.buffer, src.byteOffset, src.length);
  if (acc.componentType === 5125) {
    const out = new Uint16Array(src.length);
    for (let i = 0; i < src.length; i++) out[i] = src[i];
    return out;
  }
  throw new Error(`[gltf] unsupported index componentType ${acc.componentType}`);
}

/**
 * Interleaved mesh: 8 floats/vertex (pos3, normal3, uv2) for seg-enhanced pipeline.
 * Node `extras.annotationId` is preserved for SEG Explainer tour wiring.
 * @param {{ json: object, bin: ArrayBuffer }} doc
 * @returns {{ meshes: object[], nodes: object[] }}
 */
export function extractGltfMeshes(doc) {
  const { json, bin } = doc;
  const meshes = (json.meshes || []).map((mesh, meshIndex) => {
    const primitives = mesh.primitives.map((prim) => {
      const pos = readAccessor(json, bin, prim.attributes.POSITION);
      const nrm = prim.attributes.NORMAL != null
        ? readAccessor(json, bin, prim.attributes.NORMAL)
        : null;
      const uv = prim.attributes.TEXCOORD_0 != null
        ? readAccessor(json, bin, prim.attributes.TEXCOORD_0)
        : null;
      const indices = readIndices(json, bin, prim.indices);
      const count = pos.count;
      const vertices = new Float32Array(count * 8);
      for (let i = 0; i < count; i++) {
        const o = i * 8;
        vertices[o] = pos.data[i * 3];
        vertices[o + 1] = pos.data[i * 3 + 1];
        vertices[o + 2] = pos.data[i * 3 + 2];
        if (nrm) {
          vertices[o + 3] = nrm.data[i * 3];
          vertices[o + 4] = nrm.data[i * 3 + 1];
          vertices[o + 5] = nrm.data[i * 3 + 2];
        } else {
          vertices[o + 3] = 0;
          vertices[o + 4] = 1;
          vertices[o + 5] = 0;
        }
        if (uv) {
          vertices[o + 6] = uv.data[i * 2];
          vertices[o + 7] = uv.data[i * 2 + 1];
        }
      }
      return {
        name: mesh.name || `mesh_${meshIndex}`,
        vertices,
        indices,
        vertexCount: count,
        indexCount: indices.length
      };
    });
    return { name: mesh.name || `mesh_${meshIndex}`, primitives };
  });

  const nodes = (json.nodes || []).map((node, nodeIndex) => ({
    index: nodeIndex,
    name: node.name || `node_${nodeIndex}`,
    mesh: node.mesh ?? null,
    translation: node.translation || [0, 0, 0],
    rotation: node.rotation || [0, 0, 0, 1],
    scale: node.scale || [1, 1, 1],
    children: node.children || [],
    extras: node.extras || {}
  }));

  return { meshes, nodes, scene: json.scene ?? 0, scenes: json.scenes || [{ nodes: [0] }] };
}
