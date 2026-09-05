import { MultiDeviceShaders } from './multi-device-shaders.js';
import './devices/register-plugins.js';
import { MultiDeviceCamera } from './multi-device-camera';
import { SimRateController } from './sim-rate-controller';
import { WebGPUManager, DEPTH_FORMAT } from './webgpu-manager';
import { PipelineLayoutCache } from './pipeline-layout-cache';
import { CameraController } from './camera-controller';
import { PerformanceProfiler } from './performance-profiler';
import { DebugPanel } from './debug-panel.js';
import { DEVICE_CONFIG } from './devices/device-config';
import { getMergedDeviceConfig, getAllSimDeviceIds } from './devices/device-registry.js';
import { DeviceInstance } from './device-instance.js';
import { EnergyPipe } from './energy-pipe';
import { OverviewCullPass } from './devices/overview-cull';
import {
  computeSEGLayout,
  SEG_LAYOUT_PRESETS,
  SEG_LAYOUT_UNIFORM_BYTES,
  packSEGLayoutUniforms
} from './seg-layout';
import {
  getHeronLayout,
  HERON_LAYOUT_PRESETS,
  parseHeronLayoutPreset
} from './heron-layout';
import { parseSegFrameLevel } from './seg-frame-model.js';
import {
  parseLightingLook,
  getLightingPreset,
} from './seg-lighting-presets';
import { writeQueueBuffer } from './gpu-buffer-write';
import { segOperator } from './seg-operator-state';
import { telemetryHub, TelemetryHub } from './telemetry-hub';
import { segWasm } from './wasm/seg-physics-bridge.js';
import { HardwareBridge, TWIN_MODES } from './hardware-bridge.js';
import { ElectromagnetController } from './electromagnet-controller.js';
import { initHardwarePanel } from './hardware-panel.js';
import { initSEGAnnotations } from './seg-annotations.js';
import { explainerState } from './seg-explainer/explainer-state.js';
import { isDeviceActive as isDeviceVisible } from './renderers/shared/device-view.js';
import { EnergyNetwork, ENERGY_PIPE_EDGES, initEnergyCouplingDisclaimer } from './renderers/shared/energy-network';
import { gpuChores } from './gpu-chores';
import { showWebGPUHardFail, type WebGPUProbeResult } from './renderers/webgpu-probe';
import {
  parsePrototypePreset,
  parseSegLayoutPreset,
  parseAnomalousEffects,
  parseSsrEnabled
} from './renderers/shared/url-params.js';
import { createIblResources } from './ibl-prefilter';
import {
  SEGIntegrationManager,
  PHYSICS_UNIFORM_BYTES
} from './integration';
import { primitiveMethods } from './visualizer/primitives.js';
import { geometrySetupMethods } from './visualizer/setup-geometry.js';
import { sceneSetupMethods } from './visualizer/scene-setup.js';
import { renderLoopMethods } from './visualizer/render-loop.js';
import { hardwareTwinMethods } from './visualizer/hardware-twin.js';
import { materialMethods } from './visualizer/materials.js';
import { diagnosticsMethods } from './visualizer/diagnostics.js';
import { gltfSetupMethods } from './visualizer/setup-gltf.js';
import type {
  VisualizerLike,
  MeshBuffers,
  VertexOnlyBuffers,
  GltfDrawable,
  SegFrameBuffers,
  SegLayout
} from './devices/types';
import type { HeronLayout } from './renderers/shared/device-physics';
import type { PrototypePreset } from './renderers/shared/url-params.js';
import type { LightingLook } from './seg-lighting-presets';
import type { HardwareTwinTelemetry } from './telemetry/types';
import { getPostQualityGates } from './post-processing-config';

type HeronLayoutWithMeta = HeronLayout & { name: string; description: string };

/**
 * Mixin methods merged onto the prototype at the bottom of this file
 * (Object.assign) — declared here via interface merging so the class body
 * above can call them with real signatures instead of falling back to `any`.
 */
type PrimitiveMesh = { vertices: Float32Array; indices: Uint16Array };

export interface MultiDeviceVisualizer {
  // primitiveMethods
  generateCylinder(radius: number, height: number, segments: number): PrimitiveMesh;
  generateCylinderWithUVs(radius: number, height: number, segments: number): PrimitiveMesh;
  generateDisc(
    innerRadius: number,
    outerRadius: number,
    thickness: number,
    segments: number
  ): PrimitiveMesh;
  generateDiscWithUVs(
    innerRadius: number,
    outerRadius: number,
    thickness: number,
    segments: number
  ): PrimitiveMesh;
  generateBoxWithUVs(width: number, height: number, depth: number): PrimitiveMesh;

  // geometrySetupMethods
  setupSharedGeometry(): Promise<void>;
  setupDefaultPrimitiveGeometry(deviceId: string, config: { color?: unknown }): Promise<void>;
  setupGltfAssets(
    embeddedGlb?: ArrayBuffer,
    opts?: { propBuffers?: Record<string, ArrayBuffer> }
  ): Promise<void>;
  _setupCoreSEGSharedMeshes(): Promise<void>;
  _setupAlternateDeviceSharedMeshes(): Promise<void>;

  // sceneSetupMethods
  setupFloorGrid(): Promise<void>;
  setupSkyGradient(): Promise<void>;
  setupAnomalyWallPipeline(): Promise<void>;
  setupDepthBuffer(): Promise<void>;
  setupBloomTextures(): void;
  setupBloomPipeline(): Promise<void>;
  setupIblPrefilter(): { levels: number; cached: boolean; ms: number };
  refreshIblPrefilter(): void;
  setupSsrTexture(): void;
  setupSsrPipeline(): Promise<void>;
  setupDepthResolvePipeline(): Promise<void>;
  _waitForCanvasLayout(): Promise<void>;
  _observeCanvasLayout(): void;
  _syncCanvasSize(): Promise<void>;
  _rebuildBloomBindGroups(): void;
  _rebuildSsrBindGroup(): void;
  _rebuildDepthResolveBindGroup(): void;
  _uploadSkyUniforms(energy?: number): void;
  _dispatchSsr(encoder: GPUCommandEncoder, msaaActive: boolean): void;

  // renderLoopMethods
  render(timestamp: number): void;
  renderAnomalyWalls(
    renderPass: GPURenderPassEncoder,
    globalUniformBuffer: GPUBuffer | null,
    segDevice: DeviceInstance | null | undefined
  ): void;

  // hardwareTwinMethods
  _updateHardwareTwin(deltaTime: number): void;
  _updateDeviceTelemetry(): void;
  _updateTachometer(): void;

  // materialMethods
  setupMaterialTableBuffer(): void;

  // diagnosticsMethods
  runSpeedTest(speeds?: number[], durationMs?: number): Promise<void>;
  captureParticleSubset(deviceId?: string, maxCount?: number): Promise<unknown>;
  captureOverviewCull(): Promise<unknown>;

  // gltfSetupMethods
  ensureGltfPropsForView(view: string): Promise<void>;
  updateGltfHousingState(): void;
  _loadGltfPropsForSegFocus(): Promise<void>;
  _loadGltfPropsForSegFocusInner(): Promise<void>;
  _disposeFocusOnlyGltfProps(): void;
  _uploadGltfProp(
    prop: {
      id: string;
      url: string;
      role: string;
      loadPolicy: string;
      enabled: () => boolean;
      placeholder?: boolean;
    },
    ctx: { scale: number; yOffset: number; pickables: GltfPickable[] }
  ): Promise<void>;
}

/** Minimal glTF pickable / annotation shapes used by CAD prop loaders. */
export interface GltfPickable {
  annotationId?: string | null;
  propId?: string;
  vertices?: Float32Array;
  indices?: Uint16Array | Uint32Array;
  worldMatrix?: Float32Array;
  worldPosition?: number[];
  pos?: number[];
  id?: string;
}

export class MultiDeviceVisualizer implements VisualizerLike {
  canvas: HTMLCanvasElement;
  webgpu: WebGPUManager;
  camera: CameraController;
  profiler: PerformanceProfiler | null;
  debugPanel: DebugPanel | null;
  /** Matches WebGPUManager.depthFormat (depth24plus, no stencil). */
  depthFormat: GPUTextureFormat;
  shaders: MultiDeviceShaders;
  cameraController: MultiDeviceCamera | null;

  currentView: string;
  devicesEnabled: Record<string, boolean>;
  devices: Record<string, DeviceInstance>;
  energyPipes: EnergyPipe[];
  energyNetwork: EnergyNetwork;

  // Hardware digital twin (Web Serial / mock)
  emController: ElectromagnetController;
  hardwareBridge: HardwareBridge;
  hardwareTargetPhase: number;
  hardwareTargetSpeed: number;
  hardwareShadow: { phaseError: number; rpmError: number };
  hardwareTwinTelemetry: HardwareTwinTelemetry | null;

  integration: SEGIntegrationManager | null;
  /** Manager-owned physics uniform buffer (alias). */
  physicsUniformBuffer: GPUBuffer | null;

  time: number;
  lastFrameTime: number;
  fps: number;
  speedMult: number;
  globalEnergyLevel: number;
  /** Integrated SEG spin state (from segOperator physics) */
  segOmega: number;
  corona: number;

  prototypePreset: PrototypePreset;
  anomalousEffectsEnabled: boolean;
  simRateController: SimRateController;

  lightingLook: LightingLook;
  lightingConfig: ReturnType<typeof getLightingPreset>['lighting'];
  postPreset: ReturnType<typeof getLightingPreset>;
  postExposure: number;
  postBloomStrength: number;

  segLayoutPreset: string;
  segLayout: SegLayout | null;

  heronLayoutPreset: string;
  heronLayout: HeronLayoutWithMeta | null;

  segFrameLevel: string;
  segFrameBuffers: SegFrameBuffers | null;
  frameStructuralInstanceBuffer: GPUBuffer | null;
  frameControlInstanceBuffer: GPUBuffer | null;
  frameCageInstanceBuffer: GPUBuffer | null;
  frameLabBenchInstanceBuffer: GPUBuffer | null;

  // Set later in init(); undefined until then (matches original runtime behavior).
  pipelineCache?: PipelineLayoutCache | null;
  segLayoutUniformBuffer?: GPUBuffer | null;
  lightingUniformBuffer?: GPUBuffer | null;

  /** Prefiltered GGX environment chain + sampler (ADR-0005 WS2, always-on). */
  iblResources?: ReturnType<typeof createIblResources> | null;
  /** Roughness level count uploaded to LightingConfig.iblLevels (0 = analytic fallback). */
  iblLevels?: number;

  /** Screen-space reflections (high/ultra tier, `?ssr=0` kill switch). */
  ssrEnabled: boolean;
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

  // Populated by the merged-in mixins below (setup-geometry.js, scene-setup.js,
  // materials.js, setup-gltf.js); declared here so class-body reads type-check.
  materialTableBuffer?: GPUBuffer | null;
  skyUniformBuffer?: GPUBuffer;
  batteryGaugeVertexBuffer?: GPUBuffer;
  batteryGaugeIndexBuffer?: GPUBuffer;
  batteryGaugeIndexCount?: number;

  // Shared geometry (VisualizerLike surface — see setup-geometry.js)
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

  // glTF housing (setup-gltf.js)
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

  // Shared geometry extras (setup-geometry.js)
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

  // Scene / post (scene-setup.js)
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
  _canvasResizeObserver?: ResizeObserver | null;
  _lastCanvasWidth?: number;
  _lastCanvasHeight?: number;

  // Per-frame render-loop scratch
  _overviewMeshDetail?: string;
  _overviewCullActive?: boolean;
  _postQualityGates?: ReturnType<typeof getPostQualityGates>;
  _ssrActive?: boolean;

  constructor() {
    console.log('MultiDeviceVisualizer v5 starting - depthStencil fix applied');
    this.canvas = document.getElementById('gpuCanvas') as HTMLCanvasElement;

    // Initialize managers (single adapter path lives in WebGPUManager)
    this.webgpu = new WebGPUManager(this.canvas, {
      onDeviceLost: (info: { reason?: string; message?: string }) => {
        console.error('[MultiDeviceVisualizer] GPU device lost — prompting reload', info);
        WebGPUManager.showDeviceLostUI(info);
      }
    });
    this.camera = new CameraController();
    this.profiler = null;
    this.debugPanel = null;
    this.depthFormat = DEPTH_FORMAT;

    // Initialize shader provider and camera controller
    this.shaders = new MultiDeviceShaders();
    this.cameraController = null; // Will be initialized after debugPanel is ready

    this.currentView = 'overview';
    this.devicesEnabled = Object.fromEntries(getAllSimDeviceIds().map((id) => [id, true]));
    this.devices = {};
    this.energyPipes = [];
    this.energyNetwork = new EnergyNetwork();

    // Hardware digital twin (Web Serial / mock)
    this.emController = new ElectromagnetController();
    this.hardwareBridge = new HardwareBridge({
      onError: (e: unknown) => console.error('[HardwareBridge]', e)
    });
    this.hardwareTargetPhase = 0;
    this.hardwareTargetSpeed = 0;
    this.hardwareShadow = { phaseError: 0, rpmError: 0 };
    this.hardwareTwinTelemetry = null;

    this.integration = null;
    this.physicsUniformBuffer = null;

    this.time = 0;
    this.lastFrameTime = 0;
    this.fps = 60;
    this.speedMult = 1.0;
    this.globalEnergyLevel = 0.0;
    /** Integrated SEG spin state (from segOperator physics) */
    this.segOmega = 0;
    this.corona = 0;

    const params = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');

    // Prototype-accuracy preset for SEG rollers (parse before lighting / layout).
    this.prototypePreset = parsePrototypePreset(params);
    this.anomalousEffectsEnabled = parseAnomalousEffects(this.prototypePreset);

    // SimRateController for speed-scaled physics and visuals
    this.simRateController = new SimRateController();

    // Screen-space reflections: `?ssr=0` disables without touching the tier.
    this.ssrEnabled = parseSsrEnabled(params);

    // Lighting / post look preset (studio | lab | drama)
    this.lightingLook = parseLightingLook(params);
    const lookPreset = getLightingPreset(this.lightingLook);

    // Lighting configuration for PBR shaders (from active look preset)
    this.lightingConfig = { ...lookPreset.lighting };
    this.postPreset = lookPreset;
    this.postExposure = lookPreset.post.exposure;
    this.postBloomStrength = lookPreset.post.bloomStrength;

    // Literature-grounded SEG layout preset (roller counts, gap rule, scale).
    //   searl    = documented 10/25/35 three-ring device
    //   roschin  = Roschin–Godin 1 m single-ring 12-roller converter
    //   legacy   = previous 8/12/16 toy proportions (regression)
    this.segLayoutPreset = parseSegLayoutPreset(params, this.prototypePreset);
    this.segLayout = null;

    this.heronLayoutPreset = parseHeronLayoutPreset(params);
    try {
      const storedHeron = localStorage.getItem('heron-layout');
      const heronPresets: string[] = Object.values(HERON_LAYOUT_PRESETS);
      if (storedHeron && heronPresets.includes(storedHeron)) {
        this.heronLayoutPreset = storedHeron;
      }
    } catch (_) { /* ignore */ }
    this.heronLayout = getHeronLayout(this.heronLayoutPreset);

    this.segFrameLevel = parseSegFrameLevel(params);
    this.segFrameBuffers = null;
    this.frameStructuralInstanceBuffer = null;
    this.frameControlInstanceBuffer = null;
    this.frameCageInstanceBuffer = null;
    this.frameLabBenchInstanceBuffer = null;

    this.ready = this.init();
  }

  /** Settles when WebGPU session init finishes (or rejects on hard-fail). */
  ready: Promise<void>;

  /** Proxies WebGPUManager's device — non-null once init() has completed. */
  get device(): GPUDevice {
    return this.webgpu.device as GPUDevice;
  }

  get context(): GPUCanvasContext | null {
    return this.webgpu.context;
  }

  get globalUniformBuffer(): GPUBuffer | null {
    return this.webgpu.globalUniformBuffer;
  }

  async init(): Promise<void> {
    try {
      await this.webgpu.init();
      this.depthFormat = this.webgpu.depthFormat || DEPTH_FORMAT;
      if (this.webgpu.adapterInfo?.fallback || this.webgpu.adapterInfo?.software) {
        this.ssrEnabled = false;
        console.log('[MultiDeviceVisualizer] SSR disabled (fallback/software adapter)');
      }
      this.webgpu.resize();

      // Explicit bind-group / pipeline layouts + shared device pipelines (once)
      this.pipelineCache = new PipelineLayoutCache(this.device, {
        canvasFormat: this.webgpu.canvasFormat || navigator.gpu.getPreferredCanvasFormat(),
        depthFormat: this.depthFormat
      });
      await this.pipelineCache.ensureDevicePipelines(this.shaders);
      // 4x MSAA variants (ADR-0005 WS2 showroom pass, `high` tier + focus
      // mode — see render-loop.ts `msaaActive`), created eagerly here rather
      // than lazily on first use so the per-frame render loop never awaits
      // pipeline creation. DevicePipelineManager.applyMsaaState() picks
      // between the two per frame.
      await this.pipelineCache.ensureDevicePipelines(this.shaders, { sampleCount: 4 });
      console.log(
        `[MultiDeviceVisualizer] Pipeline cache: ${this.pipelineCache.stats.pipelineCreates} creates ` +
        `(shared across all devices)`
      );

      // Typed physics hub (ValidatedConstants + fallback formulas → GPU uniforms)
      try {
        this.integration = new SEGIntegrationManager(this.device, this.canvas, {
          enableScientificOverlay: false
        });
        this.physicsUniformBuffer = this.integration.getPhysicsUniformBuffer();
        if (typeof window !== 'undefined') {
          window.SEGIntegration = window.SEGIntegration || {
            manager: null,
            initialize: () => {
              throw new Error('[MultiDeviceVisualizer] window.SEGIntegration.initialize is not wired for this bootstrap path');
            }
          };
          window.SEGIntegration.manager = this.integration;
        }
        console.log('[MultiDeviceVisualizer] SEGIntegrationManager attached (typed physics uniforms)');
      } catch (e) {
        console.warn('[MultiDeviceVisualizer] SEGIntegrationManager init failed:', e);
        this.integration = null;
        this.physicsUniformBuffer = null;
      }

      // Profiler reuses the single adapter from WebGPUManager (no second requestAdapter)
      this.profiler = new PerformanceProfiler(this.device, this.canvas, {
        adapter: this.webgpu.adapter,
        adapterInfo: this.webgpu.adapterInfo
      });
      await this.profiler.init();
      if (this.integration) {
        this.profiler.trackBuffer('physicsUniforms', PHYSICS_UNIFORM_BYTES, GPUBufferUsage.UNIFORM);
      }

      // Initialize debug panel
      this.debugPanel = new DebugPanel(this.profiler);

      // Initialize multi-device camera controller (for view transitions and matrix math)
      // Note: MultiDeviceCamera focuses on view transitions and matrix operations only.
      // Input handling is delegated to CameraController.setupInteraction() below.
      this.cameraController = new MultiDeviceCamera(this.canvas, this.camera.camera, this);

      this.camera.setupInteraction(this.canvas, (mode: string) => this.switchMode(mode));

      this.segLayoutUniformBuffer = this.device.createBuffer({
        label: 'seg-layout-uniforms',
        size: SEG_LAYOUT_UNIFORM_BYTES,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
      });
      this.profiler.trackBuffer('seg-layout-uniforms', SEG_LAYOUT_UNIFORM_BYTES, GPUBufferUsage.UNIFORM);
      this.refreshSEGLayout(1.0);

      // IBL must be resident before any SEG-enhanced bind group is built.
      this.setupIblPrefilter();

      await this.setupSharedGeometry();
      await this.setupDevices();
      await this.setupEnergyPipes();
      await this.setupOverviewCull();
      await this.setupFloorGrid();
      await this.setupSkyGradient();

      // Match canvas backing store to layout before depth/bloom textures are allocated.
      await this._waitForCanvasLayout();
      await this._syncCanvasSize();
      await this.setupBloomPipeline();
      await this.setupSsrPipeline();
      await this.setupDepthResolvePipeline();
      await this.setupAnomalyWallPipeline();

      // Track initial allocations
      this.profiler.trackBuffer('globalUniforms', 512, GPUBufferUsage.UNIFORM);

      // Create lighting uniform buffer for all lit SEG and solar-gauge passes (192 bytes)
      this.lightingUniformBuffer = this.device.createBuffer({
        size: 192,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
      });
      this.profiler.trackBuffer('lightingUniforms', 192, GPUBufferUsage.UNIFORM);

      this.setupMaterialTableBuffer();

      this.render(0);

      gpuChores.adopt({
        sessionApi: 'webgpu',
        device: this.device,
        pipelineCache: this.pipelineCache
      });
      window.getRendererInfo = () => ({
        renderer: 'webgpu',
        fps: (this.profiler as { lastFps?: number; fps?: number } | null)?.fps
          ?? (this.profiler as { lastFps?: number } | null)?.lastFps
          ?? 0,
        particleCount: 0,
        view: this.currentView,
        speedMult: this.speedMult,
        segOmega: this.segOmega,
        corona: this.corona,
        segLayoutPreset: this.segLayoutPreset,
        prototypePreset: this.prototypePreset,
        anomalousEffectsEnabled: this.anomalousEffectsEnabled,
        heronLayoutPreset: this.heronLayoutPreset,
        devicesEnabled: { ...this.devicesEnabled },
        wasmPhysics: !!(typeof window !== 'undefined' && (window as Window & { segWasm?: { enabled?: boolean } }).segWasm?.enabled),
        telemetry: telemetryHub.getSnapshot()?.seg ?? null,
        devices: {},
        debug: {},
        intentionalGaps: [],
        hardwareTwin: telemetryHub.getSnapshot()?.hardwareTwin ?? null,
        chores: gpuChores.breadcrumb()
      });

      window.runSEGSpeedTest = (speeds?: number[], durationMs?: number) => this.runSpeedTest(speeds, durationMs);

      try {
        this.segAnnotations = initSEGAnnotations(() => this);
      } catch (e) {
        console.warn('[MultiDeviceVisualizer] SEG annotations init failed:', e);
      }

      window.addEventListener('resize', () => this._syncCanvasSize());
      this._observeCanvasLayout();

      // Show optimal settings hint
      this.showOptimalSettingsHint();

      // Hardware twin panel (feature-detects Web Serial; Mock always available)
      try {
        initHardwarePanel(this);
      } catch (e) {
        console.warn('[MultiDeviceVisualizer] Hardware panel init failed:', e);
      }
      // Also default WebGPU mock path to shadow when auto-connecting
      try {
        if (new URLSearchParams(location.search).get('mockHardware') === '1') {
          this.hardwareBridge.connectMock().then(() => {
            this.hardwareBridge.setTwinMode(TWIN_MODES.SHADOW);
          });
        }
      } catch (_) { /* ignore */ }

      if (typeof window.syncSEGLayoutUI === 'function') {
        window.syncSEGLayoutUI();
      }
      if (typeof window.syncHeronLayoutUI === 'function') {
        window.syncHeronLayoutUI();
      }
      if (typeof window.syncLayoutPanelsVisibility === 'function') {
        window.syncLayoutPanelsVisibility();
      }

    } catch (e) {
      console.error('[MultiDeviceVisualizer] init failed — hard-fail (no WebGL2):', e);
      const message = e instanceof Error ? e.message : String(e);
      const prev = (typeof window !== 'undefined' ? window.webgpuProbe : null) as WebGPUProbeResult | undefined;
      const fail: WebGPUProbeResult = {
        ok: false,
        timestamp: new Date().toISOString(),
        browser: prev?.browser || { brand: 'unknown', version: '', userAgent: navigator.userAgent, brands: [] },
        hasNavigatorGpu: !!navigator.gpu,
        adapter: prev?.adapter || null,
        features: prev?.features || [],
        limits: prev?.limits || {},
        preferredCanvasFormat: prev?.preferredCanvasFormat || null,
        error: message,
        chromeVsEdge: (prev?.chromeVsEdge || '') + ' MultiDeviceVisualizer init failed after probe.',
        probeDeviceDestroyed: prev?.probeDeviceDestroyed ?? false
      };
      if (typeof window !== 'undefined') window.webgpuProbe = fail;
      showWebGPUHardFail(fail);
      gpuChores.adopt({ sessionApi: 'webgpu', device: null, pipelineCache: null });
      throw e;
    }
  }

  setSegFrameLevel(level: string): void {
    const allowed = ['off', 'minimal', 'full'];
    if (!allowed.includes(level)) return;
    this.segFrameLevel = level;
    console.log(`[SEG] Frame level → ${level} (reload to rebuild geometry if buffers missing)`);
  }

  /** Switch studio / lab / drama lighting + post look at runtime. */
  setLightingLook(look: string): void {
    const preset = getLightingPreset(look as LightingLook);
    if (!preset) return;
    this.lightingLook = look as LightingLook;
    this.postPreset = preset;
    this.lightingConfig = { ...preset.lighting };
    this.postExposure = preset.post.exposure;
    this.postBloomStrength = preset.post.bloomStrength;
    this._uploadSkyUniforms();
    // The prefiltered environment is baked per preset — rebake (memoised) so
    // reflections and irradiance follow the new rig.
    this.refreshIblPrefilter();
    console.log(`[SEG] Lighting look → ${look}`);
  }

  _uploadSkyUniforms(energy = 0): void {
    if (!this.skyUniformBuffer || !this.device) return;
    const sky = this.postPreset?.sky ?? getLightingPreset(this.lightingLook).sky;
    writeQueueBuffer(this.device, this.skyUniformBuffer, new Float32Array([
      sky.mode,
      sky.energy + energy * 0.5,
      0, 0
    ]));
  }

  refreshSEGLayout(qualityScale = 1.0): SegLayout {
    this.segLayout = computeSEGLayout(this.segLayoutPreset, qualityScale) as SegLayout;
    if (this.segLayoutUniformBuffer && this.device) {
      writeQueueBuffer(this.device, 
        this.segLayoutUniformBuffer, packSEGLayoutUniforms(this.segLayout)
      );
    }
    return this.segLayout!;
  }

  getSEGLayoutPreset(): string {
    return this.segLayoutPreset;
  }

  /**
   * Switch SEG layout preset at runtime (rebuilds shared SEG meshes + uniform buffer).
   * @param presetName - 'searl', 'roschin', or 'legacy'
   */
  async setSEGLayoutPreset(presetName: string): Promise<SegLayout | null> {
    const presets: string[] = Object.values(SEG_LAYOUT_PRESETS);
    if (!presets.includes(presetName)) {
      console.warn('[SEG] Unknown layout preset:', presetName);
      return null;
    }
    if (this.segLayoutPreset === presetName) {
      return this.segLayout;
    }

    this.segLayoutPreset = presetName;
    await this._setupCoreSEGSharedMeshes();

    const quality = this.profiler?.qualityLevel ?? 1.0;
    const layout = this.refreshSEGLayout(quality);

    if (DEVICE_CONFIG.seg && layout.cameraOffset) {
      DEVICE_CONFIG.seg.cameraOffset = layout.cameraOffset;
    }

    try {
      const url = new URL(window.location.href);
      url.searchParams.set('layout', presetName);
      window.history.replaceState(null, '', url);
    } catch (_) { /* ignore */ }

    if (this.currentView === 'seg' && this.cameraController) {
      this.cameraController.focusOnDevice('seg');
    }

    return layout;
  }

  getHeronLayoutPreset(): string {
    return this.heronLayoutPreset;
  }

  /**
   * Switch Heron's Fountain build shape (vessels, plumbing, hydraulic params).
   * @param presetName - classic, compact, tower, wide, spiral
   */
  async setHeronLayoutPreset(presetName: string): Promise<HeronLayoutWithMeta | null> {
    const presets: string[] = Object.values(HERON_LAYOUT_PRESETS);
    if (!presets.includes(presetName)) {
      console.warn('[Heron] Unknown layout preset:', presetName);
      return null;
    }
    if (this.heronLayoutPreset === presetName) {
      return this.heronLayout;
    }

    this.heronLayoutPreset = presetName;
    this.heronLayout = getHeronLayout(presetName);

    const heron = this.devices.heron;
    if (heron?.geometry?.applyHeronLayout) {
      await heron.geometry.applyHeronLayout(presetName);
    }
    if (heron?.physicsState) {
      heron.physicsState.heronLayoutId = presetName;
      heron.physicsState.heronHeadMax = this.heronLayout!.headMaxM;
      heron.physicsState.heronHead = Math.min(heron.physicsState.heronHead, this.heronLayout!.headMaxM);
    }

    try {
      localStorage.setItem('heron-layout', presetName);
    } catch (_) { /* ignore */ }
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('heronLayout', presetName);
      window.history.replaceState(null, '', url);
    } catch (_) { /* ignore */ }

    if (this.currentView === 'heron' && this.cameraController) {
      this.cameraController.focusOnDevice('heron');
    }

    return this.heronLayout;
  }

  showOptimalSettingsHint(): void {
    const settings = this.profiler!.getOptimalSettings();
    console.log('Detected GPU Tier:', this.profiler!.gpuTier);
    console.log('Recommended settings:', settings);

    // Could show a UI notification here
  }

  /**
   * Resize the 3D solar battery gauge cylinder to reflect charge level (0–1).
   * Called at init and each frame from DeviceInstance.update for the solar device.
   */
  updateBatteryGaugeMesh(charge = 0.5): void {
    if (!this.device || !this.batteryGaugeVertexBuffer || !this.batteryGaugeIndexBuffer) return;
    const clamped = Math.max(0, Math.min(1, charge));
    const minH = 0.04;
    const maxH = 0.35;
    const height = minH + (maxH - minH) * clamped;
    const gaugeData = this.generateCylinder(0.3, height, 16);
    writeQueueBuffer(this.device, this.batteryGaugeVertexBuffer, gaugeData.vertices);
    writeQueueBuffer(this.device, this.batteryGaugeIndexBuffer, gaugeData.indices);
    this.batteryGaugeIndexCount = gaugeData.indices.length;
  }

  switchMode(mode: string): void {
    this.onModeChange(mode);
  }

  /**
   * Whether a device should simulate and render this frame.
   * Overview shows all enabled devices; focused mode shows only the active device.
   */
  isDeviceActive(deviceId: string): boolean {
    return isDeviceVisible(this.currentView, this.devicesEnabled, deviceId);
  }

  /** True when the multi-device overview (all devices) is active. */
  isOverviewMode(): boolean {
    return !this.currentView || this.currentView === 'overview';
  }

  async setupDevices(): Promise<void> {
    const deviceConfig = getMergedDeviceConfig();
    for (const [deviceId, config] of Object.entries(deviceConfig)) {
      this.devices[deviceId] = new DeviceInstance(
        this.device,
        deviceId,
        config,
        this
      );
      await this.profiler!.trackShaderCompile(`device-${deviceId}`, async () => {
        await this.devices[deviceId].init();
      });

      // Initialize battery gauge for solar device
      if (deviceId === 'solar') {
        this.updateBatteryGaugeMesh(this.devices[deviceId].batteryCharge || 0);
      }
    }
  }

  async setupEnergyPipes(): Promise<void> {
    for (const config of ENERGY_PIPE_EDGES) {
      const pipe = new EnergyPipe(this.device, config, this);
      await pipe.init();
      this.energyPipes.push(pipe);
    }
    await this.setupEnergyPipePipeline();
    initEnergyCouplingDisclaimer();
  }

  /**
   * Overview GPU cull pass. Optional: if the pipeline fails to build the
   * render loop keeps the CPU prefix path.
   */
  async setupOverviewCull(): Promise<void> {
    if (!this.pipelineCache) return;
    try {
      this.overviewCullPipeline = await this.pipelineCache.ensureOverviewCullPipeline(this.shaders);
      const pass = new OverviewCullPass(this.device, this);
      this.overviewCull = pass.init(this.overviewCullPipeline) ? pass : null;
    } catch (err) {
      console.warn('[overview-cull] disabled — falling back to CPU instance prefix', err);
      this.overviewCull = null;
    }
  }

  async setupEnergyPipePipeline(): Promise<void> {
    this.energyPipePipelineBase = await this.pipelineCache!.ensureEnergyPipePipeline(this.shaders);
    this.energyPipePipelineMsaa4 = await this.pipelineCache!.ensureEnergyPipePipeline(this.shaders, { sampleCount: 4 });
    this.energyPipePipeline = this.energyPipePipelineBase;
    this.energyPipeComputePipeline = await this.pipelineCache!.ensureEnergyPipeComputePipeline(this.shaders);
    for (const pipe of this.energyPipes) {
      pipe._setupComputeResources();
    }
  }

  /**
   * Handle simulation mode change (forwarded from window.setMode).
   * Focuses the camera on the named device, matching the single-device API.
   */
  onModeChange(mode: string): void {
    const prev = this.currentView;
    this.currentView = mode;
    if (mode === 'overview') {
      this.cameraController?.showOverview();
    } else if (this.cameraController) {
      this.cameraController.focusOnDevice(mode);
    }
    document.querySelectorAll('.mode-btn').forEach((btn) => btn.classList.remove('active'));
    const activeBtn = document.getElementById(`btn-${mode}`);
    if (activeBtn) activeBtn.classList.add('active');

    // Re-initialize focused device simulation when entering from another view.
    if (mode && mode !== 'overview' && mode !== prev) {
      const device = this.devices[mode];
      device?.resetForModeEntry?.();
    }

    // Lazy CAD props: load on SEG focus; dispose focus-only props on leave.
    if (typeof this.ensureGltfPropsForView === 'function') {
      this.ensureGltfPropsForView(mode).catch((err: unknown) => {
        console.warn('[gltf] ensureGltfPropsForView failed', err);
      });
    }

    this._updateDeviceTelemetry();
    if (typeof window.syncLayoutPanelsVisibility === 'function') {
      window.syncLayoutPanelsVisibility();
    }
    if (mode === 'heron' && typeof window.syncHeronLayoutUI === 'function') {
      window.syncHeronLayoutUI();
    } else if (mode === 'seg' && typeof window.syncSEGLayoutUI === 'function') {
      window.syncSEGLayoutUI();
    }
  }

  /** Adjust SEG particle count from the operator panel slider */
  setParticleCount(count: number): void {
    const seg = this.devices?.seg;
    if (!seg || count === seg.particleCount) return;
    seg.particleCount = count;
  }
}

Object.assign(
  MultiDeviceVisualizer.prototype,
  primitiveMethods,
  geometrySetupMethods,
  sceneSetupMethods,
  renderLoopMethods,
  hardwareTwinMethods,
  materialMethods,
  diagnosticsMethods,
  gltfSetupMethods
);
