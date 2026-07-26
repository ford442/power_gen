import { rowFromSnapshot } from './telemetry-schema';
import type { TelemetrySnapshot } from './types';

export interface TelemetrySamplerOpts {
  sampleHz?: number;
  maxDurationSec?: number;
}

/**
 * Ring buffer of telemetry samples at a configurable rate (1–60 Hz).
 */
export class TelemetrySampler {
  sampleHz: number;
  maxDurationSec: number;
  maxSamples: number;
  private _rows: Record<string, number | string>[] = [];
  private _simTimeS = 0;
  private _accum = 0;
  private _recording = false;
  private _recordUntilS: number | null = null;
  private _loadOhm = 100;

  constructor(opts: TelemetrySamplerOpts = {}) {
    this.sampleHz = Math.min(60, Math.max(1, opts.sampleHz ?? 10));
    this.maxDurationSec = opts.maxDurationSec ?? 120;
    this.maxSamples = Math.ceil(this.maxDurationSec * this.sampleHz);
  }

  setSampleHz(hz: number): void {
    this.sampleHz = Math.min(60, Math.max(1, hz));
    this.maxSamples = Math.ceil(this.maxDurationSec * this.sampleHz);
  }

  setLoadOhm(ohm: number): void {
    this._loadOhm = ohm;
  }

  /** Auto-stop after N seconds of sim time */
  start(durationSec: number | null = null): void {
    this._rows = [];
    this._simTimeS = 0;
    this._accum = 0;
    this._recording = true;
    this._recordUntilS = durationSec != null ? durationSec : null;
  }

  stop(): void {
    this._recording = false;
    this._recordUntilS = null;
  }

  get recording(): boolean {
    return this._recording;
  }

  get simTimeS(): number {
    return this._simTimeS;
  }

  getRows(): Record<string, number | string>[] {
    return this._rows.slice();
  }

  clear(): void {
    this._rows = [];
    this._simTimeS = 0;
    this._accum = 0;
  }

  /** Call once per published frame. */
  onFrame(snap: TelemetrySnapshot, dt: number): void {
    if (!this._recording || dt <= 0) return;

    this._simTimeS += dt;
    this._accum += dt;
    const interval = 1 / this.sampleHz;

    while (this._accum >= interval && this._rows.length < this.maxSamples) {
      this._accum -= interval;
      const tSample = this._simTimeS - this._accum;
      this._rows.push(rowFromSnapshot(snap, tSample, {
        loadOhm: this._loadOhm,
        mode: snap.view === 'overview' ? 'seg' : (snap.view || 'seg')
      }));
    }

    if (this._recordUntilS != null && this._simTimeS >= this._recordUntilS) {
      this.stop();
    }
    if (this._rows.length >= this.maxSamples) {
      this.stop();
    }
  }
}
