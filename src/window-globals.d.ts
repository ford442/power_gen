import type { SEGOperatorState } from './seg-operator-state';
import type { TelemetryHub } from './telemetry-hub';
import type { HeronLayout, DevicePhysicsState } from './renderers/shared/device-physics';
import type { SEGTourPlayer } from './seg-explainer/seg-tour-player.js';
import type { SegLayout } from './devices/types';
import type { HardwarePanel } from './hardware-panel';
import type { HardwareBridge } from './hardware-bridge';
import type { SEGOperatorPanel } from './seg-operator-panel';
import type { MultiDeviceCamera } from './multi-device-camera';

/**
 * Minimal window-facing view of SegLayout. Kept separate (rather than reusing
 * SegLayout directly) because window.multiVisualizer may be the untyped WebGL2
 * fallback, whose segLayout field can't be verified against the full shape.
 */
export type SegLayoutSummary = Partial<Pick<SegLayout, 'name' | 'totalRollers' | 'ringCount' | 'cameraOffset'>>;

/** Shared window hooks used by telemetry export, replay, and operator UI. */
export interface MultiVisualizerWindowRef {
  speedMult?: number;
  segLayoutPreset?: string;
  heronLayoutPreset?: string;
  currentView?: string;
  segFrameLevel?: string;
  cameraController?: MultiDeviceCamera | null;
  devicesEnabled?: Record<string, boolean>;
  anomalousEffectsEnabled?: boolean;
  segLayout?: SegLayoutSummary | null;
  heronLayout?: (HeronLayout & { name?: string; description?: string }) | null;
  devices?: Record<string, {
    physicsState?: DevicePhysicsState | null;
    /** WebGL2 fallback alias for physicsState. */
    physics?: DevicePhysicsState | null;
    flowEnergyLevel?: number;
    particleCount?: number;
  }>;
  segOmega?: number;
  postExposure?: number;
  postBloomStrength?: number;
  energyPipes?: { flowLevel?: number }[];
  energyNetwork?: {
    couplingEnabled?: boolean;
    getSnapshot?: () => {
      couplingEnabled?: boolean;
      labBudgetW: number;
      totalAllocatedW: number;
      residualW: number;
    } | null;
    setCouplingEnabled?: (enabled: boolean) => void;
  } | null;
  getSEGLayoutPreset?: () => string;
  setSEGLayoutPreset?: (preset: string) => void;
  getHeronLayoutPreset?: () => string;
  setHeronLayoutPreset?: (preset: string) => void;
  setSegFrameLevel?: (level: string) => void;
  setLightingLook?: (look: string) => void;
  setParticleCount?: (count: number) => void;
  onModeChange?: (mode: string) => void;
  captureParticleSubset?: (deviceId: string, maxCount: number) => Promise<unknown>;
  captureOverviewCull?: () => Promise<unknown>;
  profiler?: {
    benchmarkSamples?: unknown[];
    endBenchmark?: () => unknown;
    getStats?: () => unknown;
  } | null;
}

/** Snapshot returned by window.getRendererInfo() (WebGL2 fallback + agent/e2e hooks). */
export interface RendererInfoSnapshot {
  renderer: string;
  fps: number;
  particleCount: number;
  view: string;
  speedMult: number;
  segOmega: number;
  corona: number;
  segLayoutPreset: string;
  prototypePreset: string;
  anomalousEffectsEnabled: boolean;
  heronLayoutPreset: string;
  devicesEnabled: Record<string, boolean>;
  wasmPhysics: boolean;
  telemetry: unknown;
  devices: Record<string, unknown>;
  debug: unknown;
  intentionalGaps: string[];
  hardwareTwin: unknown;
  chores?: {
    sessionApi: string;
    backend: string;
    killSwitch: boolean;
    adoptedDevice: boolean;
    lastOp?: string | null;
    lastCount?: number;
  };
  /** WebGPU: bc | etc2 | astc | none. WebGL2 is always none. */
  textureCompression?: string;
}

/** Canvas readback returned by window.captureCanvasFrame() (WebGL2 fallback + agent/e2e hooks). */
export interface CanvasFrameCapture {
  width: number;
  height: number;
  pixels: Uint8Array;
  format: string;
  origin: 'top-left' | 'bottom-left';
  view: string;
  renderer: string;
}

export interface CaptureCanvasFrameOptions {
  flush?: boolean;
  flipY?: boolean;
}

declare global {
  interface Window {
    segOperator: SEGOperatorState;
    segOperatorPanel?: SEGOperatorPanel;
    /** 2D schematic overlay singleton (seg-diagram-2d.js). */
    segDiagram2D?: { setVisible?: (on: boolean) => void };
    telemetryHub: TelemetryHub;
    multiVisualizer?: MultiVisualizerWindowRef;
    currentRenderer?: string | null;
    /** Boot probe result (WebGPU required path). See renderers/webgpu-probe.ts. */
    webgpuProbe?: {
      ok: boolean;
      error: string | null;
      chromeVsEdge: string;
      browser?: { brand: string; version: string };
      adapter?: unknown;
      features?: string[];
      hasNavigatorGpu?: boolean;
    };
    setSEGLayout?: (preset: string) => void;
    setHeronLayout?: (preset: string) => void;
    /** Snap camera to a specific device in the multi-device overview (index.html inline handler). */
    focusDevice?: (deviceId: string) => void;
    /** Toggle a device's visibility in the multi-device overview (index.html inline handler). */
    toggleDevice?: (deviceId: string) => void;

    /** Focus a simulation mode / device view (main.js, keyboard shortcuts, tours). */
    setMode?(mode: string): void;
    /** WebGL2-only diagnostic snapshot (agent / e2e hooks); absent on the WebGPU path. */
    getRendererInfo?(): RendererInfoSnapshot;
    /** WebGL2-only canvas readback (agent / e2e hooks); absent on the WebGPU path. */
    captureCanvasFrame?(opts?: CaptureCanvasFrameOptions): CanvasFrameCapture;

    setTransformerLeakage?: (enabled: boolean) => void;
    setHallCarrierType?: (carrier: 'semiconductor' | 'metal') => void;
    setLorentzFieldT?: (fieldT: number) => void;
    setSegFrameLevel?: (level: string) => void;
    setLightingLook?: (look: string) => void;
    setRenderer?: (name: string) => void;
    syncSEGLayoutUI?: () => void;
    syncHeronLayoutUI?: () => void;
    syncLayoutPanelsVisibility?: () => void;
    DEBUG_RENDERER?: string;
    sciUI?: { toggle: () => void; show?: () => void; hide?: () => void } | null;
    segTour?: SEGTourPlayer;
    vdgTour?: SEGTourPlayer;
    goToVdgStep?: (id: string) => void;
    lorentzTour?: SEGTourPlayer;
    startLorentzTour?: () => void;
    goToLorentzStep?: (id: string) => void;
    captureParticleSubset?: (opts?: { deviceId?: string; maxCount?: number }) => Promise<unknown>;
    captureOverviewCull?: () => Promise<unknown>;
    runSEGSpeedTest?: (speeds?: number[], durationMs?: number) => Promise<unknown>;
    exportTelemetryCsv?: () => { ok: boolean; error?: string; rows?: number };
    exportConfigJson?: () => void;
    startTelemetryRecording?: (sec?: number, hz?: number) => void;
    stopTelemetryRecording?: () => void;
    applyReplayFile?: (replay: unknown) => () => void;
    loadReplayFile?: (file: File) => Promise<unknown>;
    showReplayBar?: () => void;
    replayPlayer?: unknown;
    gpuChores?: {
      breadcrumb: () => {
        sessionApi: string;
        backend: string;
        killSwitch: boolean;
        adoptedDevice: boolean;
        lastOp: string | null;
        lastCount: number;
      };
    };
    exportBenchmarkPack?: () => unknown;
    startSEGTour?: () => void;
    startVdgTour?: () => void;
    shareLabLink?: () => Promise<unknown>;

    /** URL / window overrides shared by WebGPU + WebGL2 (url-params). */
    SEG_PROTOTYPE_PRESET?: 'lab' | 'showroom';
    SEG_SSR_ENABLED?: boolean;
    SEG_LAYOUT_PRESET?: string;

    /** WASM physics bridge singleton (seg-physics-bridge). */
    segWasm?: unknown;

    /** Force-disable the SEG housing glTF prop (assets/gltf/prop-registry.ts). */
    GLTF_HOUSING?: boolean;

    /** SEG component-label overlay singleton (seg-annotations.js). */
    segAnnotations?: { setEnabled: (on: boolean) => void };

    /** Hardware digital twin connect panel singleton (hardware-panel.ts). */
    hardwarePanel?: HardwarePanel;
    /** Exposed for console/e2e access after initHardwarePanel(). */
    HardwareBridge?: typeof HardwareBridge;
  }
}

export {};
