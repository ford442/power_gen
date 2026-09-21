/**
 * HardwareBridge protocol methods — Line Parsing + Command Writing.
 *
 * Split out of hardware-bridge.ts (issues #142/#143/#187). Merged onto
 * HardwareBridge.prototype via `Object.assign` at the bottom of hardware-bridge.ts;
 * a merged `interface HardwareBridge` declaration there gives TypeScript the
 * member signatures (interface members can't be `private`, so these methods —
 * `private` inside the original class — drop that modifier here, matching the
 * mixin convention already used by src/visualizer/render-loop.ts and scene-setup.ts).
 * Because these end up as real prototype methods (not per-instance bound
 * closures), normal `this` binding at call time works automatically.
 */
import type { HardwareBridge, HardwareBridgeConfig, SensorSnapshot, UpdateSimInput } from './hardware-bridge';
import {
  TWIN_MODES,
  type TwinMode,
  MODE_RUN,
  MODE_BRAKE,
  MODE_COAST,
  finiteNum,
  clampRpm,
  clampPwmDuty,
  pwmDutyToWire
} from './hardware-protocol-shared';

export const protocolMethods: ThisType<HardwareBridge> & {
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
} = {
  // ============================================
  // Line Parsing
  //
  // Whole lines arrive from the live transport (mock / serial / bluetooth /
  // usb); framing and the read loop belong to ./hardware-transport.ts.
  // ============================================

  _parseLine(line: string): void {
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
  },

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
  },

  // ============================================
  // Command Writing
  // ============================================

  /**
   * Queue one protocol line on the live transport. Non-blocking by design: the
   * coast / watchdog paths must never await a link that has gone away.
   */
  _writeLine(text: string): void {
    if (!this.transport || !this.isConnected) return;
    try {
      this.transport.writeLine(text);
    } catch (err) {
      console.error('[HardwareBridge] Write failed:', err);
    }
  },

  _writeLineImmediate(text: string): void {
    // Same path — kept as a separate name for the safety call sites.
    this._writeLine(text);
  },

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

    // Mock only: drive its synthetic V/I proxies so the shadow charts move.
    this.transport?.setElectricalTargets?.(this.shadow.simVoltage, this.shadow.simCurrent);

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
  },

  async _sendConfig(): Promise<void> {
    const { numCoils, offsetAngle, dwellAngle, advanceAngle } = this.config;
    this._commandQueue.push(
      `CONF${numCoils},${offsetAngle.toFixed(1)},${dwellAngle.toFixed(1)},${advanceAngle.toFixed(1)}`
    );
  },

  setConfig(newConfig: Partial<HardwareBridgeConfig>): void {
    Object.assign(this.config, newConfig);
    if (this.isConnected) this._sendConfig();
  },

  setTwinMode(mode: string): void {
    if (!Object.values(TWIN_MODES).includes(mode as TwinMode)) return;
    this.twinMode = mode as TwinMode;
    this.mirrorEnabled = mode === TWIN_MODES.CLOSED;
    if (this.onTwinModeChange) this.onTwinModeChange(this.twinMode);
  },

  setTarget(phase: number, speed: number, mode: number = MODE_RUN): void {
    this.targetPhase = finiteNum(phase, 0);
    this.targetSpeed = clampRpm(speed);
    this.controlMode = mode;
    this.manualMode = false;
  },

  /**
   * Manual coil override. pwmOrDuty: 0..1 duty, or legacy 0..255 wire value.
   */
  setManualCoils(coilMask: number, pwmOrDuty: number = 1): void {
    this.manualCoilMask = coilMask >>> 0;
    const duty = pwmOrDuty > 1 ? pwmOrDuty / 255 : pwmOrDuty;
    this.manualPwmDuty = clampPwmDuty(duty);
    this.manualMode = this.manualCoilMask !== 0 && this.manualPwmDuty > 0;
  },

  clearManual(): void {
    this.manualMode = false;
    this.manualCoilMask = 0;
    this.manualPwmDuty = 0;
    // Release override on device
    this._writeLineImmediate('C0,0,0');
  },

  brake(): void {
    this.controlMode = MODE_BRAKE;
    this.targetSpeed = 0;
    this.manualMode = false;
    this.manualPwmDuty = 0;
  },

  coast(): void {
    this.controlMode = MODE_COAST;
    this.targetSpeed = 0;
    this.manualMode = false;
    this.manualPwmDuty = 0;
  }
};
