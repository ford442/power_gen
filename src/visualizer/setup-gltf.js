/**
 * Load glTF housing assets for SEG focus view (WebGPU + seg-enhanced PBR).
 * WebGL2 fallback keeps procedural geometry only — see docs/GLTF_ASSETS.md.
 */
import { loadGlb, parseGlb, extractGltfMeshes } from '../assets/gltf/gltf-loader.js';
import { buildGltfScene } from '../assets/gltf/gltf-scene.js';
import {
  uploadGltfMesh,
  createGltfInstanceBuffer,
  updateGltfInstanceEmissive,
  GLTF_INSTANCE_BYTES
} from '../assets/gltf/gltf-gpu.js';
import {
  parseGltfHousingEnabled,
  SEG_HOUSING_GLB_URL
} from '../assets/gltf/parse-gltf-housing.js';
import { attachGltfHousingPickHandler } from '../assets/gltf/gltf-housing-pick.js';
import { computeFrameDimensions } from '../seg-frame-model.js';

function scaleMeshVertices(vertices, scale, offsetY = 0) {
  const out = new Float32Array(vertices.length);
  for (let i = 0; i < vertices.length; i += 8) {
    out[i] = vertices[i] * scale;
    out[i + 1] = vertices[i + 1] * scale + offsetY;
    out[i + 2] = vertices[i + 2] * scale;
    out[i + 3] = vertices[i + 3];
    out[i + 4] = vertices[i + 4];
    out[i + 5] = vertices[i + 5];
    out[i + 6] = vertices[i + 6];
    out[i + 7] = vertices[i + 7];
  }
  return out;
}

function bakeWorldVertices(vertices, worldMatrix, scale, offsetY = 0) {
  const out = new Float32Array(vertices.length);
  const m = worldMatrix;
  for (let i = 0; i < vertices.length; i += 8) {
    const lx = vertices[i];
    const ly = vertices[i + 1];
    const lz = vertices[i + 2];
    out[i] = (m[0] * lx + m[4] * ly + m[8] * lz + m[12]) * scale;
    out[i + 1] = (m[1] * lx + m[5] * ly + m[9] * lz + m[13]) * scale + offsetY;
    out[i + 2] = (m[2] * lx + m[6] * ly + m[10] * lz + m[14]) * scale;
    out[i + 3] = vertices[i + 3];
    out[i + 4] = vertices[i + 4];
    out[i + 5] = vertices[i + 5];
    out[i + 6] = vertices[i + 6];
    out[i + 7] = vertices[i + 7];
  }
  return out;
}

export const gltfSetupMethods = {
  parseGltfHousingEnabled,

  /**
   * Load SEG housing GLB after core procedural meshes are ready.
   * @param {ArrayBuffer} [embeddedGlb] optional preloaded buffer (tests)
   */
  async setupGltfAssets(embeddedGlb) {
    this.gltfHousingEnabled = parseGltfHousingEnabled();
    this.gltfHousingDrawables = [];
    this.gltfHousingAnchors = [];
    this.gltfHousingPickables = [];
    this.gltfAnnotationPoints = [];

    if (!this.gltfHousingEnabled) {
      console.log('[gltf] housing disabled (?gltfHousing=0)');
      return;
    }

    try {
      const doc = embeddedGlb
        ? parseGlb(embeddedGlb)
        : await loadGlb(SEG_HOUSING_GLB_URL);
      const extracted = extractGltfMeshes(doc);
      const scene = buildGltfScene(extracted);
      const layout = this.segLayout || this.refreshSEGLayout(1.0);
      const frameDims = computeFrameDimensions(layout);
      const scale = layout.worldScale;
      const yOffset = frameDims.baseBottomY;

      this.gltfHousingAnchors = scene.anchors.map((a) => ({
        ...a,
        worldPosition: [
          a.worldPosition[0] * scale,
          a.worldPosition[1] * scale + yOffset,
          a.worldPosition[2] * scale
        ]
      }));

      this.gltfAnnotationPoints = scene.annotations.map((a) => ({
        id: a.annotationId,
        pos: [
          a.worldPosition[0] * scale,
          a.worldPosition[1] * scale + yOffset,
          a.worldPosition[2] * scale
        ]
      }));

      /** @type {import('../assets/gltf/gltf-pick.js').GltfPickable[]} */
      const pickables = [];

      for (const drawable of scene.roots.flatMap((r) => r.flattenDrawables())) {
        const isAnnotation = !!drawable.annotationId;
        const scaledVerts = isAnnotation
          ? bakeWorldVertices(drawable.mesh.vertices, drawable.worldMatrix, scale, yOffset)
          : scaleMeshVertices(drawable.mesh.vertices, scale, yOffset);

        if (isAnnotation) {
          pickables.push({
            annotationId: drawable.annotationId,
            vertices: scaledVerts,
            indices: drawable.mesh.indices,
            worldMatrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
          });
          continue;
        }

        const gpu = uploadGltfMesh(this.device, {
          vertices: scaledVerts,
          indices: drawable.mesh.indices
        });
        const instanceBuffer = createGltfInstanceBuffer(this.device, {
          position: [0, 0, 0],
          ringIndex: drawable.materialRingIndex,
          color: [0.78, 0.80, 0.84],
          emissive: 0
        });
        this.gltfHousingDrawables.push({
          name: drawable.name,
          gpu,
          instanceBuffer,
          ringIndex: drawable.materialRingIndex,
          annotationId: null
        });
        this.profiler.trackBuffer(`gltf-${drawable.name}-vb`, gpu.vertexBuffer.size, GPUBufferUsage.VERTEX);
        this.profiler.trackBuffer(`gltf-${drawable.name}-ib`, gpu.indexBuffer.size, GPUBufferUsage.INDEX);
        this.profiler.trackBuffer(`gltf-${drawable.name}-inst`, GLTF_INSTANCE_BYTES, GPUBufferUsage.STORAGE);
      }

      this.gltfHousingPickables = pickables;
      attachGltfHousingPickHandler(this);

      console.log(
        `[gltf] loaded housing: ${this.gltfHousingDrawables.length} drawable(s), ` +
        `${this.gltfHousingAnchors.length} anchor(s), ${pickables.length} annotation pick(s)`
      );
    } catch (err) {
      console.warn('[gltf] housing load failed — procedural frame only', err);
      this.gltfHousingEnabled = false;
      this.gltfHousingDrawables = [];
    }
  },

  /** RPM / segOmega-driven emissive on housing trim (greenEmissive channel). */
  updateGltfHousingState() {
    if (!this.gltfHousingDrawables?.length) return;
    const omega = this.segOmega ?? 0;
    const emissive = Math.min(0.55, omega * 0.12);
    for (const d of this.gltfHousingDrawables) {
      updateGltfInstanceEmissive(this.device, d.instanceBuffer, emissive);
    }
  }
};
