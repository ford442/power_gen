/**
 * In-memory mock Arduino for demos/CI (no navigator.serial).
 * Accepts P/C/CONF lines; streams S at ~120 Hz.
 *
 * Split out of hardware-bridge.ts (issues #142/#143/#187): self-contained
 * fake serial-port transport used for `?mockHardware=1` / no-Arduino development.
 * Doesn't need anything from HardwareBridge.
 */
import { MODE_RUN, MODE_BRAKE, MODE_COAST, finiteNum, clampRpm } from './hardware-protocol-shared';

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
