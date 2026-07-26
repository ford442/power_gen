import type { SEGOperatorState } from './seg-operator-state';
import type { TelemetryHub } from './telemetry-hub';

/** Shared window hooks used by telemetry export, replay, and operator UI. */
export interface MultiVisualizerWindowRef {
  speedMult?: number;
  segLayoutPreset?: string;
  heronLayoutPreset?: string;
  currentView?: string;
  getSEGLayoutPreset?: () => string;
  setSEGLayoutPreset?: (preset: string) => void;
  setHeronLayoutPreset?: (preset: string) => void;
  profiler?: {
    benchmarkSamples?: unknown[];
    endBenchmark?: () => unknown;
    getStats?: () => unknown;
  };
}

declare global {
  interface Window {
    segOperator: SEGOperatorState;
    telemetryHub: TelemetryHub;
    multiVisualizer?: MultiVisualizerWindowRef;
    currentRenderer?: string | null;
    setSEGLayout?: (preset: string) => void;
    setHeronLayout?: (preset: string) => void;
  }
}

export {};
