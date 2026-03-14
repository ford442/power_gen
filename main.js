import { PerformanceProfiler } from './performance-profiler.js';
import { DebugPanel } from './debug-panel.js';
import { WebGPUManager } from './webgpu-manager.js';
import { CameraController } from './camera-controller.js';
import { MultiDeviceVisualizer } from './multi-device-visualizer.js';
import { DeviceInstance } from './device-instance.js';
import { DeviceGeometry } from './device-geometry.js';
import { DevicePipelineManager } from './device-pipeline-manager.js';
import { EnergyPipe } from './energy-pipe.js';

// ============================================
// INITIALIZATION
// ============================================
let visualizer;
window.addEventListener('load', () => {
  visualizer = new MultiDeviceVisualizer();
});
