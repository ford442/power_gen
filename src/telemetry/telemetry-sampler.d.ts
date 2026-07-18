import type { TelemetrySnapshot } from './types.ts';

export interface TelemetrySamplerOpts {
  sampleHz?: number;
  maxDurationSec?: number;
}

export class TelemetrySampler {
  sampleHz: number;
  maxDurationSec: number;
  maxSamples: number;
  recording: boolean;
  simTimeS: number;
  constructor(opts?: TelemetrySamplerOpts);
  setSampleHz(hz: number): void;
  setLoadOhm(ohm: number): void;
  start(durationSec?: number | null): void;
  stop(): void;
  getRows(): Record<string, number | string>[];
  clear(): void;
  onFrame(snap: TelemetrySnapshot, dt: number): void;
}
