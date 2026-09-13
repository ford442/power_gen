/**
 * Replay player — load .seg-replay.json / telemetry CSV, scrub, and inject
 * recorded frames through TelemetryHub without advancing the live plant.
 */

import { telemetryHub } from '../telemetry-hub';
import { segOperator, SEG_SPEC } from '../seg-operator-state';
import { setSimulationSeed } from './deterministic-rng';
import { interpolateSpeedCurve, REPLAY_VERSION, type ReplayFile } from './replay-format';
import {
  interpolateSample,
  parseReplayPayload,
  replayDurationS,
  replayStartS,
  sampleIndexAt
} from './replay-parse';
import type { ReplayWorkerRequest, ReplayWorkerResponse } from './replay-protocol';
import { devicePhysicsFromRow, type TelemetryCsvRow } from './telemetry-schema';
import type { SegOperatorTelemetry } from './types';

export type ReplayPlayerListener = (state: ReplayPlayerState) => void;

export interface ReplayPlayerState {
  loaded: boolean;
  playing: boolean;
  t: number;
  duration: number;
  filename: string;
  source: 'json' | 'csv' | null;
  error: string | null;
  parsing: boolean;
}

function blankState(): ReplayPlayerState {
  return {
    loaded: false,
    playing: false,
    t: 0,
    duration: 0,
    filename: '',
    source: null,
    error: null,
    parsing: false
  };
}

function num(v: unknown, fallback = 0): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function segTelemetryFromRow(row: TelemetryCsvRow): SegOperatorTelemetry {
  const omega = num(row.seg_omega);
  const rpm = Math.round(num(row.rpm_inner));
  return {
    status: String(row.status || 'standby'),
    segOmega: omega,
    corona: num(row.corona),
    rpmInner: rpm,
    rpmDisplay: rpm,
    rpmPct: Math.min(100, omega * 100),
    voltage: num(row.voltage_v),
    current: num(row.current_a),
    power: num(row.power_w),
    fieldSim: num(row.field_sim_t),
    fieldClaimedRef: SEG_SPEC.B_SURFACE_T * (num(row.excitation_pct) / 100),
    temperature: num(row.temperature_c, 25),
    efficiency: num(row.efficiency_pct),
    totalEnergy: 0,
    drive: num(row.drive),
    excitationPct: Math.round(num(row.excitation_pct))
  };
}

function applyReplayHeader(replay: ReplayFile): void {
  if (replay.seed != null) setSimulationSeed(replay.seed);
  const v = window.multiVisualizer;
  if (replay.segLayoutPreset && typeof v?.setSEGLayoutPreset === 'function') {
    v.setSEGLayoutPreset(replay.segLayoutPreset);
  } else if (replay.segLayoutPreset && typeof window.setSEGLayout === 'function') {
    window.setSEGLayout(replay.segLayoutPreset);
  }
  if (replay.heronLayoutPreset && typeof v?.setHeronLayoutPreset === 'function') {
    v.setHeronLayoutPreset(replay.heronLayoutPreset);
  } else if (replay.heronLayoutPreset && typeof window.setHeronLayout === 'function') {
    window.setHeronLayout(replay.heronLayoutPreset);
  }
  if (replay.config) {
    segOperator.loadResistance = replay.config.loadOhm;
    segOperator.magneticFieldStrength = replay.config.magneticFieldStrength;
  }
}

export class ReplayPlayer {
  private _replay: ReplayFile | null = null;
  private _state: ReplayPlayerState = blankState();
  private _listeners = new Set<ReplayPlayerListener>();
  private _raf = 0;
  private _lastWall = 0;
  private _tAbs = 0;
  private _t0 = 0;
  private _worker: Worker | null = null;
  private _reqId = 0;
  private _pending = new Map<number, {
    resolve: (r: ReplayFile) => void;
    reject: (e: Error) => void;
  }>();

  get state(): ReplayPlayerState {
    return this._state;
  }

  get replay(): ReplayFile | null {
    return this._replay;
  }

  subscribe(fn: ReplayPlayerListener): () => void {
    this._listeners.add(fn);
    fn(this._state);
    return () => this._listeners.delete(fn);
  }

  private _emit(): void {
    for (const fn of this._listeners) {
      try { fn(this._state); } catch (e) { console.warn('[ReplayPlayer]', e); }
    }
  }

  private _ensureWorker(): Worker | null {
    if (this._worker) return this._worker;
    if (typeof Worker === 'undefined') return null;
    try {
      this._worker = new Worker(
        new URL('../workers/replay-worker.ts', import.meta.url),
        { type: 'module' }
      );
      this._worker.onmessage = (e: MessageEvent<ReplayWorkerResponse>) => {
        const msg = e.data;
        const pending = this._pending.get(msg.id);
        if (!pending) return;
        this._pending.delete(msg.id);
        if (msg.type === 'ok') pending.resolve(msg.replay);
        else pending.reject(new Error(msg.error || 'Parse failed'));
      };
      this._worker.onerror = (err) => {
        console.warn('[ReplayPlayer] worker error', err);
      };
      return this._worker;
    } catch (err) {
      console.warn('[ReplayPlayer] Worker unavailable, parsing on main thread', err);
      return null;
    }
  }

  parseText(text: string, filename = 'replay.json'): Promise<ReplayFile> {
    const worker = this._ensureWorker();
    if (!worker) {
      return Promise.resolve(parseReplayPayload(text, filename).replay);
    }
    const id = ++this._reqId;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      const req: ReplayWorkerRequest = { type: 'parse', id, text, filename };
      worker.postMessage(req);
    });
  }

  async loadText(text: string, filename = 'replay.json'): Promise<ReplayFile> {
    this._state = { ...this._state, parsing: true, error: null };
    this._emit();
    try {
      const replay = await this.parseText(text, filename);
      this.attach(replay, filename, /\.csv$/i.test(filename) ? 'csv' : 'json');
      return replay;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this._state = { ...this._state, parsing: false, error: message };
      this._emit();
      throw err;
    }
  }

  async loadFile(file: File): Promise<ReplayFile> {
    const text = await file.text();
    return this.loadText(text, file.name);
  }

  attach(replay: ReplayFile, filename = 'replay.json', source: 'json' | 'csv' = 'json'): void {
    if (replay.replayVersion !== REPLAY_VERSION) {
      throw new Error(`Unsupported replay version: ${replay.replayVersion}`);
    }
    this.stopPlayback();
    this._replay = replay;
    this._t0 = replayStartS(replay);
    this._tAbs = this._t0;
    const duration = replayDurationS(replay);
    applyReplayHeader(replay);
    segOperator.enterReplayMode();
    telemetryHub.setReplayMode(true);
    this._state = {
      loaded: true,
      playing: false,
      t: 0,
      duration,
      filename,
      source,
      error: null,
      parsing: false
    };
    this.seek(0);
    this._emit();
  }

  play(): void {
    if (!this._replay || this._state.playing) return;
    if (this._state.duration > 0 && this._state.t >= this._state.duration - 1e-4) {
      this._tAbs = this._t0;
      this._state = { ...this._state, t: 0 };
    }
    this._state = { ...this._state, playing: true };
    this._lastWall = performance.now();
    this._raf = requestAnimationFrame(this._tick);
    this._emit();
  }

  pause(): void {
    if (!this._state.playing) return;
    this._state = { ...this._state, playing: false };
    cancelAnimationFrame(this._raf);
    this._raf = 0;
    this._emit();
  }

  toggle(): void {
    if (this._state.playing) this.pause();
    else this.play();
  }

  step(): void {
    if (!this._replay) return;
    this.pause();
    const samples = this._replay.samples as TelemetryCsvRow[];
    if (!samples?.length) {
      this.seek(Math.min(this._state.duration, this._state.t + 1 / 60));
      return;
    }
    const idx = sampleIndexAt(samples, this._tAbs);
    const next = Math.min(samples.length - 1, idx + 1);
    const t = num(samples[next].time_s);
    this._tAbs = t;
    this._state = { ...this._state, t: t - this._t0 };
    this._applyAt(this._tAbs);
    this._emit();
  }

  seek(tRel: number): void {
    if (!this._replay) return;
    const t = Math.max(0, Math.min(this._state.duration, tRel));
    this._tAbs = this._t0 + t;
    this._state = { ...this._state, t };
    this._applyAt(this._tAbs);
    this._emit();
  }

  /** Leave replay mode and restore live plant / telemetry. */
  exit(): void {
    this.stopPlayback();
    this._replay = null;
    segOperator.exitReplayMode();
    telemetryHub.setReplayMode(false);
    this._state = blankState();
    this._emit();
  }

  private stopPlayback(): void {
    this._state = { ...this._state, playing: false };
    cancelAnimationFrame(this._raf);
    this._raf = 0;
  }

  private _tick = (): void => {
    if (!this._state.playing || !this._replay) return;
    const now = performance.now();
    const dt = Math.min(0.1, Math.max(0, (now - this._lastWall) / 1000));
    this._lastWall = now;
    const next = Math.min(this._state.duration, this._state.t + dt);
    this._tAbs = this._t0 + next;
    this._state = { ...this._state, t: next };
    this._applyAt(this._tAbs);
    this._emit();
    if (next >= this._state.duration - 1e-4) {
      this.pause();
      return;
    }
    this._raf = requestAnimationFrame(this._tick);
  };

  private _applyAt(tAbs: number): void {
    const replay = this._replay;
    if (!replay) return;
    const samples = replay.samples as TelemetryCsvRow[];
    const row = samples?.length ? interpolateSample(samples, tAbs) : null;
    const curve = interpolateSpeedCurve(replay.speedCurve, tAbs);

    if (row) {
      segOperator.applyReplaySample(row);
    } else {
      segOperator.targetDrive = curve.drive;
    }

    const v = window.multiVisualizer;
    if (v) {
      const omega = row ? num(row.seg_omega) : segOperator.physics.segOmega;
      const corona = row ? num(row.corona) : segOperator.physics.corona;
      (v as { segOmega?: number; corona?: number }).segOmega = omega;
      (v as { segOmega?: number; corona?: number }).corona = corona;
      const segDev = v.devices?.seg;
      if (segDev?.physicsState) {
        segDev.physicsState.segOmega = omega;
        segDev.physicsState.corona = corona;
        segDev.physicsState.energyLevel = omega;
      }
    }

    const segTelemetry = row
      ? segTelemetryFromRow(row)
      : segOperator.computeTelemetry(0);
    const residual = row ? Number(row.energy_residual_w) : NaN;
    // Per-device catalog columns round-trip too — replay is not SEG-RPM-only.
    const devicePhysics = row ? devicePhysicsFromRow(row) : undefined;
    telemetryHub.publishFrame({
      source: 'replay',
      dt: 0,
      simTimeS: tAbs,
      view: row ? String(row.view || 'seg') : (v?.currentView || 'seg'),
      renderer: window.currentRenderer ?? undefined,
      segTelemetry,
      devicePhysics,
      scientific: row
        ? {
            particleFlux: num(row.particle_flux),
            avgEnergyDensity: num(row.energy_density_j_m3)
          }
        : undefined,
      energyNetwork: row && Number.isFinite(residual)
        ? {
            couplingEnabled: num(row.energy_coupled) > 0,
            labBudgetW: 0,
            totalAllocatedW: 0,
            residualW: residual
          }
        : undefined,
      replayMeta: {
        t: tAbs - this._t0,
        duration: this._state.duration,
        filename: this._state.filename
      }
    });
  }
}

export const replayPlayer = new ReplayPlayer();

if (typeof window !== 'undefined') {
  (window as Window & { replayPlayer?: ReplayPlayer }).replayPlayer = replayPlayer;
}
