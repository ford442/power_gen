// Tachometer overlay + hardware digital twin sync.
import { segOperator } from '../seg-operator-state.js';
import { telemetryHub, TelemetryHub } from '../telemetry-hub.js';
import { TWIN_MODES } from '../hardware-bridge.js';

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
    if (!hw?.isConnected) return;

    // Simulated electrical phase / RPM from operator plant
    const tel = segOperator.computeTelemetry(0);
    const simRpm = tel.rpmDisplay || 0;
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

    hw.update({ simPhase, simRpm });

    // Closed-loop: hardware is authority for visual roller spin
    if (hw.twinMode === TWIN_MODES.CLOSED && !hw.isSensorStale) {
      // Map HW RPM (~0–3000) into normalized segOmega 0–1
      const wNorm = Math.min(1, Math.abs(hw.actualRpm) / 3000);
      this.segOmega = wNorm;
      this.corona = Math.max(0, Math.min(1, (wNorm - 0.6) / 0.4));
      segOperator.physics.segOmega = wNorm;
      segOperator.physics.corona = this.corona;
    }

    this.hardwareShadow = {
      phaseError: hw.shadow.phaseErrorDeg,
      rpmError: hw.shadow.rpmError
    };
  },

  _updateDeviceTelemetry() {
    telemetryHub.publishFrame({
      dt: 0,
      view: this.currentView || 'overview',
      renderer: 'webgpu',
      devicePhysics: TelemetryHub.collectDevicePhysics(this.devices)
    });
    if (this.currentView === 'heron' && typeof window.syncHeronLayoutUI === 'function') {
      window.syncHeronLayoutUI();
    }
  }
};
