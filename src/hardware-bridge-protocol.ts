/**
 * HardwareBridge protocol methods — Line Parsing + Command Writing.
 *
 * Split out of hardware-bridge.ts (issues #142/#143/#187) to keep it under the
 * 700-line cap. Plain module functions that take the bridge; HardwareBridge
 * declares each one as a real class method that delegates here (no prototype
 * mixin — see ADR-0016 and #244, a WebGPU boot break from that pattern). Calls back into the
 * bridge (`bridge._writeLine`, `bridge.getSensorSnapshot`, …) go through those
 * class methods, so a test stubbing one on an instance still sees every call.
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
  pwmDutyToWire,
  parseFirmwareHello,
  HELLO_COMMAND,
  HELLO_ATTEMPTS,
  HELLO_RETRY_MS
} from './hardware-protocol-shared';

// ============================================
// Line Parsing
//
// Whole lines arrive from the live transport (mock / serial / bluetooth /
// usb); framing and the read loop belong to ./hardware-transport.ts.
// ============================================

export function parseLine(bridge: HardwareBridge, line: string): void {
  // S{phase},{rpm},{magX},{magY},{magZ},{hallMask},{coilMask},{timestampMs}
  if (line.startsWith('S')) {
    const parts = line.slice(1).split(',');
    if (parts.length >= 8) {
      bridge.actualPhase = finiteNum(parseFloat(parts[0]), 0);
      bridge.actualRpm = clampRpm(parseFloat(parts[1]));
      bridge.magnetometer.x = finiteNum(parseFloat(parts[2]), 0);
      bridge.magnetometer.y = finiteNum(parseFloat(parts[3]), 0);
      bridge.magnetometer.z = finiteNum(parseFloat(parts[4]), 0);
      bridge.hallMask = parseInt(parts[5], 10) || 0;
      bridge.coilMask = parseInt(parts[6], 10) || 0;
      bridge.lastTimestampMs = parseInt(parts[7], 10) || 0;
      if (parts.length >= 10) {
        bridge.actualVoltage = finiteNum(parseFloat(parts[8]), 0);
        bridge.actualCurrent = finiteNum(parseFloat(parts[9]), 0);
      }
      bridge.lastSensorUpdate = performance.now();

      // Shadow error vs last sim setpoints
      let dPhase = bridge.actualPhase - bridge.shadow.simPhase;
      while (dPhase > 180) dPhase -= 360;
      while (dPhase < -180) dPhase += 360;
      bridge.shadow.phaseErrorDeg = dPhase;
      bridge.shadow.rpmError = bridge.actualRpm - bridge.shadow.simRpm;
      bridge.shadow.voltageError = bridge.actualVoltage - bridge.shadow.simVoltage;
      bridge.shadow.currentError = bridge.actualCurrent - bridge.shadow.simCurrent;

      if (bridge._hasListeners('sensor')) {
        bridge._emit('sensor', bridge.getSensorSnapshot());
      }
    }
  } else if (line.startsWith('E')) {
    console.error('[Arduino Error]', line.slice(1));
  } else if (line.startsWith('I')) {
    // A v2 board says hello at boot and in answer to `V2`; v1 never does.
    const hello = parseFirmwareHello(line);
    if (hello) bridge.firmware = hello;
    console.log('[Arduino]', line.slice(1));
  }
}

export function getSensorSnapshot(bridge: HardwareBridge): SensorSnapshot {
  return {
    phase: bridge.actualPhase,
    rpm: bridge.actualRpm,
    magnetometer: { ...bridge.magnetometer },
    hallMask: bridge.hallMask,
    coilMask: bridge.coilMask,
    timestamp: bridge.lastTimestampMs,
    twinMode: bridge.twinMode,
    shadow: { ...bridge.shadow },
    magMagnitudeUt: Math.hypot(
      bridge.magnetometer.x,
      bridge.magnetometer.y,
      bridge.magnetometer.z
    )
  };
}

// ============================================
// Command Writing
// ============================================

/**
 * Queue one protocol line on the live transport. Non-blocking by design: the
 * coast / watchdog paths must never await a link that has gone away.
 */
export function writeLine(bridge: HardwareBridge, text: string): void {
  if (!bridge.transport || !bridge.isConnected) return;
  try {
    bridge.transport.writeLine(text);
  } catch (err) {
    console.error('[HardwareBridge] Write failed:', err);
  }
}

export function writeLineImmediate(bridge: HardwareBridge, text: string): void {
  // Same path — kept as a separate name for the safety call sites.
  bridge._writeLine(text);
}

/**
 * Called from render loop ~60 Hz.
 */
export function update(bridge: HardwareBridge, sim: UpdateSimInput = {}): void {
  if (!bridge.isConnected) return;
  bridge._lastUpdateCall = performance.now();

  if (typeof sim.simPhase === 'number' && Number.isFinite(sim.simPhase)) {
    bridge.shadow.simPhase = sim.simPhase;
  }
  if (typeof sim.simRpm === 'number' && Number.isFinite(sim.simRpm)) {
    bridge.shadow.simRpm = sim.simRpm;
  }
  if (typeof sim.simVoltage === 'number' && Number.isFinite(sim.simVoltage)) {
    bridge.shadow.simVoltage = sim.simVoltage;
  }
  if (typeof sim.simCurrent === 'number' && Number.isFinite(sim.simCurrent)) {
    bridge.shadow.simCurrent = sim.simCurrent;
  }

  // Mock only: drive its synthetic V/I proxies so the shadow charts move.
  bridge.transport?.setElectricalTargets?.(bridge.shadow.simVoltage, bridge.shadow.simCurrent);

  // Apply twin-mode side effects for setTarget authority
  if (bridge.twinMode === TWIN_MODES.CLOSED) {
    bridge.mirrorEnabled = true;
  } else if (bridge.twinMode === TWIN_MODES.OPEN) {
    bridge.mirrorEnabled = false;
  } else {
    // shadow: visualize sim, still compare
    bridge.mirrorEnabled = false;
  }

  const now = performance.now();
  if (now - bridge._lastCommandTime < bridge.commandThrottleMs) return;
  bridge._lastCommandTime = now;

  // Ask for the v2 hello until one arrives. Queued behind this frame's P/C,
  // so it never delays a watchdog feed; a v1 sketch just drops it.
  if (!bridge.firmware && bridge._helloAttempts < HELLO_ATTEMPTS
    && now - bridge._lastHelloAt >= HELLO_RETRY_MS) {
    bridge._helloAttempts += 1;
    bridge._lastHelloAt = now;
    bridge._commandQueue.push(HELLO_COMMAND);
  }

  if (bridge.manualMode) {
    const wirePwm = pwmDutyToWire(bridge.manualPwmDuty);
    bridge._writeLine(`C${bridge.manualCoilMask},${wirePwm},0`);
  } else {
    const phase = ((bridge.targetPhase % 360) + 360) % 360;
    const speed = clampRpm(bridge.targetSpeed);
    // Protocol: P{phase},{speed},{mode}
    bridge._writeLine(
      `P${phase.toFixed(2)},${speed.toFixed(1)},${bridge.controlMode}`
    );
  }

  while (bridge._commandQueue.length > 0) {
    const cmd = bridge._commandQueue.shift();
    if (cmd) bridge._writeLine(cmd);
  }
}

export async function sendConfig(bridge: HardwareBridge): Promise<void> {
  const { numCoils, offsetAngle, dwellAngle, advanceAngle } = bridge.config;
  bridge._commandQueue.push(
    `CONF${numCoils},${offsetAngle.toFixed(1)},${dwellAngle.toFixed(1)},${advanceAngle.toFixed(1)}`
  );
}

export function setConfig(bridge: HardwareBridge, newConfig: Partial<HardwareBridgeConfig>): void {
  Object.assign(bridge.config, newConfig);
  if (bridge.isConnected) bridge._sendConfig();
}

export function setTwinMode(bridge: HardwareBridge, mode: string): void {
  if (!Object.values(TWIN_MODES).includes(mode as TwinMode)) return;
  bridge.twinMode = mode as TwinMode;
  bridge.mirrorEnabled = mode === TWIN_MODES.CLOSED;
  bridge._emit('twinMode', bridge.twinMode);
}

export function setTarget(bridge: HardwareBridge, phase: number, speed: number, mode: number = MODE_RUN): void {
  bridge.targetPhase = finiteNum(phase, 0);
  bridge.targetSpeed = clampRpm(speed);
  bridge.controlMode = mode;
  bridge.manualMode = false;
}

/**
 * Manual coil override. pwmOrDuty: 0..1 duty, or legacy 0..255 wire value.
 */
export function setManualCoils(bridge: HardwareBridge, coilMask: number, pwmOrDuty: number = 1): void {
  bridge.manualCoilMask = coilMask >>> 0;
  const duty = pwmOrDuty > 1 ? pwmOrDuty / 255 : pwmOrDuty;
  bridge.manualPwmDuty = clampPwmDuty(duty);
  bridge.manualMode = bridge.manualCoilMask !== 0 && bridge.manualPwmDuty > 0;
}

export function clearManual(bridge: HardwareBridge): void {
  bridge.manualMode = false;
  bridge.manualCoilMask = 0;
  bridge.manualPwmDuty = 0;
  // Release override on device
  bridge._writeLineImmediate('C0,0,0');
}

export function brake(bridge: HardwareBridge): void {
  bridge.controlMode = MODE_BRAKE;
  bridge.targetSpeed = 0;
  bridge.manualMode = false;
  bridge.manualPwmDuty = 0;
}

export function coast(bridge: HardwareBridge): void {
  bridge.controlMode = MODE_COAST;
  bridge.targetSpeed = 0;
  bridge.manualMode = false;
  bridge.manualPwmDuty = 0;
}

