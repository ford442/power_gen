/**
 * Per-device CPU state for the WebGL2 fallback path.
 * Mirrors WebGPU's DeviceInstance: holds particle data + physics state.
 */

import { createDevicePhysicsState } from '../shared/device-physics';
import { seedParticles } from '../shared/particle-physics';
import { getHeronLayout } from '../../heron-layout';

export class WebGL2DeviceState {
  constructor(id, config, visualizer) {
    this.id = id;
    this.config = config;
    this.visualizer = visualizer;
    this.position = config.position;
    this.particleCount = config.particleCount || 10000;
    this.particles = new Float32Array(this.particleCount * 8);
    const heronLayout = id === 'heron'
      ? (visualizer?.heronLayout || getHeronLayout(visualizer?.heronLayoutPreset))
      : null;
    this.physics = createDevicePhysicsState(id, { heronLayout });
    // Alias so TelemetryHub / debug panel can use physicsState like WebGPU
    this.physicsState = this.physics;
    seedParticles(this.particles, id, this.particleCount);
  }

  resetForModeEntry() {
    const heronLayout = this.id === 'heron'
      ? (this.visualizer?.heronLayout || getHeronLayout(this.visualizer?.heronLayoutPreset))
      : null;
    this.physics = createDevicePhysicsState(this.id, { heronLayout });
    this.physicsState = this.physics;
    seedParticles(this.particles, this.id, this.particleCount);
  }

  get energyLevel() {
    return this.physics?.energyLevel ?? 0;
  }

  get batteryCharge() {
    return this.physics?.batteryCharge ?? 0.5;
  }

  set batteryCharge(v) {
    if (this.physics) this.physics.batteryCharge = v;
  }
}
