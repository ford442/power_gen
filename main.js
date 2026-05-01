import { PerformanceProfiler } from './performance-profiler.js';
import { DebugPanel } from './debug-panel.js';
import { WebGPUManager } from './webgpu-manager.js';
import { CameraController } from './camera-controller.js';
import { MultiDeviceVisualizer } from './multi-device-visualizer.js';
import { DeviceInstance } from './device-instance.js';
import { DeviceGeometry } from './device-geometry.js';
import { DevicePipelineManager } from './device-pipeline-manager.js';
import { EnergyPipe } from './energy-pipe.js';
import { HardwareBridge } from './hardware-bridge.js';
import { ElectromagnetController } from './electromagnet-controller.js';

// ============================================
// INITIALIZATION
// ============================================
let visualizer;
let hardwareBridge;
let emController;

window.addEventListener('load', () => {
  visualizer = new MultiDeviceVisualizer();

  // Initialize hardware bridge for Arduino control
  hardwareBridge = new HardwareBridge({
    onStatusChange: (status) => {
      const statusEl = document.getElementById('hwStatusText');
      const colors = { disconnected: '#f80', connecting: '#ff0', connected: '#2f2', error: '#f22' };
      if (statusEl) {
        statusEl.textContent = status.charAt(0).toUpperCase() + status.slice(1);
        statusEl.style.color = colors[status] || '#f80';
      }
    },
    onSensorData: (data) => {
      document.getElementById('hwPhase').textContent = data.phase.toFixed(1);
      document.getElementById('hwRpm').textContent = data.rpm.toFixed(1);
      document.getElementById('hwMagX').textContent = data.magnetometer.x.toFixed(1);
      document.getElementById('hwMagY').textContent = data.magnetometer.y.toFixed(1);
      document.getElementById('hwMagZ').textContent = data.magnetometer.z.toFixed(1);
      document.getElementById('hwHallMask').textContent = data.hallMask.toString(2).padStart(8, '0');
      document.getElementById('hwCoilMask').textContent = data.coilMask.toString(2).padStart(8, '0');
    },
    onError: (err) => {
      console.error('[HardwareBridge] Error:', err);
    }
  });

  emController = new ElectromagnetController(hardwareBridge.config);

  // Wire hardware bridge into visualizer once ready
  const wireBridge = () => {
    if (visualizer && visualizer.webgpu?.device) {
      visualizer.hardwareBridge = hardwareBridge;
      visualizer.emController = emController;
    } else {
      setTimeout(wireBridge, 100);
    }
  };
  wireBridge();

  // Expose to window for UI onclick handlers
  window.hardwareBridge = hardwareBridge;
  window.emController = emController;

  // UI helpers
  window.applyCoilConfig = () => {
    const numCoils = parseInt(document.getElementById('hwNumCoils').value, 10) || 8;
    const dwell = parseFloat(document.getElementById('hwDwellSlider').value) || 67.5;
    const advance = parseFloat(document.getElementById('hwAdvanceSlider').value) || 0;
    const config = { numCoils, dwellAngle: dwell, advanceAngle: advance };
    hardwareBridge.setConfig(config);
    emController.setConfig(config);
  };

  window.setHardwareMode = (mode) => {
    const map = { run: 0, brake: 1, coast: 2 };
    hardwareBridge.controlMode = map[mode] ?? 0;
  };

  // Simulation speed slider listener (with SEG RPM readout)
  const simSpeedSlider = document.getElementById('speedSlider');
  const simSpeedVal = document.getElementById('speedVal');
  const segRpmVal = document.getElementById('segRpmVal');
  if (simSpeedSlider && simSpeedVal) {
    const updateSimSpeed = () => {
      const speed = parseFloat(simSpeedSlider.value);
      simSpeedVal.textContent = speed.toFixed(1);
      // Inner ring RPM approximation: speed * 0.5 * 2.0 rad/s * (60 / 2π) ≈ speed * 9.55
      if (segRpmVal) segRpmVal.textContent = '~' + Math.round(speed * 9.55);
    };
    simSpeedSlider.addEventListener('input', updateSimSpeed);
    updateSimSpeed();
  }

  // Hardware speed slider listener
  const speedSlider = document.getElementById('hwSpeedSlider');
  const speedVal = document.getElementById('hwSpeedVal');
  if (speedSlider && speedVal) {
    speedSlider.addEventListener('input', () => {
      const rpm = parseFloat(speedSlider.value);
      speedVal.textContent = rpm;
      hardwareBridge.targetSpeed = rpm;
    });
  }

  const dwellSlider = document.getElementById('hwDwellSlider');
  const dwellVal = document.getElementById('hwDwellVal');
  if (dwellSlider && dwellVal) {
    dwellSlider.addEventListener('input', () => {
      dwellVal.textContent = dwellSlider.value;
    });
  }

  const advanceSlider = document.getElementById('hwAdvanceSlider');
  const advanceVal = document.getElementById('hwAdvanceVal');
  if (advanceSlider && advanceVal) {
    advanceSlider.addEventListener('input', () => {
      advanceVal.textContent = advanceSlider.value;
    });
  }

  const mirrorToggle = document.getElementById('hwMirrorToggle');
  if (mirrorToggle) {
    mirrorToggle.addEventListener('change', () => {
      hardwareBridge.mirrorEnabled = mirrorToggle.checked;
    });
  }
});
