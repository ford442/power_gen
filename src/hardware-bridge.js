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

/** Twin / digital-twin operating modes */
export const TWIN_MODES = {
  OPEN: 'open',
  CLOSED: 'closed',
  SHADOW: 'shadow'
};

const MODE_RUN = 0;
const MODE_BRAKE = 1;
const MODE_COAST = 2;

/**
 * In-memory mock Arduino for demos/CI (no navigator.serial).
 * Accepts P/C/CONF lines; streams S at ~120 Hz.
 */
export class MockSerialTransport {
  constructor() {
    this._listeners = new Set();
    this._phase = 0;
    this._rpm = 0;
    this._targetRpm = 0;
    this._controlMode = MODE_RUN;
    this._coilMask = 0;
    this._manual = false;
    this._timer = null;
    this._t0 = performance.now();
  }

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => this._tick(), 8); // ~125 Hz
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  onLine(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  writeLine(text) {
    const line = String(text).trim();
    if (line.startsWith('P')) {
      const parts = line.slice(1).split(',');
      this._phase = parseFloat(parts[0]) || 0;
      this._targetRpm = parseFloat(parts[1]) || 0;
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

  _tick() {
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
    const ts = Math.floor(performance.now() - this._t0);
    this._emit(
      `S${this._phase.toFixed(2)},${this._rpm.toFixed(1)},` +
      `${magX.toFixed(2)},${magY.toFixed(2)},${magZ.toFixed(2)},` +
      `${hallMask},${this._coilMask},${ts}`
    );
  }

  _emit(line) {
    for (const fn of this._listeners) {
      try { fn(line); } catch (e) { console.warn('[MockSerial]', e); }
    }
  }
}

export class HardwareBridge {
  constructor(options = {}) {
    this.baudRate = options.baudRate || 115200;
    this.commandThrottleMs = options.commandThrottleMs || 16; // ~60Hz
    this.commandTimeoutMs = options.commandTimeoutMs || 200; // browser-side safety
    this.watchdogMs = options.watchdogMs || 100; // match firmware

    this.port = null;
    this.reader = null;
    this.writer = null;
    this.readLoopPromise = null;
    this.status = 'disconnected'; // disconnected | connecting | connected | error | mock
    this.lastError = null;
    this.useMock = false;
    this._mock = null;
    this._unsubMock = null;

    // Incoming parsed state from Arduino
    this.actualPhase = 0;
    this.actualRpm = 0;
    this.magnetometer = { x: 0, y: 0, z: 0 };
    this.hallMask = 0;
    this.coilMask = 0;
    this.lastTimestampMs = 0;
    this.lastSensorUpdate = 0;

    // Outgoing state
    this.targetPhase = 0;
    this.targetSpeed = 0;
    this.controlMode = MODE_RUN;
    this.mirrorEnabled = false; // true → visualizer follows HW (closed-loop)

    /** @type {'open'|'closed'|'shadow'} */
    this.twinMode = TWIN_MODES.OPEN;

    // Shadow comparison
    this.shadow = {
      simPhase: 0,
      simRpm: 0,
      phaseErrorDeg: 0,
      rpmError: 0
    };

    // Manual override
    this.manualCoilMask = 0;
    this.manualPwm = 255;
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

  static isSerialSupported() {
    return typeof navigator !== 'undefined' && !!navigator.serial;
  }

  // ============================================
  // Connection Lifecycle
  // ============================================

  /**
   * @param {{ mock?: boolean }} [opts]
   */
  async connect(opts = {}) {
    if (this.status === 'connected' || this.status === 'connecting' || this.status === 'mock') {
      return;
    }

    const wantMock = opts.mock === true
      || (typeof location !== 'undefined' && new URLSearchParams(location.search).get('mockHardware') === '1');

    if (wantMock || !HardwareBridge.isSerialSupported()) {
      await this._connectMock(wantMock ? null : 'Web Serial unavailable — using mock');
      return;
    }

    this._setStatus('connecting');
    try {
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
      this.port.readable.pipeTo(this._textDecoder.writable).catch(() => {});
      this.reader = this._textDecoder.readable.getReader();
      this._buffer = '';
      this.useMock = false;
      this.readLoopPromise = this._readLoop();
      await this._sendConfig();
      this._startWatchdog();
      this._setStatus('connected');
      console.log('[HardwareBridge] Connected at', this.baudRate);
    } catch (err) {
      this.lastError = err.message;
      this._setStatus('error');
      console.error('[HardwareBridge] Connection failed:', err);
      if (this.onError) this.onError(err);
    }
  }

  async connectMock() {
    return this._connectMock();
  }

  async _connectMock(infoMsg = null) {
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
  async disconnect() {
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
    this._setStatus('disconnected');
    console.log('[HardwareBridge] Disconnected (coils coasted)');
  }

  async _safeShutdown() {
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

  _startWatchdog() {
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

  _stopWatchdog() {
    if (this._watchdogTimer) {
      clearInterval(this._watchdogTimer);
      this._watchdogTimer = null;
    }
  }

  // ============================================
  // Read Loop
  // ============================================

  async _readLoop() {
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
          this.lastError = err.message;
          this._setStatus('error');
          if (this.onError) this.onError(err);
          await this._safeShutdown();
        }
        break;
      }
    }
  }

  _processBuffer() {
    let newlineIndex;
    while ((newlineIndex = this._buffer.indexOf('\n')) !== -1) {
      const line = this._buffer.slice(0, newlineIndex).trim();
      this._buffer = this._buffer.slice(newlineIndex + 1);
      if (line.length > 0) this._parseLine(line);
    }
  }

  _parseLine(line) {
    // S{phase},{rpm},{magX},{magY},{magZ},{hallMask},{coilMask},{timestampMs}
    if (line.startsWith('S')) {
      const parts = line.slice(1).split(',');
      if (parts.length >= 8) {
        this.actualPhase = parseFloat(parts[0]) || 0;
        this.actualRpm = parseFloat(parts[1]) || 0;
        this.magnetometer.x = parseFloat(parts[2]) || 0;
        this.magnetometer.y = parseFloat(parts[3]) || 0;
        this.magnetometer.z = parseFloat(parts[4]) || 0;
        this.hallMask = parseInt(parts[5], 10) || 0;
        this.coilMask = parseInt(parts[6], 10) || 0;
        this.lastTimestampMs = parseInt(parts[7], 10) || 0;
        this.lastSensorUpdate = performance.now();

        // Shadow error vs last sim setpoints
        let dPhase = this.actualPhase - this.shadow.simPhase;
        while (dPhase > 180) dPhase -= 360;
        while (dPhase < -180) dPhase += 360;
        this.shadow.phaseErrorDeg = dPhase;
        this.shadow.rpmError = this.actualRpm - this.shadow.simRpm;

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

  getSensorSnapshot() {
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

  async _writeLine(text) {
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

  _writeLineImmediate(text) {
    // Fire-and-forget for safety paths
    this._writeLine(text);
  }

  /**
   * Called from render loop ~60 Hz.
   * @param {{ simPhase?: number, simRpm?: number }} [sim]
   */
  update(sim = {}) {
    if (!this.isConnected) return;
    this._lastUpdateCall = performance.now();

    if (typeof sim.simPhase === 'number') this.shadow.simPhase = sim.simPhase;
    if (typeof sim.simRpm === 'number') this.shadow.simRpm = sim.simRpm;

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
      this._writeLine(`C${this.manualCoilMask},${this.manualPwm},0`);
    } else {
      const phase = ((this.targetPhase % 360) + 360) % 360;
      // Protocol: P{phase},{speed},{mode}
      this._writeLine(
        `P${phase.toFixed(2)},${this.targetSpeed.toFixed(1)},${this.controlMode}`
      );
    }

    while (this._commandQueue.length > 0) {
      this._writeLine(this._commandQueue.shift());
    }
  }

  async _sendConfig() {
    const { numCoils, offsetAngle, dwellAngle, advanceAngle } = this.config;
    this._commandQueue.push(
      `CONF${numCoils},${offsetAngle.toFixed(1)},${dwellAngle.toFixed(1)},${advanceAngle.toFixed(1)}`
    );
  }

  setConfig(newConfig) {
    Object.assign(this.config, newConfig);
    if (this.isConnected) this._sendConfig();
  }

  setTwinMode(mode) {
    if (!Object.values(TWIN_MODES).includes(mode)) return;
    this.twinMode = mode;
    this.mirrorEnabled = mode === TWIN_MODES.CLOSED;
    if (this.onTwinModeChange) this.onTwinModeChange(mode);
  }

  setTarget(phase, speed, mode = MODE_RUN) {
    this.targetPhase = phase;
    this.targetSpeed = speed;
    this.controlMode = mode;
    this.manualMode = false;
  }

  setManualCoils(coilMask, pwm = 255) {
    this.manualCoilMask = coilMask >>> 0;
    this.manualPwm = Math.max(0, Math.min(255, pwm | 0));
    this.manualMode = true;
  }

  clearManual() {
    this.manualMode = false;
    this.manualCoilMask = 0;
    // Release override on device
    this._writeLineImmediate('C0,0,0');
  }

  brake() {
    this.controlMode = MODE_BRAKE;
    this.targetSpeed = 0;
    this.manualMode = false;
  }

  coast() {
    this.controlMode = MODE_COAST;
    this.targetSpeed = 0;
    this.manualMode = false;
  }

  get isConnected() {
    return this.status === 'connected' || this.status === 'mock';
  }

  get isMock() {
    return this.status === 'mock';
  }

  get sensorAgeMs() {
    if (!this.lastSensorUpdate) return Infinity;
    return performance.now() - this.lastSensorUpdate;
  }

  get isSensorStale() {
    return this.sensorAgeMs > 500;
  }

  _setStatus(newStatus) {
    if (this.status === newStatus) return;
    this.status = newStatus;
    if (this.onStatusChange) this.onStatusChange(newStatus);
  }
}

export { HardwareBridge as default };
