import { MultiDeviceShaders } from './multi-device-shaders.js';
import './devices/register-plugins';
import { MultiDeviceCamera } from './multi-device-camera';
import { SimRateController } from './sim-rate-controller';
import { WebGPUManager, DEPTH_FORMAT } from './webgpu-manager';
import { PipelineLayoutCache } from './pipeline-layout-cache';
import { CameraController } from './camera-controller';
import { PerformanceProfiler } from './performance-profiler';
import { DebugPanel } from './debug-panel';
import { DEVICE_CONFIG } from './devices/device-config';
import { getMergedDeviceConfig } from './devices/device-registry.js';
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
  HERON_LAYOUT_PRESETS
} from './heron-layout';
import { parseSegFrameLevel } from './seg-frame-model';
import {
  parseLightingLook,
  getLightingPreset,
} from './seg-lighting-presets';
import { writeQueueBuffer } from './gpu-buffer-write';
import { telemetryHub } from './telemetry-hub';
import { HardwareBridge } from './hardware-bridge';
import { ElectromagnetController } from './electromagnet-controller';
import { initHardwarePanel } from './hardware-panel';
import { initSEGAnnotations } from './seg-annotations';
import { ENERGY_PIPE_EDGES, initEnergyCouplingDisclaimer } from './renderers/shared/energy-network';
import type { EnergyNetwork } from './renderers/shared/energy-network';
import { gpuChores } from './gpu-chores';
import { showWebGPUHardFail, type WebGPUProbeResult } from './renderers/webgpu-probe';
import {
  parseSsrEnabled,
  parseTaaEnabled,
  parseFdtdEnabled
} from './renderers/shared/url-params.js';
import { FdtdSlicePass } from './devices/quanta/fdtd-slice-pass';
import { pulseCoilFdtdDrive } from './devices/quanta/pulse-coil';
import { FDTD_SLICE_OWNER, fdtdSliceGateOpen } from './physics/fdtd-tmz';
import { createIblResources } from './ibl-prefilter';
import type { IblPrefilterCompute } from './ibl-prefilter-gpu';
import {
  SEGIntegrationManager,
  PHYSICS_UNIFORM_BYTES
} from './integration';
import {
  generateCylinder,
  generateCylinderWithUVs,
  generateDisc,
  generateDiscWithUVs,
  generateBoxWithUVs,
  type PrimitiveMesh
} from './visualizer/primitives.js';
import { SharedGeometryFactory } from './visualizer/setup-geometry.js';
import { PostStack } from './visualizer/scene-setup.js';
import { WebGpuFrameLoop } from './visualizer/render-loop.js';
import { MaterialTable } from './visualizer/materials.js';
import { VisualizerDiagnostics } from './visualizer/diagnostics.js';
import { GltfPropRegistry } from './visualizer/setup-gltf.js';
import { LabSession } from './session/lab-session';
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
  session: LabSession;
  geometryFactory: SharedGeometryFactory;
  postStack: PostStack;
  gltfProps: GltfPropRegistry;
  materialTable: MaterialTable;
  diagnostics: VisualizerDiagnostics;
  frameLoop: WebGpuFrameLoop;

  canvas: HTMLCanvasElement;
  webgpu: WebGPUManager;
  profiler: PerformanceProfiler | null;
  debugPanel: DebugPanel | null;
  /** Matches WebGPUManager.depthFormat (depth24plus, no stencil). */
  depthFormat: GPUTextureFormat;
  shaders: MultiDeviceShaders;

  devices: Record<string, DeviceInstance>;
  energyPipes: EnergyPipe[];

  // Hardware digital twin (Web Serial / mock) — coil GPU viz stays on this backend
  emController: ElectromagnetController;

  integration: SEGIntegrationManager | null;
  /** Manager-owned physics uniform buffer (alias). */
  physicsUniformBuffer: GPUBuffer | null;

  time: number;
  lastFrameTime: number;
  fps: number;
  globalEnergyLevel: number;

  lightingLook: LightingLook;
  lightingConfig: ReturnType<typeof getLightingPreset>['lighting'];
  postPreset: ReturnType<typeof getLightingPreset>;
  postExposure: number;
  postBloomStrength: number;

  segLayout: SegLayout | null;

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
  iblResources?: Awaited<ReturnType<typeof createIblResources>> | null;
  /** Compute prefilter, or null when it could not be built. `undefined` = not tried yet. */
  iblCompute?: IblPrefilterCompute | null;
  /** Roughness level count uploaded to LightingConfig.iblLevels (0 = analytic fallback). */
  iblLevels?: number;

  /** Screen-space reflections (high/ultra tier, `?ssr=0` kill switch). */
  ssrEnabled: boolean;
  /** `?taa=0` kill switch — independent of the tier / overview gates. */
  taaEnabled: boolean;
  /** `?fdtd=0` kill switch for the pulse-coil wave slice (ADR-0010). */
  fdtdEnabled: boolean;
  /** Lazily built on the first frame its gate could open; null if the build failed. */
  fdtdSlice?: FdtdSlicePass | null;
  private _fdtdSliceInit?: Promise<void> | null;
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

  constructor(session: LabSession) {
    console.log('MultiDeviceVisualizer v5 starting - depthStencil fix applied');
    this.session = session;
    this.session.rendererId = 'webgpu';
    this.canvas = document.getElementById('gpuCanvas') as HTMLCanvasElement;

    // Initialize managers (single adapter path lives in WebGPUManager)
    this.webgpu = new WebGPUManager(this.canvas, {
      onDeviceLost: (info: { reason?: string; message?: string }) => {
        console.error('[MultiDeviceVisualizer] GPU device lost — prompting reload', info);
        WebGPUManager.showDeviceLostUI(info);
      }
    });
    this.profiler = null;
    this.debugPanel = null;
    this.depthFormat = DEPTH_FORMAT;

    this.shaders = new MultiDeviceShaders();
    this.session.cameraController = null;

    this.devices = {};
    this.session.attachDevices(this.devices);
    this.energyPipes = [];

    this.emController = new ElectromagnetController();

    this.integration = null;
    this.physicsUniformBuffer = null;

    this.time = 0;
    this.lastFrameTime = 0;
    this.fps = 60;
    this.globalEnergyLevel = 0.0;

    const params = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
    this.ssrEnabled = parseSsrEnabled(params);
    this.taaEnabled = parseTaaEnabled(params);
    this.fdtdEnabled = parseFdtdEnabled(params);

    this.lightingLook = parseLightingLook(params);
    const lookPreset = getLightingPreset(this.lightingLook);
    this.lightingConfig = { ...lookPreset.lighting };
    this.postPreset = lookPreset;
    this.postExposure = lookPreset.post.exposure;
    this.postBloomStrength = lookPreset.post.bloomStrength;

    this.segLayout = null;

    this.segFrameLevel = parseSegFrameLevel(params);
    this.segFrameBuffers = null;
    this.frameStructuralInstanceBuffer = null;
    this.frameControlInstanceBuffer = null;
    this.frameCageInstanceBuffer = null;
    this.frameLabBenchInstanceBuffer = null;

    this.geometryFactory = new SharedGeometryFactory(this);
    this.postStack = new PostStack(this);
    this.gltfProps = new GltfPropRegistry(this);
    this.materialTable = new MaterialTable(this);
    this.diagnostics = new VisualizerDiagnostics(this);
    this.frameLoop = new WebGpuFrameLoop(this);

    this.ready = this.init();
  }

  get camera(): CameraController { return this.session.camera; }
  get cameraController(): MultiDeviceCamera | null { return this.session.cameraController; }
  set cameraController(v: MultiDeviceCamera | null) { this.session.cameraController = v; }
  get currentView(): string { return this.session.currentView; }
  set currentView(v: string) { this.session.currentView = v; }
  get devicesEnabled(): Record<string, boolean> { return this.session.devicesEnabled; }
  set devicesEnabled(v: Record<string, boolean>) { this.session.devicesEnabled = v; }
  get energyNetwork(): EnergyNetwork { return this.session.energyNetwork; }
  get hardwareBridge(): HardwareBridge { return this.session.hardwareBridge; }
  set hardwareBridge(v: HardwareBridge) { this.session.hardwareBridge = v; }
  get hardwareTargetPhase(): number { return this.session.hardwareTargetPhase; }
  set hardwareTargetPhase(v: number) { this.session.hardwareTargetPhase = v; }
  get hardwareTargetSpeed(): number { return this.session.hardwareTargetSpeed; }
  set hardwareTargetSpeed(v: number) { this.session.hardwareTargetSpeed = v; }
  get hardwareShadow(): { phaseError: number; rpmError: number } { return this.session.hardwareShadow; }
  set hardwareShadow(v: { phaseError: number; rpmError: number }) { this.session.hardwareShadow = v; }
  get hardwareTwinTelemetry(): HardwareTwinTelemetry | null { return this.session.hardwareTwinTelemetry; }
  set hardwareTwinTelemetry(v: HardwareTwinTelemetry | null) { this.session.hardwareTwinTelemetry = v; }
  get speedMult(): number { return this.session.speedMult; }
  set speedMult(v: number) { this.session.speedMult = v; }
  get segOmega(): number { return this.session.segOmega; }
  set segOmega(v: number) { this.session.segOmega = v; }
  get corona(): number { return this.session.corona; }
  set corona(v: number) { this.session.corona = v; }
  get prototypePreset(): PrototypePreset { return this.session.prototypePreset; }
  set prototypePreset(v: PrototypePreset) { this.session.prototypePreset = v; }
  get anomalousEffectsEnabled(): boolean { return this.session.anomalousEffectsEnabled; }
  set anomalousEffectsEnabled(v: boolean) { this.session.anomalousEffectsEnabled = v; }
  get simRateController(): SimRateController { return this.session.simRateController; }
  get segLayoutPreset(): string { return this.session.segLayoutPreset; }
  set segLayoutPreset(v: string) { this.session.segLayoutPreset = v; }
  get heronLayoutPreset(): string { return this.session.heronLayoutPreset; }
  set heronLayoutPreset(v: string) { this.session.heronLayoutPreset = v; }
  get heronLayout(): HeronLayoutWithMeta | null { return this.session.heronLayout; }
  set heronLayout(v: HeronLayoutWithMeta | null) { this.session.heronLayout = v; }

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
        adapterInfo: this.webgpu.adapterInfo,
        textureCompression: this.webgpu.textureCompression
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
      await this.setupIblPrefilter();

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
      await this.setupTaaPipeline();
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
        chores: gpuChores.breadcrumb(),
        textureCompression: this.webgpu.textureCompressionUsed !== 'none'
          ? this.webgpu.textureCompressionUsed
          : this.webgpu.textureCompression
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
        await this.session.maybeConnectMockHardware();
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
    // Every pixel's colour just changed — history from the old rig would ghost.
    this._resetTaaHistory();
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

    this.session.persistSegLayoutPreset(presetName);
    // The rollers move to new positions; the old frame is a different scene.
    this._resetTaaHistory();
    await this._setupCoreSEGSharedMeshes();

    const quality = this.profiler?.qualityLevel ?? 1.0;
    const layout = this.refreshSEGLayout(quality);

    if (DEVICE_CONFIG.seg && layout.cameraOffset) {
      DEVICE_CONFIG.seg.cameraOffset = layout.cameraOffset;
    }

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

    this.session.persistHeronLayoutPreset(presetName);

    const heron = this.devices.heron;
    if (heron?.geometry?.applyHeronLayout) {
      await heron.geometry.applyHeronLayout(presetName);
    }

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
    const gaugeData = generateCylinder(0.3, height, 16);
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
    return this.session.isDeviceActive(deviceId);
  }

  isOverviewMode(): boolean {
    return this.session.isOverviewMode();
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

  /**
   * Per-frame FDTD wave slice gate + uniform upload (ADR-0010). The pass is
   * not built at boot: the first frame on which the gate would open starts
   * an async build, and the slice joins a few frames later. A failed build
   * disables the slice for the session.
   *
   * @returns the pass when it should dispatch and draw this frame, else null
   */
  updateFdtdSlice(qualityTier: string): FdtdSlicePass | null {
    const owner = this.devices[FDTD_SLICE_OWNER];
    const frame = {
      enabled: this.fdtdEnabled && !!owner,
      currentView: this.currentView,
      qualityTier
    };
    if (this.fdtdSlice === undefined) {
      const wouldOpen = fdtdSliceGateOpen({ ...frame, ready: true });
      if (wouldOpen && !this._fdtdSliceInit && this.pipelineCache) {
        const pass = new FdtdSlicePass(this.device, this);
        this._fdtdSliceInit = pass.init().then(
          (ok) => { this.fdtdSlice = ok ? pass : null; },
          (err) => {
            console.warn('[fdtd-slice] disabled — pipeline build failed', err);
            pass.destroy();
            this.fdtdSlice = null;
          }
        );
      }
      return null;
    }
    const pass = this.fdtdSlice;
    if (!pass || !owner) return null;
    return pass.update({
      ...frame,
      devicePos: owner.position,
      drive: pulseCoilFdtdDrive(owner.physicsState)
    }) ? pass : null;
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
    const { view } = this.session.setMode(mode);
    // New camera framing and often a different device — reprojecting last
    // frame across the cut would smear it.
    this._resetTaaHistory();
    document.querySelectorAll('.mode-btn').forEach((btn) => btn.classList.remove('active'));
    const activeBtn = document.getElementById(`btn-${view}`);
    if (activeBtn) activeBtn.classList.add('active');

    this.ensureGltfPropsForView(view).catch((err: unknown) => {
      console.warn('[gltf] ensureGltfPropsForView failed', err);
    });

    if (typeof window.syncLayoutPanelsVisibility === 'function') {
      window.syncLayoutPanelsVisibility();
    }
    if (view === 'heron' && typeof window.syncHeronLayoutUI === 'function') {
      window.syncHeronLayoutUI();
    } else if (view === 'seg' && typeof window.syncSEGLayoutUI === 'function') {
      window.syncSEGLayoutUI();
    }
  }

  /** Adjust SEG particle count from the operator panel slider */
  setParticleCount(count: number): void {
    const seg = this.devices?.seg;
    if (!seg || count === seg.particleCount) return;
    seg.particleCount = count;
  }

  generateCylinder(radius: number, height: number, segments: number): PrimitiveMesh {
    return generateCylinder(radius, height, segments);
  }
  generateCylinderWithUVs(radius: number, height: number, segments: number): PrimitiveMesh {
    return generateCylinderWithUVs(radius, height, segments);
  }
  generateDisc(innerRadius: number, outerRadius: number, thickness: number, segments: number): PrimitiveMesh {
    return generateDisc(innerRadius, outerRadius, thickness, segments);
  }
  generateDiscWithUVs(innerRadius: number, outerRadius: number, thickness: number, segments: number): PrimitiveMesh {
    return generateDiscWithUVs(innerRadius, outerRadius, thickness, segments);
  }
  generateBoxWithUVs(width: number, height: number, depth: number): PrimitiveMesh {
    return generateBoxWithUVs(width, height, depth);
  }

  setupSharedGeometry(): Promise<void> { return this.geometryFactory.setupSharedGeometry(); }
  setupDefaultPrimitiveGeometry(deviceId: string, config: { color?: unknown }): Promise<void> {
    return this.geometryFactory.setupDefaultPrimitiveGeometry(deviceId, config);
  }
  _setupCoreSEGSharedMeshes(): Promise<void> { return this.geometryFactory._setupCoreSEGSharedMeshes(); }
  _setupAlternateDeviceSharedMeshes(): Promise<void> { return this.geometryFactory._setupAlternateDeviceSharedMeshes(); }

  setupFloorGrid(): Promise<void> { return this.postStack.setupFloorGrid(); }
  setupSkyGradient(): Promise<void> { return this.postStack.setupSkyGradient(); }
  setupAnomalyWallPipeline(): Promise<void> { return this.postStack.setupAnomalyWallPipeline(); }
  setupDepthBuffer(): Promise<void> { return this.postStack.setupDepthBuffer(); }
  setupBloomTextures(): void { this.postStack.setupBloomTextures(); }
  setupBloomPipeline(): Promise<void> { return this.postStack.setupBloomPipeline(); }
  setupTaaPipeline(): Promise<void> { return this.postStack.setupTaaPipeline(); }
  _rebuildTaaBindGroups(): void { this.postStack._rebuildTaaBindGroups(); }

  /**
   * Drop the temporal history. Anything that makes last frame's image a
   * different scene must call this or TAA ghosts across the transition:
   * mode switches, layout presets, and lighting-look changes.
   */
  _resetTaaHistory(): void { this._taaHistoryValid = false; }
  setupIblPrefilter(): ReturnType<PostStack['setupIblPrefilter']> { return this.postStack.setupIblPrefilter(); }
  refreshIblPrefilter(): void { this.postStack.refreshIblPrefilter(); }
  _bakeIbl(): ReturnType<PostStack['_bakeIbl']> { return this.postStack._bakeIbl(); }
  setupSsrTexture(): void { this.postStack.setupSsrTexture(); }
  setupSsrPipeline(): Promise<void> { return this.postStack.setupSsrPipeline(); }
  setupDepthResolvePipeline(): Promise<void> { return this.postStack.setupDepthResolvePipeline(); }
  _waitForCanvasLayout(): Promise<void> { return this.postStack._waitForCanvasLayout(); }
  _observeCanvasLayout(): void { this.postStack._observeCanvasLayout(); }
  _syncCanvasSize(): Promise<void> { return this.postStack._syncCanvasSize(); }
  _rebuildBloomBindGroups(): void { this.postStack._rebuildBloomBindGroups(); }
  _rebuildSsrBindGroup(): void { this.postStack._rebuildSsrBindGroup(); }
  _rebuildDepthResolveBindGroup(): void { this.postStack._rebuildDepthResolveBindGroup(); }

  render(timestamp: number): void { this.frameLoop.render(timestamp); }
  renderAnomalyWalls(
    renderPass: GPURenderPassEncoder,
    globalUniformBuffer: GPUBuffer | null,
    segDevice: DeviceInstance | null | undefined
  ): void {
    this.frameLoop.renderAnomalyWalls(renderPass, globalUniformBuffer, segDevice);
  }
  _encodeTaaResolve(encoder: GPUCommandEncoder, msaaActive: boolean): boolean {
    return this.frameLoop._encodeTaaResolve(encoder, msaaActive);
  }

  _dispatchSsr(encoder: GPUCommandEncoder, msaaActive: boolean): void {
    this.frameLoop._dispatchSsr(encoder, msaaActive);
  }

  setupMaterialTableBuffer(): void { this.materialTable.setupMaterialTableBuffer(); }

  runSpeedTest(speeds?: number[], durationMs?: number): Promise<void> {
    return this.diagnostics.runSpeedTest(speeds, durationMs);
  }
  captureParticleSubset(deviceId?: string, maxCount?: number): Promise<unknown> {
    return this.diagnostics.captureParticleSubset(deviceId, maxCount);
  }
  captureOverviewCull(): Promise<unknown> {
    return this.diagnostics.captureOverviewCull();
  }

  setupGltfAssets(embeddedGlb?: ArrayBuffer, opts?: { propBuffers?: Record<string, ArrayBuffer> }): Promise<void> {
    return this.gltfProps.setupGltfAssets(embeddedGlb, opts);
  }
  ensureGltfPropsForView(view: string): Promise<void> { return this.gltfProps.ensureGltfPropsForView(view); }
  updateGltfHousingState(): void { this.gltfProps.updateGltfHousingState(); }
  _loadGltfPropsForSegFocus(): Promise<void> { return this.gltfProps._loadGltfPropsForSegFocus(); }
  _loadGltfPropsForSegFocusInner(): Promise<void> { return this.gltfProps._loadGltfPropsForSegFocusInner(); }
  _disposeFocusOnlyGltfProps(): void { this.gltfProps._disposeFocusOnlyGltfProps(); }
  _uploadGltfProp(
    prop: Parameters<GltfPropRegistry['_uploadGltfProp']>[0],
    ctx: Parameters<GltfPropRegistry['_uploadGltfProp']>[1]
  ): Promise<void> {
    return this.gltfProps._uploadGltfProp(prop, ctx);
  }

  _updateHardwareTwin(deltaTime: number): void { this.session.syncHardwareTwin(deltaTime); }
  _updateTachometer(): void { this.session.updateTachometer(); }
  _updateDeviceTelemetry(): void { this.session.publishModeTelemetry(); }
}
