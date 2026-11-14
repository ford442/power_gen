import { MultiDeviceShaders } from './multi-device-shaders.js';
import './devices/register-plugins';
import { MultiDeviceCamera } from './multi-device-camera';
import { SimRateController } from './sim-rate-controller';
import { WebGPUManager, DEPTH_FORMAT } from './webgpu-manager';
import { parseColorPipelineMode } from './webgpu-init/canvas';
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
  packSEGLayoutUniforms,
  SEG_LAYOUT_UNIFORM_FLOATS
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
import { HardwareBridge } from './hardware-bridge';
import { ElectromagnetController } from './electromagnet-controller';
import { ENERGY_PIPE_EDGES, initEnergyCouplingDisclaimer } from './renderers/shared/energy-network';
import type { EnergyNetwork } from './renderers/shared/energy-network';
import type { FieldNetwork } from './renderers/shared/field-network';
import type { ChargeNetwork } from './renderers/shared/charge-network';
import {
  parseSsrEnabled,
  parseTaaEnabled,
  parseFdtdEnabled,
  parseFdtdMaterialsEnabled,
  parseFdtdDriveSource
} from './renderers/shared/url-params.js';
import type { FdtdSlicePass } from './devices/quanta/fdtd-slice-pass';
import type { FdtdDriveSource } from './physics/fdtd-tmz';
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
import { LabSession, type PlantBatch } from './session/lab-session';
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
import type { VisualizerHostFields } from './visualizer/visualizer-host-fields';
import type { PostTargetKind } from './visualizer/post-targets.js';
import type { ResourceLifetime } from './visualizer/frame-graph.js';
import { initVisualizer, bootGpuState, recoverFromDeviceLoss } from './visualizer/init-methods.js';
import { updateFdtdSlice } from './visualizer/fdtd-drive.js';

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

// The GPU field bag (setup-geometry/scene-setup/setup-gltf-owned buffers,
// pipelines, textures) is declared on a separate interface and merged in via
// declaration merging (types only — no methods), purely to keep this file
// under the repo's line cap (issues #142/#143/#187) — see
// src/visualizer/visualizer-host-fields.ts. Every method is a real class
// method below; none is merged in at runtime.
export interface MultiDeviceVisualizer extends VisualizerHostFields {}
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

  /** Screen-space reflections (high/ultra tier, `?ssr=0` kill switch); rest of the GPU field bag lives in VisualizerHostFields. */
  ssrEnabled: boolean;
  /** `?taa=0` kill switch — independent of the tier / overview gates. */
  taaEnabled: boolean;
  /** `?fdtd=0` kill switch for the pulse-coil wave slice (ADR-0010). */
  fdtdEnabled: boolean;
  /** `?fdtdMaterials=0` reverts the slice to the vacuum kernel (ADR-0012). */
  fdtdMaterialsEnabled: boolean;
  /** `?fdtdDrive=transformer` borrows another bench's flux (ADR-0012). */
  fdtdDriveSource: FdtdDriveSource;
  /** Reset alongside `fdtdSlice` by device-lost recovery — see init-methods.ts. */
  _fdtdSliceInit?: Promise<void> | null;

  constructor(session: LabSession) {
    console.log('MultiDeviceVisualizer v5 starting - depthStencil fix applied');
    this.session = session;
    this.session.rendererId = 'webgpu';
    this.canvas = document.getElementById('gpuCanvas') as HTMLCanvasElement;

    // Initialize managers (single adapter path lives in WebGPUManager)
    this.webgpu = new WebGPUManager(this.canvas, {
      // Session re-init on the existing adapter (ADR-0007: never a second
      // device) — see recoverFromDeviceLoss in visualizer/init-methods.ts.
      // Falls back to the reload overlay itself if recovery can't complete.
      onDeviceLost: (info: { reason?: string; message?: string }) => {
        this.recoverFromDeviceLoss(info).catch((e) => {
          console.error('[MultiDeviceVisualizer] recoverFromDeviceLoss threw — prompting reload', e);
          WebGPUManager.showDeviceLostUI(info);
        });
      }
    });
    this.profiler = null;
    this.debugPanel = null;
    this.depthFormat = DEPTH_FORMAT;
    this._deviceRecovering = false;

    this.shaders = new MultiDeviceShaders();
    this.session.cameraController = null;

    this.devices = {};
    this.session.attachDevices(this.devices);
    this.energyPipes = [];

    this.emController = new ElectromagnetController();

    this.time = 0;
    this.lastFrameTime = 0;
    this.fps = 60;
    this.globalEnergyLevel = 0.0;

    this.ssrEnabled = parseSsrEnabled();
    this.taaEnabled = parseTaaEnabled();
    this.fdtdEnabled = parseFdtdEnabled();
    this.fdtdMaterialsEnabled = parseFdtdMaterialsEnabled();
    this.fdtdDriveSource = parseFdtdDriveSource();

    this.lightingLook = parseLightingLook();
    const lookPreset = getLightingPreset(this.lightingLook, parseColorPipelineMode());
    this.lightingConfig = { ...lookPreset.lighting };
    this.postPreset = lookPreset;
    this.postExposure = lookPreset.post.exposure;
    this.postBloomStrength = lookPreset.post.bloomStrength;

    this.segLayout = null;

    this.segFrameLevel = parseSegFrameLevel();
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
  get fieldNetwork(): FieldNetwork { return this.session.fieldNetwork; }
  get chargeNetwork(): ChargeNetwork { return this.session.chargeNetwork; }
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
  /** This frame's plant batch — device-update.ts steps the JS plants over it. */
  get plantBatch(): PlantBatch | null { return this.session.plantBatch; }
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

  setSegFrameLevel(level: string): void {
    const allowed = ['off', 'minimal', 'full'];
    if (!allowed.includes(level)) return;
    this.segFrameLevel = level;
    console.log(`[SEG] Frame level → ${level} (reload to rebuild geometry if buffers missing)`);
  }

  /** Switch studio / lab / drama lighting + post look at runtime. */
  setLightingLook(look: string): void {
    const preset = getLightingPreset(look as LightingLook, this.webgpu.colorMode);
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
    const sky = this.postPreset?.sky ?? getLightingPreset(this.lightingLook, this.webgpu.colorMode).sky;
    const data = (this._skyUniformData ??= new Float32Array(4));
    data[0] = sky.mode;
    data[1] = sky.energy + energy * 0.5;
    // SkyParams.linear: decode the backdrop's sRGB-picked literals (sky-frag.wgsl).
    data[2] = this.webgpu.colorMode === 'linear' ? 1 : 0;
    data[3] = 0;
    writeQueueBuffer(this.device, this.skyUniformBuffer, data);
  }

  refreshSEGLayout(qualityScale = 1.0): SegLayout {
    this.segLayout = computeSEGLayout(this.segLayoutPreset, qualityScale) as SegLayout;
    if (this.segLayoutUniformBuffer && this.device) {
      writeQueueBuffer(this.device, 
        this.segLayoutUniformBuffer,
        packSEGLayoutUniforms(this.segLayout, (this._segLayoutUniformData ??= new Float32Array(SEG_LAYOUT_UNIFORM_FLOATS)))
      );
    }
    return this.segLayout!;
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
    // The vessels move and the plumbing re-routes — as with the SEG layout
    // presets, the old frame is a different scene, so reprojecting it would
    // smear the previous build shape across the new one. The CAD prop can also
    // appear or disappear on this path, which is a larger cut still.
    this._resetTaaHistory();

    const heron = this.devices.heron;
    if (heron?.geometry?.applyHeronLayout) {
      await heron.geometry.applyHeronLayout(presetName);
    }

    // The Heron CAD prop is baked for the `classic` preset only (the presets
    // re-route the plumbing rather than rescale one shape), so a preset change
    // is as much a prop change as a mode change is: re-running the per-view
    // loader disposes the classic vessels when leaving it and reloads them when
    // coming back. Without this the classic glass would stay hanging in a tower
    // layout until the user left the bench and returned.
    if (this.currentView === 'heron') {
      // Awaited, so the dispose has happened before the camera refocuses — but
      // a failed prop load must not fail the preset switch, exactly as on the
      // mode-change path.
      await this.ensureGltfPropsForView('heron').catch((err: unknown) => {
        console.warn('[gltf] heron preset prop refresh failed', err);
      });
    }

    // Again, because the two awaits above can span many frames — a prop load
    // includes a GLB fetch. The reset before them covers the geometry swap; by
    // the time the CAD lands, history has long since gone valid again, and
    // reprojecting across *that* cut is the smear the first reset was for.
    this._resetTaaHistory();

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
    // Reset rather than assume empty: device-lost recovery calls this again
    // on a fresh device, and the old pipes' GPU buffers died with it.
    this.energyPipes = [];
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

  /** Per-frame FDTD wave slice gate + upload (ADR-0010) — visualizer/fdtd-drive.ts. */
  updateFdtdSlice(qualityTier: string, deltaTime = 0): FdtdSlicePass | null {
    return updateFdtdSlice(this, qualityTier, deltaTime);
  }

  async setupEnergyPipePipeline(): Promise<void> {
    // The 4× variant compiles with the MSAA tier (visualizer/pipeline-tiers.ts).
    this.energyPipePipelineBase = await this.pipelineCache!.ensureEnergyPipePipeline(this.shaders);
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

  /**
   * Drop the temporal history. Anything that makes last frame's image a
   * different scene must call this or TAA ghosts across the transition:
   * mode switches, layout presets, and lighting-look changes.
   */
  _resetTaaHistory(): void { this._taaHistoryValid = false; }

  // ── Boot (bodies in visualizer/init-methods.ts) ──
  init(): Promise<void> { return initVisualizer.call(this); }
  /** GPU-resource half of boot; re-run by device-lost recovery (init-methods.ts). */
  _bootGpuState(): Promise<void> { return bootGpuState.call(this); }
  /** `onDeviceLost` handler (ADR-0007) — session re-init on the existing adapter. */
  recoverFromDeviceLoss(info: { reason?: string; message?: string }): Promise<void> {
    return recoverFromDeviceLoss.call(this, info);
  }

  // ── Facade: forwards to the collaborators built in the constructor ──
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
  setupIblPrefilter(): ReturnType<PostStack['setupIblPrefilter']> { return this.postStack.setupIblPrefilter(); }
  refreshIblPrefilter(): void { this.postStack.refreshIblPrefilter(); }
  _bakeIbl(): ReturnType<PostStack['_bakeIbl']> { return this.postStack._bakeIbl(); }
  _postTargetAllocated(kind: PostTargetKind): boolean { return this.postStack.targets._postTargetAllocated(kind); }
  _ensurePostTarget(kind: PostTargetKind): void { this.postStack.targets._ensurePostTarget(kind); }
  _destroyPostTarget(kind: PostTargetKind): void { this.postStack.targets._destroyPostTarget(kind); }
  _releasePostTarget(kind: PostTargetKind): void { this.postStack.targets._releasePostTarget(kind); }
  _destroyAllPostTargets(): void { this.postStack.targets._destroyAllPostTargets(); }
  _postTargetLifetimes(): Record<PostTargetKind, ResourceLifetime> { return this.postStack.targets._postTargetLifetimes(); }
  _setupPostPlaceholders(): void { this.postStack.targets._setupPostPlaceholders(); }
  _rebindPostTargets(): void { this.postStack.targets._rebindPostTargets(); }
  setupSsrPipeline(): Promise<void> { return this.postStack.setupSsrPipeline(); }
  setupDepthResolvePipeline(): Promise<void> { return this.postStack.setupDepthResolvePipeline(); }
  _waitForCanvasLayout(): Promise<void> { return this.postStack._waitForCanvasLayout(); }
  _observeCanvasLayout(): void { this.postStack._observeCanvasLayout(); }
  _syncCanvasSize(): Promise<void> { return this.postStack._syncCanvasSize(); }
  _rebuildBloomBindGroups(): void { this.postStack._rebuildBloomBindGroups(); }
  _rebuildSsrBindGroup(): void { this.postStack._rebuildSsrBindGroup(); }
  _rebuildDepthResolveBindGroup(): void { this.postStack._rebuildDepthResolveBindGroup(); }

  render(timestamp: number): void { this.frameLoop.render(timestamp); }
  renderAnomalyWalls(renderPass: GPURenderPassEncoder, segDevice: DeviceInstance | null | undefined): void {
    this.frameLoop.renderAnomalyWalls(renderPass, segDevice);
  }
  _encodeTaaResolve(encoder: GPUCommandEncoder, msaaActive: boolean,
    timestampWrites?: GPURenderPassTimestampWrites): boolean {
    return this.frameLoop._encodeTaaResolve(encoder, msaaActive, timestampWrites);
  }
  _dispatchSsr(encoder: GPUCommandEncoder, msaaActive: boolean,
    timestampWrites?: GPUComputePassTimestampWrites): boolean {
    return this.frameLoop._dispatchSsr(encoder, msaaActive, timestampWrites);
  }

  setupMaterialTableBuffer(): void { this.materialTable.setupMaterialTableBuffer(); }

  runSpeedTest(speeds?: number[], durationMs?: number): Promise<void> {
    return this.diagnostics.runSpeedTest(speeds, durationMs);
  }
  captureParticleSubset(deviceId?: string, maxCount?: number): Promise<unknown> {
    return this.diagnostics.captureParticleSubset(deviceId, maxCount);
  }
  captureOverviewCull(): Promise<unknown> { return this.diagnostics.captureOverviewCull(); }

  setupGltfAssets(embeddedGlb?: ArrayBuffer, opts?: { propBuffers?: Record<string, ArrayBuffer> }): Promise<void> {
    return this.gltfProps.setupGltfAssets(embeddedGlb, opts);
  }
  ensureGltfPropsForView(view: string): Promise<void> { return this.gltfProps.ensureGltfPropsForView(view); }
  updateGltfHousingState(): void { this.gltfProps.updateGltfHousingState(); }
  _loadGltfPropsForSegFocus(view?: string): Promise<void> { return this.gltfProps._loadGltfPropsForSegFocus(view); }
  _loadGltfPropsForSegFocusInner(view: string): Promise<void> { return this.gltfProps._loadGltfPropsForSegFocusInner(view); }
  _disposeFocusOnlyGltfProps(keepDeviceId?: string): void { this.gltfProps._disposeFocusOnlyGltfProps(keepDeviceId); }
  _uploadGltfProp(
    prop: Parameters<GltfPropRegistry['_uploadGltfProp']>[0],
    ctx: Parameters<GltfPropRegistry['_uploadGltfProp']>[1]
  ): Promise<void> {
    return this.gltfProps._uploadGltfProp(prop, ctx);
  }

  _updateHardwareTwin(deltaTime: number): void { this.session.syncHardwareTwin(deltaTime); }
  _updateTachometer(): void { this.session.updateTachometer(); }
  _updateDeviceTelemetry(): void { this.session.publishModeTelemetry(); }

  getSEGLayoutPreset(): string { return this.segLayoutPreset; }
  getHeronLayoutPreset(): string { return this.heronLayoutPreset; }
  /** Overview shows all enabled devices; focused mode only the active one. */
  isDeviceActive(deviceId: string): boolean { return this.session.isDeviceActive(deviceId); }
  isOverviewMode(): boolean { return this.session.isOverviewMode(); }
}
