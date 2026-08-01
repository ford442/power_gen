/**
 * Load glTF CAD props for SEG focus view (WebGPU + seg-enhanced PBR).
 * Lazy multi-prop registry: resident housing stays after first focus;
 * focus-only props (coil former+) dispose when leaving SEG.
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
  SEG_GLTF_PROPS,
  resolvePropMaterial
} from '../assets/gltf/prop-registry.js';
import { attachGltfHousingPickHandler } from '../assets/gltf/gltf-housing-pick.js';
import { computeFrameDimensions } from '../seg-frame-model.js';

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

function destroyGpuBuffer(buf) {
  try {
    buf?.destroy?.();
  } catch {
    /* already destroyed */
  }
}

export const gltfSetupMethods = {
  parseGltfHousingEnabled,

  /**
   * Prepare empty CAD prop state. Heavy GLB decode is deferred until SEG focus
   * via {@link ensureGltfPropsForView} so overview stays light.
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
    this._gltfPropBuffers = opts.propBuffers || null;
    this._gltfEmbeddedHousing = embeddedGlb || null;
    this._gltfLoadInFlight = null;
    this._gltfPickHandlerAttached = false;

    if (!this.gltfHousingEnabled) {
      console.log('[gltf] housing disabled (?gltfHousing=0) — skipping CAD props');
      return;
    }

    // If already focused on SEG at boot, load immediately; else wait for focus.
    if (this.currentView === 'seg') {
      await this.ensureGltfPropsForView('seg');
    } else {
      console.log('[gltf] CAD props deferred until SEG focus (overview stays light)');
    }
  },

  /**
   * Load / dispose props for the active view (SEG focus only).
   * @param {string} view
   */
  async ensureGltfPropsForView(view) {
    if (!this.gltfHousingEnabled) return;
    if (view === 'seg') {
      await this._loadGltfPropsForSegFocus();
    } else {
      this._disposeFocusOnlyGltfProps();
    }
  },

  /** @private */
  async _loadGltfPropsForSegFocus() {
    if (this._gltfLoadInFlight) return this._gltfLoadInFlight;
    this._gltfLoadInFlight = this._loadGltfPropsForSegFocusInner()
      .finally(() => { this._gltfLoadInFlight = null; });
    return this._gltfLoadInFlight;
  },

  /** @private */
  async _loadGltfPropsForSegFocusInner() {
    const layout = this.segLayout || this.refreshSEGLayout?.(1.0);
    if (!layout) return;
    const frameDims = computeFrameDimensions(layout);
    const scale = layout.worldScale;
    const yOffset = frameDims.baseBottomY;
    /** @type {import('../assets/gltf/gltf-pick.js').GltfPickable[]} */
    const pickables = [...(this.gltfHousingPickables || [])];
    const already = new Set(this.gltfLoadedProps || []);

    for (const prop of SEG_GLTF_PROPS) {
      if (this.currentView !== 'seg') {
        this._disposeFocusOnlyGltfProps();
        return;
      }
      if (prop.placeholder || !prop.enabled()) continue;
      if (already.has(prop.id)) continue;
      try {
        await this._uploadGltfProp(prop, { scale, yOffset, pickables });
        this.gltfLoadedProps.push(prop.id);
        already.add(prop.id);
      } catch (err) {
        console.warn(`[gltf] ${prop.id} load failed`, err);
        if (prop.id === 'housing') {
          this.gltfHousingEnabled = false;
          this.gltfHousingDrawables = [];
          this.gltfLoadedProps = [];
          this.gltfHousingPickables = [];
          return;
        }
      }
    }

    if (this.currentView !== 'seg') {
      this._disposeFocusOnlyGltfProps();
      return;
    }

    this.gltfHousingPickables = pickables;
    if (!this._gltfPickHandlerAttached && this.gltfHousingEnabled) {
      attachGltfHousingPickHandler(this);
      this._gltfPickHandlerAttached = true;
    }

    console.log(
      `[gltf] CAD props ready: ${this.gltfLoadedProps.join(', ') || '(none)'} — ` +
      `${this.gltfHousingDrawables.length} drawable(s), ${pickables.length} pick(s)`
    );
  },

  /**
   * @private
   * @param {import('../assets/gltf/prop-registry.js').SegGltfPropDef} prop
   * @param {{ scale: number, yOffset: number, pickables: object[] }} ctx
   */
  async _uploadGltfProp(prop, ctx) {
    const { scale, yOffset, pickables } = ctx;
    let doc;
    if (prop.id === 'housing' && this._gltfEmbeddedHousing) {
      doc = parseGlb(this._gltfEmbeddedHousing);
    } else if (this._gltfPropBuffers?.[prop.id]) {
      doc = parseGlb(this._gltfPropBuffers[prop.id]);
    } else {
      doc = await loadGlb(prop.url);
    }
    const extracted = extractGltfMeshes(doc);
    const scene = buildGltfScene(extracted, { propId: prop.id });

    // Apply registry material overrides onto scene nodes before flatten.
    for (const root of scene.roots) {
      const applyMat = (node) => {
        if (node.propId === prop.id || !node.propId) {
          const mat = resolvePropMaterial(prop, {
            materialRingIndex: node.materialRingIndex,
            material: node.material
          });
          node.material = { ...node.material, ...mat };
          node.materialRingIndex = mat.ringIndex;
        }
        for (const child of node.children || []) applyMat(child);
      };
      applyMat(root);
    }

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
          propId: prop.id,
          vertices: scaledVerts,
          indices: drawable.mesh.indices,
          worldMatrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
        });
        continue;
      }

      const mat = resolvePropMaterial(prop, drawable);
      const gpu = uploadGltfMesh(this.device, {
        vertices: scaledVerts,
        indices: drawable.mesh.indices
      });
      const instanceBuffer = createGltfInstanceBuffer(this.device, {
        position: [0, 0, 0],
        ringIndex: mat.ringIndex,
        color: mat.color,
        emissive: 0
      });
      this.gltfHousingDrawables.push({
        name: drawable.name,
        propId: prop.id,
        role: drawable.role || prop.role,
        loadPolicy: prop.loadPolicy,
        emissiveScale: mat.emissiveScale,
        gpu,
        instanceBuffer,
        ringIndex: mat.ringIndex,
        annotationId: null
      });
      this.profiler?.trackBuffer?.(`gltf-${prop.id}-${drawable.name}-vb`, gpu.vertexBuffer.size, GPUBufferUsage.VERTEX);
      this.profiler?.trackBuffer?.(`gltf-${prop.id}-${drawable.name}-ib`, gpu.indexBuffer.size, GPUBufferUsage.INDEX);
      this.profiler?.trackBuffer?.(`gltf-${prop.id}-${drawable.name}-inst`, GLTF_INSTANCE_BYTES, GPUBufferUsage.STORAGE);
      drawableCount += 1;
    }

    console.log(
      `[gltf] loaded ${prop.id} (${prop.loadPolicy}): ${drawableCount} drawable(s), ` +
      `${scene.anchors.length} anchor(s), ${scene.annotations.length} annotation(s)`
    );
  },

  /**
   * Dispose focus-only CAD props when leaving SEG (overview stays light).
   * Resident props (housing) keep GPU buffers.
   * @private
   */
  _disposeFocusOnlyGltfProps() {
    const kept = [];
    let freed = 0;
    for (const d of this.gltfHousingDrawables || []) {
      if (d.loadPolicy === 'focus') {
        destroyGpuBuffer(d.gpu?.vertexBuffer);
        destroyGpuBuffer(d.gpu?.indexBuffer);
        destroyGpuBuffer(d.instanceBuffer);
        freed += 1;
      } else {
        kept.push(d);
      }
    }
    this.gltfHousingDrawables = kept;

    const focusIds = new Set(
      SEG_GLTF_PROPS.filter((p) => p.loadPolicy === 'focus').map((p) => p.id)
    );
    this.gltfLoadedProps = (this.gltfLoadedProps || []).filter((id) => !focusIds.has(id));
    this.gltfHousingAnchors = (this.gltfHousingAnchors || []).filter((a) => !focusIds.has(a.propId));
    this.gltfAnnotationPoints = (this.gltfAnnotationPoints || []).filter((a) => !focusIds.has(a.propId));
    this.gltfHousingPickables = (this.gltfHousingPickables || []).filter((p) => !focusIds.has(p.propId));

    if (freed > 0) {
      console.log(`[gltf] disposed ${freed} focus-only drawable(s) on mode leave`);
    }
  },

  /** RPM / segOmega-driven emissive on housing trim (greenEmissive channel). */
  updateGltfHousingState() {
    if (!this.gltfHousingDrawables?.length) return;
    const omega = this.segOmega ?? 0;
    const emissive = Math.min(0.55, omega * 0.12);
    for (const d of this.gltfHousingDrawables) {
      const scale = d.emissiveScale ??
        (d.role === 'coil_former' || d.propId === 'coilFormer' ? 0.65 : 1.0);
      updateGltfInstanceEmissive(this.device, d.instanceBuffer, emissive * scale);
    }
  }
};
