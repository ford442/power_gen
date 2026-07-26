/**
 * Load glTF CAD props for SEG focus view (WebGPU + seg-enhanced PBR).
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
  SEG_GLTF_PROPS
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
   * Load SEG glTF props (housing + coil former) after core procedural meshes.
   * @param {ArrayBuffer} [embeddedGlb] optional preloaded housing buffer (tests)
   * @param {{ propBuffers?: Record<string, ArrayBuffer> }} [opts]
   */
  async setupGltfAssets(embeddedGlb, opts = {}) {
    this.gltfHousingEnabled = parseGltfHousingEnabled();
    this.gltfHousingDrawables = [];
    this.gltfHousingAnchors = [];
    this.gltfHousingPickables = [];
    this.gltfAnnotationPoints = [];
    this.gltfLoadedProps = [];

    if (!this.gltfHousingEnabled) {
      console.log('[gltf] housing disabled (?gltfHousing=0) — skipping CAD props');
      return;
    }

    const layout = this.segLayout || this.refreshSEGLayout(1.0);
    const frameDims = computeFrameDimensions(layout);
    const scale = layout.worldScale;
    const yOffset = frameDims.baseBottomY;
    /** @type {import('../assets/gltf/gltf-pick.js').GltfPickable[]} */
    const pickables = [];

    for (const prop of SEG_GLTF_PROPS) {
      if (!prop.enabled()) continue;
      try {
        let doc;
        if (prop.id === 'housing' && embeddedGlb) {
          doc = parseGlb(embeddedGlb);
        } else if (opts.propBuffers?.[prop.id]) {
          doc = parseGlb(opts.propBuffers[prop.id]);
        } else {
          doc = await loadGlb(prop.url);
        }
        const extracted = extractGltfMeshes(doc);
        const scene = buildGltfScene(extracted, { propId: prop.id });

        this.gltfHousingAnchors.push(
          ...scene.anchors.map((a) => ({
            ...a,
            propId: prop.id,
            worldPosition: [
              a.worldPosition[0] * scale,
              a.worldPosition[1] * scale + yOffset,
              a.worldPosition[2] * scale
            ]
          }))
        );

        this.gltfAnnotationPoints.push(
          ...scene.annotations.map((a) => ({
            id: a.annotationId,
            propId: prop.id,
            pos: [
              a.worldPosition[0] * scale,
              a.worldPosition[1] * scale + yOffset,
              a.worldPosition[2] * scale
            ]
          }))
        );

        let drawableCount = 0;
        for (const drawable of scene.roots.flatMap((r) => r.flattenDrawables())) {
          const isAnnotation = !!drawable.annotationId;
          const scaledVerts = bakeWorldVertices(
            drawable.mesh.vertices,
            drawable.worldMatrix,
            scale,
            yOffset
          );

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
            color: prop.defaultColor,
            emissive: 0
          });
          this.gltfHousingDrawables.push({
            name: drawable.name,
            propId: prop.id,
            role: drawable.role || prop.role,
            gpu,
            instanceBuffer,
            ringIndex: drawable.materialRingIndex,
            annotationId: null
          });
          this.profiler.trackBuffer(`gltf-${prop.id}-${drawable.name}-vb`, gpu.vertexBuffer.size, GPUBufferUsage.VERTEX);
          this.profiler.trackBuffer(`gltf-${prop.id}-${drawable.name}-ib`, gpu.indexBuffer.size, GPUBufferUsage.INDEX);
          this.profiler.trackBuffer(`gltf-${prop.id}-${drawable.name}-inst`, GLTF_INSTANCE_BYTES, GPUBufferUsage.STORAGE);
          drawableCount += 1;
        }

        this.gltfLoadedProps.push(prop.id);
        console.log(
          `[gltf] loaded ${prop.id}: ${drawableCount} drawable(s), ` +
          `${scene.anchors.length} anchor(s), ${scene.annotations.length} annotation(s)`
        );
      } catch (err) {
        console.warn(`[gltf] ${prop.id} load failed`, err);
        if (prop.id === 'housing') {
          this.gltfHousingEnabled = false;
          this.gltfHousingDrawables = [];
          this.gltfLoadedProps = [];
          return;
        }
      }
    }

    this.gltfHousingPickables = pickables;
    if (this.gltfHousingEnabled) {
      attachGltfHousingPickHandler(this);
    }

    console.log(
      `[gltf] CAD props ready: ${this.gltfLoadedProps.join(', ') || '(none)'} — ` +
      `${this.gltfHousingDrawables.length} drawable(s), ${pickables.length} pick(s)`
    );
  },

  /** RPM / segOmega-driven emissive on housing trim (greenEmissive channel). */
  updateGltfHousingState() {
    if (!this.gltfHousingDrawables?.length) return;
    const omega = this.segOmega ?? 0;
    const emissive = Math.min(0.55, omega * 0.12);
    for (const d of this.gltfHousingDrawables) {
      // Coil former gets a subtler copper glow
      const scale = d.role === 'coil_former' || d.propId === 'coilFormer' ? 0.65 : 1.0;
      updateGltfInstanceEmissive(this.device, d.instanceBuffer, emissive * scale);
    }
  }
};
