import { frameVibrationOffset } from '../../seg-frame-model.js';
import { MATERIAL_COIL_FORMER, MATERIAL_LAB_BASE, MATERIAL_STRUCTURAL } from '../material-roles.js';

const SEG_RINGS = [
  { count: 8, radius: 2.5, speed: 2.0, index: 0 },
  { count: 12, radius: 4.0, speed: 1.0, index: 1 },
  { count: 16, radius: 5.5, speed: 0.5, index: 2 }
];

export function segGetComputeSpeed(instance, baseSpeed) {
  return baseSpeed * (0.15 + 0.85 * (instance.visualizer.segOmega ?? 0));
}

export function segUpdateDynamics(instance, ctx) {
  if (!instance.rollerInstances) return;

  const time = instance.visualizer.time;
  const speedMult = instance.speedMult || 1.0;
  const { deltaTime } = ctx;

  if (instance.rollerComputeUniformBuffer) {
    const presetVal = instance.visualizer.prototypePreset === 'lab' ? 1.0 : 0.0;
    const segOmega = Math.max(0.02, instance.visualizer.segOmega ?? 1.0);
    instance.device.queue.writeBuffer(
      instance.rollerComputeUniformBuffer, 0,
      new Float32Array([time, speedMult, presetVal, segOmega])
    );
  }
  if (instance.fieldAdvectUniformBuffer && instance.geometry.fieldLineParticles) {
    instance.device.queue.writeBuffer(
      instance.fieldAdvectUniformBuffer, 0,
      new Float32Array([time, speedMult, instance.fieldLineCount, 0])
    );
  }
  if (instance.fluxTracerUniformBuffer) {
    const corona = instance.visualizer.corona ?? 0;
    const segOmega = Math.max(0.02, instance.visualizer.segOmega ?? 0);
    const lineOpacity = 1.0 + instance.energyLevel * 0.55 + corona * 0.45;
    const follow = 1.0 + Math.min(0.35, instance.energyLevel * 0.25 + segOmega * 0.15);
    instance.device.queue.writeBuffer(
      instance.fluxTracerUniformBuffer, 0,
      new Float32Array([time, deltaTime, 0.016, lineOpacity, 0.055, follow, 0.0, 0.0])
    );
  }

  segUpdateFrameVibration(instance);

  const hw = instance.visualizer.hardwareBridge;
  const useHardware = hw?.isConnected && (hw.mirrorEnabled || hw.twinMode === 'closed');
  const hardwarePhaseRad = useHardware ? (hw.actualPhase * Math.PI / 180) : null;
  const spinFactor = Math.max(0.02, instance.visualizer.segOmega ?? 1.0);

  const layout = instance.visualizer.segLayout;
  const rollerPositions = instance._rollerPositions;
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
        rollerPositions[rollerOffset * 2] = Math.cos(angle) * orbitR;
        rollerPositions[rollerOffset * 2 + 1] = Math.sin(angle) * orbitR;
        rollerOffset++;
      }
    }
  } else {
    for (const ring of SEG_RINGS) {
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
        rollerPositions[rollerOffset * 2] = Math.cos(angle) * ring.radius;
        rollerPositions[rollerOffset * 2 + 1] = Math.sin(angle) * ring.radius;
        rollerOffset++;
      }
    }
  }

  segUpdatePickupCoilEnergies(instance, rollerPositions, true);
  segUpdateElectromagnetCoils(instance);
}

export function segComputeRawEnergy(instance) {
  const coilMean = instance.coilEnergies && instance.coilEnergies.length
    ? instance.coilEnergies.reduce((sum, v) => sum + v, 0) / instance.coilEnergies.length
    : 0.0;
  const coilNorm = Math.min(1.0, coilMean * 1.6);
  const opOmega = instance.visualizer.segOmega ?? 0;
  const opCorona = instance.visualizer.corona ?? 0;
  return opOmega * 0.45 + coilNorm * 0.30 + instance.pwmEnergyLevel * 0.25 + opCorona * 0.2;
}

export function segUpdateEffects(instance, ctx) {
  const { budget, energy, time, speedMult, pushParticle, gate } = ctx;
  const coilEnergy = instance.coilEnergies
    ? instance.coilEnergies.reduce((sum, e) => sum + e, 0) / instance.coilEnergies.length
    : 0;
  const opCorona = instance.visualizer.corona ?? 0;
  const coronaStrength = Math.max(0.0, Math.min(1.0,
    opCorona * 0.85 + (speedMult - 1.0) * 0.15 + coilEnergy * 0.5 + Math.pow(energy, 1.4) * 0.6));
  const layout = instance.visualizer.segLayout;
  const ws = layout?.worldScale ?? 1.0;
  const coronaCount = Math.floor((28 + budget * 0.55) * coronaStrength);

  for (let i = 0; i < coronaCount; i++) {
    const a = (i / Math.max(1, coronaCount)) * Math.PI * 2 + time * (0.35 + coronaStrength);
    let radius = 3.0;
    let y = 0.0;
    if (layout?.rings?.length) {
      const ring = layout.rings[i % layout.rings.length];
      radius = ring.orbitRadiusM * ws + Math.sin(i * 2.31 + time) * 0.12;
      y = (Math.sin(i * 1.93 + time * 1.9) * 0.6 + (Math.random() - 0.5) * 0.25) * (0.8 + coronaStrength * 1.2);
    } else {
      const ring = i % 3;
      radius = (ring === 0 ? 2.4 : ring === 1 ? 3.9 : 5.4) + Math.sin(i * 2.31 + time) * 0.16;
      y = (Math.sin(i * 1.93 + time * 1.9) * 0.8 + (Math.random() - 0.5) * 0.3) * (0.8 + coronaStrength * 1.4);
    }
    pushParticle(Math.cos(a) * radius, y, Math.sin(a) * radius, 2.0 + Math.random());
  }

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

  if (coronaStrength > 0.45) {
    const sparkCount = Math.floor(budget * 0.12 * (coronaStrength - 0.45) * 1.8);
    for (let i = 0; i < sparkCount; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 2.2 + Math.random() * 5.0;
      pushParticle(Math.cos(a) * r, (Math.random() - 0.5) * 0.9, Math.sin(a) * r, 1.0 + Math.random());
    }
  }
  return true;
}

export function segUpdateElectromagnetCoils(instance) {
  if (!instance.electromagnetInstances) return;

  const hw = instance.visualizer.hardwareBridge;
  const em = instance.visualizer.emController;
  const useHardware = hw?.isConnected && (hw.mirrorEnabled || hw.twinMode === 'closed' || hw.twinMode === 'shadow');

  let numCoils = em?.numCoils || 8;
  let coilMask = 0;
  let pwmValues = null;

  let phaseDeg;
  if (useHardware) {
    phaseDeg = hw.actualPhase;
    numCoils = hw.config.numCoils;
    coilMask = hw.coilMask || 0;
  } else if (em) {
    const simulatedSpeed = 30;
    phaseDeg = (instance.visualizer.time * simulatedSpeed * 6) % 360;
    if (phaseDeg < 0) phaseDeg += 360;
    coilMask = em.computeCoilMask(phaseDeg, 1);
    pwmValues = em.computePwmValues(phaseDeg, 1);
  } else {
    instance.pwmEnergyLevel = 0.0;
    return;
  }

  if (useHardware && coilMask === 0 && em) {
    coilMask = em.computeCoilMask(phaseDeg, 1);
  }

  if (instance._lastCoilCount !== numCoils) {
    instance.geometry.updateElectromagnetLayout(numCoils, em?.offsetAngle || 0);
    instance._lastCoilCount = numCoils;
  }

  const maxCoils = 24;
  const instanceData = new Float32Array(maxCoils * 8);
  const radius = 7.2;
  const offsetRad = ((em?.offsetAngle || 0) * Math.PI) / 180;
  const t = instance.visualizer.time;
  const waveSpeed = 3.0;

  for (let i = 0; i < maxCoils; i++) {
    const idx = i * 8;
    if (i < numCoils) {
      const angle = (i / numCoils) * Math.PI * 2 + offsetRad;
      instanceData[idx] = Math.cos(angle) * radius;
      instanceData[idx + 1] = 0.0;
      instanceData[idx + 2] = Math.sin(angle) * radius;
      instanceData[idx + 3] = angle;

      let intensity = 0;
      if (coilMask & (1 << i)) {
        intensity = pwmValues ? (pwmValues[i] / 255) : 1.0;
      }

      const phaseOffset = (i / numCoils) * Math.PI * 2;
      const wave = 0.5 + 0.5 * Math.sin(t * waveSpeed - phaseOffset);
      if (intensity > 0) {
        intensity = intensity * (0.65 + 0.35 * wave);
      } else {
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
    instance.pwmEnergyLevel = Math.min(1.0, activeSum / numCoils);
  } else {
    instance.pwmEnergyLevel = 0.0;
  }

  instance.device.queue.writeBuffer(instance.electromagnetInstances, 0, instanceData);
}

export function segUpdatePickupCoilEnergies(instance, rollerData, compact = false) {
  if (!instance.coilInstances) return;

  const numCoils = 24;
  const coilRadius = 7.0;

  if (!instance.coilEnergies) {
    instance.coilEnergies = new Float32Array(numCoils);
  }

  const coilInstanceData = new Float32Array(numCoils * 8);

  for (let i = 0; i < numCoils; i++) {
    const coilAngle = (i / numCoils) * Math.PI * 2;
    const coilX = Math.cos(coilAngle) * coilRadius;
    const coilZ = Math.sin(coilAngle) * coilRadius;

    let minDistance = Infinity;
    let nearestRollerSpeed = 0;

    for (let r = 0; r < 36; r++) {
      const rollerX = compact ? rollerData[r * 2] : rollerData[r * 12];
      const rollerZ = compact ? rollerData[r * 2 + 1] : rollerData[r * 12 + 2];

      const dx = coilX - rollerX;
      const dz = coilZ - rollerZ;
      const dist = Math.sqrt(dx * dx + dz * dz);

      if (dist < minDistance) {
        minDistance = dist;
        if (r < 8) nearestRollerSpeed = 2.0;
        else if (r < 20) nearestRollerSpeed = 1.0;
        else nearestRollerSpeed = 0.5;
      }
    }

    const energy = Math.max(0, 1 - minDistance / 3.0) * nearestRollerSpeed * 0.5;
    instance.coilEnergies[i] = instance.coilEnergies[i] * 0.9 + energy * 0.1;

    const rotAngle = coilAngle + Math.PI;
    const rotY = Math.sin(rotAngle / 2);
    const rotW = Math.cos(rotAngle / 2);

    coilInstanceData[i * 8] = coilX;
    coilInstanceData[i * 8 + 1] = 0;
    coilInstanceData[i * 8 + 2] = coilZ;
    coilInstanceData[i * 8 + 3] = 0;
    coilInstanceData[i * 8 + 4] = rotY;
    coilInstanceData[i * 8 + 5] = 0;
    coilInstanceData[i * 8 + 6] = rotW;
    coilInstanceData[i * 8 + 7] = instance.coilEnergies[i];
  }

  instance.device.queue.writeBuffer(instance.coilInstances, 0, coilInstanceData);

  if (instance.arcSegments && instance.energyArcEnabled) {
    segUpdateEnergyArcs(instance);
  }
}

export function segUpdateEnergyArcs(instance) {
  if (!instance.arcSegments) return;
  const arcCount = 200;
  const arcData = new Float32Array(arcCount * 8);
  const time = instance.visualizer.time;
  const speedMult = instance.speedMult || 1.0;

  for (let i = 0; i < arcCount; i++) {
    const idx = i * 8;
    const arcAngle = (i / arcCount) * Math.PI * 2 + time * 0.3 * speedMult;
    const arcRadius = 5.5 + (Math.random() - 0.5) * 0.8;
    const arcHeight = (Math.random() - 0.5) * 0.6;

    arcData[idx] = Math.cos(arcAngle) * arcRadius;
    arcData[idx + 1] = arcHeight;
    arcData[idx + 2] = Math.sin(arcAngle) * arcRadius;
    arcData[idx + 3] = Math.cos(arcAngle) * 0.5;
    arcData[idx + 4] = 0.1;
    arcData[idx + 5] = Math.sin(arcAngle) * 0.5;
    arcData[idx + 6] = Math.sin(time * 5.0 * speedMult + i * 0.3) * 0.5 + 0.5;
    arcData[idx + 7] = Math.min(1.0, 0.4 + 0.6 * speedMult * 0.2);
  }

  instance.device.queue.writeBuffer(instance.arcSegments, 0, arcData);
}

export function segUpdateFrameVibration(instance) {
  const v = instance.visualizer;
  if (v.segFrameLevel === 'off' || !v.frameStructuralInstanceBuffer) return;

  const statorH = v.segFrameBuffers?.dims?.statorH ?? 0.4;
  const omega = Math.min(1.2, (instance.speedMult || 0) * 0.012 + instance.energyLevel * 0.35);
  const [dx, dy, dz] = frameVibrationOffset(omega, statorH);

  const writeInst = (buf, ringIndex, color) => {
    if (!buf) return;
    instance.device.queue.writeBuffer(buf, 0, new Float32Array([
      dx, dy, dz,
      ringIndex,
      0, 0, 0, 1,
      color[0], color[1], color[2],
      0.0
    ]));
  };

  writeInst(v.frameStructuralInstanceBuffer, MATERIAL_STRUCTURAL, [0.74, 0.76, 0.80]);
  writeInst(v.frameControlInstanceBuffer, MATERIAL_STRUCTURAL, [0.62, 0.64, 0.68]);
  writeInst(v.frameCageInstanceBuffer, MATERIAL_COIL_FORMER, [0.50, 0.54, 0.60]);
  writeInst(v.frameLabBenchInstanceBuffer, MATERIAL_LAB_BASE, [0.42, 0.40, 0.38]);
}
