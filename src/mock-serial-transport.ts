/**
 * In-memory mock board for demos/CI (no navigator.serial). Accepts P/C/CONF
 * lines, answers `V…` with a v3 hello (and timestamps every sample after a
 * `V3`), and streams S at 125 Hz.
 *
 * Since #257 the mock is a *ground-truth rig* (src/twin/rig-model.ts): the
 * catalog's lumped DC-machine with θ × (1 ± `?mockParamError=`), process noise
 * at the catalog q and sensor noise at the catalog σ, driven by the board drive
 * the host commands (`rigDriveVolts`). The estimator and the calibration then
 * have a right answer — `truth` — to find.
 *
 * Its clock is its own: each tick advances 8 ms of rig time and the `t=` µs
 * counter by 8000 whatever the host timer did, like a real board's `micros()`.
 *
 * Implements {@link HardwareTransport} so the bridge treats it like any other
 * link (ADR-0005 WS3). It cannot emulate GATT or USB descriptors — it emulates
 * the *protocol*, which is the layer the twin actually depends on.
 */
import { MODE_RUN, HOST_PROTOCOL_VERSION, clampRpm } from './hardware-protocol-shared';
import type { HardwareTransport, HardwareTransportKind } from './hardware-transport';
import { labConfig } from './config/lab-config';
import { RigTruth, rigDriveVolts, type RigTruthOptions } from './twin/rig-model';

/** Board sample period (s) — 125 Hz, the rate the sketch streams at. */
export const MOCK_SAMPLE_S = 0.008;
/** At most this many queued samples per timer callback (≈ 0.25 s of board time). */
const MOCK_MAX_CATCHUP = 32;

export class MockSerialTransport implements HardwareTransport {
  readonly kind: HardwareTransportKind = 'mock';
  readonly label = 'Mock stream';

  /** The rig the mock is (truth θ, state) — tests and the panel compare against it. */
  readonly truth: RigTruth;
  /** `mockParamError` it was built with. */
  readonly paramError: number;

  private _listeners: Set<(line: string) => void>;
  private _phase: number;
  private _targetRpm: number;
  private _controlMode: number;
  private _coilMask: number;
  private _manual: boolean;
  private _timer: ReturnType<typeof setInterval> | null;
  /** Samples since open: the board clock (`micros()` / `millis()` both wrap at 2³²). */
  private _ticks: number;
  /** The host asked for v3 (`V3`+): prefix samples with `t=`. */
  private _v3: boolean;
  /** Wall time (performance.now) at which tick 0 was due, while the timer runs. */
  private _clockStartMs: number;

  constructor(opts: RigTruthOptions = {}) {
    this.paramError = opts.paramError ?? labConfig().mockParamError;
    this.truth = new RigTruth({ ...opts, paramError: this.paramError });
    this._listeners = new Set();
    this._phase = 0;
    this._targetRpm = 0;
    this._controlMode = MODE_RUN;
    this._coilMask = 0;
    this._manual = false;
    this._timer = null;
    this._ticks = 0;
    this._v3 = false;
    this._clockStartMs = NaN;
  }

  start(): void {
    if (this._timer) return;
    this._clockStartMs = performance.now() - this._ticks * MOCK_SAMPLE_S * 1000;
    this._timer = setInterval(() => this._pump(), MOCK_SAMPLE_S * 1000);
  }

  /**
   * Timer callback: every sample due by wall time, the way a board keeps
   * sampling and its lines queue while the host's thread is busy (a slow
   * frame delays the 8 ms timer, and setInterval never catches up). Without
   * this the mock's board clock — and so the rig — ran slower than the
   * calibration staircase, which is timed on the wall clock. More than
   * {@link MOCK_MAX_CATCHUP} behind (a background tab, a debugger pause), the
   * backlog is dropped and the board clock lags the wall from there on.
   */
  private _pump(): void {
    const periodMs = MOCK_SAMPLE_S * 1000;
    let due = Math.floor((performance.now() - this._clockStartMs) / periodMs) - this._ticks;
    if (due > MOCK_MAX_CATCHUP) {
      this._clockStartMs += (due - MOCK_MAX_CATCHUP) * periodMs;
      due = MOCK_MAX_CATCHUP;
    }
    for (let k = 0; k < due; k++) this._tick();
  }

  stop(): void {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  async open(): Promise<void> {
    this.start();
  }

  async close(): Promise<void> {
    this.stop();
  }

  /** The mock never drops on its own; `stop()` is always deliberate. */
  onDrop(_fn: (err: Error | null) => void): () => void {
    return () => {};
  }

  onLine(fn: (line: string) => void): () => void {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  writeLine(text: string): void {
    const line = String(text).trim();
    if (line.startsWith('P')) {
      const parts = line.slice(1).split(',');
      this._phase = parseFloat(parts[0]) || 0;
      this._targetRpm = clampRpm(parseFloat(parts[1]) || 0);
      this._controlMode = parseInt(parts[2], 10) || 0;
      this._manual = false;
    } else if (line.startsWith('CONF')) {
      // Before `C`: matched the other way round, CONF read as a coil override.
      this._emit(`Iconfig_ack:${line.slice(4)}`);
    } else if (line.startsWith('C')) {
      const parts = line.slice(1).split(',');
      this._coilMask = parseInt(parts[0], 10) || 0;
      this._manual = this._coilMask !== 0;
    } else if (line.startsWith('V')) {
      // Answer like a v3 board (seg_safety.h formatHello); `V3` or newer also
      // switches the stream to `S t=<µs> …` (an older host keeps v1 lines).
      const asked = parseInt(line.slice(1), 10);
      this._v3 = asked >= 3;
      this._emit(`I v=${HOST_PROTOCOL_VERSION} fw=mock board=mock link=mock coils=8 halls=0 wd=100 brake=128/1000`);
    }
  }

  /** The drive the rig sees this tick (V). */
  get driveVolts(): number {
    return rigDriveVolts(this._targetRpm, this._controlMode, this._manual);
  }

  /** Put the rotor at `rpm` with its holding current (tests drive samples by hand). */
  pinRpm(rpm: number): void {
    this.truth.pin(clampRpm(rpm));
  }

  _tick(): void {
    const dt = MOCK_SAMPLE_S;
    this.truth.advance(this.driveVolts, dt);
    this._ticks++;
    const us = (this._ticks * Math.round(dt * 1e6)) % 2 ** 32;
    const ms = (this._ticks * Math.round(dt * 1e3)) % 2 ** 32;
    const [rpmRead, currentRead, voltageRead] = this.truth.read();
    const omega = this.truth.x[0];
    this._phase = (this._phase + omega * (180 / Math.PI) * dt) % 360;
    if (this._phase < 0) this._phase += 360;

    // Simulated magnetometer (unit vector in plane * ~50 µT)
    const rad = (this._phase * Math.PI) / 180;
    const magX = Math.cos(rad) * 48;
    const magY = Math.sin(rad) * 12;
    const magZ = Math.sin(rad * 2) * 8;
    const hallMask = 1 << (Math.floor(this._phase / 45) % 8);
    if (!this._manual) {
      // Overlap-ish coil mask from phase
      const coil = Math.floor(this._phase / 45) % 8;
      this._coilMask = (1 << coil) | (1 << ((coil + 1) % 8));
    }
    const rpm = clampRpm(rpmRead);
    const fields =
      `${this._phase.toFixed(2)},${rpm.toFixed(2)},` +
      `${magX.toFixed(2)},${magY.toFixed(2)},${magZ.toFixed(2)},` +
      `${hallMask},${this._coilMask},${ms},` +
      `${voltageRead.toFixed(4)},${currentRead.toFixed(5)}`;
    this._emit(this._v3 ? `S t=${us} ${fields}` : `S${fields}`);
  }

  private _emit(line: string): void {
    for (const fn of this._listeners) {
      try { fn(line); } catch (e) { console.warn('[MockSerial]', e); }
    }
  }
}
