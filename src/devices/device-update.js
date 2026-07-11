import { frameVibrationOffset } from '../seg-frame-model.js';
import {
  createDevicePhysicsState,
  stepDevicePhysics
} from '../renderers/shared/device-physics.js';
import { getHeronLayout } from '../heron-layout.js';
import { buildMagLevMesh } from './quanta/magnetic-levitation.js';
import { instancesToBufferData, countInstances } from '../device-mesh-layouts.js';

export const DeviceUpdateMixin = {
  update: function (deltaTime, qualityScale) {
    // Scale particle count by quality
    const scaledParticleCount = Math.floor(this.particleCount * qualityScale);

    // Determine ring index for shaders: 0=SEG, 1=Heron, 2=Kelvin, 3=Solar, 4=Peltier, 5=MHD
    const ringIndex = this.getRingIndex();
    this.scaledParticleCount = scaledParticleCount;

    // Update compute uniforms for shader (mode as f32: 0=SEG … 5=MHD)
    let computeSpeed = this.speedMult || 1.0;
    if (this.id === 'seg') {
      computeSpeed *= 0.15 + 0.85 * (this.visualizer.segOmega ?? 0);
    }
    this.computeManager.updateComputeUniforms(
      this.visualizer.time,
      this.getRingIndex(),
      scaledParticleCount,
      computeSpeed,
      this.physicsState
    );

    // Per-device physics integrators (Heron head, Kelvin voltage, solar battery)
    if (!this.physicsState && ['heron', 'kelvin', 'solar', 'maglev'].includes(this.id)) {
      const heronLayout = this.id === 'heron'
        ? (this.visualizer.heronLayout || getHeronLayout(this.visualizer.heronLayoutPreset))
        : null;
      this.physicsState = createDevicePhysicsState(this.id, { heronLayout });
    }
    if (this.physicsState) {
      const drive = Math.min(1, Math.log2((this.speedMult || 1) + 1) / Math.log2(21));
      const heronLayout = this.id === 'heron'
        ? (this.visualizer.heronLayout || getHeronLayout(this.physicsState.heronLayoutId))
        : null;
      stepDevicePhysics(this.physicsState, deltaTime, drive, { heronLayout });
      if (this.id === 'heron') {
        this.flowEnergyLevel = this.physicsState.energyLevel;
      } else if (this.id === 'kelvin') {
        this.voltageEnergyLevel = this.physicsState.kelvinVoltageN;
      } else if (this.id === 'solar') {
        this.batteryCharge = this.physicsState.batteryCharge;
        this.uniformManager.batteryCharge = this.physicsState.batteryCharge;
        this.visualizer.updateBatteryGaugeMesh(this.batteryCharge);
        this.uniformManager.updateGaugeBuffer(this.position, ringIndex);
      } else if (this.id === 'maglev' && this.rollerInstances) {
        const gap = this.physicsState.maglevGap ?? 0.018;
        const mesh = buildMagLevMesh(gap);
        const data = instancesToBufferData([mesh.cylinders()]);
        this.device.queue.writeBuffer(this.rollerInstances, 0, data);
        this.meshCylinderCount = countInstances(mesh.cylinders().flat());
      }
    }

    if (this.id === 'seg' && this.rollerInstances) {
      const time = this.visualizer.time;
      const speedMult = this.speedMult || 1.0;

      // Write GPU compute uniforms BEFORE the compute pass is dispatched.
      // `time` is already speed-scaled by the visualizer; the shader uses it
      // directly so there is no double-multiplication.
      if (this.rollerComputeUniformBuffer) {
        const presetVal = this.visualizer.prototypePreset === 'lab' ? 1.0 : 0.0;
        const segOmega = Math.max(0.02, this.visualizer.segOmega ?? 1.0);
        this.device.queue.writeBuffer(
          this.rollerComputeUniformBuffer, 0,
          new Float32Array([time, speedMult, presetVal, segOmega])
        );
      }
      if (this.fieldAdvectUniformBuffer && this.geometry.fieldLineParticles) {
        this.device.queue.writeBuffer(
          this.fieldAdvectUniformBuffer, 0,
          new Float32Array([time, speedMult, this.fieldLineCount, 0])
        );
      }
      // Write RK4 flux tracer uniforms: time, deltaTime, integrationStep,
      // lineOpacity, seedRadius, followStrength, _pad, _pad
      if (this.fluxTracerUniformBuffer) {
        const corona = this.visualizer.corona ?? 0;
        const segOmega = Math.max(0.02, this.visualizer.segOmega ?? 0);
        const lineOpacity = 1.0 + this.energyLevel * 0.55 + corona * 0.45;
        const follow = 1.0 + Math.min(0.35, this.energyLevel * 0.25 + segOmega * 0.15);
        this.device.queue.writeBuffer(
          this.fluxTracerUniformBuffer, 0,
          new Float32Array([time, deltaTime, 0.016, lineOpacity, 0.055, follow, 0.0, 0.0])
        );
      }

      this._updateFrameVibration();

      // Lightweight CPU coil-energy calculation.
      // We only need 36 (x, z) pairs — no quaternions, no colour lookup, no
      // buffer write — so the tight inner-loop is ~10× cheaper than before.
      const hw = this.visualizer.hardwareBridge;
      // Closed-loop twin: rollers follow measured phase/RPM
      const useHardware = hw?.isConnected && (hw.mirrorEnabled || hw.twinMode === 'closed');
      const hardwarePhaseRad = useHardware ? (hw.actualPhase * Math.PI / 180) : null;
      const spinFactor = Math.max(0.02, this.visualizer.segOmega ?? 1.0);

      const rings = [
        { count: 8,  radius: 2.5, speed: 2.0, index: 0 },
        { count: 12, radius: 4.0, speed: 1.0, index: 1 },
        { count: 16, radius: 5.5, speed: 0.5, index: 2 }
      ];

      // Compact roller positions for pickup coil energy (uses layout when available).
      const layout = this.visualizer.segLayout;
      const rollerPositions = this._rollerPositions;
      let rollerOffset = 0;

      if (layout?.rings?.length) {
        for (const ring of layout.rings) {
          const orbitR = ring.orbitRadiusM * layout.worldScale;
          const startupRamp = Math.min(time * (0.25 + ring.index * 0.1), 1.0);
          for (let i = 0; i < ring.count; i++) {
            const jitterNoise = Math.sin(rollerOffset * 127.3 + ring.index * 53.7);
            const speedJitter = 1.0 + 0.04 * Math.sin(time * 1.3 + jitterNoise * 12.7);
            let angle;
            if (useHardware) {
              angle = (i / ring.count) * Math.PI * 2 + hardwarePhaseRad * ring.speed;
            } else {
              angle = (i / ring.count) * Math.PI * 2
                    + time * 0.5 * ring.speed * speedJitter * startupRamp * spinFactor
                    + ring.index * 0.22;
            }
            rollerPositions[rollerOffset * 2]     = Math.cos(angle) * orbitR;
            rollerPositions[rollerOffset * 2 + 1] = Math.sin(angle) * orbitR;
            rollerOffset++;
          }
        }
      } else {
        for (const ring of rings) {
          const startupRamp = Math.min(time * (0.25 + ring.index * 0.1), 1.0);
          for (let i = 0; i < ring.count; i++) {
            const jitterNoise = Math.sin(rollerOffset * 127.3 + ring.index * 53.7);
            const speedJitter = 1.0 + 0.04 * Math.sin(time * 1.3 + jitterNoise * 12.7);
            let angle;
            if (useHardware) {
              angle = (i / ring.count) * Math.PI * 2 + hardwarePhaseRad * ring.speed;
            } else {
              angle = (i / ring.count) * Math.PI * 2
                    + time * 0.5 * ring.speed * speedJitter * startupRamp * spinFactor
                    + ring.index * 0.22;
            }
            rollerPositions[rollerOffset * 2]     = Math.cos(angle) * ring.radius;
            rollerPositions[rollerOffset * 2 + 1] = Math.sin(angle) * ring.radius;
            rollerOffset++;
          }
        }
      }

      // Update pickup coil energy levels from compact positions
      this.updatePickupCoilEnergies(rollerPositions, true);

      // Update electromagnet coil activation visualization
      this.updateElectromagnetCoils();
    }

    this._computeEnergyLevel(deltaTime);
    this.uniformManager.updateUniforms(this.position, this.rotation, this.renderMode, this.energyLevel);
    this.updateDeviceFlowPaths(deltaTime);
    this.updateEmitterEffects(deltaTime, qualityScale);
  },

  updateDeviceFlowPaths: function (deltaTime) {
    const paths = this.geometry.flowPathParticles;
    const count = this.geometry.flowPathCount;
    if (!paths || !count || !this.fieldLinePipeline) return;

    const t = this.visualizer.time;
    const energy = this.energyLevel;
    const data = this._flowPathData || (this._flowPathData = new Float32Array(count * 8));

    const writePath = (i, x, y, z, strength, life) => {
      const idx = i * 8;
      data[idx] = x;
      data[idx + 1] = y;
      data[idx + 2] = z;
      data[idx + 3] = 0;
      data[idx + 4] = 0;
      data[idx + 5] = 0;
      data[idx + 6] = life;
      data[idx + 7] = strength;
    };

    if (this.id === 'heron') {
      const headN = this.physicsState
        ? this.physicsState.heronHead / Math.max(0.01, this.physicsState.heronHeadMax)
        : this.flowEnergyLevel;
      const flow = this.geometry.heronFlow || { apexY: 6.1, supplyX: 1.6, drainBasinY: -2.2 };
      const jetTop = flow.apexY + headN * 0.35;
      const reservoirY = jetTop - (flow.apexY - flow.drainBasinY) * 0.42;
      const supplyX = flow.supplyX;
      for (let i = 0; i < count; i++) {
        const phase = i / count;
        const side = i % 2 === 0 ? -1 : 1;
        const u = (t * 0.35 * (0.4 + energy) + phase) % 1;
        let x, y, z;
        if (u < 0.25) {
          const k = u / 0.25;
          x = side * supplyX * 0.7 * (1 - k * 0.3);
          y = reservoirY + k * (jetTop - reservoirY);
          z = 0;
        } else if (u < 0.55) {
          const k = (u - 0.25) / 0.3;
          x = side * (supplyX * 0.5 + Math.sin(k * Math.PI) * supplyX * 0.35);
          y = jetTop - k * (jetTop - flow.drainBasinY) * 0.35;
          z = Math.sin(k * Math.PI * 2 + t) * 0.25;
        } else {
          const k = (u - 0.55) / 0.45;
          x = Math.sin(phase * 12.566 + t) * (0.4 + k);
          y = jetTop - (jetTop - flow.drainBasinY) * 0.35 - k * (jetTop - flow.drainBasinY) * 0.65;
          z = Math.cos(phase * 9.42 + t * 1.2) * 0.3;
        }
        writePath(i, x, y, z, energy * (0.4 + headN * 0.6), 0.5 + 0.5 * Math.sin(t * 4 + phase * 20));
      }
    } else if (this.id === 'kelvin') {
      const voltN = this.physicsState?.kelvinVoltageN ?? this.voltageEnergyLevel;
      const spark = this.physicsState?.kelvinSparkTimer > 0 ? 1 : 0;
      for (let i = 0; i < count; i++) {
        const side = i % 2 === 0 ? -2.5 : 2.5;
        const phase = i / count;
        const u = (t * 0.22 + phase * 0.8) % 1;
        const y = 5.5 - u * 9.2;
        const wobble = Math.sin(t * 6 + phase * 31) * (0.05 + voltN * 0.18);
        const lift = voltN > 0.7 ? Math.sin(t * 8 + phase * 17) * voltN * 0.35 : 0;
        const branch = spark > 0 ? (Math.random() - 0.5) * 1.2 : 0;
        writePath(i, side + wobble + branch, y + lift, wobble * 0.5, voltN * 0.85 + spark * 0.4, 0.35 + voltN * 0.65);
      }
    } else if (this.id === 'solar') {
      const charge = this.physicsState?.batteryCharge ?? this.batteryCharge ?? 0;
      for (let i = 0; i < count; i++) {
        const led = i % 6;
        const angle = (led / 6) * Math.PI * 2;
        const r = 3.0;
        const ledX = Math.cos(angle) * r;
        const ledZ = Math.sin(angle) * r;
        const ledY = 3.5;
        const u = (t * 0.28 * (0.35 + charge) + i * 0.017) % 1;
        const panelX = (Math.sin(i * 2.17) * 0.5) * 4.5;
        const panelZ = (Math.cos(i * 1.83) * 0.5) * 4.5;
        const x = ledX + (panelX - ledX) * u;
        const y = ledY + (0.12 - ledY) * u;
        const z = ledZ + (panelZ - ledZ) * u;
        const strength = charge * 0.7 + energy * 0.3;
        writePath(i, x, y, z, strength, 0.45 + 0.55 * (1 - Math.abs(u - 0.5) * 2));
      }
    }

    this.device.queue.writeBuffer(paths, 0, data);
  },

  _computeEnergyLevel: function (deltaTime) {
    const speed = Math.max(0.0, this.speedMult || 1.0);
    const speedNorm = Math.min(1.0, Math.log2(speed + 1.0) / Math.log2(21.0));
    const overdrive = Math.max(0.0, speed - 1.0);
    const overdriveBoost = Math.min(1.0, 1.0 - Math.exp(-overdrive * 0.18));

    let deviceEnergy = speedNorm * 0.4 + overdriveBoost * 0.25;
    if (this.id === 'seg') {
      const coilMean = this.coilEnergies && this.coilEnergies.length
        ? this.coilEnergies.reduce((sum, v) => sum + v, 0) / this.coilEnergies.length
        : 0.0;
      const coilNorm = Math.min(1.0, coilMean * 1.6);
      const opOmega = this.visualizer.segOmega ?? 0;
      const opCorona = this.visualizer.corona ?? 0;
      deviceEnergy = opOmega * 0.45 + coilNorm * 0.30 + this.pwmEnergyLevel * 0.25 + opCorona * 0.2;
    } else if (this.id === 'kelvin') {
      const fromPhysics = this.physicsState?.kelvinVoltageN;
      this.voltageEnergyLevel = fromPhysics != null
        ? fromPhysics
        : Math.min(1.0, speedNorm * 0.65 + (0.5 + 0.5 * Math.sin(this.visualizer.time * 3.2)) * 0.35);
      deviceEnergy = this.voltageEnergyLevel;
    } else if (this.id === 'heron') {
      const fromPhysics = this.physicsState?.energyLevel;
      this.flowEnergyLevel = fromPhysics != null
        ? fromPhysics
        : Math.min(1.0, speedNorm * 0.7 + (0.5 + 0.5 * Math.sin(this.visualizer.time * 1.6)) * 0.3);
      deviceEnergy = this.flowEnergyLevel;
    } else if (this.id === 'solar') {
      const battery = Math.min(1.0, Math.max(0.0, this.physicsState?.batteryCharge ?? this.batteryCharge ?? 0.0));
      deviceEnergy = battery * 0.65 + speedNorm * 0.35;
    } else if (this.id === 'peltier') {
      deviceEnergy = Math.min(1.0, speedNorm * 0.6 + overdriveBoost * 0.4);
    } else if (this.id === 'mhd') {
      deviceEnergy = Math.min(1.0, speedNorm * 0.5 + overdriveBoost * 0.5);
    } else if (this.id === 'maglev') {
      const gapN = this.physicsState?.energyLevel ?? this.energyLevel;
      deviceEnergy = Math.min(1.0, gapN * 0.7 + speedNorm * 0.3);
    }

    // Exponential response in high-energy regime to make overdrive feel dangerous.
    const boosted = Math.pow(Math.max(0.0, deviceEnergy), 0.75);
    const target = Math.min(1.0, boosted + overdriveBoost * 0.35);
    const smooth = 1.0 - Math.exp(-Math.max(0.0, deltaTime) * 14.0);
    this.energyLevel = this.energyLevel + (target - this.energyLevel) * smooth;
    this.energyLevel = Math.min(1.0, Math.max(0.0, this.energyLevel));
  },

  _buildDeviceUniformData: function (renderMode, yOffset = 0.0) {
    const ringIndex = this.getRingIndex();
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
      this.id === 'solar' ? this.batteryCharge : 0,
      this.id === 'solar' ? 1 : 0
    ]);
  },

  updateEmitterEffects: function (deltaTime, qualityScale) {
    if (!this.effectsParticles) {
      this.effectParticleCount = 0;
      return;
    }

    const t = this.visualizer.time;
    const speedMult = this.speedMult || 1.0;
    const energy = this.energyLevel;
    const quality = Math.max(0.0, Math.min(1.0, Math.min(qualityScale, this.visualizer.profiler.qualityLevel)));
    const budget = Math.min(
      this.maxEffectParticles,
      Math.floor(this.maxEffectParticles * quality * Math.min(1.0, 0.28 + speedMult * 0.18 + Math.pow(energy, 1.35) * 0.7))
    );
    if (budget <= 0) {
      this.effectParticleCount = 0;
      return;
    }

    const gate = (value, low, high) => {
      if (high <= low) return value > high ? 1 : 0;
      return Math.max(0, Math.min(1, (value - low) / (high - low)));
    };

    const pushParticle = (x, y, z, phaseEncoded) => {
      if (this.effectParticleCount >= budget) return;
      const idx = this.effectParticleCount * 4;
      this._effectParticleData[idx] = x;
      this._effectParticleData[idx + 1] = y;
      this._effectParticleData[idx + 2] = z;
      this._effectParticleData[idx + 3] = phaseEncoded;
      this.effectParticleCount++;
    };

    this.effectParticleCount = 0;

    if (this.id === 'seg') {
      const coilEnergy = this.coilEnergies
        ? this.coilEnergies.reduce((sum, e) => sum + e, 0) / this.coilEnergies.length
        : 0;
      const opCorona = this.visualizer.corona ?? 0;
      const coronaStrength = Math.max(0.0, Math.min(1.0,
        opCorona * 0.85 + (speedMult - 1.0) * 0.15 + coilEnergy * 0.5 + Math.pow(energy, 1.4) * 0.6));
      const layout = this.visualizer.segLayout;
      const ws = layout?.worldScale ?? 1.0;
      const coronaCount = Math.floor((28 + budget * 0.55) * coronaStrength);

      for (let i = 0; i < coronaCount; i++) {
        const a = (i / Math.max(1, coronaCount)) * Math.PI * 2 + t * (0.35 + coronaStrength);
        let radius = 3.0;
        let y = 0.0;
        if (layout?.rings?.length) {
          const ring = layout.rings[i % layout.rings.length];
          radius = ring.orbitRadiusM * ws + Math.sin(i * 2.31 + t) * 0.12;
          y = (Math.sin(i * 1.93 + t * 1.9) * 0.6 + (Math.random() - 0.5) * 0.25) * (0.8 + coronaStrength * 1.2);
        } else {
          const ring = i % 3;
          radius = (ring === 0 ? 2.4 : ring === 1 ? 3.9 : 5.4) + Math.sin(i * 2.31 + t) * 0.16;
          y = (Math.sin(i * 1.93 + t * 1.9) * 0.8 + (Math.random() - 0.5) * 0.3) * (0.8 + coronaStrength * 1.4);
        }
        pushParticle(Math.cos(a) * radius, y, Math.sin(a) * radius, 2.0 + Math.random());
      }

      // Inner corona sheath (broader, softer billboards hugging rollers)
      const sheathCount = Math.floor(budget * 0.22 * coronaStrength);
      for (let i = 0; i < sheathCount; i++) {
        const a = Math.random() * Math.PI * 2;
        const r = 2.0 + Math.random() * 4.5;
        const y = (Math.random() - 0.5) * 1.2;
        pushParticle(Math.cos(a) * r, y, Math.sin(a) * r, 2.5 + Math.random() * 0.3);
      }

      const burstBase = Math.floor(budget * (0.08 + coronaStrength * 0.35));
      for (let i = 0; i < burstBase; i++) {
        const a = Math.random() * Math.PI * 2;
        const radius = 2.8 + Math.random() * 3.2;
        const y = (Math.random() - 0.5) * 1.6;
        pushParticle(Math.cos(a) * radius, y, Math.sin(a) * radius, 1.0 + Math.random());
      }

      // Roller-gap micro-sparks at high corona (discharge accents)
      if (coronaStrength > 0.45) {
        const sparkCount = Math.floor(budget * 0.12 * (coronaStrength - 0.45) * 1.8);
        for (let i = 0; i < sparkCount; i++) {
          const a = Math.random() * Math.PI * 2;
          const r = 2.2 + Math.random() * 5.0;
          pushParticle(Math.cos(a) * r, (Math.random() - 0.5) * 0.9, Math.sin(a) * r, 1.0 + Math.random());
        }
      }
    } else if (this.id === 'kelvin') {
      const voltageProxy = Math.max(0.0, Math.min(1.0, this.voltageEnergyLevel * 0.7 + Math.pow(energy, 1.2) * 0.5));
      const sparkGate = Math.pow(gate(voltageProxy, 0.24, 0.60), 1.4);
      const branchGate = Math.pow(gate(voltageProxy, 0.58, 0.92), 1.8);
      const sparkCount = Math.floor(budget * 0.58 * sparkGate);
      for (let i = 0; i < sparkCount; i++) {
        const side = i % 2 === 0 ? -1 : 1;
        const y = -2.4 + Math.random() * 8.0;
        const z = (Math.random() - 0.5) * 1.0;
        pushParticle(side * (2.2 + Math.random() * 0.8), y, z, 1.0 + Math.random());
      }

      const filamentCount = Math.floor(budget * 0.16 * sparkGate);
      for (let i = 0; i < filamentCount; i++) {
        const y = -2.8 + (i / Math.max(1, filamentCount)) * 8.8;
        const wobble = Math.sin(i * 1.7 + t * 7.0) * 0.22;
        pushParticle(wobble, y, (Math.random() - 0.5) * 0.4, 3.0 + Math.random());
      }
      const branchCount = Math.floor(budget * 0.24 * branchGate);
      for (let i = 0; i < branchCount; i++) {
        const side = i % 2 === 0 ? -1 : 1;
        const trunk = (Math.random() - 0.5) * 0.5;
        const y = -2.5 + Math.random() * 8.4;
        const z = (Math.random() - 0.5) * (0.5 + branchGate * 1.2);
        pushParticle(side * (0.6 + Math.random() * 2.0) + trunk, y, z, 6.0 + Math.random());
      }
    } else if (this.id === 'heron') {
      const flowGate = Math.pow(gate(this.flowEnergyLevel, 0.18, 0.58), 1.2);
      const impactGate = Math.pow(gate(this.flowEnergyLevel, 0.55, 0.90), 1.6);
      const flow = this.geometry.heronFlow || { apexY: 6.1, drainBasinY: -2.2 };
      const headN = this.physicsState
        ? this.physicsState.heronHead / Math.max(0.01, this.physicsState.heronHeadMax)
        : this.flowEnergyLevel;
      const jetY = flow.apexY + headN * 0.25;
      const basinY = flow.drainBasinY;
      const mistCount = Math.floor(budget * 0.56 * flowGate);
      const clusterA = [Math.sin(t * 0.8) * 0.25, jetY - 0.9 + Math.sin(t * 1.2) * 0.12, Math.cos(t * 0.9) * 0.25];
      const clusterB = [-clusterA[0], jetY - 0.4 + Math.cos(t * 1.1) * 0.12, -clusterA[2]];
      for (let i = 0; i < mistCount; i++) {
        const c = i % 2 === 0 ? clusterA : clusterB;
        const r = Math.random() * 1.1;
        const a = Math.random() * Math.PI * 2;
        pushParticle(c[0] + Math.cos(a) * r, c[1] + (Math.random() - 0.5) * 1.5, c[2] + Math.sin(a) * r, Math.random());
      }
      const rippleCount = Math.floor(budget * 0.30 * impactGate);
      for (let i = 0; i < rippleCount; i++) {
        const a = Math.random() * Math.PI * 2;
        const r = 0.3 + Math.random() * 1.3;
        const y = basinY + 0.3 + Math.random() * 0.35;
        pushParticle(Math.cos(a) * r, y, Math.sin(a) * r, 5.0 + Math.random());
      }
    } else if (this.id === 'solar') {
      const batteryGate = Math.pow(gate(this.batteryCharge * 0.75 + energy * 0.25, 0.20, 0.78), 1.3);
      const refractGate = Math.pow(gate(this.batteryCharge * 0.6 + energy * 0.4, 0.55, 0.92), 1.8);
      const photonCount = Math.floor(budget * 0.45 * batteryGate);
      for (let i = 0; i < photonCount; i++) {
        const led = i % 6;
        const a = (led / 6) * Math.PI * 2 + (Math.random() - 0.5) * 0.18;
        const r = 3.0 + Math.random() * 0.6;
        const y = 2.8 + Math.random() * 1.2;
        pushParticle(Math.cos(a) * r, y, Math.sin(a) * r, 1.0 + Math.random());
      }
      const refractCount = Math.floor(budget * 0.20 * refractGate);
      for (let i = 0; i < refractCount; i++) {
        const x = (Math.random() - 0.5) * 5.8;
        const z = (Math.random() - 0.5) * 5.8;
        const y = 0.9 + Math.random() * 0.5;
        pushParticle(x, y, z, 7.0 + Math.random());
      }
    } else if (this.id === 'peltier') {
      const thermalGate = Math.pow(gate(energy, 0.24, 0.70), 1.4);
      const thermalCount = Math.floor(budget * 0.36 * thermalGate);
      for (let i = 0; i < thermalCount; i++) {
        const x = (Math.random() - 0.5) * 3.2;
        const y = (Math.random() - 0.5) * 1.8;
        const z = (Math.random() - 0.5) * 2.6;
        pushParticle(x, y, z, 3.0 + Math.random());
      }
    } else if (this.id === 'mhd') {
      const channelGate = Math.pow(gate(energy, 0.22, 0.68), 1.45);
      const filamentCount = Math.floor(budget * 0.40 * channelGate);
      for (let i = 0; i < filamentCount; i++) {
        const drift = Math.sin(t * 1.6 + i * 0.23) * 0.8;
        const x = (Math.random() - 0.5) * 4.4 + drift;
        const y = (Math.random() - 0.5) * 2.4;
        const z = (Math.random() - 0.5) * 1.8;
        pushParticle(x, y, z, 3.0 + Math.random());
      }
    } else if (this.id === 'maglev') {
      const fieldGate = Math.pow(gate(energy, 0.2, 0.75), 1.3);
      const gap = this.physicsState?.maglevGap ?? 0.018;
      const orbitCount = Math.floor(budget * 0.42 * fieldGate);
      for (let i = 0; i < orbitCount; i++) {
        const a = (i / Math.max(1, orbitCount)) * Math.PI * 2 + t * 1.2;
        const r = 1.0 + Math.random() * 2.0;
        const y = 0.55 + gap + Math.sin(t * 4 + i * 0.31) * 0.12;
        pushParticle(Math.cos(a) * r, y, Math.sin(a) * r, 3.0 + Math.random());
      }
    }

    // Subtle thermal haze billboards around hot devices.
    if ((this.id === 'seg' || this.id === 'peltier' || this.id === 'mhd' || this.id === 'maglev') && energy > 0.35) {
      const hazeCount = Math.floor(budget * Math.pow(gate(energy, 0.35, 0.9), 1.4) * 0.18);
      for (let i = 0; i < hazeCount; i++) {
        const a = Math.random() * Math.PI * 2;
        const r = 2.4 + Math.random() * 3.0;
        const y = (Math.random() - 0.5) * 2.2;
        pushParticle(Math.cos(a) * r, y, Math.sin(a) * r, 4.0 + Math.random());
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

  updateElectromagnetCoils: function () {
    if (!this.electromagnetInstances) return;

    const hw = this.visualizer.hardwareBridge;
    const em = this.visualizer.emController;
    const useHardware = hw?.isConnected && (hw.mirrorEnabled || hw.twinMode === 'closed' || hw.twinMode === 'shadow');

    let numCoils = em?.numCoils || 8;
    let coilMask = 0;
    let pwmValues = null;

    // Determine phase to use for commutation
    let phaseDeg;
    if (useHardware) {
      phaseDeg = hw.actualPhase;
      numCoils = hw.config.numCoils;
      // Use hardware-reported coil mask if available, otherwise compute
      coilMask = hw.coilMask || 0;
    } else if (em) {
      // Simulated: compute from visualizer time
      const simulatedSpeed = 30; // RPM for demo visualization
      phaseDeg = (this.visualizer.time * simulatedSpeed * 6) % 360;
      if (phaseDeg < 0) phaseDeg += 360;
      coilMask = em.computeCoilMask(phaseDeg, 1);
      pwmValues = em.computePwmValues(phaseDeg, 1);
    } else {
      this.pwmEnergyLevel = 0.0;
      return;
    }

    // If hardware is connected but coil mask is stale/empty, fall back to computed
    if (useHardware && coilMask === 0 && em) {
      coilMask = em.computeCoilMask(phaseDeg, 1);
    }

    // Update layout if coil count changed
    if (this._lastCoilCount !== numCoils) {
      this.geometry.updateElectromagnetLayout(numCoils, em?.offsetAngle || 0);
      this._lastCoilCount = numCoils;
    }

    // Read current instance data, update only the activeIntensity field
    // Format per instance: position(3) + angle(1) + activeIntensity(1) + coilIndex(1) + pad(2)
    const maxCoils = 24;
    const instanceData = new Float32Array(maxCoils * 8);
    const radius = 7.2;
    const offsetRad = ((em?.offsetAngle || 0) * Math.PI) / 180;

    // Traveling wave parameters for electromagnet pulse animation
    const t = this.visualizer.time;
    const waveSpeed = 3.0;

    for (let i = 0; i < maxCoils; i++) {
      const idx = i * 8;
      if (i < numCoils) {
        const angle = (i / numCoils) * Math.PI * 2 + offsetRad;
        instanceData[idx] = Math.cos(angle) * radius;
        instanceData[idx + 1] = 0.0;
        instanceData[idx + 2] = Math.sin(angle) * radius;
        instanceData[idx + 3] = angle;

        // Determine base active intensity from commutation state
        let intensity = 0;
        if (coilMask & (1 << i)) {
          intensity = pwmValues ? (pwmValues[i] / 255) : 1.0;
        }

        // Apply traveling wave pulse with per-coil phase offset
        const phaseOffset = (i / numCoils) * Math.PI * 2;
        const wave = 0.5 + 0.5 * Math.sin(t * waveSpeed - phaseOffset);
        if (intensity > 0) {
          // Active coil: strong pulse modulation
          intensity = intensity * (0.65 + 0.35 * wave);
        } else {
          // Inactive coil: faint ambient traveling glow
          intensity = wave * 0.06;
        }

        instanceData[idx + 4] = intensity;
        instanceData[idx + 5] = i;
        instanceData[idx + 6] = 0;
        instanceData[idx + 7] = 0;
      } else {
        instanceData[idx] = 0;
        instanceData[idx + 1] = -1000;
        instanceData[idx + 2] = 0;
        instanceData[idx + 3] = 0;
        instanceData[idx + 4] = 0;
        instanceData[idx + 5] = i;
        instanceData[idx + 6] = 0;
        instanceData[idx + 7] = 0;
      }
    }

    if (numCoils > 0) {
      let activeSum = 0;
      for (let i = 0; i < numCoils; i++) activeSum += instanceData[i * 8 + 4];
      this.pwmEnergyLevel = Math.min(1.0, activeSum / numCoils);
    } else {
      this.pwmEnergyLevel = 0.0;
    }

    this.device.queue.writeBuffer(this.electromagnetInstances, 0, instanceData);
  },

  updatePickupCoilEnergies: function (rollerData, compact = false) {
    if (!this.coilInstances) return;

    const numCoils = 24;
    const coilRadius = 7.0;

    // Initialize coil energies array if needed
    if (!this.coilEnergies) {
      this.coilEnergies = new Float32Array(numCoils);
    }

    // Coil data packed as vec4f pairs for the shader
    const coilInstanceData = new Float32Array(numCoils * 8);

    for (let i = 0; i < numCoils; i++) {
      const coilAngle = (i / numCoils) * Math.PI * 2;
      const coilX = Math.cos(coilAngle) * coilRadius;
      const coilZ = Math.sin(coilAngle) * coilRadius;

      // Find nearest roller and calculate energy
      let minDistance = Infinity;
      let nearestRollerSpeed = 0;

      // Check all 36 rollers (3 rings: 8 + 12 + 16)
      for (let r = 0; r < 36; r++) {
        const rollerX = compact ? rollerData[r * 2]     : rollerData[r * 12];
        const rollerZ = compact ? rollerData[r * 2 + 1] : rollerData[r * 12 + 2];

        const dx = coilX - rollerX;
        const dz = coilZ - rollerZ;
        const dist = Math.sqrt(dx * dx + dz * dz);

        if (dist < minDistance) {
          minDistance = dist;
          // Ring speed factors: inner=2.0, middle=1.0, outer=0.5
          if (r < 8) nearestRollerSpeed = 2.0;
          else if (r < 20) nearestRollerSpeed = 1.0;
          else nearestRollerSpeed = 0.5;
        }
      }

      // Calculate energy: higher when rollers are closer, modulated by roller speed
      const energy = Math.max(0, 1 - minDistance / 3.0) * nearestRollerSpeed * 0.5;

      // Smooth energy transition
      this.coilEnergies[i] = this.coilEnergies[i] * 0.9 + energy * 0.1;

      // Rotation: face inward (toward center)
      const rotAngle = coilAngle + Math.PI;
      const rotY = Math.sin(rotAngle / 2);
      const rotW = Math.cos(rotAngle / 2);

      // Pack data into two vec4f
      coilInstanceData[i * 8] = coilX;
      coilInstanceData[i * 8 + 1] = 0;
      coilInstanceData[i * 8 + 2] = coilZ;
      coilInstanceData[i * 8 + 3] = 0;

      coilInstanceData[i * 8 + 4] = rotY;
      coilInstanceData[i * 8 + 5] = 0;
      coilInstanceData[i * 8 + 6] = rotW;
      coilInstanceData[i * 8 + 7] = this.coilEnergies[i];
    }

    this.device.queue.writeBuffer(this.coilInstances, 0, coilInstanceData);

    // Field-line particles are now animated by the GPU field-advect compute
    // shader dispatched in the compute pass; no CPU updateFieldLines() call needed.

    // Update energy arcs
    if (this.arcSegments && this.energyArcEnabled) {
      this.updateEnergyArcs();
    }
  },

  updateFieldLines: function (deltaTime) {
    // Animate field line particles flowing along magnetic field lines
    const fieldData = new Float32Array(this.fieldLineCount * 8);
    const time = this.visualizer.time;

    for (let i = 0; i < this.fieldLineCount; i++) {
      const idx = i * 8;

      // Get ring for this particle
      const ringIdx = i % 3;
      const ringRadii = [2.5, 4.0, 5.5];
      const ringRadius = ringRadii[ringIdx];

      // Flow along circular magnetic field line
      const baseAngle = (i / this.fieldLineCount) * Math.PI * 20 + time * (0.5 + ringIdx * 0.3);
      const heightOffset = Math.sin(time * 0.5 + i * 0.1) * 0.8;

      // Position along magnetic field line
      fieldData[idx] = Math.cos(baseAngle) * ringRadius;
      fieldData[idx + 1] = heightOffset + (Math.random() - 0.5) * 0.2;
      fieldData[idx + 2] = Math.sin(baseAngle) * ringRadius;

      // Velocity tangent to field line
      const speed = 1.0 + ringIdx * 0.5;
      fieldData[idx + 3] = -Math.sin(baseAngle) * speed;
      fieldData[idx + 4] = Math.cos(time * 2 + i * 0.05) * 0.1;
      fieldData[idx + 5] = Math.cos(baseAngle) * speed;

      // Life cycles through 0-1
      fieldData[idx + 6] = (Math.sin(time * 2 + i * 0.5) * 0.5 + 0.5);

      // Strength varies by position
      fieldData[idx + 7] = 0.3 + 0.7 * Math.sin(baseAngle * 3 + time);
    }

    this.device.queue.writeBuffer(this.fieldLineParticles, 0, fieldData);
  },

  updateEnergyArcs: function () {
    if (!this.arcSegments) return;
    const arcCount = 200;
    const arcData = new Float32Array(arcCount * 8);
    const time = this.visualizer.time;
    const speedMult = this.speedMult || 1.0;

    for (let i = 0; i < arcCount; i++) {
      const idx = i * 8;
      // Spread arcs around the outer coil ring
      const arcAngle = (i / arcCount) * Math.PI * 2 + time * 0.3 * speedMult;
      const arcRadius = 5.5 + (Math.random() - 0.5) * 0.8;
      const arcHeight = (Math.random() - 0.5) * 0.6;

      arcData[idx]     = Math.cos(arcAngle) * arcRadius;
      arcData[idx + 1] = arcHeight;
      arcData[idx + 2] = Math.sin(arcAngle) * arcRadius;

      // Velocity: outward radial
      arcData[idx + 3] = Math.cos(arcAngle) * 0.5;
      arcData[idx + 4] = 0.1;
      arcData[idx + 5] = Math.sin(arcAngle) * 0.5;

      // Life and intensity
      arcData[idx + 6] = Math.sin(time * 5.0 * speedMult + i * 0.3) * 0.5 + 0.5;
      arcData[idx + 7] = Math.min(1.0, 0.4 + 0.6 * speedMult * 0.2);
    }

    this.device.queue.writeBuffer(this.arcSegments, 0, arcData);
  },

  _updateFrameVibration: function () {
    const v = this.visualizer;
    if (v.segFrameLevel === 'off' || !v.frameStructuralInstanceBuffer) return;

    const statorH = v.segFrameBuffers?.dims?.statorH ?? 0.4;
    const omega = Math.min(1.2, (this.speedMult || 0) * 0.012 + this.energyLevel * 0.35);
    const [dx, dy, dz] = frameVibrationOffset(omega, statorH);

    const writeInst = (buf, ringIndex, color) => {
      if (!buf) return;
      this.device.queue.writeBuffer(buf, 0, new Float32Array([
        dx, dy, dz,
        ringIndex,
        0, 0, 0, 1,
        color[0], color[1], color[2],
        0.0
      ]));
    };

    writeInst(v.frameStructuralInstanceBuffer, 11.0, [0.74, 0.76, 0.80]);
    writeInst(v.frameControlInstanceBuffer, 11.0, [0.62, 0.64, 0.68]);
    writeInst(v.frameCageInstanceBuffer, 12.0, [0.50, 0.54, 0.60]);
    writeInst(v.frameLabBenchInstanceBuffer, 13.0, [0.42, 0.40, 0.38]);
  },

};
