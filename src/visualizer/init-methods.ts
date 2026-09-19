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
import { DEPTH_FORMAT } from '../webgpu-manager';
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
import { SEGIntegrationManager, PHYSICS_UNIFORM_BYTES } from '../integration';
import type { MultiDeviceVisualizer } from '../multi-device-visualizer.js';

type Host = MultiDeviceVisualizer;

export interface VisualizerInitMethods {
  init(): Promise<void>;
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
};
