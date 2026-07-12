/**
 * Scene graph for loaded glTF assets — transform hierarchy, visibility, anchor baking.
 */

/** @typedef {{ name: string, position: [number, number, number], worldPosition?: [number, number, number] }} GltfAnchor */

/**
 * @param {import('./gltf-loader.js').extractGltfMeshes extends Function ? ReturnType<import('./gltf-loader.js').extractGltfMeshes> : never} extracted
 */
export function buildGltfScene(extracted) {
  const { meshes, nodes, scenes, scene } = extracted;
  const nodeByIndex = nodes.map((n) => new GltfSceneNode(n, meshes));

  for (const n of nodeByIndex) {
    for (const childIdx of n.source.children) {
      const child = nodeByIndex[childIdx];
      if (child) {
        n.children.push(child);
        child.parent = n;
      }
    }
  }

  const rootIndices = scenes[scene]?.nodes ?? [0];
  const roots = rootIndices.map((i) => nodeByIndex[i]).filter(Boolean);

  /** @type {GltfAnchor[]} */
  const anchors = [];
  for (const root of roots) {
    root.updateWorldTransform();
    anchors.push(...root.collectAnchors());
  }

  return { roots, nodeByIndex, anchors };
}

export class GltfSceneNode {
  /**
   * @param {object} source
   * @param {object[]} meshes
   */
  constructor(source, meshes) {
    this.source = source;
    this.name = source.name;
    this.visible = true;
    this.parent = null;
    /** @type {GltfSceneNode[]} */
    this.children = [];
    this.localTranslation = [...source.translation];
    this.localRotation = [...source.rotation];
    this.localScale = [...source.scale];
    this.worldMatrix = new Float32Array(16);
    this.meshPrimitives = null;
    this.materialRingIndex = source.extras?.power_gen?.materialRingIndex ?? 11.0;
    this.extras = source.extras || {};

    if (source.mesh != null && meshes[source.mesh]) {
      this.meshPrimitives = meshes[source.mesh].primitives;
    }
  }

  updateWorldTransform(parentMatrix = null) {
    const local = composeTrsMatrix(
      this.localTranslation,
      this.localRotation,
      this.localScale
    );
    if (parentMatrix) {
      multiplyMat4(this.worldMatrix, parentMatrix, local);
    } else {
      this.worldMatrix.set(local);
    }
    for (const child of this.children) {
      child.updateWorldTransform(this.worldMatrix);
    }
  }

  /** @returns {GltfAnchor[]} */
  collectAnchors() {
    /** @type {GltfAnchor[]} */
    const out = [];
    const pg = this.extras.power_gen;
    if (pg?.anchors) {
      for (const a of pg.anchors) {
        const wp = transformPoint(this.worldMatrix, a.position);
        out.push({ name: a.name, position: a.position, worldPosition: wp });
      }
    }
    for (const child of this.children) {
      out.push(...child.collectAnchors());
    }
    return out;
  }

  /** Flatten visible mesh primitives with baked world transforms. */
  flattenDrawables() {
    /** @type {object[]} */
    const out = [];
    if (this.visible && this.meshPrimitives) {
      for (const prim of this.meshPrimitives) {
        out.push({
          name: `${this.name}:${prim.name}`,
          mesh: prim,
          worldMatrix: Float32Array.from(this.worldMatrix),
          materialRingIndex: this.materialRingIndex,
          node: this
        });
      }
    }
    for (const child of this.children) {
      out.push(...child.flattenDrawables());
    }
    return out;
  }
}

function composeTrsMatrix(t, r, s) {
  const m = new Float32Array(16);
  const [qx, qy, qz, qw] = r;
  const [sx, sy, sz] = s;
  const x2 = qx + qx;
  const y2 = qy + qy;
  const z2 = qz + qz;
  const xx = qx * x2;
  const xy = qx * y2;
  const xz = qx * z2;
  const yy = qy * y2;
  const yz = qy * z2;
  const zz = qz * z2;
  const wx = qw * x2;
  const wy = qw * y2;
  const wz = qw * z2;

  m[0] = (1 - (yy + zz)) * sx;
  m[1] = (xy + wz) * sx;
  m[2] = (xz - wy) * sx;
  m[3] = 0;
  m[4] = (xy - wz) * sy;
  m[5] = (1 - (xx + zz)) * sy;
  m[6] = (yz + wx) * sy;
  m[7] = 0;
  m[8] = (xz + wy) * sz;
  m[9] = (yz - wx) * sz;
  m[10] = (1 - (xx + yy)) * sz;
  m[11] = 0;
  m[12] = t[0];
  m[13] = t[1];
  m[14] = t[2];
  m[15] = 1;
  return m;
}

function multiplyMat4(out, a, b) {
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] =
        a[r] * b[c * 4] +
        a[4 + r] * b[c * 4 + 1] +
        a[8 + r] * b[c * 4 + 2] +
        a[12 + r] * b[c * 4 + 3];
    }
  }
}

function transformPoint(m, p) {
  const x = p[0];
  const y = p[1];
  const z = p[2];
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14]
  ];
}
