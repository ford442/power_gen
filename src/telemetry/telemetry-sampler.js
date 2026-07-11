import { rowFromSnapshot } from './telemetry-schema.js';

/**
 * Ring buffer of telemetry samples at a configurable rate (1–60 Hz).
 */
export class TelemetrySampler {
  /**
   * @param {{ sampleHz?: number, maxDurationSec?: number }} [opts]
   */
  constructor(opts = {}) {
    this.sampleHz = Math.min(60, Math.max(1, opts.sampleHz ?? 10));
    this.maxDurationSec = opts.maxDurationSec ?? 120;
    this.maxSamples = Math.ceil(this.maxDurationSec * this.sampleHz);
    /** @type {Record<string, number|string>[]} */
    this._rows = [];
    this._simTimeS = 0;
    this._accum = 0;
    this._recording = false;
    this._recordUntilS = null;
    this._loadOhm = 100;
  }

  setSampleHz(hz) {
    this.sampleHz = Math.min(60, Math.max(1, hz));
    this.maxSamples = Math.ceil(this.maxDurationSec * this.sampleHz);
  }

  setLoadOhm(ohm) {
    this._loadOhm = ohm;
  }

  /** @param {number} [durationSec]  Auto-stop after N seconds of sim time */
  start(durationSec = null) {
    this._rows = [];
    this._simTimeS = 0;
    this._accum = 0;
    this._recording = true;
    this._recordUntilS = durationSec != null ? durationSec : null;
  }

  stop() {
    this._recording = false;
    this._recordUntilS = null;
  }

  get recording() {
    return this._recording;
  }

  get simTimeS() {
    return this._simTimeS;
  }

  getRows() {
    return this._rows.slice();
  }

  clear() {
    this._rows = [];
    this._simTimeS = 0;
    this._accum = 0;
  }

  /**
   * Call once per published frame.
   * @param {object} snap  TelemetryHub snapshot
   * @param {number} dt  Frame delta (seconds)
   */
  onFrame(snap, dt) {
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
