/**
 * The session's hardware twin (#257, ADR-0019): estimator, calibration profile
 * and the calibration run, between the bridge and LabSession.
 *
 * - **Estimate.** Every bridge sample goes to the {@link TwinEstimatorHost}
 *   (the C++ EKF in sim_core) with the board-clock gap and the drive the host
 *   last sent. Without sim_core the twin says so (`needs-wasm`) and closed loop
 *   keeps the raw sample, as before #257.
 * - **Closed loop** writes the *filtered* ω into the SEG plant, before the
 *   step (the plant worker integrates from it) and after it (the display).
 * - **Calibrate.** If the kept run does not excite the rig, a 30 s RPM
 *   staircase is commanded *through the bridge* (its clamps, throttle and
 *   watchdog apply; any operator button, a disconnect or a manual coil override
 *   aborts it), then the run is fitted in the offline worker (twin/calibrate.ts)
 *   and the profile goes to the estimator and the `twinProfile` share field.
 *
 * The estimator only reads. Coil commands still come from LabSession's
 * `hw.setTarget` and the bridge's safety paths.
 */
import type { HardwareBridge } from '../hardware-bridge';
import { RPM_MAX, clampRpm } from '../hardware-protocol-shared';
import { labConfig, setLabUrlParam } from '../config/lab-config';
import { segOperator } from '../seg-operator-state';
import { getSimCore, loadSimCore } from '../wasm/index';
import { TwinEstimatorHost } from './estimator-host';
import { decodeTwinProfile, encodeTwinProfile, type TwinProfile } from './profile';
import { rigDriveVolts, rigNominal } from './rig-model';
import { TWIN_RUN_STRIDE, profileFromFit, type TwinSysIdProgress, type TwinSysIdResult } from './sysid-run';

export type TwinState = 'off' | 'loading' | 'ready' | 'needs-wasm' | 'error';
export type CalibrationPhase = 'idle' | 'exciting' | 'fitting' | 'done' | 'failed';

/** Calibration drive: 12 levels × 2.5 s = 30 s (fractions of {@link EXCITATION_MAX_RPM}). */
export const EXCITATION_LEVELS = [0.33, 0.78, 0.5, 1, 0.22, 0.67, 0, 0.89, 0.39, 0.72, 0.56, 0] as const;
export const EXCITATION_STEP_S = 2.5;
export const EXCITATION_MAX_RPM = 900;
/** A kept run is fitted as is when it is this long and its drive varies this much (V). */
const MIN_RUN_S = 20;
const MIN_DRIVE_SD_V = 1;

export interface CalibrationStatus {
  phase: CalibrationPhase;
  message: string;
  /** Excitation progress 0–1, then fit iterations. */
  progress: number;
  costHistory: number[];
  result: TwinSysIdResult | null;
}

/** A saved twin (plant snapshot `twin` block, docs/SNAPSHOTS.md). */
export interface TwinSnapshotBlock {
  version: 1;
  /** `TwinEstimator` snapshot doubles: [layout v, N, NP, M, t, x, P, θ, q, σ, hMax]. */
  values: number[];
  /** The profile in use, if any. */
  profile: string | null;
  /** Board-clock time of the last sample (s); absent or null when unknown. */
  t?: number | null;
}

export class SessionTwin {
  host: TwinEstimatorHost | null = null;
  state: TwinState = 'off';
  message = '';
  profile: TwinProfile | null = null;
  profileText: string | null = null;
  profileError: string | null = null;
  calibration: CalibrationStatus = { phase: 'idle', message: '', progress: 0, costHistory: [], result: null };
  private hostInit: Promise<TwinEstimatorHost | null> | null = null;
  private readonly listeners = new Set<() => void>();
  private excitation: { startMs: number; epoch: number; resolve: (ok: boolean) => void } | null = null;
  private qScale = 1;
  private rScale = 1;

  constructor(private readonly bridge: HardwareBridge) {
    bridge.on('status', () => this.onStatus());
    bridge.on('sensor', () => this.onSensor());
    const boot = labConfig().twinProfile;
    if (boot) this.applyProfile(boot);
  }

  /** Called on every estimator / calibration change (the panel redraws). */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void {
    for (const fn of this.listeners) {
      try { fn(); } catch (e) { console.warn('[twin] listener threw', e); }
    }
  }

  private onStatus(): void {
    if (this.bridge.isConnected) {
      void this.ensureHost();
    } else {
      this.host?.restart();
      this.abortExcitation('link closed');
      if (this.state === 'ready') this.state = 'off';
      this.changed();
    }
  }

  /** The estimator host (created on first connect; null without sim_core). */
  async ensureHost(): Promise<TwinEstimatorHost | null> {
    if (this.host) {
      this.state = 'ready';
      return this.host;
    }
    this.hostInit ??= (async () => {
      this.state = 'loading';
      const mod = getSimCore() ?? (await loadSimCore());
      if (!mod) {
        this.state = 'needs-wasm';
        this.message = 'estimator needs sim_core.wasm — closed loop uses the raw sample';
        return null;
      }
      try {
        const host = new TwinEstimatorHost(mod);
        host.setNoiseScale(this.qScale, this.rScale);
        if (this.profile) host.setTheta(this.profile.theta);
        this.host = host;
        this.state = 'ready';
        this.message = '';
        return host;
      } catch (err) {
        this.state = 'error';
        this.message = err instanceof Error ? err.message : String(err);
        console.warn('[twin] estimator unavailable:', err);
        return null;
      }
    })().finally(() => {
      this.hostInit = null;
      this.changed();
    });
    return this.hostInit;
  }

  private onSensor(): void {
    const host = this.host;
    const hw = this.bridge;
    if (!host || !hw.isConnected) return;
    const d = hw.driveSent;
    host.onSample({
      t: hw.sampleClock.t,
      epoch: hw.sampleClock.epoch,
      v: rigDriveVolts(d.rpm, d.mode, d.manual),
      z: [hw.actualRpm, hw.hasElectrical ? hw.actualCurrent : null, hw.hasElectrical ? hw.actualVoltage : null]
    });
  }

  /** Q / R multipliers on the catalog figures (panel sliders). */
  setNoiseScale(qScale: number, rScale: number): void {
    this.qScale = qScale;
    this.rScale = rScale;
    this.host?.setNoiseScale(qScale, rScale);
    this.changed();
  }

  get noiseScale(): { q: number; r: number } {
    return { q: this.host?.qScale ?? this.qScale, r: this.host?.rScale ?? this.rScale };
  }

  /**
   * Use a `tp1;…` profile (null: back to the catalog nominal). Live LabConfig
   * field: boot `?twinProfile=`, a `#lab2=` link, a `.lab.json`. A profile
   * for another rig is refused and the current θ kept.
   */
  applyProfile(text: string | null, opts: { persist?: boolean } = {}): boolean {
    if (text === null) {
      this.profile = null;
      this.profileText = null;
      this.profileError = null;
      this.host?.setTheta(rigNominal());
    } else {
      const { profile, error } = decodeTwinProfile(text);
      if (!profile) {
        this.profileError = error;
        this.changed();
        return false;
      }
      this.profile = profile;
      this.profileText = text;
      this.profileError = null;
      this.host?.setTheta(profile.theta);
    }
    if (opts.persist) setLabUrlParam('twinProfile', this.profileText);
    this.changed();
    return true;
  }

  /** Filtered rotor RPM for closed loop (null: no estimate — use the raw sample). */
  closedLoopRpm(): number | null {
    const w = this.host?.omega();
    return w ? clampRpm((w.value * 30) / Math.PI) : null;
  }

  // ── calibration ─────────────────────────────────────────────

  /** RPM the calibration run commands now, or null when none runs. */
  excitationRpm(nowMs: number): number | null {
    const ex = this.excitation;
    if (!ex) return null;
    const hw = this.bridge;
    if (!hw.isConnected) return this.abortExcitation('link closed'), null;
    if (segOperator.epoch !== ex.epoch) return this.abortExcitation('operator button pressed'), null;
    if (hw.manualMode) return this.abortExcitation('manual coil override'), null;
    const t = (nowMs - ex.startMs) / 1000;
    const k = Math.floor(t / EXCITATION_STEP_S);
    this.calibration.progress = Math.min(1, t / (EXCITATION_LEVELS.length * EXCITATION_STEP_S));
    if (k >= EXCITATION_LEVELS.length) {
      this.excitation = null;
      ex.resolve(true);
      return 0;
    }
    return Math.min(EXCITATION_MAX_RPM, RPM_MAX) * EXCITATION_LEVELS[k];
  }

  private abortExcitation(why: string): void {
    const ex = this.excitation;
    if (!ex) return;
    this.excitation = null;
    this.calibration = { ...this.calibration, phase: 'failed', message: `calibration run aborted: ${why}` };
    ex.resolve(false);
    this.changed();
  }

  /** Does the kept run excite the rig enough to fit as is? */
  private runIsExciting(): boolean {
    const run = this.host?.run;
    if (!run || run.durationS < MIN_RUN_S) return false;
    const rows = run.rows();
    let s = 0, s2 = 0;
    const n = rows.length / TWIN_RUN_STRIDE;
    for (let k = 0; k < n; k++) {
      const v = rows[k * TWIN_RUN_STRIDE + 1];
      s += v;
      s2 += v * v;
    }
    return Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2)) >= MIN_DRIVE_SD_V;
  }

  /**
   * One click: (excite if needed →) fit → apply. Resolves with the result,
   * or null when it could not run (the status says why).
   */
  async calibrate(opts: { confirm?: (text: string) => boolean } = {}): Promise<TwinSysIdResult | null> {
    const hw = this.bridge;
    const fail = (message: string): null => {
      this.calibration = { ...this.calibration, phase: 'failed', message };
      this.changed();
      return null;
    };
    if (this.calibration.phase === 'exciting' || this.calibration.phase === 'fitting') return null;
    if (!hw.isConnected) return fail('connect the rig (or the mock) first');
    const host = await this.ensureHost();
    if (!host) return fail(this.message || 'estimator unavailable');
    let samples: Float64Array;
    if (this.runIsExciting()) {
      samples = host.run.rows();
    } else {
      if (segOperator.status === 'estop') return fail('clear the E-stop first');
      const text = `Calibration drives the rotor through a ${EXCITATION_LEVELS.length * EXCITATION_STEP_S} s RPM staircase `
        + `up to ${EXCITATION_MAX_RPM} RPM through the bridge (watchdog and coast-on-disconnect stay on). Continue?`;
      if (hw.isPhysical && !(opts.confirm ?? ((t) => window.confirm(t)))(text)) return fail('calibration cancelled');
      this.calibration = { phase: 'exciting', message: 'driving the calibration staircase…', progress: 0, costHistory: [], result: null };
      this.changed();
      const startT = hw.sampleClock.t;
      const ok = await new Promise<boolean>((resolve) => {
        this.excitation = { startMs: performance.now(), epoch: segOperator.epoch, resolve };
      });
      if (!ok) return null;
      // Only the staircase (the run restarts on a gap, so it may hold less).
      samples = host.run.rowsSince(Number.isFinite(startT) ? startT : -Infinity);
    }
    this.calibration = { phase: 'fitting', message: 'fitting (offline worker)…', progress: 0, costHistory: [], result: null };
    this.changed();
    try {
      const { calibrateRun } = await import('./calibrate');
      const result = await calibrateRun({ samples, theta0: host.theta.slice() }, (p: TwinSysIdProgress) => {
        this.calibration.costHistory.push(p.cost);
        this.calibration.progress = p.iteration;
        this.changed();
      });
      if (result.status === 'failed') return fail(`fit failed: ${result.error ?? 'unknown'}`);
      this.applyProfile(encodeTwinProfile(profileFromFit(result)), { persist: true });
      this.calibration = {
        phase: 'done',
        message: `calibrated from ${result.durationS.toFixed(1)} s (${result.samples} samples, ${result.iterations} iterations)`,
        progress: result.iterations,
        costHistory: result.costHistory,
        result
      };
      this.changed();
      return result;
    } catch (err) {
      return fail(`fit failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── snapshots ───────────────────────────────────────────────

  saveSnapshot(): TwinSnapshotBlock | null {
    if (!this.host) return null;
    const t = this.host.lastSampleT;
    return { version: 1, values: this.host.save(), profile: this.profileText, t: Number.isFinite(t) ? t : null };
  }

  /** Restore a saved twin; false when there is no estimator or the layout differs. */
  restoreSnapshot(block: TwinSnapshotBlock): boolean {
    if (block.profile !== undefined && block.profile !== this.profileText) this.applyProfile(block.profile);
    const ok = !!this.host && this.host.load(block.values, block.t ?? NaN);
    this.changed();
    return ok;
  }
}
