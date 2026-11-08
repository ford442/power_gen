/**
 * Closed-form particle orbits for the Quanta / lighter benches — the CPU twins
 * of the `pos*` helpers in passes/particle-compute.wgsl. Pure functions of
 * (phase, index, time, normalised drive), consumed by `stepParticles` in
 * particle-physics.ts (split out for the 700-line gate).
 */

const TAU = Math.PI * 2;

export interface ParticlePhase {
  phase: number;
}

export function integrateMagLev(
  p: ParticlePhase,
  idx: number,
  t: number,
  gap = 0.018,
  field = 0.5
): [number, number, number] {
  const phase = p.phase;
  const angle = phase * TAU + t * (0.7 + field * 0.5) + idx * 0.017;
  const r = 0.9 + ((idx * 0.131) % 1) * 2.0;
  const y = 0.55 + gap + Math.sin(t * 3.2 + phase * 11.0) * 0.07 * (0.4 + field);
  return [Math.cos(angle) * r, y, Math.sin(angle) * r];
}

export function integrateHomopolar(
  p: ParticlePhase,
  idx: number,
  t: number,
  rpmN = 0,
  emfN = 0,
  discAngle = 0
): [number, number, number] {
  const phase = p.phase;
  const rFrac = ((idx * 0.618034 + phase * 0.37) % 1 + 1) % 1;
  const drift = ((phase + t * (0.12 + emfN * 0.35)) % 1 + 1) % 1;
  const r = (0.18 + 1.15 * drift * (0.35 + rFrac * 0.65));
  const theta = discAngle + phase * TAU + t * (0.4 + rpmN * 3.5) + idx * 0.011;
  const y = 0.16 + Math.sin(t * 4.0 + phase * 18.0) * 0.04 * (0.3 + emfN);
  return [Math.cos(theta) * r, y, Math.sin(theta) * r];
}

export function integratePulseCoil(
  p: ParticlePhase,
  idx: number,
  t: number,
  iN = 0,
  bN = 0,
  travel = 0
): [number, number, number] {
  const phase = p.phase;
  const angle = phase * TAU + t * (0.9 + iN * 2.5) + idx * 0.019;
  const r = 0.35 + (((idx * 0.211 + phase) % 1 + 1) % 1) * (0.9 + iN * 0.8);
  const y = 0.2 + travel * 0.55 + Math.sin(t * 5.0 + phase * 14.0) * 0.08 * (0.3 + bN);
  return [Math.cos(angle) * r, y, Math.sin(angle) * r];
}

export function integrateHalbach(
  p: ParticlePhase,
  idx: number,
  t: number,
  segN = 8,
  peakB = 0.5
): [number, number, number] {
  const phase = p.phase;
  const angle = phase * TAU + t * (0.5 + peakB * 0.8) + idx * 0.013;
  const r = 0.7 + (((idx * 0.173 + segN * 0.04) % 1 + 1) % 1) * 2.4;
  const y = 0.25 + Math.sin(t * 2.8 + phase * 9.0) * 0.12 * (0.35 + peakB);
  return [Math.cos(angle) * r, y, Math.sin(angle) * r];
}

export function integrateMHD(
  p: ParticlePhase,
  idx: number,
  t: number,
  flowN = 0.4,
  bN = 0.4
): [number, number, number] {
  const phase = p.phase;
  const drift = (((phase + t * (0.35 + flowN * 0.9)) % 1) + 1) % 1;
  const x = -2.1 + drift * 4.2;
  const swirl = bN * 0.55;
  const y = Math.sin(t * 2.2 + phase * 11.0 + idx * 0.07) * swirl
    + ((((idx * 0.137) % 1) + 1) % 1 - 0.5) * 0.7;
  const z = Math.cos(t * 1.8 + phase * 8.0) * swirl * 0.75
    + ((((idx * 0.191) % 1) + 1) % 1 - 0.5) * 0.5;
  return [x, y, z];
}

export function integratePeltier(
  p: ParticlePhase,
  idx: number,
  t: number,
  deltaTN = 0.4,
  hotN = 0.3
): [number, number, number] {
  const phase = p.phase;
  const speed = 0.35 + deltaTN * 0.55;
  const cycleT = (((t * speed + phase) % 1) + 1) % 1;
  const x = ((((idx * 0.173 + phase) % 1) + 1) % 1 - 0.5) * 1.8;
  const z = ((((idx * 0.211 + phase * 0.7) % 1) + 1) % 1 - 0.5) * 1.4;
  const rising = idx % 2 === 0;
  const y = rising
    ? -0.35 + cycleT * 0.9 + Math.sin(t * 3.0 + phase * 9.0) * 0.04 * (0.3 + hotN)
    : 0.55 - cycleT * 0.8 - Math.sin(t * 2.5 + phase * 7.0) * 0.03 * (0.3 + deltaTN);
  return [x, y, z];
}

export function integrateTransformer(
  p: ParticlePhase,
  idx: number,
  t: number,
  ipN = 0.3,
  isN = 0.3,
  fluxN = 0.3
): [number, number, number] {
  const phase = p.phase;
  const u = (((phase + t * (0.25 + ipN * 0.35 + isN * 0.25)) % 1) + 1) % 1;
  if (u < 0.35) {
    const a = (u / 0.35) * TAU + t * (1.0 + ipN);
    return [-0.55 + Math.cos(a) * 0.28, 0.15 + Math.sin(a) * 0.22, Math.sin(a * 2.0) * 0.1];
  }
  if (u < 0.65) {
    const s = (u - 0.35) / 0.3;
    return [-0.55 + s * 1.1, 0.55 + Math.sin(t * 3.5 + phase * 8.0) * 0.06 * fluxN, 0];
  }
  const a = ((u - 0.65) / 0.35) * TAU + t * (1.2 + isN);
  return [0.55 + Math.cos(a) * 0.24, 0.15 + Math.sin(a) * 0.2, Math.sin(a * 2.0 + 1.0) * 0.1];
}

/** Mirrors posVdg in particle-compute.wgsl. */
export function integrateVdg(
  p: ParticlePhase,
  idx: number,
  t: number,
  chargeN = 0,
  sparkGlow = 0
): [number, number, number] {
  const phase = p.phase;
  const side = (idx & 1) === 1 ? 1 : -1;
  const topY = 1.13;
  const botY = -0.55;
  const cycleT = (((t * (0.4 + chargeN * 0.3) + phase) % 1) + 1) % 1;
  const y = botY + (topY - botY) * cycleT;
  const jitter = Math.sin(t * 6.0 + phase * 20.0) * 0.02;
  let x = side * 0.09 + jitter;
  let z = jitter * 0.5;
  if (cycleT > 0.92) {
    const burst = sparkGlow * Math.sin(phase * 53.0 + t * 15.0);
    x += burst * 0.5;
    z += burst * 0.3;
  }
  return [x, y, z];
}

/** Mirrors posHall in particle-compute.wgsl. */
export function integrateHall(
  p: ParticlePhase,
  idx: number,
  t: number,
  iN = 0,
  bN = 0
): [number, number, number] {
  const phase = p.phase;
  const stripL = 0.5;
  const stripW = 0.08;
  const cycleT = (((t * (0.3 + iN * 0.6) + phase) % 1) + 1) % 1;
  const x = -stripL * 0.5 + stripL * cycleT;
  const z = ((((idx * 0.271) % 1) + 1) % 1 - 0.5) * stripW * (1.0 - bN * 0.6) + bN * stripW * 0.5;
  const y = Math.sin(t * 3.0 + phase * 12.0 + idx * 0.05) * 0.02;
  return [x, y, z];
}

/** Mirrors posLorentzSled in particle-compute.wgsl. */
export function integrateLorentzSled(
  p: ParticlePhase,
  idx: number,
  t: number,
  iN = 0,
  posN = 0,
  bN = 0
): [number, number, number] {
  const phase = p.phase;
  // 12 / 2.6 mirror LORENTZ_SCENE.railLenU / railHalfGapU in
  // devices/quanta/lorentz-sled.ts (device-local render units, not metres).
  const railLen = 12.0;
  const railHalf = 2.6;
  const xSled = -railLen * 0.5 + posN * railLen;
  const flow = (((t * (0.25 + iN * 1.2) + phase) % 1) + 1) % 1;
  const armature = idx % 4 === 0;
  let x: number;
  let z: number;
  if (armature) {
    x = xSled + Math.sin(t * 8.0 + phase * 30.0) * 0.12 * bN;
    z = -railHalf + flow * (railHalf * 2.0);
  } else if ((idx & 1) === 0) {
    x = -railLen * 0.5 + flow * (xSled + railLen * 0.5);
    z = -railHalf;
  } else {
    x = xSled - flow * (xSled + railLen * 0.5);
    z = railHalf;
  }
  const y = Math.sin(t * 3.0 + phase * 12.0 + idx * 0.05) * 0.12;
  return [x, y, z];
}

/** Mirrors posJumpingRing in particle-compute.wgsl. */
export function integrateJumpingRing(
  p: ParticlePhase,
  idx: number,
  t: number,
  irN = 0,
  hN = 0,
  kN = 0
): [number, number, number] {
  const phase = p.phase;
  // -4 / 12.5 / 2.8 mirror RING_SCENE baseY / poleU / ringRadiusU in
  // devices/quanta/jumping-ring.ts (device-local render units, not metres).
  const baseY = -4.0;
  const poleU = 12.5;
  const ringR = 2.8;
  const coreR = 0.55;
  const outerR = ringR * 1.5;
  const yRing = baseY + hN * poleU;
  const u = (((t * (0.3 + irN * 0.9) + phase) % 1) + 1) % 1;

  if (idx % 5 === 0) {
    const a = u * 6.28318 + t * (1.0 + irN * 4.0);
    return [
      Math.cos(a) * ringR,
      yRing + Math.sin(t * 9.0 + phase * 30.0) * 0.12 * irN,
      Math.sin(a) * ringR
    ];
  }

  const a = ((((idx * 0.618) % 1) + 1) % 1) * 6.28318;
  let y: number;
  let radius: number;
  if (u < 0.45) {
    y = baseY + (u / 0.45) * poleU;
    radius = coreR;
  } else if (u < 0.55) {
    y = baseY + poleU;
    radius = coreR + ((u - 0.45) / 0.1) * (outerR - coreR);
  } else if (u < 0.95) {
    y = baseY + poleU - ((u - 0.55) / 0.4) * poleU;
    radius = outerR;
  } else {
    y = baseY;
    radius = outerR + ((u - 0.95) / 0.05) * (coreR - outerR);
  }
  const near = Math.exp(-Math.abs(y - yRing) * 0.9);
  radius *= 1 + near * kN * 0.45;
  return [Math.cos(a) * radius, y, Math.sin(a) * radius];
}

const fract = (x: number): number => ((x % 1) + 1) % 1;

/** Mirrors posDropTube in particle-compute.wgsl. */
export function integrateDropTube(
  p: ParticlePhase,
  idx: number,
  t: number,
  travelN = 0,
  vN = 0,
  aheadN = 0,
  behindN = 0
): [number, number, number] {
  const phase = p.phase;
  // 9.6 / -6.08 / 2.6 / 1.25 / 1.8 mirror DROP_Y_TOP / DROP_Y_BOTTOM /
  // hoopRadiusU / magnetHalfU / loopOffsetU in devices/quanta/drop-tube.ts
  // (device-local render units, not metres).
  const yMag = 9.6 + (-6.08 - 9.6) * Math.max(0, Math.min(1, travelN));
  const hoopR = 2.6;
  const magHalf = 1.25;
  const loopOff = 1.8;
  const kind = idx % 8;

  if (kind < 4) {
    const ahead = kind < 2;
    const s = ahead ? aheadN : behindN;
    if (s < 0.02) {
      const a0 = phase * 6.28318;
      return [Math.cos(a0) * 0.3, yMag + (fract(phase * 7.0) - 0.5) * 1.6, Math.sin(a0) * 0.3];
    }
    const dir = ahead ? 1 : -1;
    const a = (phase * 6.28318 + t * (1.0 + s * 5.0)) * dir;
    const r = hoopR + (fract(idx * 0.37) - 0.5) * 0.5;
    const y = yMag + (ahead ? -loopOff : loopOff) + (fract(idx * 0.73) - 0.5) * 0.6 * s;
    return [Math.cos(a) * r, y, Math.sin(a) * r];
  }

  if (kind < 7) {
    const u = fract(phase + t * (0.6 + 2.0 * vN));
    const a = phase * 43.98;
    const r = 0.25 + 0.35 * u;
    return [Math.cos(a) * r, yMag + magHalf + u * (0.6 + vN * 7.0), Math.sin(a) * r];
  }

  const th = fract(phase + t * 0.15) * 3.14159;
  const ph = fract(idx * 0.618) * 6.28318;
  const st = Math.sin(th);
  const rr = 3.4 * st * st;
  return [rr * st * Math.cos(ph), yMag + rr * Math.cos(th), rr * st * Math.sin(ph)];
}
