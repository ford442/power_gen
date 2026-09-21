import { MultiDeviceShaders } from './multi-device-shaders.js';
import './devices/register-plugins';
import { MultiDeviceCamera } from './multi-device-camera';
import { SimRateController } from './sim-rate-controller';
import { WebGPUManager, DEPTH_FORMAT } from './webgpu-manager';
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
import { HardwareBridge } from './hardware-bridge';
import { ElectromagnetController } from './electromagnet-controller';
import { ENERGY_PIPE_EDGES, initEnergyCouplingDisclaimer } from './renderers/shared/energy-network';
import type { EnergyNetwork } from './renderers/shared/energy-network';
import type { FieldNetwork } from './renderers/shared/field-network';
import {
  parseSsrEnabled,
  parseTaaEnabled,
  parseFdtdEnabled,
  parseFdtdMaterialsEnabled,
  parseFdtdDriveSource
} from './renderers/shared/url-params.js';
import { FdtdSlicePass } from './devices/quanta/fdtd-slice-pass';
import { pulseCoilFdtdDrive, transformerFdtdDrive } from './devices/quanta/pulse-coil';
import {
  FDTD_DRIVE_DEVICE,
  FDTD_DRIVE_SOURCES,
  FDTD_SLICE_OWNER,
  fdtdSliceGateOpen,
  type FdtdDriveSource
} from './physics/fdtd-tmz';
import type { SEGIntegrationManager } from './integration';
import { generateCylinder } from './visualizer/primitives.js';
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
import type { DevicePhysicsState, HeronLayout } from './renderers/shared/device-physics';
import type { PrototypePreset } from './renderers/shared/url-params.js';
import type { LightingLook } from './seg-lighting-presets';
import type { HardwareTwinTelemetry } from './telemetry/types';
import type { VisualizerHostFields } from './visualizer/visualizer-host-fields';
import { facadeMethods } from './visualizer/facade-methods.js';
import type { VisualizerFacadeMethods } from './visualizer/facade-methods.js';
import { initMethods } from './visualizer/init-methods.js';
import type { VisualizerInitMethods } from './visualizer/init-methods.js';
import { bindHostMethods } from './visualizer/bind-host-methods.js';

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
// pipelines, textures) and the facade methods that just forward to
// collaborator objects are declared on separate interfaces and merged in via
// declaration merging, purely to keep this file under the repo's line cap
// (issues #142/#143/#187) — see src/visualizer/visualizer-host-fields.ts,
// src/visualizer/facade-methods.ts and src/visualizer/init-methods.ts.
export interface MultiDeviceVisualizer extends VisualizerHostFields, VisualizerFacadeMethods, VisualizerInitMethods {}
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
    this.fdtdMaterialsEnabled = parseFdtdMaterialsEnabled(params);
    this.fdtdDriveSource = parseFdtdDriveSource(params);

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

    // Facade methods that just forward to the collaborator objects above
    // (see src/visualizer/facade-methods.ts), plus the async boot sequence
    // (see src/visualizer/init-methods.ts) — attached here rather than
    // declared as class methods to keep this file under the line cap.
    Object.assign(this, bindHostMethods(facadeMethods, this));
    Object.assign(this, bindHostMethods(initMethods, this));

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
        const pass = new FdtdSlicePass(this.device, this, {
          materialsEnabled: this.fdtdMaterialsEnabled
        });
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
      drive: this._fdtdDrive(owner)
    }) ? pass : null;
  }

  /**
   * Source amplitude for the slice (ADR-0012). Default: the pulse coil's own
   * discharge current. Under `?fdtdDrive=transformer`, the transformer bench's
   * normalised core flux instead — continuous AC, so the panel shows successive
   * fronts rather than one transient. If that bench isn't in the lab, fall back
   * to the coil rather than showing a dead panel.
   */
  private _fdtdDrive(owner: { physicsState?: Partial<DevicePhysicsState> | null }): number {
    if (this.fdtdDriveSource === FDTD_DRIVE_SOURCES.TRANSFORMER) {
      const src = this.devices[FDTD_DRIVE_DEVICE.transformer];
      if (src) return transformerFdtdDrive(src.physicsState);
    }
    return pulseCoilFdtdDrive(owner.physicsState);
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

  /**
   * Drop the temporal history. Anything that makes last frame's image a
   * different scene must call this or TAA ghosts across the transition:
   * mode switches, layout presets, and lighting-look changes.
   */
  _resetTaaHistory(): void { this._taaHistoryValid = false; }
}
