// Tachometer overlay + hardware digital twin sync.
import { segOperator } from '../seg-operator-state';
import { telemetryHub, TelemetryHub } from '../telemetry-hub';
import { HardwareBridge, TWIN_MODES } from '../hardware-bridge.js';

/**
 * Build hub-facing hardware twin snapshot (includes shadowResidual).
 * @param {import('../hardware-bridge.js').HardwareBridge|null|undefined} hw
 * @returns {import('../telemetry/types').HardwareTwinTelemetry|null}
 */
export function buildHardwareTwinTelemetry(hw) {
  if (!hw?.isConnected) return null;
  return {
    connected: true,
    mock: !!hw.isMock,
    connectionState: hw.connectionKind,
    twinMode: hw.twinMode,
    sensorRpm: HardwareBridge.sanitizeRpm(hw.actualRpm),
    sensorPhase: hw.actualPhase,
    sensorVoltage: hw.actualVoltage ?? 0,
    sensorCurrent: hw.actualCurrent ?? 0,
    shadowResidual: {
      phaseErrorDeg: hw.shadow.phaseErrorDeg,
      rpmError: hw.shadow.rpmError,
      voltageError: hw.shadow.voltageError ?? 0,
      currentError: hw.shadow.currentError ?? 0
    }
  };
}

export const hardwareTwinMethods = {
  _updateTachometer() {
    const el = document.getElementById('tachometer');
    if (!el) return;
    const src = this.simRateController;
    const fill = el.querySelector('.tach-fill');
    const label = el.querySelector('.tach-label');
    if (fill) {
      fill.style.width = `${(src.tachFill * 100).toFixed(1)}%`;
      fill.style.background = `hsl(${src.tachHue}, 100%, 50%)`;
      if (src.isOverdrive) fill.classList.add('overdrive');
      else fill.classList.remove('overdrive');
    }
    if (label) {
      label.textContent = `${src.speedMult.toFixed(2)}×`;
      label.style.color = `hsl(${src.tachHue}, 100%, 65%)`;
    }
  },

  _updateHardwareTwin(deltaTime) {
    const hw = this.hardwareBridge;
    if (!hw?.isConnected) {
      this.hardwareTwinTelemetry = null;
      this.hardwareShadow = { phaseError: 0, rpmError: 0 };
      return;
    }

    // Simulated electrical phase / RPM from operator plant
    const tel = segOperator.computeTelemetry(0);
    const simRpm = HardwareBridge.sanitizeRpm(tel.rpmDisplay || 0);
    const simVoltage = Number.isFinite(tel.voltage) ? tel.voltage : 0;
    const simCurrent = Number.isFinite(tel.current) ? tel.current : 0;
    // Integrate phase: deg/s = RPM * 6
    if (!hw.manualMode && hw.controlMode === 0) {
      this.hardwareTargetPhase += simRpm * 6.0 * Math.max(0, deltaTime);
      this.hardwareTargetSpeed = simRpm;
    }
    const simPhase = ((this.hardwareTargetPhase % 360) + 360) % 360;

    // Open / shadow: sim commands hardware. Closed: still send setpoints as soft reference.
    if (hw.twinMode === TWIN_MODES.OPEN || hw.twinMode === TWIN_MODES.SHADOW
        || hw.twinMode === TWIN_MODES.CLOSED) {
      const runMode = segOperator.isRunning ? 0 : 2; // run vs coast when plant stopped
      if (!hw.manualMode) {
        hw.setTarget(simPhase, segOperator.isRunning ? simRpm : 0, runMode);
      }
    }

    hw.update({ simPhase, simRpm, simVoltage, simCurrent });

    // Closed-loop: hardware is authority for visual roller spin (never NaN-spin)
    if (hw.twinMode === TWIN_MODES.CLOSED && !hw.isSensorStale) {
      const hwRpm = HardwareBridge.sanitizeRpm(hw.actualRpm);
      const wNorm = Math.min(1, Math.abs(hwRpm) / 3000);
      this.segOmega = wNorm;
      this.corona = Math.max(0, Math.min(1, (wNorm - 0.6) / 0.4));
      segOperator.physics.segOmega = wNorm;
      segOperator.physics.corona = this.corona;
    }

    this.hardwareShadow = {
      phaseError: hw.shadow.phaseErrorDeg,
      rpmError: hw.shadow.rpmError
    };
    this.hardwareTwinTelemetry = buildHardwareTwinTelemetry(hw);
  },

  _updateDeviceTelemetry() {
    telemetryHub.publishFrame({
      dt: 0,
      view: this.currentView || 'overview',
      renderer: 'webgpu',
      devicePhysics: TelemetryHub.collectDevicePhysics(this.devices),
      hardwareTwin: this.hardwareTwinTelemetry ?? null
    });
    if (this.currentView === 'heron' && typeof window.syncHeronLayoutUI === 'function') {
      window.syncHeronLayoutUI();
    }
  }
};
