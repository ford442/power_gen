// SEG roller instance kinematics (GPU compute).
#include "common/roller-instance.wgsl"
#include "common/seg-layout-uniforms.wgsl"

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
