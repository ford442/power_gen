/**
 * Formal scene graph node for CAD props and glTF hierarchy.
 *
 * ADR-0003 / ADR-0005 — no Three.js Object3D. Nodes feed the existing
 * WebGPU (and future reduced WebGL2) mesh path via flattenDrawables().
 */

export type SceneNodeRole = 'housing' | 'coil_former' | 'annotation' | 'prop' | string | null;

export interface SceneAnchor {
  name: string;
  position: [number, number, number];
  worldPosition?: [number, number, number];
}

export interface SceneAnnotation {
  annotationId: string;
  name: string;
  worldPosition: [number, number, number];
  node: SceneNode;
}

export interface SceneMaterial {
  ringIndex?: number;
  color?: [number, number, number];
  metallic?: number;
  roughness?: number;
}

export interface SceneMeshPrimitive {
  name: string;
  [key: string]: unknown;
}

export interface SceneDrawable {
  name: string;
  mesh: SceneMeshPrimitive;
  worldMatrix: Float32Array;
  materialRingIndex: number;
  annotationId: string | null;
  role: SceneNodeRole;
  propId: string | null;
  node: SceneNode;
}

export interface SceneNodeExtras {
  annotationId?: string;
  power_gen?: {
    role?: SceneNodeRole;
    anchors?: Array<{ name: string; position: [number, number, number] }>;
  };
  [key: string]: unknown;
}

export interface SceneNodeOptions {
  name?: string;
  translation?: [number, number, number];
  rotation?: [number, number, number, number];
  scale?: [number, number, number];
  meshPrimitives?: SceneMeshPrimitive[] | null;
  material?: SceneMaterial;
  extras?: SceneNodeExtras;
  role?: SceneNodeRole;
  annotationId?: string | null;
  propId?: string | null;
  source?: unknown;
}

/**
 * Column-major 4×4 TRS compose (glTF convention).
 * @param t translation
 * @param r quaternion xyzw
 * @param s scale
 */
export function composeTrsMatrix(
  t: [number, number, number] | number[],
  r: [number, number, number, number] | number[],
  s: [number, number, number] | number[]
): Float32Array {
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

export function multiplyMat4(
  out: Float32Array,
  a: Float32Array | number[],
  b: Float32Array | number[]
): void {
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

export function transformPoint(
  m: Float32Array | number[],
  p: [number, number, number] | number[]
): [number, number, number] {
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
  name: string;
  visible = true;
  parent: SceneNode | null = null;
  children: SceneNode[] = [];
  localTranslation: number[];
  localRotation: number[];
  localScale: number[];
  worldMatrix: Float32Array;
  meshPrimitives: SceneMeshPrimitive[] | null;
  material: SceneMaterial;
  materialRingIndex: number;
  extras: SceneNodeExtras;
  annotationId: string | null;
  role: SceneNodeRole;
  propId: string | null;
  source: unknown;

  constructor(opts: SceneNodeOptions = {}) {
    this.name = opts.name || 'node';
    this.localTranslation = opts.translation ? [...opts.translation] : [0, 0, 0];
    this.localRotation = opts.rotation ? [...opts.rotation] : [0, 0, 0, 1];
    this.localScale = opts.scale ? [...opts.scale] : [1, 1, 1];
    this.worldMatrix = new Float32Array(16);
    this.meshPrimitives = opts.meshPrimitives ?? null;
    this.material = opts.material || { ringIndex: 11.0 };
    this.materialRingIndex = this.material.ringIndex ?? 11.0;
    this.extras = opts.extras || {};
    this.annotationId =
      opts.annotationId ?? this.extras.annotationId ?? null;
    this.role =
      opts.role ??
      this.extras?.power_gen?.role ??
      (this.annotationId ? 'annotation' : null);
    this.propId = opts.propId ?? null;
    this.source = opts.source ?? null;
  }

  updateWorldTransform(parentMatrix: Float32Array | null = null): void {
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

  collectAnnotations(): SceneAnnotation[] {
    const out: SceneAnnotation[] = [];
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

  collectAnchors(): SceneAnchor[] {
    const out: SceneAnchor[] = [];
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
  flattenDrawables(): SceneDrawable[] {
    const out: SceneDrawable[] = [];
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
