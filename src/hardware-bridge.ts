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
 *
 * Split across three files (issues #142/#143/#187 — "MockSerialTransport vs
 * HardwareBridge vs protocol parse"):
 *   - ./hardware-protocol-shared.ts — constants/helpers shared by all three
 *   - ./mock-serial-transport.ts    — MockSerialTransport (fake serial port)
 *   - ./hardware-bridge-protocol.ts — Read Loop + Command Writing, merged onto
 *     HardwareBridge.prototype below. This file keeps the constructor,
 *     Connection Lifecycle and class-field declarations.
 */
import { MockSerialTransport } from './mock-serial-transport';
import { protocolMethods } from './hardware-bridge-protocol';
import { TWIN_MODES, type TwinMode, MODE_RUN, MODE_COAST, clampRpm, clampPwmDuty } from './hardware-protocol-shared';

export { MockSerialTransport } from './mock-serial-transport';
export { TWIN_MODES, type TwinMode } from './hardware-protocol-shared';

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
  // Not `private`: read/written from hardware-bridge-protocol.ts's mixin methods too.
  _mock: MockSerialTransport | null;
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

  // Not `private`: read/written from hardware-bridge-protocol.ts's mixin methods too.
  _lastCommandTime: number;
  _lastUpdateCall: number;
  _commandQueue: string[];
  private _textDecoder: TextDecoderStream | null;
  _buffer: string;
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

  // Not `private`: called from hardware-bridge-protocol.ts's `_readLoop` too.
  async _safeShutdown(): Promise<void> {
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

  // Not `private`: called from hardware-bridge-protocol.ts's `_readLoop` too.
  _setStatus(newStatus: string): void {
    if (this.status === newStatus) return;
    this.status = newStatus;
    if (this.onStatusChange) this.onStatusChange(newStatus);
  }
}

// ============================================
// Read Loop + Command Writing (src/hardware-bridge-protocol.ts)
// ============================================

/** TS mixin declaration merging: gives the members added below their types. */
export interface HardwareBridge {
  _readLoop(): Promise<void>;
  _processBuffer(): void;
  _parseLine(line: string): void;
  getSensorSnapshot(): SensorSnapshot;
  _writeLine(text: string): Promise<void>;
  _writeLineImmediate(text: string): void;
  update(sim?: UpdateSimInput): void;
  _sendConfig(): Promise<void>;
  setConfig(newConfig: Partial<HardwareBridgeConfig>): void;
  setTwinMode(mode: string): void;
  setTarget(phase: number, speed: number, mode?: number): void;
  setManualCoils(coilMask: number, pwmOrDuty?: number): void;
  clearManual(): void;
  brake(): void;
  coast(): void;
}

Object.assign(HardwareBridge.prototype, protocolMethods);

export { HardwareBridge as default };
