// =============================================================
// Particle compute — multi-device mode paths (SEG / Heron / …)
// Canonical .wgsl form; also loaded by generators/compute-shaders.js.
// =============================================================

#include "common/particle.wgsl"
#include "common/compute-uniforms.wgsl"
#include "common/overview-lod.wgsl"
#include "generated/device-catalog.wgsl"

@binding(0) @group(0) var<storage, read_write> particles: array<GpuParticle>;
@binding(1) @group(0) var<uniform> uniforms: ComputeUniforms;

const PI: f32 = 3.14159265359;

fn posSEG(phase: f32, t: f32, idx: u32) -> vec3f {
  let cycleT  = fract(t * 0.12 + phase);
  let radius  = 8.5 - cycleT * 8.0;
  let angle   = phase * 6.28318 + cycleT * 18.84956;
  let height  = sin(cycleT * 6.28318 * 2.0 + phase * 6.28318) * 2.8;

  // Harmonic turbulence: high-frequency jitter gives electrified, organic motion
  let jitter1    = sin(t * 7.3  + phase * 31.4) * 0.12;
  let jitter2    = cos(t * 11.7 + phase * 17.8) * 0.08;
  let jitter3    = sin(t * 5.1  + phase * 43.2) * 0.06;
  let turbAngle  = angle  + jitter2;
  let turbRadius = radius + sin(t * 3.7 + phase * 23.5) * (radius * 0.04);
  let turbHeight = height + jitter1 + jitter3;

  return vec3f(cos(turbAngle) * turbRadius, turbHeight, sin(turbAngle) * turbRadius);
}

fn posHeron(phase: f32, t: f32, idx: u32) -> vec3f {
  let headN = uniforms.physics0;
  let vExit = uniforms.physics1;
  let cycleT  = fract(t * (0.18 + vExit * 0.08) + phase);
  let spread  = phase * 6.28318;
  let spreadR = fract(f32(idx) * 0.618034) * 0.55;
  let apexY = 5.2 + headN * 2.2;
  var pos: vec3f;
  if (cycleT < 0.35) {
    let k = cycleT / 0.35;
    pos = vec3f(sin(spread) * spreadR * k * 1.4,
                apexY - 0.8 + k * 0.4 - k * k * 0.3,
                cos(spread) * spreadR * k * 1.4);
  } else if (cycleT < 0.72) {
    let k = (cycleT - 0.35) / 0.37;
    pos = vec3f(sin(spread) * spreadR * (1.4 - k * 0.9),
                apexY - k * (2.8 + headN * 1.2),
                cos(spread) * spreadR * (1.4 - k * 0.9));
  } else {
    let k = (cycleT - 0.72) / 0.28;
    let bunch = sin(spread * 3.0 + t * 4.0) * 0.15 * headN;
    pos = vec3f(sin(spread) * spreadR * (0.5 - k * 0.5) + bunch,
                4.5 - k * 6.5,
                cos(spread) * spreadR * (0.5 - k * 0.5) + bunch);
  }
  return pos;
}

fn posKelvin(phase: f32, t: f32, idx: u32) -> vec3f {
  let voltN = uniforms.physics0;
  let spark = uniforms.physics1;
  let qE = uniforms.physics2;
  let cycleT = fract(t * (0.28 + voltN * 0.12) + phase);
  let side   = select(-1.0, 1.0, (idx & 1u) == 1u);
  let wobble = sin(t * 4.0 + phase * 20.0) * (0.06 + voltN * 0.12);
  let levitate = select(0.0, sin(t * 9.0 + phase * 24.0) * voltN * 0.45, voltN > 0.72);
  var pos: vec3f;
  if (cycleT < 0.82) {
    let k = cycleT / 0.82;
    pos = vec3f(side * 2.5 + wobble, 5.5 - k * 8.8 + levitate + qE * 0.02, wobble * 0.4);
  } else {
    let k = (cycleT - 0.82) / 0.18;
    let scatter = spark * sin(phase * 62.83 + t * 22.0) * 0.9;
    pos = vec3f(side * 2.5 * (1.0 - k * 1.9) + scatter, -3.2 + k * 1.4, scatter * 0.5);
  }
  return pos;
}

fn ledHexPos(ledIdx: u32) -> vec3f {
  let angle = (f32(ledIdx) / 6.0) * 6.28318;
  let r = 3.0;
  return vec3f(cos(angle) * r, 3.5, sin(angle) * r);
}

fn posSolar(phase: f32, t: f32, idx: u32, speedMult: f32) -> vec3f {
  let ledIdx = idx % 6u;
  let ledPos = ledHexPos(ledIdx);
  let panelX = (fract(f32(idx) * 0.61803) - 0.5) * 9.0;
  let panelZ = (fract(f32(idx) * 0.38490) - 0.5) * 9.0;
  let panelPos = vec3f(panelX, 0.05, panelZ);
  let charge = uniforms.physics0;
  let speed = 1.0 + speedMult * 1.5 + charge * 0.8;
  let life  = fract(t * speed * 0.18 + phase);
  var pos = mix(ledPos, panelPos, min(life * 1.05, 1.0));
  if (life > 0.92) {
    let refract = sin(phase * 40.0 + t * 6.0) * 0.15;
    pos = vec3f(pos.x + refract, pos.y, pos.z + refract * 0.5);
  }
  return pos;
}

/// Mode 4 — Peltier: air beside the two end bodies of the stack (odd idx: the
/// cold block above, even: the heat sink below). A parcel drifts up beside a
/// body warmer than the room and down beside a colder one; the drift is
/// integrated on the CPU from each body's temperature (advancePeltierAir), so
/// reversing the current reverses it. Illustrative paths — not a convection
/// solve, and the air does not feed back into the plant.
///   physics0  sink-side travel, fractional (rises when > 0 over time)
///   physics1  block-side travel, fractional
/// 2.5 / 2.6 / 0.95 / 0.5 mirror PELTIER_AIR in devices/core/peltier-mesh.ts;
/// integratePeltier (particle-orbits.ts) is the CPU twin.
fn posPeltier(phase: f32, t: f32, idx: u32) -> vec3f {
  let onBlock = (idx % 2u) == 1u;
  let travel = select(uniforms.physics0, uniforms.physics1, onBlock);
  let yBody = select(-2.5, 2.5, onBlock);
  let a = fract(f32(idx) * 0.618034) * 6.28318;
  let r = 0.95 + fract(f32(idx) * 0.211 + phase) * 0.5;
  let u = fract(phase + travel);
  return vec3f(cos(a) * r, yBody + (u - 0.5) * 2.6, sin(a) * r);
}

/// u(eta) / u(0) for fully developed Hartmann flow, eta = y/a in [-1, 1]:
/// (cosh Ha - cosh(Ha*eta)) / (cosh Ha - 1), written with decaying
/// exponentials so a large Ha cannot overflow. Below Ha = 0.25 the closed form
/// cancels in f32 and a series in Ha^2 takes over (Ha -> 0 is the Poiseuille
/// parabola). Twin of hartmannShape in physics/hartmann.ts, whose
/// HARTMANN_SERIES_BELOW is the 0.25.
fn hartmannShape(eta: f32, ha: f32) -> f32 {
  let e = min(abs(eta), 1.0);
  let h = abs(ha);
  if (h < 0.25) {
    return (1.0 - e * e) * (1.0 + h * h * e * e / 12.0);
  }
  let coshRatio = exp(h * (e - 1.0)) * (1.0 + exp(-2.0 * h * e)) / (1.0 + exp(-2.0 * h));
  let sech = 2.0 * exp(-h) / (1.0 + exp(-2.0 * h));
  return (1.0 - coshRatio) / (1.0 - sech);
}

/// Mode 5 — MHD duct: timelines in fully developed Hartmann flow. A line of
/// markers released across the gap bends into the velocity profile, because
/// each marker moves at u(y) and nothing moves across the stream — the laminar
/// solution has no swirl. Eight lines are in the duct at once.
///   physics0  centre-line transits, fractional part (advanceMhdTravel)
///   physics2  Hartmann number, not normalised
/// -2.1 / 4.2 / 0.42 / 0.12 / 8 mirror MHD_DUCT in devices/core/mhd-parcels.ts,
/// whose mhdParcelPosition is this function's CPU twin (golden-particles).
fn posMhd(phase: f32, t: f32, idx: u32) -> vec3f {
  let travel = uniforms.physics0;
  let ha = uniforms.physics2;
  let line = idx % 8u;
  let lane = f32(idx / 8u) + 0.5;
  // R2 sequence: lanes fill the cross-section evenly at any particle count.
  let eta = fract(lane * 0.7548777) * 2.0 - 1.0;
  let zeta = fract(lane * 0.5698403) * 2.0 - 1.0;
  let tau = fract(travel + f32(line) / 8.0);
  let x = -2.1 + 4.2 * tau * hartmannShape(eta, ha);
  return vec3f(x, eta * 0.42, zeta * 0.12);
}

fn posMagLev(phase: f32, t: f32, idx: u32) -> vec3f {
  let gap = uniforms.physics0;
  let field = uniforms.physics1;
  let angle = phase * 6.28318 + t * (0.7 + field * 0.5) + f32(idx) * 0.017;
  let r = 0.9 + fract(f32(idx) * 0.131) * 2.0;
  let y = 0.55 + gap + sin(t * 3.2 + phase * 11.0) * 0.07 * (0.4 + field);
  return vec3f(cos(angle) * r, y, sin(angle) * r);
}

fn posHomopolar(phase: f32, t: f32, idx: u32) -> vec3f {
  let rpmN = uniforms.physics0;
  let emfN = uniforms.physics1;
  let discAngle = uniforms.physics2;
  let rFrac = fract(f32(idx) * 0.618034 + phase * 0.37);
  let drift = fract(phase + t * (0.12 + emfN * 0.35));
  let r = mix(0.18, 1.15, drift * (0.35 + rFrac * 0.65));
  let theta = discAngle + phase * 6.28318 + t * (0.4 + rpmN * 3.5) + f32(idx) * 0.011;
  let y = 0.16 + sin(t * 4.0 + phase * 18.0) * 0.04 * (0.3 + emfN);
  return vec3f(cos(theta) * r, y, sin(theta) * r);
}

fn posHalbach(phase: f32, t: f32, idx: u32) -> vec3f {
  let segN = uniforms.physics0;
  let peakB = uniforms.physics1;
  let angle = phase * 6.28318 + t * (0.5 + peakB * 0.8) + f32(idx) * 0.013;
  let r = 0.7 + fract(f32(idx) * 0.173 + segN * 0.04) * 2.4;
  let y = 0.25 + sin(t * 2.8 + phase * 9.0) * 0.12 * (0.35 + peakB);
  return vec3f(cos(angle) * r, y, sin(angle) * r);
}

/// Mode 7 — pulse-coil: radial flux burst around coil + axial drift with armature.
fn posPulseCoil(phase: f32, t: f32, idx: u32) -> vec3f {
  let iN = uniforms.physics0;
  let bN = uniforms.physics1;
  let travel = uniforms.physics2;
  let angle = phase * 6.28318 + t * (0.9 + iN * 2.5) + f32(idx) * 0.019;
  let r = 0.35 + fract(f32(idx) * 0.211 + phase) * (0.9 + iN * 0.8);
  let y = 0.2 + travel * 0.55 + sin(t * 5.0 + phase * 14.0) * 0.08 * (0.3 + bN);
  return vec3f(cos(angle) * r, y, sin(angle) * r);
}

/// Mode 10 — transformer: primary orbit → flux bridge → secondary orbit.
fn posTransformer(phase: f32, t: f32, idx: u32) -> vec3f {
  let ipN = uniforms.physics0;
  let isN = uniforms.physics1;
  let fluxN = uniforms.physics2;
  let u = fract(phase + t * (0.25 + ipN * 0.35 + isN * 0.25));
  if (u < 0.35) {
    let a = (u / 0.35) * 6.28318 + t * (1.0 + ipN);
    return vec3f(-0.55 + cos(a) * 0.28, 0.15 + sin(a) * 0.22, sin(a * 2.0) * 0.1);
  } else if (u < 0.65) {
    let s = (u - 0.35) / 0.3;
    return vec3f(-0.55 + s * 1.1, 0.55 + sin(t * 3.5 + phase * 8.0) * 0.06 * fluxN, 0.0);
  } else {
    let a = ((u - 0.65) / 0.35) * 6.28318 + t * (1.2 + isN);
    return vec3f(0.55 + cos(a) * 0.24, 0.15 + sin(a) * 0.2, sin(a * 2.0 + 1.0) * 0.1);
  }
}

/// Mode 12 — Van de Graaff: charge packets riding the belt loop; near the
/// terminal, sparkGlow adds outward jitter toward the discharge electrode.
fn posVdg(phase: f32, t: f32, idx: u32) -> vec3f {
  let chargeN = uniforms.physics0;
  let sparkGlow = uniforms.physics1;
  let side = select(-1.0, 1.0, (idx & 1u) == 1u);
  let topY = 1.13;
  let botY = -0.55;
  let cycleT = fract(t * (0.4 + chargeN * 0.3) + phase);
  let y = mix(botY, topY, cycleT);
  let jitter = sin(t * 6.0 + phase * 20.0) * 0.02;
  var x = side * 0.09 + jitter;
  var z = jitter * 0.5;
  if (cycleT > 0.92) {
    let burst = sparkGlow * sin(phase * 53.0 + t * 15.0);
    x = x + burst * 0.5;
    z = z + burst * 0.3;
  }
  return vec3f(x, y, z);
}

/// Mode 13 — Hall bench: carriers drifting along the strip, deflected
/// toward one edge by the transverse field (illustrative, not a real
/// per-particle Lorentz-force integrator).
fn posHall(phase: f32, t: f32, idx: u32) -> vec3f {
  let iN = uniforms.physics0;
  let bN = uniforms.physics1;
  let stripL = 0.5;
  let stripW = 0.08;
  let cycleT = fract(t * (0.3 + iN * 0.6) + phase);
  let x = mix(-stripL * 0.5, stripL * 0.5, cycleT);
  let z = (fract(f32(idx) * 0.271) - 0.5) * stripW * (1.0 - bN * 0.6) + bN * stripW * 0.5;
  let y = sin(t * 3.0 + phase * 12.0 + f32(idx) * 0.05) * 0.02;
  return vec3f(x, y, z);
}

/// Mode 14 — Lorentz rail sled: the drive current loop drawn as packets
/// running out one rail, across the sliding armature, and back along the
/// other. Illustrative, not a per-particle Lorentz-force integrator.
fn posLorentzSled(phase: f32, t: f32, idx: u32) -> vec3f {
  let iN = uniforms.physics0;
  let posN = uniforms.physics1;
  let bN = uniforms.physics2;
  // 12 / 2.6 mirror LORENTZ_SCENE.railLenU / railHalfGapU in
  // devices/quanta/lorentz-sled.ts (device-local render units, not metres).
  let railLen = 12.0;
  let railHalf = 2.6;
  let xSled = mix(-railLen * 0.5, railLen * 0.5, posN);
  let flow = fract(t * (0.25 + iN * 1.2) + phase);
  var x = 0.0;
  var z = 0.0;
  if ((idx % 4u) == 0u) {
    // Armature crossing: current traversing the gap between the rails.
    x = xSled + sin(t * 8.0 + phase * 30.0) * 0.12 * bN;
    z = mix(-railHalf, railHalf, flow);
  } else if ((idx & 1u) == 0u) {
    x = mix(-railLen * 0.5, xSled, flow);
    z = -railHalf;
  } else {
    x = mix(xSled, -railLen * 0.5, flow);
    z = railHalf;
  }
  let y = sin(t * 3.0 + phase * 12.0 + f32(idx) * 0.05) * 0.12;
  return vec3f(x, y, z);
}

/// Mode 15 — Thomson jumping ring: flux packets running up the core, out over
/// the top and back down outside it, plus a ring of current packets riding the
/// aluminium at its live height. The return path is squeezed where the ring
/// sits — a cartoon of the flux it is excluding. Illustrative, not a field
/// solver, and nothing here glows because anything is hot: this bench has no
/// thermal model at all.
fn posJumpingRing(phase: f32, t: f32, idx: u32) -> vec3f {
  let irN = uniforms.physics0;
  let hN = uniforms.physics1;
  let kN = uniforms.physics2;
  // -4 / 12.5 / 2.8 mirror RING_SCENE baseY / poleU / ringRadiusU in
  // devices/quanta/jumping-ring.ts (device-local render units, not metres).
  let baseY = -4.0;
  let poleU = 12.5;
  let ringR = 2.8;
  let coreR = 0.55;
  let outerR = ringR * 1.5;
  let yRing = baseY + hN * poleU;
  let u = fract(t * (0.3 + irN * 0.9) + phase);

  if ((idx % 5u) == 0u) {
    // Induced ring current, orbiting the aluminium where it actually is.
    let a = u * 6.28318 + t * (1.0 + irN * 4.0);
    return vec3f(cos(a) * ringR,
                 yRing + sin(t * 9.0 + phase * 30.0) * 0.12 * irN,
                 sin(a) * ringR);
  }

  let a = fract(f32(idx) * 0.618) * 6.28318;
  var y = baseY;
  var radius = coreR;
  if (u < 0.45) {
    y = baseY + (u / 0.45) * poleU;
    radius = coreR;
  } else if (u < 0.55) {
    y = baseY + poleU;
    radius = mix(coreR, outerR, (u - 0.45) / 0.1);
  } else if (u < 0.95) {
    y = baseY + poleU - ((u - 0.55) / 0.4) * poleU;
    radius = outerR;
  } else {
    y = baseY;
    radius = mix(outerR, coreR, (u - 0.95) / 0.05);
  }
  let near = exp(-abs(y - yRing) * 0.9);
  radius = radius * (1.0 + near * kN * 0.45);
  return vec3f(cos(a) * radius, y, sin(a) * radius);
}

/// Mode 16 — Lenz drop tube: the two eddy-current loops in the wall just ahead
/// of and behind the falling magnet, circulating in opposite senses, a wake
/// above it whose length follows its speed, and a few dipole field loops riding
/// with it. Loop speed follows the plant's loop currents. Illustrative, not a
/// field solver — and nothing here glows because the wall is warm: this bench
/// has no thermal model.
fn posDropTube(phase: f32, t: f32, idx: u32) -> vec3f {
  let travelN = clamp(uniforms.physics0, 0.0, 1.0);
  let vN = uniforms.physics1;
  let aheadN = uniforms.physics2;
  let behindN = uniforms.physics3;
  // 9.6 / -6.08 / 2.6 / 1.25 / 1.8 mirror DROP_Y_TOP / DROP_Y_BOTTOM /
  // hoopRadiusU / magnetHalfU / loopOffsetU in devices/quanta/drop-tube.ts
  // (device-local render units, not metres).
  let yMag = mix(9.6, -6.08, travelN);
  let hoopR = 2.6;
  let magHalf = 1.25;
  let loopOff = 1.8;
  let kind = idx % 8u;

  if (kind < 4u) {
    let ahead = kind < 2u;
    let s = select(behindN, aheadN, ahead);
    if (s < 0.02) {
      // No loop to show: tuck the packet inside the (opaque) magnet.
      let a0 = phase * 6.28318;
      return vec3f(cos(a0) * 0.3, yMag + (fract(phase * 7.0) - 0.5) * 1.6, sin(a0) * 0.3);
    }
    let dir = select(-1.0, 1.0, ahead);
    let a = (phase * 6.28318 + t * (1.0 + s * 5.0)) * dir;
    let r = hoopR + (fract(f32(idx) * 0.37) - 0.5) * 0.5;
    let y = yMag + select(loopOff, -loopOff, ahead) + (fract(f32(idx) * 0.73) - 0.5) * 0.6 * s;
    return vec3f(cos(a) * r, y, sin(a) * r);
  }

  if (kind < 7u) {
    // Wake: a thin column above the magnet, stretched by its speed.
    let u = fract(phase + t * (0.6 + 2.0 * vN));
    let a = phase * 43.98;
    let r = 0.25 + 0.35 * u;
    return vec3f(cos(a) * r, yMag + magHalf + u * (0.6 + vN * 7.0), sin(a) * r);
  }

  // Dipole field loop r = L·sin²θ about the magnet.
  let th = fract(phase + t * 0.15) * 3.14159;
  let ph = fract(f32(idx) * 0.618) * 6.28318;
  let st = sin(th);
  let rr = 3.4 * st * st;
  return vec3f(rr * st * cos(ph), yMag + rr * cos(th), rr * st * sin(ph));
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let idx = id.x;
  // GPU LOD: high-index particles above the level's threshold are never
  // integrated, and the cull pass sizes the indirect draw with the same
  // ladder — so nothing stale is ever drawn.
  let liveCount = overviewLodCount(u32(uniforms.particleCount), u32(uniforms.lodLevel));
  if (idx >= liveCount) { return; }

  let p = particles[idx];
  let phase = p.phase;
  let t = uniforms.time;
  let m = u32(uniforms.mode + 0.5);

  var newPos: vec3f;
  if (m == MODE_SEG) {
    newPos = posSEG(phase, t, idx);
  } else if (m == MODE_HERON) {
    newPos = posHeron(phase, t, idx);
  } else if (m == MODE_KELVIN) {
    newPos = posKelvin(phase, t, idx);
  } else if (m == MODE_SOLAR) {
    newPos = posSolar(phase, t, idx, uniforms.speedMult);
  } else if (m == MODE_PELTIER) {
    newPos = posPeltier(phase, t, idx);
  } else if (m == MODE_MHD) {
    newPos = posMhd(phase, t, idx);
  } else if (m == MODE_MAGLEV) {
    newPos = posMagLev(phase, t, idx);
  } else if (m == MODE_PULSE_COIL) {
    newPos = posPulseCoil(phase, t, idx);
  } else if (m == MODE_HOMOPOLAR) {
    newPos = posHomopolar(phase, t, idx);
  } else if (m == MODE_HALBACH_VIZ) {
    newPos = posHalbach(phase, t, idx);
  } else if (m == MODE_TRANSFORMER) {
    newPos = posTransformer(phase, t, idx);
  } else if (m == MODE_VDG) {
    newPos = posVdg(phase, t, idx);
  } else if (m == MODE_HALL) {
    newPos = posHall(phase, t, idx);
  } else if (m == MODE_LORENTZ_SLED) {
    newPos = posLorentzSled(phase, t, idx);
  } else if (m == MODE_JUMPING_RING) {
    newPos = posJumpingRing(phase, t, idx);
  } else if (m == MODE_DROP_TUBE) {
    newPos = posDropTube(phase, t, idx);
  } else {
    newPos = posMagLev(phase, t, idx);
  }

  var outP: GpuParticle;
  outP.pos = newPos;
  outP.phase = phase;
  particles[idx] = outP;
}
