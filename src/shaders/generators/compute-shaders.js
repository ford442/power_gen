/**
 * Particle / roller / field compute entry points.
 * Particle compute is authored as `passes/particle-compute.wgsl` (with #includes)
 * so naga CI and the runtime share one source. Vite expands includes via
 * `vite-plugin-wgsl-include` on `?raw` import.
 */
import particleComputeWgsl from '../passes/particle-compute.wgsl?raw';

export function getComputeShader() {
  return particleComputeWgsl;
}

export function getSegRollerComputeShader() {
  return /* wgsl */ `
    struct RollerInstance {
      position:     vec3f,
      ringIndex:    f32,
      rotation:     vec4f,
      copperColor:  vec3f,
      greenEmissive: f32,
    }

    struct RollerUniforms {
      time:      f32,
      speedMult: f32,
      prototypePreset: f32,
      segOmega:  f32,
    }

    struct SEGLayoutRing {
      count: f32,
      fullCount: f32,
      orbitRadius: f32,
      rollerRadius: f32,
      rollerHeight: f32,
      speed: f32,
      statorInner: f32,
      statorOuter: f32,
      rollerOffset: f32,
      _pad0: f32,
      _pad1: f32,
      _pad2: f32
    }

    struct SEGLayoutUniforms {
      worldScale: f32,
      ringCount: f32,
      totalRollers: f32,
      maxRollers: f32,
      refRollerRadius: f32,
      refRollerHeight: f32,
      statorHeight: f32,
      fluxLinesPerRing: f32,
      ring0: SEGLayoutRing,
      ring1: SEGLayoutRing,
      ring2: SEGLayoutRing
    }

    @group(0) @binding(0) var<storage, read_write> rollers: array<RollerInstance>;
    @group(0) @binding(1) var<uniform>             uniforms: RollerUniforms;
    @group(0) @binding(2) var<uniform>             segLayout: SEGLayoutUniforms;

    const PI: f32 = 3.14159265359;

    fn poleTint(ringIdx: u32, localI: u32, lab: bool) -> vec3f {
      let isNorth = ((localI + ringIdx) & 1u) == 0u;
      if (lab) {
        return select(vec3f(0.48, 0.50, 0.54), vec3f(0.78, 0.80, 0.82), isNorth);
      }
      return select(vec3f(0.38, 0.45, 0.68), vec3f(0.92, 0.58, 0.35), isNorth);
    }

    fn ringForFlatIndex(idx: u32) -> SEGLayoutRing {
      if (idx >= u32(segLayout.ring2.rollerOffset)) { return segLayout.ring2; }
      if (idx >= u32(segLayout.ring1.rollerOffset)) { return segLayout.ring1; }
      return segLayout.ring0;
    }

    fn localIndexInRing(idx: u32, ring: SEGLayoutRing) -> u32 {
      return idx - u32(ring.rollerOffset);
    }

    @compute @workgroup_size(64)
    fn main(@builtin(global_invocation_id) gid: vec3u) {
      let idx = gid.x;
      if (idx >= u32(segLayout.totalRollers)) { return; }

      let ring = ringForFlatIndex(idx);
      let localI = localIndexInRing(idx, ring);
      if (localI >= u32(ring.count)) { return; }

      var ringIdx: u32 = 0u;
      if (u32(ring.rollerOffset) == u32(segLayout.ring1.rollerOffset)) { ringIdx = 1u; }
      if (u32(ring.rollerOffset) == u32(segLayout.ring2.rollerOffset)) { ringIdx = 2u; }

      let count = u32(ring.count);
      let radius = ring.orbitRadius;
      let rollerR = ring.rollerRadius;
      let speed = ring.speed;
      let t = uniforms.time;
      let lab = uniforms.prototypePreset > 0.5;

      let startupRamp = min(t * (0.25 + f32(ringIdx) * 0.1), 1.0) * max(uniforms.segOmega, 0.02);
      let jitterSeed = f32(idx) * 127.3 + f32(ringIdx) * 53.7;
      let speedJitter = 1.0 + 0.04 * sin(t * 1.3 + sin(jitterSeed) * 12.7);

      let baseAngle = (f32(localI) / f32(count)) * PI * 2.0;
      let angle = baseAngle + t * 0.5 * speed * speedJitter * startupRamp + f32(ringIdx) * 0.22;

      let x = cos(angle) * radius;
      let z = sin(angle) * radius;

      let gearRatio = radius / max(rollerR, 1e-4);
      let selfRotAngle = angle * gearRatio * 0.5;
      let tangentAngle = angle + PI / 2.0;
      let rollAxisX = cos(tangentAngle);
      let rollAxisZ = sin(tangentAngle);
      let halfAngle = selfRotAngle / 2.0;

      let isNorth = ((localI + ringIdx) & 1u) == 0u;
      let baseEmit = select(0.0, 0.08, isNorth);
      let emissive = min(baseEmit * max(1.0, uniforms.speedMult * 0.5) + uniforms.speedMult * 0.02
        + uniforms.segOmega * 0.55, 1.0);

      var r: RollerInstance;
      r.position = vec3f(x, 0.0, z);
      r.ringIndex = f32(ringIdx);
      r.rotation = vec4f(
        rollAxisX * sin(halfAngle),
        0.0,
        rollAxisZ * sin(halfAngle),
        cos(halfAngle)
      );
      r.copperColor = poleTint(ringIdx, localI, lab);
      r.greenEmissive = emissive;

      rollers[idx] = r;
    }
  `;
}

export function getSegFieldAdvectShader() {
  // Avoid `array<f32,N>(...)[i]` — naga rejects dynamic index of value arrays
  // (Tint/Chrome allow it). Use if-ladder instead for CI validation.
  return /* wgsl */ `
    struct FieldParticle {
      posX: f32,
      posY: f32,
      posZ: f32,
      velX: f32,
      velY: f32,
      velZ: f32,
      life: f32,
      strength: f32,
    }

    struct FieldUniforms {
      time:          f32,
      speedMult:     f32,
      particleCount: u32,
      pad:           f32,
    }

    @group(0) @binding(0) var<storage, read_write> particles: array<FieldParticle>;
    @group(0) @binding(1) var<uniform>             uniforms:  FieldUniforms;

    const PI: f32 = 3.14159265359;

    fn ringRadius(ringIdx: u32) -> f32 {
      if (ringIdx == 0u) { return 2.5; }
      if (ringIdx == 1u) { return 4.0; }
      return 5.5;
    }

    @compute @workgroup_size(64)
    fn main(@builtin(global_invocation_id) gid: vec3u) {
      let i = gid.x;
      if (i >= uniforms.particleCount) { return; }

      let t      = uniforms.time;
      let sm     = uniforms.speedMult;
      let ringIdx = i % 3u;
      let r      = ringRadius(ringIdx);

      let angle       = (f32(i) / f32(uniforms.particleCount)) * PI * 20.0
                      + t * (0.5 + f32(ringIdx) * 0.3);
      let heightOffset = sin(t * 0.5 + f32(i) * 0.1) * 0.8;

      let px = cos(angle) * r;
      let pz = sin(angle) * r;
      let py = heightOffset;

      let speed = 1.0 + f32(ringIdx) * 0.5;
      let vx = -sin(angle) * speed;
      let vy =  cos(t * 2.0 + f32(i) * 0.05) * 0.1;
      let vz =  cos(angle)  * speed;

      let lifePulse = sin(t * 2.0 + f32(i) * 0.5) * 0.5 + 0.5;
      let life      = clamp(lifePulse * min(sm * 0.4 + 0.6, 1.0), 0.0, 1.0);
      let strength  = clamp(0.3 + 0.7 * sin(angle * 3.0 + t), 0.0, 1.0)
                    * min(1.0, 0.5 + sm * 0.15);

      var p: FieldParticle;
      p.posX = px;
      p.posY = py;
      p.posZ = pz;
      p.velX = vx;
      p.velY = vy;
      p.velZ = vz;
      p.life     = life;
      p.strength = strength;

      particles[i] = p;
    }
  `;
}
