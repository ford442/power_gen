/**
 * Formal scene graph node for CAD props and glTF hierarchy.
 *
 * ADR-0003 / ADR-0005 — no Three.js Object3D. Nodes feed the existing
 * WebGPU (and future reduced WebGL2) mesh path via flattenDrawables().
 *
 * @typedef {'housing'|'coil_former'|'annotation'|'prop'|string|null} SceneNodeRole
 * @typedef {{ name: string, position: [number, number, number], worldPosition?: [number, number, number] }} SceneAnchor
 * @typedef {{ annotationId: string, name: string, worldPosition: [number, number, number], node: SceneNode }} SceneAnnotation
 * @typedef {{ ringIndex?: number, color?: [number, number, number], metallic?: number, roughness?: number }} SceneMaterial
 */

/**
 * Column-major 4×4 TRS compose (glTF convention).
 * @param {[number, number, number]} t
 * @param {[number, number, number, number]} r quaternion xyzw
 * @param {[number, number, number]} s
 */
export function composeTrsMatrix(t, r, s) {
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

/** @param {Float32Array} out @param {Float32Array|number[]} a @param {Float32Array|number[]} b */
export function multiplyMat4(out, a, b) {
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

/** @param {Float32Array|number[]} m @param {[number, number, number]|number[]} p */
export function transformPoint(m, p) {
  const x = p[0];
  const y = p[1];
  const z = p[2];
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14]
  ];
}

export class SceneNode {
  /**
   * @param {object} [opts]
   * @param {string} [opts.name]
   * @param {[number, number, number]} [opts.translation]
   * @param {[number, number, number, number]} [opts.rotation]
   * @param {[number, number, number]} [opts.scale]
   * @param {object[]|null} [opts.meshPrimitives]
   * @param {SceneMaterial} [opts.material]
   * @param {object} [opts.extras]
   * @param {SceneNodeRole} [opts.role]
   * @param {string|null} [opts.annotationId]
   * @param {string|null} [opts.propId] registry id (`housing`, `coilFormer`, …)
   */
  constructor(opts = {}) {
    this.name = opts.name || 'node';
    this.visible = true;
    this.parent = null;
    /** @type {SceneNode[]} */
    this.children = [];
    this.localTranslation = opts.translation ? [...opts.translation] : [0, 0, 0];
    this.localRotation = opts.rotation ? [...opts.rotation] : [0, 0, 0, 1];
    this.localScale = opts.scale ? [...opts.scale] : [1, 1, 1];
    this.worldMatrix = new Float32Array(16);
    this.meshPrimitives = opts.meshPrimitives ?? null;
    this.material = opts.material || { ringIndex: 11.0 };
    this.materialRingIndex = this.material.ringIndex ?? 11.0;
    this.extras = opts.extras || {};
    this.annotationId = opts.annotationId
      ?? this.extras.annotationId
      ?? null;
    this.role = opts.role
      ?? this.extras?.power_gen?.role
      ?? (this.annotationId ? 'annotation' : null);
    this.propId = opts.propId ?? null;
    /** Optional back-ref to source glTF node descriptor */
    this.source = opts.source ?? null;
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

  /** @returns {SceneAnnotation[]} */
  collectAnnotations() {
    /** @type {SceneAnnotation[]} */
    const out = [];
    if (this.annotationId) {
      out.push({
        annotationId: this.annotationId,
        name: this.name,
        worldPosition: [this.worldMatrix[12], this.worldMatrix[13], this.worldMatrix[14]],
        node: this
      });
    }
    for (const child of this.children) {
      out.push(...child.collectAnnotations());
    }
    return out;
  }

  /** @returns {SceneAnchor[]} */
  collectAnchors() {
    /** @type {SceneAnchor[]} */
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

  /**
   * Flatten visible mesh primitives with baked world transforms.
   * @returns {object[]}
   */
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
          annotationId: this.annotationId,
          role: this.role,
          propId: this.propId,
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
