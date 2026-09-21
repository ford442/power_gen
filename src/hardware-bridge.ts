/**
 * HardwareBridge — hardware-twin link for SEG electromagnet control.
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
 * Transports (ADR-0005 WS3): the bridge owns the protocol and every safety
 * rule; a {@link HardwareTransport} only moves framed lines. `mock` needs no
 * hardware, `serial` is the reference link, `bluetooth` covers classroom tables
 * that cannot run a cable, `usb` is a last resort for boards Web Serial cannot
 * see. Switching links always coasts the old one first.
 *
 * Split across three files (issues #142/#143/#187 — "MockSerialTransport vs
 * HardwareBridge vs protocol parse"):
 *   - ./hardware-protocol-shared.ts — constants/helpers shared by all three
 *   - ./mock-serial-transport.ts    — MockSerialTransport (fake serial port)
 *   - ./hardware-bridge-protocol.ts — Line Parsing + Command Writing, merged
 *     onto HardwareBridge.prototype below. This file keeps the constructor,
 *     Connection Lifecycle and class-field declarations.
 */
import { MockSerialTransport } from './mock-serial-transport';
import { protocolMethods } from './hardware-bridge-protocol';
import { TWIN_MODES, type TwinMode, MODE_RUN, MODE_COAST, clampRpm, clampPwmDuty } from './hardware-protocol-shared';
import {
  isBluetoothSupported,
  isSerialSupported,
  isWebUsbSupported,
  supportedTransports,
  type HardwareTransport,
  type HardwareTransportKind
} from './hardware-transport';
import { SerialLineTransport } from './serial-line-transport';
import { BluetoothUartTransport } from './bluetooth-uart-transport';
import { WebUsbCdcTransport } from './webusb-cdc-transport';

export { MockSerialTransport } from './mock-serial-transport';
export { TWIN_MODES, type TwinMode } from './hardware-protocol-shared';
export type { HardwareTransport, HardwareTransportKind } from './hardware-transport';

import type { FiringPattern } from './electromagnet-controller';

/**
 * Bridge status. `connected` means the reference Serial link, kept as-is so
 * existing panels / tests keep working; the wireless links get their own
 * states rather than hiding behind it.
 */
export type HardwareBridgeStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'mock'
  | 'bluetooth'
  | 'usb'
  | 'error';

/** What the badge and telemetry report. */
export type HardwareConnectionKind = 'disconnected' | HardwareTransportKind;

/** `status` for a live transport of this kind. */
export function statusForTransportKind(kind: HardwareTransportKind): HardwareBridgeStatus {
  switch (kind) {
    case 'mock': return 'mock';
    case 'bluetooth': return 'bluetooth';
    case 'usb': return 'usb';
    default: return 'connected';
  }
}

/** Inverse of {@link statusForTransportKind}, for the badge / telemetry. */
export function connectionKindForStatus(status: string): HardwareConnectionKind {
  switch (status) {
    case 'mock': return 'mock';
    case 'connected': return 'serial';
    case 'bluetooth': return 'bluetooth';
    case 'usb': return 'usb';
    default: return 'disconnected';
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

export interface HardwareConnectOptions {
  /** Legacy flag — same as `transport: 'mock'`. */
  mock?: boolean;
  /** Explicit link. Omitted → Serial, or mock when Serial is unavailable. */
  transport?: HardwareTransportKind;
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
  /** Live throttle — a slow link (BLE) may widen it on connect. */
  commandThrottleMs: number;
  commandTimeoutMs: number;
  watchdogMs: number;
  /** Throttle requested by the caller; restored when the link closes. */
  private readonly _configuredThrottleMs: number;

  /** The live link, or null. Owns framing + its own read loop. */
  transport: HardwareTransport | null;
  private _unsubTransport: Array<() => void>;
  status: HardwareBridgeStatus;
  lastError: string | null;

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
  private _watchdogTimer: ReturnType<typeof setInterval> | null;

  onStatusChange: ((status: string) => void) | null;
  onSensorData: ((snapshot: SensorSnapshot) => void) | null;
  onError: ((err: Error) => void) | null;
  onTwinModeChange: ((mode: TwinMode) => void) | null;

  static sanitizeRpm = clampRpm;
  static clampPwmDuty = clampPwmDuty;

  constructor(options: HardwareBridgeOptions = {}) {
    this.baudRate = options.baudRate || 115200;
    this._configuredThrottleMs = options.commandThrottleMs || 16; // ~60Hz
    this.commandThrottleMs = this._configuredThrottleMs;
    this.commandTimeoutMs = options.commandTimeoutMs || 200; // browser-side safety
    this.watchdogMs = options.watchdogMs || 100; // match firmware

    this.transport = null;
    this._unsubTransport = [];
    this.status = 'disconnected';
    this.lastError = null;

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
    this._watchdogTimer = null;

    this.onStatusChange = options.onStatusChange || null;
    this.onSensorData = options.onSensorData || null;
    this.onError = options.onError || null;
    this.onTwinModeChange = options.onTwinModeChange || null;
  }

  /** Explicit connection kind for UI: disconnected | mock | serial | bluetooth | usb */
  get connectionKind(): HardwareConnectionKind {
    return connectionKindForStatus(this.status);
  }

  /** Short label of the live link (panel badge). */
  get transportLabel(): string {
    return this.transport?.label ?? '';
  }

  static isSerialSupported = isSerialSupported;
  static isBluetoothSupported = isBluetoothSupported;
  static isWebUsbSupported = isWebUsbSupported;
  static supportedTransports = supportedTransports;

  static isTransportSupported(kind: HardwareTransportKind): boolean {
    switch (kind) {
      case 'mock': return true;
      case 'serial': return isSerialSupported();
      case 'bluetooth': return isBluetoothSupported();
      case 'usb': return isWebUsbSupported();
      default: return false;
    }
  }

  // ============================================
  // Connection Lifecycle
  // ============================================

  /**
   * Legacy entry point: opens Serial, or the mock when `?mockHardware=1` is set
   * or Web Serial is unavailable. Use {@link connectTransport} to name a link.
   */
  async connect(opts: HardwareConnectOptions = {}): Promise<void> {
    if (opts.transport) return this.connectTransport(opts.transport);

    const wantMock = opts.mock === true
      || (typeof location !== 'undefined' && new URLSearchParams(location.search).get('mockHardware') === '1');
    if (wantMock) return this.connectTransport('mock');
    if (!isSerialSupported()) {
      console.info('[HardwareBridge] Web Serial unavailable — using mock');
      return this.connectTransport('mock');
    }
    return this.connectTransport('serial');
  }

  async connectMock(): Promise<void> {
    return this.connectTransport('mock');
  }

  async connectSerial(): Promise<void> {
    return this.connectTransport('serial');
  }

  /** Wireless Nordic-UART twin — same protocol, ~20 Hz command rate. */
  async connectBluetooth(): Promise<void> {
    return this.connectTransport('bluetooth');
  }

  /** Raw CDC-ACM, only for boards the platform hides from Web Serial. */
  async connectUsb(): Promise<void> {
    return this.connectTransport('usb');
  }

  /**
   * Open a link. Already on a link of that kind → no-op. On a different one →
   * coasts and closes the old one first, so coils are never left commanded by
   * a transport switch.
   *
   * Pass a {@link HardwareTransport} instance instead of a kind to open a link
   * the page already has permission for — `navigator.serial.getPorts()` or a
   * remembered `BluetoothDevice` — which skips the chooser and therefore does
   * not need a fresh user gesture.
   */
  async connectTransport(kindOrTransport: HardwareTransportKind | HardwareTransport): Promise<void> {
    const preBuilt = typeof kindOrTransport === 'string' ? null : kindOrTransport;
    const kind: HardwareTransportKind = preBuilt ? preBuilt.kind : kindOrTransport as HardwareTransportKind;
    if (this.status === 'connecting') return;
    if (this.isConnected) {
      if (this.connectionKind === kind) return;
      await this.disconnect();
    }
    if (!preBuilt && !HardwareBridge.isTransportSupported(kind)) {
      const err = new Error(`${kind} transport unavailable in this browser`);
      this.lastError = err.message;
      this._setStatus('error');
      if (this.onError) this.onError(err);
      return;
    }

    this._setStatus('connecting');
    const transport = preBuilt ?? this._createTransport(kind);
    try {
      this._unsubTransport = [
        transport.onLine((line) => this._parseLine(line)),
        transport.onDrop((err) => this._onTransportDrop(err))
      ];
      await transport.open();
      this.transport = transport;
      // A slow link may not sustain 60 Hz; stay inside the firmware watchdog.
      this.commandThrottleMs = Math.max(
        this._configuredThrottleMs,
        transport.preferredCommandThrottleMs ?? 0
      );
      this._startWatchdog();
      await this._sendConfig();
      this._setStatus(statusForTransportKind(kind));
      console.log(`[HardwareBridge] Connected via ${transport.label}`
        + (kind === 'serial' ? ` at ${this.baudRate}` : ''));
    } catch (err) {
      for (const off of this._unsubTransport) off();
      this._unsubTransport = [];
      try { await transport.close(); } catch { /* never opened */ }
      this.transport = null;
      this.commandThrottleMs = this._configuredThrottleMs;
      this.lastError = (err as Error).message;
      this._setStatus('error');
      console.error(`[HardwareBridge] ${kind} connection failed:`, err);
      if (this.onError) this.onError(err as Error);
    }
  }

  private _createTransport(kind: HardwareTransportKind): HardwareTransport {
    switch (kind) {
      case 'mock': return new MockSerialTransport();
      case 'bluetooth': return new BluetoothUartTransport();
      case 'usb': return new WebUsbCdcTransport();
      default: return new SerialLineTransport(this.baudRate);
    }
  }

  /**
   * Safe disconnect: coast + coils off, then close the link.
   */
  async disconnect(): Promise<void> {
    await this._safeShutdown();
    this._stopWatchdog();

    for (const off of this._unsubTransport) off();
    this._unsubTransport = [];
    if (this.transport) {
      try { await this.transport.close(); } catch (_) { /* link may already be dead */ }
      this.transport = null;
    }

    this.commandThrottleMs = this._configuredThrottleMs;
    this.manualMode = false;
    this.manualCoilMask = 0;
    this.manualPwmDuty = 0;
    this.targetSpeed = 0;
    this.controlMode = MODE_COAST;
    this._setStatus('disconnected');
    console.log('[HardwareBridge] Disconnected (coils coasted)');
  }

  /**
   * Link lost without a `disconnect()` — unplug, out-of-range BLE, read error.
   * There is nothing left to write a coast down, so the **firmware** watchdog
   * (no `P` for >100 ms) is what drops the coils; the host side just stops
   * pretending to be connected.
   */
  private _onTransportDrop(err: Error | null): void {
    if (!this.isConnected && this.status !== 'connecting') return;
    this._stopWatchdog();
    for (const off of this._unsubTransport) off();
    this._unsubTransport = [];
    const dead = this.transport;
    this.transport = null;
    if (dead) {
      // Best effort: release streams / GATT handles without writing.
      void Promise.resolve(dead.close()).catch(() => { /* already gone */ });
    }
    this.commandThrottleMs = this._configuredThrottleMs;
    this.manualMode = false;
    this.manualCoilMask = 0;
    this.manualPwmDuty = 0;
    this.targetSpeed = 0;
    this.controlMode = MODE_COAST;
    this.lastError = err?.message ?? 'link closed';
    this._setStatus('error');
    console.warn('[HardwareBridge] Link dropped —', this.lastError,
      '(firmware watchdog coasts the coils)');
    if (err && this.onError) this.onError(err);
  }

  /**
   * Best-effort coast + clear coils before tearing down the link.
   * `flush()` matters on queued links (BLE): without it the GATT writes are
   * dropped with the connection instead of reaching the board.
   */
  async _safeShutdown(): Promise<void> {
    const transport = this.transport;
    if (!transport) return;
    try {
      transport.writeLine('P0,0,2');
      transport.writeLine('C0,0,0');
      await transport.flush?.();
    } catch (_) { /* ignore — link may already be dead */ }
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
    return this.status === 'connected'
      || this.status === 'mock'
      || this.status === 'bluetooth'
      || this.status === 'usb';
  }

  get isMock(): boolean {
    return this.status === 'mock';
  }

  /** True while the link is a real device (not the mock transport). */
  get isPhysical(): boolean {
    return this.isConnected && this.status !== 'mock';
  }

  get sensorAgeMs(): number {
    if (!this.lastSensorUpdate) return Infinity;
    return performance.now() - this.lastSensorUpdate;
  }

  get isSensorStale(): boolean {
    return this.sensorAgeMs > 500;
  }

  // Not `private`: called from hardware-bridge-protocol.ts's mixin methods too.
  _setStatus(newStatus: HardwareBridgeStatus): void {
    if (this.status === newStatus) return;
    this.status = newStatus;
    if (this.onStatusChange) this.onStatusChange(newStatus);
  }
}

// ============================================
// Line Parsing + Command Writing (src/hardware-bridge-protocol.ts)
// ============================================

/** TS mixin declaration merging: gives the members added below their types. */
export interface HardwareBridge {
  _parseLine(line: string): void;
  getSensorSnapshot(): SensorSnapshot;
  _writeLine(text: string): void;
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
