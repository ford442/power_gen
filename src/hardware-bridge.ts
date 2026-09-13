/**
 * HardwareBridge — Web Serial (or mock) connection for SEG electromagnet control.
 *
 * Protocol: docs/hardware_connection.md / firmware/seg-driver/protocol.h
 *   App → Arduino: P phase, C coils, CONF geometry
 *   Arduino → App: S sensor stream
 *
 * Twin modes:
 *   open   — sim → hardware (visualize sim)
 *   closed — hardware RPM/phase → visualizer rollers
 *   shadow — sim → hardware; compare HW telemetry vs sim
 */

import type { FiringPattern } from './electromagnet-controller';

/** Minimal Web Serial API surface — no `@types/w3c-web-serial` dependency. */
interface SerialPortFilter {
  usbVendorId?: number;
  usbProductId?: number;
}
interface SerialPort {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
}
interface Serial {
  requestPort(options?: { filters?: SerialPortFilter[] }): Promise<SerialPort>;
}
declare global {
  interface Navigator {
    serial?: Serial;
  }
}

/** Twin / digital-twin operating modes */
export const TWIN_MODES = {
  OPEN: 'open',
  CLOSED: 'closed',
  SHADOW: 'shadow'
} as const;

export type TwinMode = (typeof TWIN_MODES)[keyof typeof TWIN_MODES];

const MODE_RUN = 0;
const MODE_BRAKE = 1;
const MODE_COAST = 2;

/** Protocol RPM limits (docs/hardware_connection.md). */
const RPM_MIN = -999.9;
const RPM_MAX = 999.9;

function finiteNum(n: unknown, fallback = 0): number {
  const x = Number(n);
  return Number.isFinite(x) ? x : fallback;
}

function clampRpm(rpm: unknown): number {
  return Math.max(RPM_MIN, Math.min(RPM_MAX, finiteNum(rpm, 0)));
}

function clampPwmDuty(duty: unknown): number {
  return Math.max(0, Math.min(1, finiteNum(duty, 0)));
}

function pwmDutyToWire(duty: number): number {
  return Math.round(clampPwmDuty(duty) * 255);
}

/**
 * In-memory mock Arduino for demos/CI (no navigator.serial).
 * Accepts P/C/CONF lines; streams S at ~120 Hz.
 */
export class MockSerialTransport {
  private _listeners: Set<(line: string) => void>;
  private _phase: number;
  private _rpm: number;
  private _targetRpm: number;
  private _targetVoltage: number;
  private _targetCurrent: number;
  private _voltage: number;
  private _current: number;
  private _controlMode: number;
  private _coilMask: number;
  private _manual: boolean;
  private _timer: ReturnType<typeof setInterval> | null;
  private _t0: number;

  constructor() {
    this._listeners = new Set();
    this._phase = 0;
    this._rpm = 0;
    this._targetRpm = 0;
    this._targetVoltage = 0;
    this._targetCurrent = 0;
    this._voltage = 0;
    this._current = 0;
    this._controlMode = MODE_RUN;
    this._coilMask = 0;
    this._manual = false;
    this._timer = null;
    this._t0 = performance.now();
  }

  start(): void {
    if (this._timer) return;
    this._timer = setInterval(() => this._tick(), 8); // ~125 Hz
  }

  stop(): void {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
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
    } else if (line.startsWith('C')) {
      const parts = line.slice(1).split(',');
      this._coilMask = parseInt(parts[0], 10) || 0;
      this._manual = this._coilMask !== 0;
      if (this._coilMask === 0) this._manual = false;
    } else if (line.startsWith('CONF')) {
      this._emit(`Iconfig_ack:${line.slice(4)}`);
    }
  }

  private _tick(): void {
    const dt = 0.008;
    if (this._controlMode === MODE_COAST) {
      this._rpm *= 0.98;
    } else if (this._controlMode === MODE_BRAKE) {
      this._rpm *= 0.85;
    } else {
      // First-order lag toward target RPM
      this._rpm += (this._targetRpm - this._rpm) * Math.min(1, dt * 4);
    }
    this._phase = (this._phase + this._rpm * 6 * dt) % 360;
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
    // Lagging electrical proxies for shadow V/I charts (mock only — not metrology)
    this._voltage += (this._targetVoltage - this._voltage) * Math.min(1, dt * 3);
    this._current += (this._targetCurrent - this._current) * Math.min(1, dt * 3);

    const ts = Math.floor(performance.now() - this._t0);
    this._emit(
      `S${this._phase.toFixed(2)},${this._rpm.toFixed(1)},` +
      `${magX.toFixed(2)},${magY.toFixed(2)},${magZ.toFixed(2)},` +
      `${hallMask},${this._coilMask},${ts},` +
      `${this._voltage.toFixed(2)},${this._current.toFixed(2)}`
    );
  }

  setElectricalTargets(voltage: number, current: number): void {
    this._targetVoltage = finiteNum(voltage, 0);
    this._targetCurrent = finiteNum(current, 0);
  }

  private _emit(line: string): void {
    for (const fn of this._listeners) {
      try { fn(line); } catch (e) { console.warn('[MockSerial]', e); }
    }
  }
}

export interface HardwareBridgeOptions {
  baudRate?: number;
  commandThrottleMs?: number;
  commandTimeoutMs?: number;
  watchdogMs?: number;
  onStatusChange?: ((status: string) => void) | null;
  onSensorData?: ((snapshot: SensorSnapshot) => void) | null;
  onError?: ((err: Error) => void) | null;
  onTwinModeChange?: ((mode: TwinMode) => void) | null;
}

export interface HardwareBridgeConfig {
  numCoils: number;
  offsetAngle: number;
  dwellAngle: number;
  advanceAngle: number;
  firingPattern: FiringPattern;
}

export interface ShadowComparison {
  simPhase: number;
  simRpm: number;
  simVoltage: number;
  simCurrent: number;
  phaseErrorDeg: number;
  rpmError: number;
  voltageError: number;
  currentError: number;
}

export interface SensorSnapshot {
  phase: number;
  rpm: number;
  magnetometer: { x: number; y: number; z: number };
  hallMask: number;
  coilMask: number;
  timestamp: number;
  twinMode: TwinMode;
  shadow: ShadowComparison;
  magMagnitudeUt: number;
}

export interface UpdateSimInput {
  simPhase?: number;
  simRpm?: number;
  simVoltage?: number;
  simCurrent?: number;
}

export class HardwareBridge {
  baudRate: number;
  commandThrottleMs: number;
  commandTimeoutMs: number;
  watchdogMs: number;

  port: SerialPort | null;
  reader: ReadableStreamDefaultReader<string> | null;
  writer: WritableStreamDefaultWriter<Uint8Array> | null;
  readLoopPromise: Promise<void> | null;
  /** disconnected | connecting | connected | error | mock */
  status: string;
  lastError: string | null;
  useMock: boolean;
  private _mock: MockSerialTransport | null;
  private _unsubMock: (() => void) | null;

  // Incoming parsed state from Arduino
  actualPhase: number;
  actualRpm: number;
  actualVoltage: number;
  actualCurrent: number;
  magnetometer: { x: number; y: number; z: number };
  hallMask: number;
  coilMask: number;
  lastTimestampMs: number;
  lastSensorUpdate: number;

  // Outgoing state
  targetPhase: number;
  targetSpeed: number;
  controlMode: number;
  /** true → visualizer follows HW (closed-loop) */
  mirrorEnabled: boolean;

  twinMode: TwinMode;

  shadow: ShadowComparison;

  // Manual override — duty 0..1 internally; wire protocol uses 0..255
  manualCoilMask: number;
  manualPwmDuty: number;
  manualMode: boolean;

  config: HardwareBridgeConfig;

  private _lastCommandTime: number;
  private _lastUpdateCall: number;
  private _commandQueue: string[];
  private _textDecoder: TextDecoderStream | null;
  private _buffer: string;
  private _watchdogTimer: ReturnType<typeof setInterval> | null;

  onStatusChange: ((status: string) => void) | null;
  onSensorData: ((snapshot: SensorSnapshot) => void) | null;
  onError: ((err: Error) => void) | null;
  onTwinModeChange: ((mode: TwinMode) => void) | null;

  static sanitizeRpm = clampRpm;
  static clampPwmDuty = clampPwmDuty;

  constructor(options: HardwareBridgeOptions = {}) {
    this.baudRate = options.baudRate || 115200;
    this.commandThrottleMs = options.commandThrottleMs || 16; // ~60Hz
    this.commandTimeoutMs = options.commandTimeoutMs || 200; // browser-side safety
    this.watchdogMs = options.watchdogMs || 100; // match firmware

    this.port = null;
    this.reader = null;
    this.writer = null;
    this.readLoopPromise = null;
    this.status = 'disconnected';
    this.lastError = null;
    this.useMock = false;
    this._mock = null;
    this._unsubMock = null;

    this.actualPhase = 0;
    this.actualRpm = 0;
    this.actualVoltage = 0;
    this.actualCurrent = 0;
    this.magnetometer = { x: 0, y: 0, z: 0 };
    this.hallMask = 0;
    this.coilMask = 0;
    this.lastTimestampMs = 0;
    this.lastSensorUpdate = 0;

    this.targetPhase = 0;
    this.targetSpeed = 0;
    this.controlMode = MODE_RUN;
    this.mirrorEnabled = false;

    this.twinMode = TWIN_MODES.OPEN;

    this.shadow = {
      simPhase: 0,
      simRpm: 0,
      simVoltage: 0,
      simCurrent: 0,
      phaseErrorDeg: 0,
      rpmError: 0,
      voltageError: 0,
      currentError: 0
    };

    this.manualCoilMask = 0;
    this.manualPwmDuty = 1;
    this.manualMode = false;

    this.config = {
      numCoils: 8,
      offsetAngle: 0,
      dwellAngle: 67.5,
      advanceAngle: 0,
      firingPattern: 'overlap'
    };

    this._lastCommandTime = 0;
    this._lastUpdateCall = 0;
    this._commandQueue = [];
    this._textDecoder = null;
    this._buffer = '';
    this._watchdogTimer = null;

    this.onStatusChange = options.onStatusChange || null;
    this.onSensorData = options.onSensorData || null;
    this.onError = options.onError || null;
    this.onTwinModeChange = options.onTwinModeChange || null;
  }

  /** Explicit connection kind for UI: disconnected | mock | serial */
  get connectionKind(): 'mock' | 'serial' | 'disconnected' {
    if (this.status === 'mock') return 'mock';
    if (this.status === 'connected') return 'serial';
    return 'disconnected';
  }

  static isSerialSupported(): boolean {
    return typeof navigator !== 'undefined' && !!navigator.serial;
  }

  // ============================================
  // Connection Lifecycle
  // ============================================

  async connect(opts: { mock?: boolean } = {}): Promise<void> {
    if (this.status === 'connecting') return;
    if (this.status === 'mock') {
      // Switching serial ← mock: coast mock coils before opening a real port.
      await this.disconnect();
    }
    if (this.status === 'connected') return;

    const wantMock = opts.mock === true
      || (typeof location !== 'undefined' && new URLSearchParams(location.search).get('mockHardware') === '1');

    if (wantMock || !HardwareBridge.isSerialSupported()) {
      await this._connectMock(wantMock ? undefined : 'Web Serial unavailable — using mock');
      return;
    }

    this._setStatus('connecting');
    try {
      if (!navigator.serial) throw new Error('Web Serial unavailable');
      this.port = await navigator.serial.requestPort({
        filters: [
          { usbVendorId: 0x2341 },
          { usbVendorId: 0x2A03 },
          { usbVendorId: 0x1A86 },
          { usbVendorId: 0x10C4 },
          { usbVendorId: 0x0403 },
          { usbVendorId: 0x303A }
        ]
      });

      await this.port.open({ baudRate: this.baudRate });
      this.writer = this.port.writable.getWriter();
      this._textDecoder = new TextDecoderStream();
      this.port.readable.pipeTo(this._textDecoder.writable as WritableStream<Uint8Array>).catch(() => {});
      this.reader = this._textDecoder.readable.getReader();
      this._buffer = '';
      this.useMock = false;
      this.readLoopPromise = this._readLoop();
      await this._sendConfig();
      this._startWatchdog();
      this._setStatus('connected');
      console.log('[HardwareBridge] Connected at', this.baudRate);
    } catch (err) {
      this.lastError = (err as Error).message;
      this._setStatus('error');
      console.error('[HardwareBridge] Connection failed:', err);
      if (this.onError) this.onError(err as Error);
    }
  }

  async connectMock(): Promise<void> {
    if (this.status === 'mock') return;
    if (this.isConnected) {
      // Switching mock ← serial: coast real coils before starting mock transport.
      await this.disconnect();
    }
    return this._connectMock();
  }

  private async _connectMock(infoMsg?: string): Promise<void> {
    this._setStatus('connecting');
    this.useMock = true;
    this._mock = new MockSerialTransport();
    this._unsubMock = this._mock.onLine((line) => this._parseLine(line));
    this._mock.start();
    this._startWatchdog();
    await this._sendConfig();
    this._setStatus('mock');
    if (infoMsg) console.info('[HardwareBridge]', infoMsg);
    console.log('[HardwareBridge] Mock serial transport active');
  }

  /**
   * Safe disconnect: coast + coils off, then close port.
   */
  async disconnect(): Promise<void> {
    await this._safeShutdown();
    this._stopWatchdog();

    if (this._unsubMock) {
      this._unsubMock();
      this._unsubMock = null;
    }
    if (this._mock) {
      this._mock.stop();
      this._mock = null;
    }
    this.useMock = false;

    if (this.reader) {
      try { await this.reader.cancel(); } catch (_) { /* */ }
      this.reader = null;
    }
    if (this.writer) {
      try { this.writer.releaseLock(); } catch (_) { /* */ }
      this.writer = null;
    }
    if (this.port) {
      try { await this.port.close(); } catch (_) { /* */ }
      this.port = null;
    }

    this.readLoopPromise = null;
    this._buffer = '';
    this.manualMode = false;
    this.manualCoilMask = 0;
    this.manualPwmDuty = 0;
    this.targetSpeed = 0;
    this.controlMode = MODE_COAST;
    this._setStatus('disconnected');
    console.log('[HardwareBridge] Disconnected (coils coasted)');
  }

  private async _safeShutdown(): Promise<void> {
    // Best-effort coast + clear coils before tearing down streams
    try {
      if (this.useMock && this._mock) {
        this._mock.writeLine('P0,0,2');
        this._mock.writeLine('C0,0,0');
      } else if (this.writer) {
        const enc = new TextEncoder();
        await this.writer.write(enc.encode('P0,0,2\n'));
        await this.writer.write(enc.encode('C0,0,0\n'));
      }
    } catch (_) { /* ignore — port may already be dead */ }
  }

  private _startWatchdog(): void {
    this._stopWatchdog();
    this._lastUpdateCall = performance.now();
    this._watchdogTimer = setInterval(() => {
      if (!this.isConnected) return;
      const age = performance.now() - this._lastUpdateCall;
      if (age > this.commandTimeoutMs) {
        // Host stopped pumping update() — force coast
        this.controlMode = MODE_COAST;
        this.targetSpeed = 0;
        this._writeLineImmediate('P0,0,2');
        this._writeLineImmediate('C0,0,0');
        console.warn('[HardwareBridge] Command timeout — coasting coils');
      }
    }, 50);
  }

  private _stopWatchdog(): void {
    if (this._watchdogTimer) {
      clearInterval(this._watchdogTimer);
      this._watchdogTimer = null;
    }
  }

  // ============================================
  // Read Loop
  // ============================================

  private async _readLoop(): Promise<void> {
    while ((this.status === 'connected') && this.reader) {
      try {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (value) {
          this._buffer += value;
          this._processBuffer();
        }
      } catch (err) {
        if (this.status === 'connected') {
          this.lastError = (err as Error).message;
          this._setStatus('error');
          if (this.onError) this.onError(err as Error);
          await this._safeShutdown();
        }
        break;
      }
    }
  }

  private _processBuffer(): void {
    let newlineIndex: number;
    while ((newlineIndex = this._buffer.indexOf('\n')) !== -1) {
      const line = this._buffer.slice(0, newlineIndex).trim();
      this._buffer = this._buffer.slice(newlineIndex + 1);
      if (line.length > 0) this._parseLine(line);
    }
  }

  private _parseLine(line: string): void {
    // S{phase},{rpm},{magX},{magY},{magZ},{hallMask},{coilMask},{timestampMs}
    if (line.startsWith('S')) {
      const parts = line.slice(1).split(',');
      if (parts.length >= 8) {
        this.actualPhase = finiteNum(parseFloat(parts[0]), 0);
        this.actualRpm = clampRpm(parseFloat(parts[1]));
        this.magnetometer.x = finiteNum(parseFloat(parts[2]), 0);
        this.magnetometer.y = finiteNum(parseFloat(parts[3]), 0);
        this.magnetometer.z = finiteNum(parseFloat(parts[4]), 0);
        this.hallMask = parseInt(parts[5], 10) || 0;
        this.coilMask = parseInt(parts[6], 10) || 0;
        this.lastTimestampMs = parseInt(parts[7], 10) || 0;
        if (parts.length >= 10) {
          this.actualVoltage = finiteNum(parseFloat(parts[8]), 0);
          this.actualCurrent = finiteNum(parseFloat(parts[9]), 0);
        }
        this.lastSensorUpdate = performance.now();

        // Shadow error vs last sim setpoints
        let dPhase = this.actualPhase - this.shadow.simPhase;
        while (dPhase > 180) dPhase -= 360;
        while (dPhase < -180) dPhase += 360;
        this.shadow.phaseErrorDeg = dPhase;
        this.shadow.rpmError = this.actualRpm - this.shadow.simRpm;
        this.shadow.voltageError = this.actualVoltage - this.shadow.simVoltage;
        this.shadow.currentError = this.actualCurrent - this.shadow.simCurrent;

        if (this.onSensorData) {
          this.onSensorData(this.getSensorSnapshot());
        }
      }
    } else if (line.startsWith('E')) {
      console.error('[Arduino Error]', line.slice(1));
    } else if (line.startsWith('I')) {
      console.log('[Arduino]', line.slice(1));
    }
  }

  getSensorSnapshot(): SensorSnapshot {
    return {
      phase: this.actualPhase,
      rpm: this.actualRpm,
      magnetometer: { ...this.magnetometer },
      hallMask: this.hallMask,
      coilMask: this.coilMask,
      timestamp: this.lastTimestampMs,
      twinMode: this.twinMode,
      shadow: { ...this.shadow },
      magMagnitudeUt: Math.hypot(
        this.magnetometer.x,
        this.magnetometer.y,
        this.magnetometer.z
      )
    };
  }

  // ============================================
  // Command Writing
  // ============================================

  private async _writeLine(text: string): Promise<void> {
    if (this.useMock && this._mock) {
      this._mock.writeLine(text);
      return;
    }
    if (!this.writer || this.status !== 'connected') return;
    const encoder = new TextEncoder();
    try {
      await this.writer.write(encoder.encode(text + '\n'));
    } catch (err) {
      console.error('[HardwareBridge] Write failed:', err);
    }
  }

  private _writeLineImmediate(text: string): void {
    // Fire-and-forget for safety paths
    this._writeLine(text);
  }

  /**
   * Called from render loop ~60 Hz.
   */
  update(sim: UpdateSimInput = {}): void {
    if (!this.isConnected) return;
    this._lastUpdateCall = performance.now();

    if (typeof sim.simPhase === 'number' && Number.isFinite(sim.simPhase)) {
      this.shadow.simPhase = sim.simPhase;
    }
    if (typeof sim.simRpm === 'number' && Number.isFinite(sim.simRpm)) {
      this.shadow.simRpm = sim.simRpm;
    }
    if (typeof sim.simVoltage === 'number' && Number.isFinite(sim.simVoltage)) {
      this.shadow.simVoltage = sim.simVoltage;
    }
    if (typeof sim.simCurrent === 'number' && Number.isFinite(sim.simCurrent)) {
      this.shadow.simCurrent = sim.simCurrent;
    }

    if (this.useMock && this._mock) {
      this._mock.setElectricalTargets(this.shadow.simVoltage, this.shadow.simCurrent);
    }

    // Apply twin-mode side effects for setTarget authority
    if (this.twinMode === TWIN_MODES.CLOSED) {
      this.mirrorEnabled = true;
    } else if (this.twinMode === TWIN_MODES.OPEN) {
      this.mirrorEnabled = false;
    } else {
      // shadow: visualize sim, still compare
      this.mirrorEnabled = false;
    }

    const now = performance.now();
    if (now - this._lastCommandTime < this.commandThrottleMs) return;
    this._lastCommandTime = now;

    if (this.manualMode) {
      const wirePwm = pwmDutyToWire(this.manualPwmDuty);
      this._writeLine(`C${this.manualCoilMask},${wirePwm},0`);
    } else {
      const phase = ((this.targetPhase % 360) + 360) % 360;
      const speed = clampRpm(this.targetSpeed);
      // Protocol: P{phase},{speed},{mode}
      this._writeLine(
        `P${phase.toFixed(2)},${speed.toFixed(1)},${this.controlMode}`
      );
    }

    while (this._commandQueue.length > 0) {
      const cmd = this._commandQueue.shift();
      if (cmd) this._writeLine(cmd);
    }
  }

  private async _sendConfig(): Promise<void> {
    const { numCoils, offsetAngle, dwellAngle, advanceAngle } = this.config;
    this._commandQueue.push(
      `CONF${numCoils},${offsetAngle.toFixed(1)},${dwellAngle.toFixed(1)},${advanceAngle.toFixed(1)}`
    );
  }

  setConfig(newConfig: Partial<HardwareBridgeConfig>): void {
    Object.assign(this.config, newConfig);
    if (this.isConnected) this._sendConfig();
  }

  setTwinMode(mode: string): void {
    if (!Object.values(TWIN_MODES).includes(mode as TwinMode)) return;
    this.twinMode = mode as TwinMode;
    this.mirrorEnabled = mode === TWIN_MODES.CLOSED;
    if (this.onTwinModeChange) this.onTwinModeChange(this.twinMode);
  }

  setTarget(phase: number, speed: number, mode: number = MODE_RUN): void {
    this.targetPhase = finiteNum(phase, 0);
    this.targetSpeed = clampRpm(speed);
    this.controlMode = mode;
    this.manualMode = false;
  }

  /**
   * Manual coil override. pwmOrDuty: 0..1 duty, or legacy 0..255 wire value.
   */
  setManualCoils(coilMask: number, pwmOrDuty: number = 1): void {
    this.manualCoilMask = coilMask >>> 0;
    const duty = pwmOrDuty > 1 ? pwmOrDuty / 255 : pwmOrDuty;
    this.manualPwmDuty = clampPwmDuty(duty);
    this.manualMode = this.manualCoilMask !== 0 && this.manualPwmDuty > 0;
  }

  clearManual(): void {
    this.manualMode = false;
    this.manualCoilMask = 0;
    this.manualPwmDuty = 0;
    // Release override on device
    this._writeLineImmediate('C0,0,0');
  }

  brake(): void {
    this.controlMode = MODE_BRAKE;
    this.targetSpeed = 0;
    this.manualMode = false;
    this.manualPwmDuty = 0;
  }

  coast(): void {
    this.controlMode = MODE_COAST;
    this.targetSpeed = 0;
    this.manualMode = false;
    this.manualPwmDuty = 0;
  }

  get isConnected(): boolean {
    return this.status === 'connected' || this.status === 'mock';
  }

  get isMock(): boolean {
    return this.status === 'mock';
  }

  get sensorAgeMs(): number {
    if (!this.lastSensorUpdate) return Infinity;
    return performance.now() - this.lastSensorUpdate;
  }

  get isSensorStale(): boolean {
    return this.sensorAgeMs > 500;
  }

  private _setStatus(newStatus: string): void {
    if (this.status === newStatus) return;
    this.status = newStatus;
    if (this.onStatusChange) this.onStatusChange(newStatus);
  }
}

export { HardwareBridge as default };
