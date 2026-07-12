/**
 * CPU fallback for passes/particle-compute.wgsl particle integration.
 * Mirrors the WGSL Particle struct: pos(3), phase, vel(3), aux — 8 floats / 32 bytes.
 *
 * WebGPU compute → this module on WebGL2 path.
 */

import { ValidatedConstants } from '../../ValidatedConstants';
import { simRandom } from '../../telemetry/deterministic-rng.js';

const PI = Math.PI;
const TAU = Math.PI * 2;
const GRAV = 9.81;

function hash1(n) {
  return ((Math.sin(n * 78.233 + 12.9898) * 43758.5453) % 1 + 1) % 1;
}

function rnd(idx, salt, simClock) {
  return hash1(idx * 0.1031 + salt * 1.7 + simClock * 0.37);
}

function segRingRadius(idx) {
  const z = idx % 3;
  if (z === 0) return 3.5;
  if (z === 1) return 5.5;
  return 7.5;
}

function fresnelReflectance(cosI, n2) {
  const n1 = 1.0;
  const ci = Math.max(0, Math.min(1, cosI));
  const sinI = Math.sqrt(Math.max(0, 1 - ci * ci));
  const sinT = (n1 / n2) * sinI;
  if (sinT >= 1.0) return 1.0;
  const ct = Math.sqrt(Math.max(0, 1 - sinT * sinT));
  const rs = (n1 * ci - n2 * ct) / (n1 * ci + n2 * ct);
  const rp = (n1 * ct - n2 * ci) / (n1 * ct + n2 * ci);
  return Math.max(0, Math.min(1, 0.5 * (rs * rs + rp * rp)));
}

function spawnSEG(idx, u) {
  const R = segRingRadius(idx);
  const a = rnd(idx, 1, u.simClock) * TAU;
  const y = (rnd(idx, 2, u.simClock) - 0.5) * 1.6;
  const vT = u.segOmega * R * 1.2;
  return {
    pos: [Math.cos(a) * R, y, Math.sin(a) * R],
    phase: rnd(idx, 3, u.simClock),
    vel: [-Math.sin(a) * vT, 0, Math.cos(a) * vT],
    aux: 0
  };
}

function spawnHeron(idx, u) {
  const ang = rnd(idx, 1, u.simClock) * TAU;
  const rad = rnd(idx, 2, u.simClock) * 0.18;
  const spread = 0.9;
  return {
    pos: [Math.cos(ang) * rad, 5.6, Math.sin(ang) * rad],
    phase: rnd(idx, 3, u.simClock),
    vel: [Math.cos(ang) * rad * spread, u.heronVExit, Math.sin(ang) * rad * spread],
    aux: 0
  };
}

function spawnKelvin(idx, u) {
  const side = (idx & 1) === 1 ? 1 : -1;
  const jitterX = (rnd(idx, 1, u.simClock) - 0.5) * 0.18;
  const jitterZ = (rnd(idx, 2, u.simClock) - 0.5) * 0.18;
  return {
    pos: [side * 2.5 + jitterX, 5.0 + rnd(idx, 4, u.simClock) * 0.4, jitterZ],
    phase: rnd(idx, 3, u.simClock),
    vel: [0, -0.25, 0],
    aux: side * (0.25 + 0.75 * u.kelvinVoltageN)
  };
}

function spawnSolar(idx, u) {
  const ledIdx = idx % 6;
  const ledX = (ledIdx - 2.5) * 1.6;
  const led = [ledX, 3.5, 1.5];
  const panel = [(rnd(idx, 1, u.simClock) - 0.5) * 9.0, 0.05, (rnd(idx, 2, u.simClock) - 0.5) * 9.0];
  const dx = panel[0] - led[0], dy = panel[1] - led[1], dz = panel[2] - led[2];
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
  return {
    pos: [...led],
    phase: rnd(idx, 3, u.simClock),
    vel: [dx / len * 6, dy / len * 6, dz / len * 6],
    aux: 0
  };
}

function integrateMagLev(p, idx, t, gap = 0.018, field = 0.5) {
  const phase = p.phase;
  const angle = phase * TAU + t * (0.7 + field * 0.5) + idx * 0.017;
  const r = 0.9 + ((idx * 0.131) % 1) * 2.0;
  const y = 0.55 + gap + Math.sin(t * 3.2 + phase * 11.0) * 0.07 * (0.4 + field);
  return [Math.cos(angle) * r, y, Math.sin(angle) * r];
}

function integrateMHD(p, idx, t) {
  const phase = p.phase;
  const speed = 0.7;
  const cycleT = ((t * speed + ((phase * 123.45) % 1)) % 1 + 1) % 1;
  const zPos = 8.0 + (-16.0) * cycleT;
  const isPositive = phase < 0.5;
  const chargeMultiplier = isPositive ? 1 : -1;
  const px = Math.sin(idx * 123.45) * 0.8;
  const py = Math.cos(idx * 0.123) * 0.8;
  let xDeflection = 0;
  if (zPos < 2.0) {
    const exposure = Math.max(0, Math.min(1, (2.0 - zPos) / 4.0));
    xDeflection = chargeMultiplier * exposure * 4.0;
  }
  return [px + xDeflection, py, zPos];
}

/**
 * @typedef {Object} ParticleUniforms
 * @property {number} time
 * @property {number} mode
 * @property {number} particleCount
 * @property {number} dt
 * @property {number} segOmega
 * @property {number} heronVExit
 * @property {number} kelvinE
 * @property {number} kelvinVoltageN
 * @property {number} solarN2
 * @property {number} corona
 * @property {number} simClock
 * @property {number} speedMult
 */

/**
 * Advance particle buffer in-place (8 floats per particle).
 * @param {Float32Array} particles
 * @param {ParticleUniforms} u
 */
export function stepParticles(particles, u) {
  const count = Math.min(u.particleCount, particles.length / 8);
  const dt = u.dt;
  const mode = u.mode;

  for (let idx = 0; idx < count; idx++) {
    const base = idx * 8;
    let px = particles[base];
    let py = particles[base + 1];
    let pz = particles[base + 2];
    const phase = particles[base + 3];
    let vx = particles[base + 4];
    let vy = particles[base + 5];
    let vz = particles[base + 6];
    let aux = particles[base + 7];

    if (mode < 0.5) {
      const R = segRingRadius(idx);
      const rx = px, rz = pz;
      const r = Math.max(Math.sqrt(rx * rx + rz * rz), 1e-4);
      const radialX = rx / r, radialZ = rz / r;
      const tangentX = -radialZ, tangentZ = radialX;
      const vTan = vx * tangentX + vz * tangentZ;
      const vRad = vx * radialX + vz * radialZ;
      const vTarget = u.segOmega * R * 1.2;
      const aTan = (vTarget - vTan) * 3.0;
      const aRad = -(r - R) * 26.0 - vRad * 4.0;
      const aY = -py * 9.0 - vy * 3.0;
      const aX = tangentX * aTan + radialX * aRad;
      const aZ = tangentZ * aTan + radialZ * aRad;
      const turb1 = Math.sin(u.simClock * 7.3 + phase * 31.4) * 0.045;
      const turb2 = Math.cos(u.simClock * 11.7 + phase * 17.8) * 0.032;
      const turb3 = Math.sin(u.simClock * 5.1 + phase * 43.2) * 0.028;
      const turbX = turb1 + turb2 * radialX;
      const turbZ = turb1 * radialZ - turb2;
      const corona = u.corona || 0;
      vx += (aX + turbX * corona) * dt;
      vy += (aY + turb3 * corona) * dt;
      vz += (aZ + turbZ * corona) * dt;
      px += vx * dt;
      py += vy * dt;
      pz += vz * dt;
      if (r < 1.0 || r > 11.0 || Math.abs(py) > 5.0) {
        const s = spawnSEG(idx, u);
        px = s.pos[0]; py = s.pos[1]; pz = s.pos[2];
        particles[base + 3] = s.phase;
        vx = s.vel[0]; vy = s.vel[1]; vz = s.vel[2];
        aux = s.aux;
      }
    } else if (mode < 1.5) {
      const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
      vx += (0 - vx * (0.18 + 0.05 * speed)) * dt;
      vy += (-GRAV - vy * (0.18 + 0.05 * speed)) * dt;
      vz += (0 - vz * (0.18 + 0.05 * speed)) * dt;
      px += vx * dt;
      py += vy * dt;
      pz += vz * dt;
      if (py < 3.4 || Math.abs(px) > 6.0 || Math.abs(pz) > 6.0) {
        const s = spawnHeron(idx, u);
        px = s.pos[0]; py = s.pos[1]; pz = s.pos[2];
        particles[base + 3] = s.phase;
        vx = s.vel[0]; vy = s.vel[1]; vz = s.vel[2];
        aux = s.aux;
      }
    } else if (mode < 2.5) {
      const q = aux;
      const stokes = 2.0;
      const aE = u.kelvinE * Math.abs(q);
      let ax = -vx * stokes;
      let ay = -GRAV + aE - vy * stokes;
      let az = -vz * stokes;
      if (aE > GRAV * 0.85) {
        const s = aE - GRAV * 0.85;
        ax += (rnd(idx, 5, u.simClock) - 0.5) * s * 2.2;
        az += (rnd(idx, 6, u.simClock) - 0.5) * s * 2.2;
      }
      vx += ax * dt;
      vy += ay * dt;
      vz += az * dt;
      px += vx * dt;
      py += vy * dt;
      pz += vz * dt;
      if (py < -2.4 || Math.abs(px) > 8.0 || py > 9.0) {
        const s = spawnKelvin(idx, u);
        px = s.pos[0]; py = s.pos[1]; pz = s.pos[2];
        particles[base + 3] = s.phase;
        vx = s.vel[0]; vy = s.vel[1]; vz = s.vel[2];
        aux = s.aux;
      }
    } else if (mode < 4.5) {
      px += vx * dt;
      py += vy * dt;
      pz += vz * dt;
      if (aux < 0.5 && py <= 0.06 && vy < 0) {
        const vlen = Math.sqrt(vx * vx + vy * vy + vz * vz) || 1;
        const cosI = Math.max(0, Math.min(1, -vy / vlen));
        const Rf = fresnelReflectance(cosI, u.solarN2);
        if (rnd(idx, 7, u.simClock) < Rf) {
          py = 0.07;
          vy = -vy;
          aux = 1.0;
        } else {
          const s = spawnSolar(idx, u);
          px = s.pos[0]; py = s.pos[1]; pz = s.pos[2];
          particles[base + 3] = s.phase;
          vx = s.vel[0]; vy = s.vel[1]; vz = s.vel[2];
          aux = s.aux;
        }
      } else if (aux > 0.5 && py > 3.6) {
        const s = spawnSolar(idx, u);
        px = s.pos[0]; py = s.pos[1]; pz = s.pos[2];
        particles[base + 3] = s.phase;
        vx = s.vel[0]; vy = s.vel[1]; vz = s.vel[2];
        aux = s.aux;
      }
    } else if (mode >= 6.0) {
      const gap = u.maglevGap ?? 0.018;
      const field = u.maglevFieldT ?? 0.5;
      const pos = integrateMagLev({ phase }, idx, u.time, gap, field);
      px = pos[0]; py = pos[1]; pz = pos[2];
    } else {
      const pos = integrateMHD({ phase }, idx, u.time);
      px = pos[0]; py = pos[1]; pz = pos[2];
    }

    particles[base] = px;
    particles[base + 1] = py;
    particles[base + 2] = pz;
    particles[base + 4] = vx;
    particles[base + 5] = vy;
    particles[base + 6] = vz;
    particles[base + 7] = aux;
  }
}

/**
 * Seed particle buffer for a device type.
 * @param {Float32Array} particles
 * @param {string} deviceId
 * @param {number} count
 */
export function seedParticles(particles, deviceId, count) {
  for (let i = 0; i < count; i++) {
    const base = i * 8;
    particles[base + 3] = simRandom();
    if (deviceId === 'seg') {
      const theta = simRandom() * Math.PI * 2;
      const r = 2 + simRandom() * 4;
      particles[base] = r * Math.cos(theta);
      particles[base + 1] = (simRandom() - 0.5) * 6;
      particles[base + 2] = r * Math.sin(theta);
    } else if (deviceId === 'maglev') {
      const r = 0.8 + simRandom() * 2.2;
      const a = simRandom() * Math.PI * 2;
      particles[base] = Math.cos(a) * r;
      particles[base + 1] = 0.6 + simRandom() * 0.8;
      particles[base + 2] = Math.sin(a) * r;
    } else if (deviceId === 'solar' || deviceId === 'peltier') {
      const ledCount = 6;
      const ledIdx = Math.floor(simRandom() * ledCount);
      const ledAngle = (ledIdx / ledCount) * Math.PI * 2;
      const ledRadius = 3.0;
      particles[base] = Math.cos(ledAngle) * ledRadius;
      particles[base + 1] = 3.0 + simRandom() * 0.5;
      particles[base + 2] = Math.sin(ledAngle) * ledRadius;
    } else {
      particles[base + 1] = (simRandom() - 0.5) * 6;
    }
    particles[base + 4] = 0;
    particles[base + 5] = 0;
    particles[base + 6] = 0;
    particles[base + 7] = 0;
  }
}

/** Default solar refractive index from ValidatedConstants */
export const DEFAULT_SOLAR_N2 = ValidatedConstants.SILICON_REFRACTIVE_INDEX;
