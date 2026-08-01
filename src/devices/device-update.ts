import {
  createDevicePhysicsState,
  stepDevicePhysics
} from '../renderers/shared/device-physics';
import { getHeronLayout } from '../heron-layout.js';
import { segWasm } from '../wasm/seg-physics-bridge.js';
import type {
  DeviceEffectContext,
  DeviceEnergyContext,
  DeviceFlowPathContext,
  DeviceInstanceLike,
  DeviceUpdateContext
} from './types';
import {
  deviceNeedsPhysicsState,
  getPluginComputeSpeed,
  pluginWasmSkipsJsPhysics,
  runSyncAfterPhysics,
  runUpdateDynamics,
  runUpdateMesh,
  runComputeRawEnergy,
  runBuildUniformExtras,
  runUpdateFlowPaths,
  runUpdateEffects,
  deviceWantsThermalHaze
} from './device-registry.js';
import {
  effectGate,
  computeEffectBudget,
  computeSpeedNorm,
  computeOverdriveBoost,
  smoothEnergyLevel
} from './update-helpers';
import {
  segUpdateElectromagnetCoils,
  segUpdatePickupCoilEnergies,
  segUpdateEnergyArcs
} from './core/seg-update.js';

export const DeviceUpdateMixin = {
  update: function (this: DeviceInstanceLike, deltaTime: number, qualityScale: number): void {
    const scaledParticleCount = Math.floor(this.particleCount * qualityScale);
    const ringIndex = this.getRingIndex();
    this.scaledParticleCount = scaledParticleCount;

    const computeSpeed = getPluginComputeSpeed(this);
    this.computeManager.updateComputeUniforms(
      this.visualizer.time,
      ringIndex,
      scaledParticleCount,
      computeSpeed,
      this.physicsState
    );

    if (!this.physicsState && deviceNeedsPhysicsState(this.id)) {
      const heronLayout = this.id === 'heron'
        ? (this.visualizer.heronLayout || getHeronLayout(this.visualizer.heronLayoutPreset))
        : null;
      this.physicsState = createDevicePhysicsState(this.id, { heronLayout });
    }

    const ctx: DeviceUpdateContext = {
      deltaTime,
      qualityScale,
      ringIndex,
      scaledParticleCount,
      drive: Math.min(1, Math.log2((this.speedMult || 1) + 1) / Math.log2(21))
    };

    if (this.physicsState) {
      const heronLayout = this.id === 'heron'
        ? (this.visualizer.heronLayout || getHeronLayout(this.physicsState.heronLayoutId))
        : null;
      const wasmOwnsPlant = segWasm.enabled
        && this.physicsState._wasmPlantActive
        && pluginWasmSkipsJsPhysics(this);
      if (!wasmOwnsPlant) {
        stepDevicePhysics(this.physicsState, deltaTime, ctx.drive, { heronLayout });
      } else {
        this.physicsState._wasmPlantActive = false;
      }
      runSyncAfterPhysics(this, ctx);
      runUpdateMesh(this);
    }

    runUpdateDynamics(this, ctx);

    this._computeEnergyLevel(deltaTime);
    this.uniformManager.updateUniforms(this.position, this.rotation, this.renderMode, this.energyLevel);
    this.updateDeviceFlowPaths(deltaTime);
    this.updateEmitterEffects(deltaTime, qualityScale);
  },

  updateDeviceFlowPaths: function (this: DeviceInstanceLike, deltaTime: number): void {
    const paths = this.geometry.flowPathParticles;
    const count = this.geometry.flowPathCount;
    if (!paths || !count || !this.fieldLinePipeline) return;

    const data = this._flowPathData || (this._flowPathData = new Float32Array(count * 8));
    const flowCtx: DeviceFlowPathContext = {
      deltaTime,
      qualityScale: 1,
      ringIndex: this.getRingIndex(),
      scaledParticleCount: this.scaledParticleCount,
      drive: 0,
      energy: this.energyLevel,
      time: this.visualizer.time,
      count,
      writePath: (i: number, x: number, y: number, z: number, strength: number, life: number) => {
        const idx = i * 8;
        data[idx] = x;
        data[idx + 1] = y;
        data[idx + 2] = z;
        data[idx + 3] = 0;
        data[idx + 4] = 0;
        data[idx + 5] = 0;
        data[idx + 6] = life;
        data[idx + 7] = strength;
      }
    };

    if (!runUpdateFlowPaths(this, flowCtx)) return;
    this.device.queue.writeBuffer(paths, 0, data);
  },

  _computeEnergyLevel: function (this: DeviceInstanceLike, deltaTime: number): void {
    const speedNorm = computeSpeedNorm(this.speedMult);
    const overdriveBoost = computeOverdriveBoost(this.speedMult);
    const energyCtx: DeviceEnergyContext = {
      deltaTime,
      speedNorm,
      overdriveBoost,
      time: this.visualizer.time
    };

    let deviceEnergy = speedNorm * 0.4 + overdriveBoost * 0.25;
    const fromPlugin = runComputeRawEnergy(this, energyCtx);
    if (fromPlugin != null) {
      deviceEnergy = fromPlugin;
    }

    smoothEnergyLevel(this, deviceEnergy, deltaTime);
  },

  _buildDeviceUniformData: function (
    this: DeviceInstanceLike,
    renderMode: number,
    yOffset = 0.0
  ): Float32Array<ArrayBuffer> {
    const ringIndex = this.getRingIndex();
    const extras = runBuildUniformExtras(this);
    return new Float32Array([
      renderMode,
      this.position[0],
      this.position[1] + yOffset,
      this.position[2],
      Math.sin(this.rotation[1] / 2),
      0,
      Math.cos(this.rotation[1] / 2),
      1.0,
      this.energyLevel,
      ringIndex,
      extras.batteryCharge ?? 0,
      extras.solarFlag ?? 0
    ]);
  },

  updateEmitterEffects: function (
    this: DeviceInstanceLike,
    deltaTime: number,
    qualityScale: number
  ): void {
    if (!this.effectsParticles) {
      this.effectParticleCount = 0;
      return;
    }

    const budget = computeEffectBudget(this, qualityScale);
    if (budget <= 0) {
      this.effectParticleCount = 0;
      return;
    }

    this.effectParticleCount = 0;
    const effectCtx: DeviceEffectContext = {
      deltaTime,
      qualityScale,
      ringIndex: this.getRingIndex(),
      scaledParticleCount: this.scaledParticleCount,
      drive: 0,
      budget,
      energy: this.energyLevel,
      speedMult: this.speedMult || 1.0,
      time: this.visualizer.time,
      gate: effectGate,
      pushParticle: (x: number, y: number, z: number, phaseEncoded: number) => {
        if (this.effectParticleCount >= budget) return;
        const idx = this.effectParticleCount * 4;
        this._effectParticleData[idx] = x;
        this._effectParticleData[idx + 1] = y;
        this._effectParticleData[idx + 2] = z;
        this._effectParticleData[idx + 3] = phaseEncoded;
        this.effectParticleCount++;
      }
    };

    runUpdateEffects(this, effectCtx);

    if (deviceWantsThermalHaze(this) && this.energyLevel > 0.35) {
      const hazeCount = Math.floor(budget * Math.pow(effectGate(this.energyLevel, 0.35, 0.9), 1.4) * 0.18);
      for (let i = 0; i < hazeCount; i++) {
        const a = Math.random() * Math.PI * 2;
        const r = 2.4 + Math.random() * 3.0;
        const y = (Math.random() - 0.5) * 2.2;
        effectCtx.pushParticle(Math.cos(a) * r, y, Math.sin(a) * r, 4.0 + Math.random());
      }
    }

    if (this.effectParticleCount > 0) {
      this.device.queue.writeBuffer(
        this.effectsParticles,
        0,
        this._effectParticleData,
        0,
        this.effectParticleCount * 4
      );
    }
  },

  updateElectromagnetCoils: segUpdateElectromagnetCoils,
  updatePickupCoilEnergies: segUpdatePickupCoilEnergies,
  updateEnergyArcs: segUpdateEnergyArcs,

  updateFieldLines: function (this: DeviceInstanceLike): void {
    const target = this.fieldLineParticles;
    if (!target) return;

    const fieldData = new Float32Array(this.fieldLineCount * 8);
    const time = this.visualizer.time;

    for (let i = 0; i < this.fieldLineCount; i++) {
      const idx = i * 8;
      const ringIdx = i % 3;
      const ringRadii = [2.5, 4.0, 5.5];
      const ringRadius = ringRadii[ringIdx];
      const baseAngle = (i / this.fieldLineCount) * Math.PI * 20 + time * (0.5 + ringIdx * 0.3);
      const heightOffset = Math.sin(time * 0.5 + i * 0.1) * 0.8;

      fieldData[idx] = Math.cos(baseAngle) * ringRadius;
      fieldData[idx + 1] = heightOffset + (Math.random() - 0.5) * 0.2;
      fieldData[idx + 2] = Math.sin(baseAngle) * ringRadius;
      const speed = 1.0 + ringIdx * 0.5;
      fieldData[idx + 3] = -Math.sin(baseAngle) * speed;
      fieldData[idx + 4] = Math.cos(time * 2 + i * 0.05) * 0.1;
      fieldData[idx + 5] = Math.cos(baseAngle) * speed;
      fieldData[idx + 6] = (Math.sin(time * 2 + i * 0.5) * 0.5 + 0.5);
      fieldData[idx + 7] = 0.3 + 0.7 * Math.sin(baseAngle * 3 + time);
    }

    this.device.queue.writeBuffer(target, 0, fieldData);
  }
};
