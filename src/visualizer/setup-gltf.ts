/**
 * Load glTF CAD props for the **focused device** (WebGPU + seg-enhanced PBR).
 *
 * Lazy per-device registry (ADR-0005 WS1): entering a focus view loads that
 * bench's props and disposes every other bench's `focus`-policy props, so the
 * GPU never holds two benches' CAD at once. SEG's resident housing is the one
 * exception and survives a mode change.
 *
 * Scale: SEG props bake through the layout's `worldScale` and frame base offset
 * (the assembly's size is preset-driven); every other bench bakes at scale 1
 * with no Y offset, because its GLB is authored in its own metres and the device
 * uniform already supplies world position and rotation.
 *
 * WebGL2 fallback keeps procedural geometry only — see docs/GLTF_ASSETS.md.
 */
import { loadGlb, parseGlb, extractGltfMeshes } from '../assets/gltf/gltf-loader';
import { buildGltfScene } from '../assets/gltf/gltf-scene';
import {
  uploadGltfMesh,
  createGltfInstanceBuffer,
  updateGltfInstanceEmissive,
  GLTF_INSTANCE_BYTES
} from '../assets/gltf/gltf-gpu';
import { uploadGltfCompressedAlbedo } from '../assets/gltf/ktx2-gpu';
import {
  parseGltfHousingEnabled,
  allFocusPropIds,
  propsForDevice,
  resolvePropMaterial,
  type SegGltfPropDef
} from '../assets/gltf/prop-registry';
import { attachGltfHousingPickHandler } from '../assets/gltf/gltf-housing-pick';
import { computeFrameDimensions } from '../seg-frame-model';
import type { SceneAnchor, SceneMaterial } from '../assets/scene/scene-node.js';
import type { MultiDeviceVisualizer, GltfPickable } from '../multi-device-visualizer.js';
import { bindHostMethods } from './bind-host-methods.js';

type Host = MultiDeviceVisualizer;

function bakeWorldVertices(
  vertices: Float32Array | number[],
  worldMatrix: Float32Array | number[],
  scale: number,
  offsetY = 0
): Float32Array {
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

function destroyGpuBuffer(buf: { destroy?: () => void } | null | undefined) {
  try {
    buf?.destroy?.();
  } catch {
    /* already destroyed */
  }
}

export const gltfSetupMethods: ThisType<Host> & {
  parseGltfHousingEnabled: typeof parseGltfHousingEnabled;
  setupGltfAssets(
    embeddedGlb?: ArrayBuffer,
    opts?: { propBuffers?: Record<string, ArrayBuffer> }
  ): Promise<void>;
  ensureGltfPropsForView(view: string): Promise<void>;
  _loadGltfPropsForSegFocus(view?: string): Promise<void>;
  _loadGltfPropsForSegFocusInner(view: string): Promise<void>;
  _uploadGltfProp(
    prop: SegGltfPropDef,
    ctx: { scale: number; yOffset: number; pickables: GltfPickable[] }
  ): Promise<void>;
  _disposeFocusOnlyGltfProps(keepDeviceId?: string): void;
  updateGltfHousingState(): void;
} = {
  parseGltfHousingEnabled,

  /**
   * Prepare empty CAD prop state. Heavy GLB decode is deferred until SEG focus
   * via {@link ensureGltfPropsForView} so overview stays light.
   */
  async setupGltfAssets(embeddedGlb?: ArrayBuffer, opts: { propBuffers?: Record<string, ArrayBuffer> } = {}) {
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

    // Booting straight into a focus view is a normal entry point — shareable lab
    // links carry `mode=` — so load whatever bench we started on rather than
    // assuming SEG, which would leave a deep-linked bench without its CAD until
    // the user navigated away and back.
    const view = this.currentView || 'overview';
    if (propsForDevice(view).length > 0) {
      await this.ensureGltfPropsForView(view);
    } else {
      console.log(`[gltf] CAD props deferred until a bench with props is focused (at "${view}")`);
    }
  },

  /**
   * Load / dispose props for the active view. Every bench with registry entries
   * gets the same treatment; leaving one disposes its focus-only props.
   */
  async ensureGltfPropsForView(view: string) {
    if (!this.gltfHousingEnabled) return;
    // Drop the props of whatever bench we just left before loading this one's.
    this._disposeFocusOnlyGltfProps(view);
    if (propsForDevice(view).length > 0) {
      await this._loadGltfPropsForSegFocus(view);
    }
  },

  /**
   * Serialize prop loads. A second request for the *same* view joins the one in
   * flight; a request for a different view queues **behind** it rather than
   * being dropped — switching benches faster than a GLB downloads used to leave
   * the second bench without its CAD until it was re-entered.
   * @private
   */
  async _loadGltfPropsForSegFocus(view: string = 'seg') {
    const pending = this._gltfLoadInFlight;
    if (pending && this._gltfLoadInFlightView === view) return pending;

    // Each link in the chain must only clear the slot while it still owns it.
    // Clearing unconditionally lets an *earlier* load's `finally` wipe the entry
    // a later one installed, after which a third request starts immediately
    // instead of queueing — and two uploads then mutate and dispose the shared
    // glTF arrays at once.
    const claim = (task: Promise<void>): Promise<void> => {
      const owned: Promise<void> = task.finally(() => {
        if (this._gltfLoadInFlight === owned) {
          this._gltfLoadInFlight = null;
          this._gltfLoadInFlightView = null;
        }
      });
      this._gltfLoadInFlight = owned;
      this._gltfLoadInFlightView = view;
      return owned;
    };

    if (pending) {
      return claim(pending
        .catch(() => { /* the previous view's failure is already logged */ })
        // Only continue if the user is still on this view once the queue drains.
        .then(() => (this.currentView === view
          ? this._loadGltfPropsForSegFocusInner(view)
          : undefined)));
    }
    return claim(this._loadGltfPropsForSegFocusInner(view));
  },

  /** @private */
  async _loadGltfPropsForSegFocusInner(view: string) {
    const props = propsForDevice(view) as SegGltfPropDef[];
    if (props.length === 0) return;

    // SEG geometry is layout-preset-scaled; other benches are authored in their
    // own metres and placed by the device uniform.
    let scale = 1;
    let yOffset = 0;
    if (props.some((p) => p.layoutScaled)) {
      const layout = this.segLayout || this.refreshSEGLayout?.(1.0);
      if (!layout) return;
      const frameDims = computeFrameDimensions(layout);
      scale = layout.worldScale;
      yOffset = frameDims.baseBottomY;
    }

    const pickables: GltfPickable[] = [...(this.gltfHousingPickables || [])];
    const already = new Set(this.gltfLoadedProps || []);

    for (const prop of props) {
      // The user can leave focus mid-download; drop what we were loading for it.
      if (this.currentView !== view) {
        this._disposeFocusOnlyGltfProps(this.currentView ?? undefined);
        return;
      }
      if (already.has(prop.id)) continue;
      try {
        await this._uploadGltfProp(prop, {
          scale: prop.layoutScaled ? scale : 1,
          yOffset: prop.layoutScaled ? yOffset : 0,
          pickables
        });
        this.gltfLoadedProps!.push(prop.id);
        already.add(prop.id);
      } catch (err) {
        console.warn(`[gltf] ${prop.id} load failed`, err);
        if (prop.id === 'housing') {
          // The housing is the resident prop the SEG showroom is built around;
          // losing it means the CAD path is not viable this session.
          this.gltfHousingEnabled = false;
          this.gltfHousingDrawables = [];
          this.gltfLoadedProps = [];
          this.gltfHousingPickables = [];
          return;
        }
      }
    }

    if (this.currentView !== view) {
      this._disposeFocusOnlyGltfProps(this.currentView ?? undefined);
      return;
    }

    this.gltfHousingPickables = pickables;
    // Ray picking is SEG-only: the annotation ids belong to the SEG tour.
    if (view === 'seg' && !this._gltfPickHandlerAttached && this.gltfHousingEnabled) {
      attachGltfHousingPickHandler(this);
      this._gltfPickHandlerAttached = true;
    }

    console.log(
      `[gltf] ${view} CAD props ready: ${this.gltfLoadedProps!.join(', ') || '(none)'} — ` +
      `${this.gltfHousingDrawables!.length} drawable(s), ${pickables.length} pick(s)`
    );
  },

  /**
   * @private
   */
  async _uploadGltfProp(
    prop: SegGltfPropDef,
    ctx: { scale: number; yOffset: number; pickables: GltfPickable[] }
  ) {
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

    let albedoTexture: GPUTexture | null = null;
    try {
      const uploaded = uploadGltfCompressedAlbedo(
        this.device,
        doc,
        this.webgpu?.adapterInfo
      );
      if (uploaded) {
        albedoTexture = uploaded.texture;
        if (this.webgpu) this.webgpu.textureCompressionUsed = uploaded.kind;
        if (this.profiler) this.profiler.textureCompression = uploaded.kind;
        this.profiler?.trackTexture?.(
          `gltf-${prop.id}-albedo`,
          4,
          4,
          uploaded.format
        );
        console.log(`[gltf] ${prop.id} albedo compression: ${uploaded.kind} (${uploaded.format})`);
      }
    } catch (err) {
      console.warn(`[gltf] ${prop.id} albedo upload skipped`, err);
    }

    // Apply registry material overrides onto scene nodes before flatten.
    for (const root of scene.roots) {
      const applyMat = (node: {
        propId?: string | null;
        materialRingIndex?: number;
        material?: Record<string, unknown> | SceneMaterial;
        children?: unknown[];
      }) => {
        if (node.propId === prop.id || !node.propId) {
          const mat = resolvePropMaterial(prop, {
            materialRingIndex: node.materialRingIndex,
            material: node.material
          });
          node.material = { ...node.material, ...mat };
          node.materialRingIndex = mat.ringIndex;
        }
        for (const child of (node.children || []) as typeof node[]) applyMat(child);
      };
      applyMat(root);
    }

    this.gltfHousingAnchors!.push(
      ...scene.anchors.map((a: SceneAnchor) => {
        const wp = a.worldPosition ?? a.position;
        return {
          ...a,
          propId: prop.id,
          worldPosition: [
            wp[0] * scale,
            wp[1] * scale + yOffset,
            wp[2] * scale
          ] as [number, number, number]
        };
      })
    );

    this.gltfAnnotationPoints!.push(
      ...scene.annotations.map((a: { annotationId: string; worldPosition: number[] }) => ({
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
    for (const drawable of scene.roots.flatMap((r: { flattenDrawables: () => unknown[] }) => r.flattenDrawables()) as Array<{
      annotationId?: string;
      mesh: { vertices: Float32Array; indices: Uint16Array | Uint32Array };
      worldMatrix: Float32Array;
      name: string;
      role?: string;
    }>) {
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
      this.gltfHousingDrawables!.push({
        name: drawable.name,
        propId: prop.id,
        deviceId: prop.deviceId,
        role: drawable.role || prop.role,
        loadPolicy: prop.loadPolicy as 'resident' | 'focus',
        emissiveScale: mat.emissiveScale,
        gpu,
        instanceBuffer,
        ringIndex: mat.ringIndex,
        annotationId: null,
        albedoTexture
      });
      albedoTexture = null;
      this.profiler?.trackBuffer?.(`gltf-${prop.id}-${drawable.name}-vb`, gpu.vertexBuffer.size, GPUBufferUsage.VERTEX);
      this.profiler?.trackBuffer?.(`gltf-${prop.id}-${drawable.name}-ib`, gpu.indexBuffer.size, GPUBufferUsage.INDEX);
      this.profiler?.trackBuffer?.(`gltf-${prop.id}-${drawable.name}-inst`, GLTF_INSTANCE_BYTES, GPUBufferUsage.STORAGE);
      drawableCount += 1;
    }

    console.log(
      `[gltf] loaded ${prop.id} (${prop.loadPolicy}): ${drawableCount} drawable(s), ` +
      `${scene.anchors.length} anchor(s), ${scene.annotations.length} annotation(s)`
    );
    if (albedoTexture) {
      try { albedoTexture.destroy(); } catch { /* unused albedo */ }
    }
  },

  /**
   * Dispose focus-only CAD props on a mode change (overview stays light).
   * Resident props (SEG's housing) keep their GPU buffers.
   *
   * @param keepDeviceId the bench being entered — its own props survive, so
   *   re-entering a view does not free and immediately reload the same GLBs.
   *   Omit it (or pass a view with no props) to drop every focus-only prop.
   * @private
   */
  _disposeFocusOnlyGltfProps(keepDeviceId?: string) {
    const focusIds = allFocusPropIds();
    const keptIds = new Set(
      keepDeviceId ? propsForDevice(keepDeviceId).map((p) => p.id) : []
    );
    /** Drop this prop's GPU buffers on this mode change? */
    const drops = (propId: string | null | undefined): boolean =>
      focusIds.has(propId || '') && !keptIds.has(propId || '');

    const kept = [];
    let freed = 0;
    for (const d of this.gltfHousingDrawables || []) {
      if (d.loadPolicy === 'focus' && drops(d.propId)) {
        destroyGpuBuffer(d.gpu?.vertexBuffer);
        destroyGpuBuffer(d.gpu?.indexBuffer);
        destroyGpuBuffer(d.instanceBuffer);
        try { d.albedoTexture?.destroy?.(); } catch { /* already destroyed */ }
        freed += 1;
      } else {
        kept.push(d);
      }
    }
    this.gltfHousingDrawables = kept;

    this.gltfLoadedProps = (this.gltfLoadedProps || []).filter((id) => !drops(id));
    this.gltfHousingAnchors = (this.gltfHousingAnchors || []).filter((a) => !drops(a.propId));
    this.gltfAnnotationPoints = (this.gltfAnnotationPoints || []).filter((a) => !drops(a.propId));
    this.gltfHousingPickables = (this.gltfHousingPickables || []).filter((p) => !drops(p.propId));

    if (freed > 0) {
      console.log(`[gltf] disposed ${freed} focus-only drawable(s) on mode leave`);
    }
  },

  /**
   * Sim-driven emissive trim (greenEmissive channel).
   *
   * SEG props follow `segOmega`; a non-SEG prop follows its own device's
   * `energyLevel`, because a transformer core glowing with the SEG's RPM would be
   * telling the viewer something untrue.
   */
  updateGltfHousingState() {
    if (!this.gltfHousingDrawables?.length) return;
    const segEmissive = Math.min(0.55, (this.segOmega ?? 0) * 0.12);
    for (const d of this.gltfHousingDrawables) {
      const scale = d.emissiveScale ??
        (d.role === 'coil_former' || d.propId === 'coilFormer' ? 0.65 : 1.0);
      const owner = d.deviceId && d.deviceId !== 'seg' ? this.devices?.[d.deviceId] : null;
      // `instance.energyLevel` (smoothEnergyLevel) — not physicsState's raw
      // value — is what drives the device's uniforms, particles and haze, so the
      // CAD trim tracks the same number as the rest of that bench's effects.
      const emissive = owner
        ? Math.min(0.55, (owner.energyLevel ?? 0) * 0.55)
        : segEmissive;
      updateGltfInstanceEmissive(this.device, d.instanceBuffer, emissive * scale);
    }
  }
};

/** Lazy SEG CAD prop registry (WebGPU). */
export class GltfPropRegistry {
  setupGltfAssets: typeof gltfSetupMethods.setupGltfAssets;
  ensureGltfPropsForView: typeof gltfSetupMethods.ensureGltfPropsForView;
  _loadGltfPropsForSegFocus: typeof gltfSetupMethods._loadGltfPropsForSegFocus;
  _loadGltfPropsForSegFocusInner: typeof gltfSetupMethods._loadGltfPropsForSegFocusInner;
  _uploadGltfProp: typeof gltfSetupMethods._uploadGltfProp;
  _disposeFocusOnlyGltfProps: typeof gltfSetupMethods._disposeFocusOnlyGltfProps;
  updateGltfHousingState: typeof gltfSetupMethods.updateGltfHousingState;

  constructor(host: MultiDeviceVisualizer) {
    const bound = bindHostMethods(gltfSetupMethods, host);
    this.setupGltfAssets = bound.setupGltfAssets;
    this.ensureGltfPropsForView = bound.ensureGltfPropsForView;
    this._loadGltfPropsForSegFocus = bound._loadGltfPropsForSegFocus;
    this._loadGltfPropsForSegFocusInner = bound._loadGltfPropsForSegFocusInner;
    this._uploadGltfProp = bound._uploadGltfProp;
    this._disposeFocusOnlyGltfProps = bound._disposeFocusOnlyGltfProps;
    this.updateGltfHousingState = bound.updateGltfHousingState;
  }
}

