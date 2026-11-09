// MultiDeviceVisualizer's async boot sequence, split out purely to keep the
// host class under the repo's line-count cap (issues #142/#143/#187) —
// attached in the constructor via
// `Object.assign(this, bindHostMethods(initMethods, this))` and merged into
// the class's public type via `VisualizerInitMethods` (see
// multi-device-visualizer.ts's `export interface MultiDeviceVisualizer
// extends ... VisualizerInitMethods {}`). No behavior change from the
// method this replaces — same body, same `this`, following the
// ThisType<Host> + bindHostMethods idiom already used by WebGpuFrameLoop
// and PostStack.
import { DEPTH_FORMAT, WebGPUManager } from '../webgpu-manager';
import { PipelineLayoutCache } from '../pipeline-layout-cache';
import { PerformanceProfiler } from '../performance-profiler';
import { DebugPanel } from '../debug-panel';
import { MultiDeviceCamera } from '../multi-device-camera';
import { SEG_LAYOUT_UNIFORM_BYTES } from '../seg-layout';
import { telemetryHub } from '../telemetry-hub';
import { initHardwarePanel } from '../hardware-panel';
import { initSEGAnnotations } from '../seg-annotations';
import { gpuChores } from '../gpu-chores';
import { showWebGPUHardFail, type WebGPUProbeResult } from '../renderers/webgpu-probe';
import type { MultiDeviceVisualizer } from '../multi-device-visualizer.js';
import { postTargetBytes } from './post-targets.js';
import { UniformRing } from './uniform-ring.js';
import { PipelineTiers } from './pipeline-tiers.js';
import { ShadowMap, SHADOW_MAP_SIZE } from './shadow-map.js';
import { FrameBindings } from './frame-bindings.js';
import { StaticBundles } from './render-bundles.js';

type Host = MultiDeviceVisualizer;

export interface VisualizerInitMethods {
  init(): Promise<void>;
  /**
   * The GPU-resource half of boot: pipelines, geometry, devices, IBL, post
   * stack, … Anything here dies with the device and must run again after
   * `WebGPUManager.reinit()` — split out from `init()` so device-lost
   * recovery (see `recoverFromDeviceLoss`) can call it a second time without
   * re-running the one-time DOM/session wiring (input listeners, hardware
   * panel, annotations) that lives in `init()` itself.
   */
  _bootGpuState(): Promise<void>;
  /**
   * `onDeviceLost` handler (ADR-0007: one live device — the lost one is dead;
   * `WebGPUManager.reinit()` re-requests the adapter, which the first
   * `requestDevice` consumed). Re-runs
   * {@link _bootGpuState} on the freshly re-created device. `LabSession` and
   * the module-level plant singletons it reads (`segOperator`, `segWasm`) are
   * never touched here, so the sim keeps running through the outage instead
   * of resetting to 0 RPM. Falls back to the reload overlay if the adapter
   * itself is gone or rebuild throws.
   */
  recoverFromDeviceLoss(info: { reason?: string; message?: string }): Promise<void>;
}

export const initMethods: ThisType<Host> & VisualizerInitMethods = {
  async init() {
    try {
      await this.webgpu.init();
      this.depthFormat = this.webgpu.depthFormat || DEPTH_FORMAT;
      if (this.webgpu.adapterInfo?.fallback || this.webgpu.adapterInfo?.software) {
        this.ssrEnabled = false;
        console.log('[MultiDeviceVisualizer] SSR disabled (fallback/software adapter)');
      }
      this.webgpu.resize();

      await this._bootGpuState();

      // Pointer/wheel listeners on the canvas — one-time only. _bootGpuState()
      // re-runs on device-lost recovery and must not double-register these.
      // Double-tap focus reads cameraController through a getter: device-lost
      // recovery rebuilds it, and these listeners outlive that.
      this.camera.setupInteraction(this.canvas, (mode: string) => this.switchMode(mode), () => this.cameraController);

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
        plant: { ...this.session.plantStats },
        energyBus: { ...this.session.energyNetwork.busStatus(), wasmPlantError: this.session.wasmPlantError },
        segPartModes: (this.devices.seg as { segPartModes?: () => Record<string, number> } | undefined)?.segPartModes?.() ?? {},
        textureCompression: this.webgpu.textureCompressionUsed !== 'none'
          ? this.webgpu.textureCompressionUsed
          : this.webgpu.textureCompression,
        colorPipeline: this.webgpu.colorTargets
          ? {
              mode: this.webgpu.colorTargets.mode,
              canvasFormat: this.webgpu.colorTargets.canvasFormat,
              outputFormat: this.webgpu.colorTargets.outputFormat,
              sceneFormat: this.webgpu.colorTargets.sceneFormat,
              bloomFormat: this.webgpu.colorTargets.bloomFormat,
              hdrOutput: this.webgpu.colorTargets.hdrOutput,
              bloomLevels: this.bloomChain?.levels ?? 0
            }
          : undefined,
        gpuMemory: (() => {
          const estimate = this.profiler?.gpuMemoryEstimate();
          return estimate ? { ...estimate, postTargetBytes: postTargetBytes(estimate.textures) } : undefined;
        })(),
        frameGraph: this._frameGraph
          ? {
              passes: this._frameGraph.passNames(),
              ran: this._frameGraphReport?.ran ?? [],
              allocated: this._frameGraph.allocatedLifetimes(),
              timed: (this._frameGraphReport?.timedPasses ?? []).map((t) => t.name)
            }
          : undefined,
        pipelineTiers: this.pipelineTiers
          ? { states: this.pipelineTiers.snapshot(), compileMs: { ...this.pipelineTiers.compileMs } }
          : undefined,
        renderBundles: this.staticBundles
          ? { names: this.staticBundles.names(), records: this.staticBundles.records, replays: this.staticBundles.replays }
          : undefined,
        uniformRing: this.uniformRing
          ? { slotsUsed: this.uniformRing.slotsUsed, slotsTotal: this.uniformRing.capacity, writes: this.uniformRing.writes }
          : undefined,
        shadow: this.shadowMap
          ? { active: !!this._shadowActive, allocated: this.shadowMap.isAllocated(), size: SHADOW_MAP_SIZE }
          : undefined
      });

      window.runSEGSpeedTest = (speeds?: number[], durationMs?: number) => this.runSpeedTest(speeds, durationMs);
      // Debug / e2e: destroy the device as a flagged test loss → recoverFromDeviceLoss.
      window.simulateDeviceLost = () => this.webgpu.simulateDeviceLost();

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
  },

  async recoverFromDeviceLoss(info) {
    console.error('[MultiDeviceVisualizer] GPU device lost — re-requesting adapter + device', info);
    this._deviceRecovering = true;

    const reinitOk = await this.webgpu.reinit();
    if (!reinitOk) {
      console.error('[MultiDeviceVisualizer] Device re-init failed (adapter likely gone) — reload required');
      WebGPUManager.showDeviceLostUI(info);
      return;
    }

    try {
      this.depthFormat = this.webgpu.depthFormat || DEPTH_FORMAT;
      this.webgpu.resize();

      // Force-rebuild the handful of setup steps that memoise "already built"
      // state across calls — everything else in _bootGpuState() creates fresh
      // GPU objects unconditionally and just overwrites the dead references.
      this.iblResources = null;
      this.iblCompute = undefined;
      // _syncCanvasSize skips the depth/bloom rebuild when the size is unchanged
      // and a depth texture exists, and the lazy post targets (post-targets.ts)
      // only allocate when absent — both would keep the dead device's textures,
      // and every post bind group built from them fails validation (no frame
      // ever draws after recovery). The frame graph is rebuilt too, so its
      // release clocks start fresh.
      this.depthTexture = null;
      this._lastCanvasWidth = 0;
      this._lastCanvasHeight = 0;
      this._destroyAllPostTargets();
      // The bloom mip chain holds its own device handle and is only recreated
      // on a format change — reusing it would build bind groups for the dead
      // device every frame.
      this.bloomChain?.destroy();
      this.bloomChain = null;
      // Pipelines of the lost device: the new PipelineTiers recompiles them on
      // first use; until then the gates read these as absent.
      this.depthResolvePipeline = null;
      this.ssrPipeline = null;
      this.taaPipeline = null;
      this.skyPipelineMsaa4 = this.gridPipelineMsaa4 = this.anomalyWallPipelineMsaa4 = null;
      this.energyPipePipelineMsaa4 = undefined;
      this._frameGraph = null;
      this._frameGraphReport = null;
      // Post params + sampler: _syncCanvasSize rebuilds the bloom/SSR/TAA bind
      // groups *before* setup{Bloom,Ssr,Taa}Pipeline recreate these, so live
      // dead-device handles meant one burst of "associated with [Device]"
      // validation errors per recovery. Null → the rebuilders' guards skip
      // until the setup calls create fresh ones and rebuild again.
      this.bloomSampler = null;
      this.bloomParamsBuffer = null;
      this.ssrParamsBuffer = null;
      this.taaParamsBuffer = null;
      this.fdtdSlice?.destroy();
      this.fdtdSlice = undefined;
      this._fdtdSliceInit = null;
      this.overviewCull?.destroy();
      this.overviewCull = null;

      await this._bootGpuState();

      gpuChores.adopt({
        sessionApi: 'webgpu',
        device: this.device,
        pipelineCache: this.pipelineCache
      });

      this._deviceRecovering = false;
      console.log('[MultiDeviceVisualizer] GPU session re-initialized after device loss — plant/telemetry state preserved');
    } catch (e) {
      console.error('[MultiDeviceVisualizer] GPU state rebuild failed after device re-init — reload required', e);
      WebGPUManager.showDeviceLostUI(info);
    }
  },

  async _bootGpuState() {
      // Explicit bind-group / pipeline layouts + shared device pipelines (once)
      this.pipelineCache = new PipelineLayoutCache(this.device, {
        colorTargets: this.webgpu.colorTargets!,
        depthFormat: this.depthFormat
      });
      // Per-draw DeviceUniforms slots — every device bind group built from
      // here on points at this one buffer (visualizer/uniform-ring.ts).
      this.uniformRing?.destroy();
      this.uniformRing = new UniformRing(this.device, { label: 'frame-uniform-ring' });
      // Every 1× pipeline in one Promise.all; MSAA / SSR / TAA / shadow
      // variants compile the first frame their gate opens (pipeline-tiers.ts).
      this.pipelineTiers = new PipelineTiers(this);
      await this.pipelineTiers.boot();
      this.shadowMap?.destroy();
      this.shadowMap = new ShadowMap(this);
      this.frameBindings = new FrameBindings(this);
      this.staticBundles = new StaticBundles(this);
      console.log(
        `[MultiDeviceVisualizer] Pipeline cache: ${this.pipelineCache.stats.pipelineCreates} creates ` +
        `(shared across all devices)`
      );

      // Profiler reuses the single adapter from WebGPUManager (no second requestAdapter)
      this.profiler = new PerformanceProfiler(this.device, this.canvas, {
        adapter: this.webgpu.adapter,
        adapterInfo: this.webgpu.adapterInfo,
        textureCompression: this.webgpu.textureCompression
      });
      await this.profiler.init();

      // Initialize debug panel
      this.debugPanel = new DebugPanel(this.profiler);

      // Initialize multi-device camera controller (for view transitions and matrix math)
      // Note: MultiDeviceCamera focuses on view transitions and matrix operations only.
      // Input handling is delegated to CameraController.setupInteraction() below.
      this.cameraController = new MultiDeviceCamera(this.canvas, this.camera.camera, this);

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
  }
};
