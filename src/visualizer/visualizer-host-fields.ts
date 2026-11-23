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
import type { FieldVolumePass } from './field-volume-pass';
import type { FluidCeiling, FluidChoice, FluidPreset, HeronLiquidPass } from './heron-liquid-pass';
import type { KelvinLiquidPass } from './kelvin-liquid-pass';
import type { MhdSlicePass } from './mhd-slice-pass';
import type { FieldReadout, FieldViewState } from './field-volume-drive';
import type { getPostQualityGates } from '../post-processing-config';
import type { BloomChain, BloomChainPipelines } from './bloom-chain';
import type { FrameGraph, FrameGraphReport } from './frame-graph';
import type { FrameCtx } from './render-encode';
import type { UniformRing } from './uniform-ring';
import type { PipelineTiers } from './pipeline-tiers';
import type { ShadowMap } from './shadow-map';
import type { FrameBindings } from './frame-bindings';
import type { StaticBundles } from './render-bundles';
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

  /**
   * Debug / e2e (visualizer/test-hooks.ts): when set, the render loop holds
   * scene time at this value and steps nothing (dt = 0), so two captures of
   * the same view are the same image. `null` / unset → the clock runs.
   */
  frozenTime?: number | null;
  /** True while `captureCanvasFrame()` renders one frame outside the rAF chain. */
  _frameOnDemand?: boolean;
  /** Frames submitted to the queue since boot (`getRendererInfo().frames`). */
  framesSubmitted?: number;

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
  /** Heron's liquid (ADR-0022): lazily built like fdtdSlice; null if the build failed. */
  heronLiquid?: HeronLiquidPass | null;
  _heronLiquidInit?: Promise<void> | null;
  /** Kelvin's drops on the solver: lazily built the same way; null if the build failed. */
  kelvinLiquid?: KelvinLiquidPass | null;
  _kelvinLiquidInit?: Promise<void> | null;
  /** The MHD duct's lattice-Boltzmann slice: lazily built the same way; null if the build failed. */
  mhdSlice?: MhdSlicePass | null;
  _mhdSliceInit?: Promise<void> | null;
  /** The plant drive of the frame being rendered (what `session.stepPlant` used). */
  plantDrive?: number;
  /** `?thermal=1`: every bench is drawn in the IR view (thermal/ir-view.ts). Read once at boot. */
  thermalView?: boolean;
  /** `?fluid=` choice (read once from LabConfig on first use). */
  fluidChoice?: FluidChoice;
  /** What the lab mode asks of the liquid while `fluid` is `auto` (lab-mode.ts `LabModePreset.fluid`). */
  fluidPreset?: FluidPreset;
  /** The largest tier `auto` may still build on this page; lowered when the profiler could not hold one. */
  fluidCeiling?: FluidCeiling;
  /** Bench whose particles the liquid solver draws this frame, in place of its stateless ones. */
  liquidOwner?: string | null;
  /** Field volume (ADR-0017): lazily built like fdtdSlice; null if the build failed. */
  fieldVolume?: FieldVolumePass | null;
  _fieldVolumeInit?: Promise<void> | null;
  /** `?fieldVolume=0` kill switch (read once from LabConfig on first use). */
  fieldVolumeEnabled?: boolean;
  /** Slice / iso / particle choices the field panel edits. */
  fieldView?: FieldViewState;
  /** Last frame's probe and scaling numbers for the focused field bench. */
  fieldReadout?: FieldReadout | null;
  /** Device whose fallback flux lines the volume tracer replaces this frame. */
  fieldVolumeLinesOwner?: string | null;
  /** Isosurfaces drawn this frame (SEG anomaly walls stand aside). */
  fieldIsoActive?: boolean;
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
  // MaterialTable, GltfPropRegistry — ADR-0009 collaborators); declared here
  // so class-body reads type-check.
  materialTableBuffer?: GPUBuffer | null;
  skyUniformBuffer?: GPUBuffer;
  /** Reused SkyParams upload (written every frame). */
  _skyUniformData?: Float32Array<ArrayBuffer>;
  _segLayoutUniformData?: Float32Array<ArrayBuffer>;
  /** Reused per-frame upload staging (render-loop.ts) — no allocation per frame. */
  _globalUniformData?: Float32Array<ArrayBuffer>;
  _lightingUniformData?: Float32Array<ArrayBuffer>;
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
  /** SEG pickup-coil mesh (setup-geometry.ts), drawn by renderPickupCoils. */
  pickupCoilBuffer?: MeshBuffers | null;
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
  /** View `_gltfLoadInFlight` is loading for, so a fast mode switch can queue behind it. */
  _gltfLoadInFlightView?: string | null;
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
  /** 4x MSAA scene attachments (ADR-0005 WS2, `high` tier + focus only) — allocated lazily by post-targets.ts. */
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
  /** Linear colour pipeline's mip-chain bloom (null on ?color=legacy) — visualizer/bloom-chain.ts. */
  bloomChain?: BloomChain | null;
  bloomChainPipelines?: BloomChainPipelines | null;
  bloomBlurTexture?: GPUTexture | null;
  bloomTempTexture?: GPUTexture | null;
  prevSceneTexture?: GPUTexture | null;
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
  /** False until prevSceneTexture holds a copied frame — motion blur waits for it. */
  _historyValid?: boolean;

  // ── #225 §3–4: uniform ring, frame group, bundles, tiers, shadow ───────
  /** Per-draw DeviceUniforms slots, one writeBuffer per frame (uniform-ring.ts). */
  uniformRing?: UniformRing | null;
  /** Scene / shadow-pass @group(0) (frame-bindings.ts). */
  frameBindings?: FrameBindings | null;
  /** Static-geometry render bundles (render-bundles.ts). */
  staticBundles?: StaticBundles | null;
  /** Boot + lazily compiled pipeline tiers (pipeline-tiers.ts). */
  pipelineTiers?: PipelineTiers | null;
  /** Key-light shadow map + its uniforms (shadow-map.ts). */
  shadowMap?: ShadowMap | null;
  /** Whether the shadow pass encoded this frame. */
  _shadowActive?: boolean;

  // ── Frame graph (visualizer/frame-graph.ts, render-encode.ts) ──────────
  _frameGraph?: FrameGraph<FrameCtx> | null;
  /** Last frame's report: passes run, timed slots, lifetimes allocated / released. */
  _frameGraphReport?: FrameGraphReport | null;
  /** 1×1 stand-ins bound in place of a released history / SSR target (post-targets.ts). */
  _postPlaceholderHistory?: GPUTexture | null;
  _postPlaceholderSsr?: GPUTexture | null;

  _canvasResizeObserver?: ResizeObserver | null;
  /** device-pixel-content-box observer on the canvas itself — see webgpu-init/canvas.ts. */
  _canvasDprObserver?: ResizeObserver | null;
  _lastCanvasWidth?: number;
  _lastCanvasHeight?: number;

  // Per-frame render-loop scratch
  _overviewMeshDetail?: string;
  _overviewCullActive?: boolean;
  _postQualityGates?: ReturnType<typeof getPostQualityGates>;
  _ssrActive?: boolean;
}
