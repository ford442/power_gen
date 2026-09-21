// GPU field bag for MultiDeviceVisualizer, split out purely to keep the host
// class under the repo's line-count cap (issues #142/#143/#187). None of
// these are initialized in the constructor — they're written later by
// collaborator setup methods (setup-geometry.js, scene-setup.js,
// materials.js, setup-gltf.js, render-loop.js, overview-cull.js, fdtd-slice,
// etc.) — so moving just their type declarations out is pure type-level
// refactor with zero runtime change. Attached to MultiDeviceVisualizer via
// declaration merging:
// `export interface MultiDeviceVisualizer extends VisualizerHostFields {}`.
import type { PipelineLayoutCache } from '../pipeline-layout-cache';
import type { OverviewCullPass } from '../devices/overview-cull';
import type { createIblResources } from '../ibl-prefilter';
import type { IblPrefilterCompute } from '../ibl-prefilter-gpu';
import type { FdtdSlicePass } from '../devices/quanta/fdtd-slice-pass';
import type { getPostQualityGates } from '../post-processing-config';
import type {
  MeshBuffers,
  VertexOnlyBuffers,
  GltfDrawable
} from '../devices/types';
import type { GltfPickable } from '../multi-device-visualizer';

export interface VisualizerHostFields {
  /**
   * True from the moment `device.lost` fires until GPU state has either
   * been fully rebuilt on the recovered device or the reload overlay was
   * shown. The render loop no-ops while this is true (see render-loop.ts)
   * so it never touches half-rebuilt pipelines/bind groups mid-recovery.
   */
  _deviceRecovering?: boolean;

  // Set later in init(); undefined until then (matches original runtime behavior).
  pipelineCache?: PipelineLayoutCache | null;
  segLayoutUniformBuffer?: GPUBuffer | null;
  lightingUniformBuffer?: GPUBuffer | null;

  /** Prefiltered GGX environment chain + sampler (ADR-0005 WS2, always-on). */
  iblResources?: Awaited<ReturnType<typeof createIblResources>> | null;
  /** Compute prefilter, or null when it could not be built. `undefined` = not tried yet. */
  iblCompute?: IblPrefilterCompute | null;
  /** Roughness level count uploaded to LightingConfig.iblLevels (0 = analytic fallback). */
  iblLevels?: number;

  /** Lazily built on the first frame its gate could open; null if the build failed. */
  fdtdSlice?: FdtdSlicePass | null;
  ssrPipeline?: GPUComputePipeline | null;
  ssrParamsBuffer?: GPUBuffer | null;
  ssrTexture?: GPUTexture | null;
  ssrTextureView?: GPUTextureView | null;
  ssrBindGroup?: GPUBindGroup | null;
  ssrWidth?: number;
  ssrHeight?: number;
  energyPipePipeline?: GPURenderPipeline;
  energyPipePipelineBase?: GPURenderPipeline;
  energyPipePipelineMsaa4?: GPURenderPipeline;
  energyPipeComputePipeline?: GPUComputePipeline;
  overviewCullPipeline?: GPUComputePipeline;
  /** GPU frustum cull → draw-indirect for the overview ring (ADR-0005 WS4). */
  overviewCull?: OverviewCullPass | null;
  segAnnotations?: unknown;

  // Populated by the collaborators below (SharedGeometryFactory, PostStack,
  // MaterialTable, GltfPropRegistry — ADR-0009 bindHostMethods); declared here
  // so class-body reads type-check.
  materialTableBuffer?: GPUBuffer | null;
  skyUniformBuffer?: GPUBuffer;
  batteryGaugeVertexBuffer?: GPUBuffer;
  batteryGaugeIndexBuffer?: GPUBuffer;
  batteryGaugeIndexCount?: number;

  // Shared geometry (VisualizerLike surface — see visualizer/setup-geometry.ts)
  cylinderBuffer?: MeshBuffers | null;
  kelvinRingBuffer?: MeshBuffers | null;
  deviceTubeBuffer?: MeshBuffers | null;
  solarPanelBuffer?: MeshBuffers | null;
  basePlateBuffer?: MeshBuffers | null;
  statorRingUVBuffer?: MeshBuffers | null;
  wiringUVBuffer?: MeshBuffers | null;
  coreShaftBuffer?: MeshBuffers | null;
  coreMagnetBuffer?: MeshBuffers | null;
  corePlateBuffer?: MeshBuffers | null;
  coreBoltBuffer?: MeshBuffers | null;
  connectionRingBuffer?: MeshBuffers | null;
  standBuffer?: MeshBuffers | null;
  wireBuffers?: MeshBuffers[] | null;
  coilBuffer?: VertexOnlyBuffers | null;
  baseInstanceBuffer?: GPUBuffer | null;
  coreBoltInstanceBuffer?: GPUBuffer | null;
  coreBoltPositions?: ArrayLike<number>;

  // glTF housing (visualizer/setup-gltf.ts)
  gltfHousingEnabled?: boolean;
  gltfHousingDrawables?: GltfDrawable[] | null;
  gltfHousingAnchors?: GltfPickable[];
  gltfHousingPickables?: GltfPickable[];
  gltfAnnotationPoints?: GltfPickable[];
  gltfLoadedProps?: string[];
  _gltfPropBuffers?: Record<string, ArrayBuffer> | null;
  _gltfEmbeddedHousing?: ArrayBuffer | null;
  _gltfLoadInFlight?: Promise<void> | null;
  _gltfPickHandlerAttached?: boolean;
  /** Internal re-entrancy guard inside attachGltfHousingPickHandler (gltf-housing-pick.ts). */
  _gltfPickBound?: boolean;

  // Shared geometry extras (visualizer/setup-geometry.ts)
  deviceGeometryBuffers?: Record<string, MeshBuffers & { color?: unknown }>;
  coilUVBuffer?: MeshBuffers | null;
  enhancedRollerBuffer?: MeshBuffers | null;
  /** C-core pickup coil parts (core / winding / foot), not a single MeshBuffers. */
  cCoreCoilBuffer?: {
    core: MeshBuffers;
    winding: MeshBuffers;
    foot: MeshBuffers;
  } | null;
  coilWindingBuffer?: MeshBuffers | null;
  magneticWallBuffer?: MeshBuffers | null;
  connectionRingInstances?: GPUBuffer | null;
  statorRingInstanceBuffer?: GPUBuffer | null;

  // Scene / post (visualizer/scene-setup.ts)
  depthTexture?: GPUTexture | null;
  depthAttachmentView?: GPUTextureView | null;
  depthSampleView?: GPUTextureView | null;
  /** 4x MSAA scene attachments (ADR-0005 WS2, `high` tier + focus only) — see render-loop.ts `msaaActive`. */
  sceneMsaaTexture?: GPUTexture | null;
  sceneMsaaView?: GPUTextureView | null;
  materialGBufferMsaaTexture?: GPUTexture | null;
  materialGBufferMsaaView?: GPUTextureView | null;
  depthMsaaTexture?: GPUTexture | null;
  depthMsaaAttachmentView?: GPUTextureView | null;
  depthMsaaSampleView?: GPUTextureView | null;
  /** Manually resolved (frag_depth) single-sample copy of depthMsaaTexture — see passes/depth-resolve.wgsl. */
  depthResolvedTexture?: GPUTexture | null;
  depthResolvedAttachmentView?: GPUTextureView | null;
  depthResolvedSampleView?: GPUTextureView | null;
  depthResolvePipeline?: GPURenderPipeline | null;
  _depthResolveBindGroup?: GPUBindGroup | null;
  ssrBindGroupResolved?: GPUBindGroup | null;
  gridPipeline?: GPURenderPipeline | null;
  gridPipelineBase?: GPURenderPipeline | null;
  gridPipelineMsaa4?: GPURenderPipeline | null;
  gridVertexBuffer?: GPUBuffer | null;
  gridBindGroup?: GPUBindGroup | null;
  skyPipeline?: GPURenderPipeline | null;
  skyPipelineBase?: GPURenderPipeline | null;
  skyPipelineMsaa4?: GPURenderPipeline | null;
  skyBindGroup?: GPUBindGroup | null;
  anomalyWallPipeline?: GPURenderPipeline | null;
  anomalyWallPipelineBase?: GPURenderPipeline | null;
  anomalyWallPipelineMsaa4?: GPURenderPipeline | null;
  anomalyWallParamsBuffer?: GPUBuffer | null;
  anomalyWallBindGroup?: GPUBindGroup | null;
  bloomSampler?: GPUSampler | null;
  bloomParamsBuffer?: GPUBuffer | null;
  bloomBlurDirXBuffer?: GPUBuffer | null;
  bloomBlurDirYBuffer?: GPUBuffer | null;
  bloomSceneTexture?: GPUTexture | null;
  /** Metalness/roughness G-buffer (ADR-0005 WS2) — second color target on the scene pass, read by SSR. */
  materialGBufferTexture?: GPUTexture | null;
  materialGBufferView?: GPUTextureView | null;
  bloomBlurTexture?: GPUTexture | null;
  bloomTempTexture?: GPUTexture | null;
  prevSceneTexture?: GPUTexture | null;
  bloomIntermediateFormat?: GPUTextureFormat;
  bloomExtractPipeline?: GPURenderPipeline | null;
  bloomBlurPipeline?: GPURenderPipeline | null;
  bloomCompositePipeline?: GPURenderPipeline | null;
  bloomExtractBindGroup?: GPUBindGroup | null;
  bloomBlurXBindGroup?: GPUBindGroup | null;
  bloomBlurYBindGroup?: GPUBindGroup | null;
  bloomCompositeBindGroup?: GPUBindGroup | null;
  bloomCompositeBindGroupResolved?: GPUBindGroup | null;

  // ── Temporal AA (ADR-0005 WS2) ──────────────────────────────────────────
  taaResolveTexture?: GPUTexture | null;
  taaResolveView?: GPUTextureView | null;
  taaPipeline?: GPURenderPipeline | null;
  taaParamsBuffer?: GPUBuffer | null;
  taaBindGroup?: GPUBindGroup | null;
  taaBindGroupResolved?: GPUBindGroup | null;
  /** Bloom variants that read the TAA resolve target instead of the raw scene. */
  bloomExtractBindGroupTaa?: GPUBindGroup | null;
  bloomCompositeBindGroupTaa?: GPUBindGroup | null;
  bloomCompositeBindGroupResolvedTaa?: GPUBindGroup | null;
  /** False until a history frame exists — reset on mode / layout / look / resize. */
  _taaHistoryValid?: boolean;
  /** Previous frame's view-projection, for reprojection. */
  _taaPrevViewProj?: Float32Array | null;
  /** Whether the TAA pass actually ran this frame (picks the bloom bind groups). */
  _taaActive?: boolean;

  _canvasResizeObserver?: ResizeObserver | null;
  _lastCanvasWidth?: number;
  _lastCanvasHeight?: number;

  // Per-frame render-loop scratch
  _overviewMeshDetail?: string;
  _overviewCullActive?: boolean;
  _postQualityGates?: ReturnType<typeof getPostQualityGates>;
  _ssrActive?: boolean;
}
