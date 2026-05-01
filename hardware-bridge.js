/**
 * HardwareBridge - Web Serial API connection manager for SEG electromagnet control
 *
 * Handles bidirectional communication with Arduino:
 *   App → Arduino: phase/speed commands (P), manual coil overrides (C), config (CONF)
 *   Arduino → App: sensor state stream (S) with phase, rpm, magnetometer, hall mask
 */

class HardwareBridge {
  constructor(options = {}) {
    this.baudRate = options.baudRate || 115200;
    this.commandThrottleMs = options.commandThrottleMs || 16; // ~60Hz max

    // Serial port state
    this.port = null;
    this.reader = null;
    this.writer = null;
    this.readLoopPromise = null;
    this.status = 'disconnected'; // 'disconnected' | 'connecting' | 'connected' | 'error'
    this.lastError = null;

    // Incoming parsed state from Arduino
    this.actualPhase = 0;        // degrees 0-360
    this.actualRpm = 0;
    this.magnetometer = { x: 0, y: 0, z: 0 }; // microtesla
    this.hallMask = 0;           // bitmask
    this.coilMask = 0;           // bitmask of active coils reported by Arduino
    this.lastTimestampMs = 0;
    this.lastSensorUpdate = 0;

    // Outgoing state
    this.targetPhase = 0;
    this.targetSpeed = 0;
    this.controlMode = 0; // 0=run, 1=brake, 2=coast
    this.mirrorEnabled = false;

    // Manual override
    this.manualCoilMask = 0;
    this.manualPwm = 255;
    this.manualMode = false;

    // Config (mirrors Arduino config, kept in sync)
    this.config = {
      numCoils: 8,
      offsetAngle: 0,
      dwellAngle: 67.5,   // default for 8 coils with 1.5x overlap
      advanceAngle: 0,
      firingPattern: 'overlap', // 'single' | 'overlap' | 'trapezoidal' | 'sinusoidal'
    };

    // Throttling
    this._lastCommandTime = 0;
    this._pendingCommand = null;
    this._commandQueue = [];

    // Text decoder for incoming stream
    this._textDecoder = new TextDecoderStream();
    this._buffer = '';

    // Callbacks
    this.onStatusChange = options.onStatusChange || null;
    this.onSensorData = options.onSensorData || null;
    this.onError = options.onError || null;
  }

  // ============================================
  // Connection Lifecycle
  // ============================================

  async connect() {
    if (this.status === 'connected' || this.status === 'connecting') return;
    this._setStatus('connecting');

    try {
      // Request port from browser
      this.port = await navigator.serial.requestPort({
        filters: [
          { usbVendorId: 0x2341 }, // Arduino
          { usbVendorId: 0x2A03 }, // Arduino (old)
          { usbVendorId: 0x1A86 }, // CH340 (clone)
          { usbVendorId: 0x10C4 }, // CP210x
          { usbVendorId: 0x0403 }, // FTDI
          { usbVendorId: 0x303A }, // Espressif (ESP32)
        ]
      });

      await this.port.open({ baudRate: this.baudRate });

      // Setup writer
      this.writer = this.port.writable.getWriter();

      // Setup reader with TextDecoderStream
      this._textDecoder = new TextDecoderStream();
      this.port.readable.pipeTo(this._textDecoder.writable).catch(() => {});
      this.reader = this._textDecoder.readable.getReader();

      // Start read loop
      this._buffer = '';
      this.readLoopPromise = this._readLoop();

      // Send initial config
      await this._sendConfig();

      this._setStatus('connected');
      console.log('[HardwareBridge] Connected at', this.baudRate);
    } catch (err) {
      this.lastError = err.message;
      this._setStatus('error');
      console.error('[HardwareBridge] Connection failed:', err);
      if (this.onError) this.onError(err);
    }
  }

  async disconnect() {
    this._setStatus('disconnected');

    // Cancel reader first
    if (this.reader) {
      try { await this.reader.cancel(); } catch (e) {}
      this.reader = null;
    }

    // Release writer
    if (this.writer) {
      try { this.writer.releaseLock(); } catch (e) {}
      this.writer = null;
    }

    // Close port
    if (this.port) {
      try { await this.port.close(); } catch (e) {}
      this.port = null;
    }

    this.readLoopPromise = null;
    this._buffer = '';
    console.log('[HardwareBridge] Disconnected');
  }

  // ============================================
  // Read Loop
  // ============================================

  async _readLoop() {
    while (this.status === 'connected' && this.reader) {
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
      if (line.length > 0) {
        this._parseLine(line);
      }
    }
  }

  _parseLine(line) {
    // Expected: S{phase},{rpm},{magX},{magY},{magZ},{hallMask},{coilMask},{timestampMs}
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

        if (this.onSensorData) {
          this.onSensorData({
            phase: this.actualPhase,
            rpm: this.actualRpm,
            magnetometer: { ...this.magnetometer },
            hallMask: this.hallMask,
            coilMask: this.coilMask,
            timestamp: this.lastTimestampMs,
          });
        }
      }
    } else if (line.startsWith('E')) {
      // Error message from Arduino
      console.error('[Arduino Error]', line.slice(1));
    } else if (line.startsWith('I')) {
      // Info/debug from Arduino
      console.log('[Arduino]', line.slice(1));
    }
  }

  // ============================================
  // Command Writing
  // ============================================

  async _writeLine(text) {
    if (!this.writer || this.status !== 'connected') return;
    const encoder = new TextEncoder();
    const data = encoder.encode(text + '\n');
    try {
      await this.writer.write(data);
    } catch (err) {
      console.error('[HardwareBridge] Write failed:', err);
    }
  }

  update() {
    // Called from render loop at ~60Hz
    if (this.status !== 'connected') return;

    const now = performance.now();
    if (now - this._lastCommandTime < this.commandThrottleMs) return;
    this._lastCommandTime = now;

    if (this.manualMode) {
      // Send manual coil override
      this._writeLine(`C${this.manualCoilMask},${this.manualPwm},0`);
    } else {
      // Send phase/speed setpoint
      const phase = ((this.targetPhase % 360) + 360) % 360;
      this._writeLine(`P${phase.toFixed(2)},${this.targetSpeed.toFixed(1)},${this.controlMode}`);
    }

    // Drain any queued config commands
    while (this._commandQueue.length > 0) {
      const cmd = this._commandQueue.shift();
      this._writeLine(cmd);
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
    if (this.status === 'connected') {
      this._sendConfig();
    }
  }

  setTarget(phase, speed, mode = 0) {
    this.targetPhase = phase;
    this.targetSpeed = speed;
    this.controlMode = mode;
    this.manualMode = false;
  }

  setManualCoils(coilMask, pwm = 255) {
    this.manualCoilMask = coilMask;
    this.manualPwm = pwm;
    this.manualMode = true;
  }

  clearManual() {
    this.manualMode = false;
    this.manualCoilMask = 0;
  }

  // ============================================
  // Helpers
  // ============================================

  get isConnected() {
    return this.status === 'connected';
  }

  get sensorAgeMs() {
    return performance.now() - this.lastSensorUpdate;
  }

  get isSensorStale() {
    return this.sensorAgeMs > 500; // 500ms threshold
  }

  _setStatus(newStatus) {
    if (this.status === newStatus) return;
    this.status = newStatus;
    if (this.onStatusChange) this.onStatusChange(newStatus);
  }
}

export { HardwareBridge };
