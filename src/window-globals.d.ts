import type { SEGOperatorState } from './seg-operator-state';
import type { TelemetryHub } from './telemetry-hub';
import type { HeronLayout, DevicePhysicsState } from './renderers/shared/device-physics';
import type { SEGTourPlayer } from './seg-explainer/seg-tour-player.js';
import type { SegLayout } from './devices/types';

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
  anomalousEffectsEnabled?: boolean;
  segLayout?: SegLayoutSummary | null;
  heronLayout?: (HeronLayout & { name?: string; description?: string }) | null;
  devices?: Record<string, { physicsState?: DevicePhysicsState | null }>;
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
    telemetryHub: TelemetryHub;
    multiVisualizer?: MultiVisualizerWindowRef;
    currentRenderer?: string | null;
    setSEGLayout?: (preset: string) => void;
    setHeronLayout?: (preset: string) => void;

    /** Focus a simulation mode / device view (main.js, keyboard shortcuts, tours). */
    setMode?(mode: string): void;
    /** WebGL2-only diagnostic snapshot (agent / e2e hooks); absent on the WebGPU path. */
    getRendererInfo?(): RendererInfoSnapshot;
    /** WebGL2-only canvas readback (agent / e2e hooks); absent on the WebGPU path. */
    captureCanvasFrame?(opts?: CaptureCanvasFrameOptions): CanvasFrameCapture;

    setTransformerLeakage?: (enabled: boolean) => void;
    setSegFrameLevel?: (level: string) => void;
    setLightingLook?: (look: string) => void;
    setRenderer?: (name: string) => void;
    syncSEGLayoutUI?: () => void;
    syncHeronLayoutUI?: () => void;
    syncLayoutPanelsVisibility?: () => void;
    DEBUG_RENDERER?: string;
    sciUI?: { toggle: () => void } | null;
    segTour?: SEGTourPlayer;
    captureParticleSubset?: (opts?: { deviceId?: string; maxCount?: number }) => Promise<unknown>;
    captureOverviewCull?: () => Promise<unknown>;
    runSEGSpeedTest?: (speeds?: number[], durationMs?: number) => Promise<unknown>;
    exportTelemetryCsv?: () => { ok: boolean; error?: string; rows?: number };
    exportConfigJson?: () => void;
    startTelemetryRecording?: (sec?: number, hz?: number) => void;
    stopTelemetryRecording?: () => void;
    applyReplayFile?: (replay: unknown) => () => void;
    exportBenchmarkPack?: () => unknown;
    startSEGTour?: () => void;
    shareLabLink?: () => Promise<unknown>;
  }
}

export {};
