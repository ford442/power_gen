// MLS-MPM liquid — export for drawing (ADR-0022).
//
// Writes one 16-byte `GpuParticle` per slot, the record the particle
// pipeline already draws: position in the bench's scene units
// (exportOrigin + metres · exportScale) and a phase word. The fraction of
// phase is the particle's speed over maxSpeed; its integer part is the
// effect type, which says who draws it:
//
//    9  liquid, drawn round and camera-facing by the particle pipeline
//   10  spray — liquid thinner than `sprayBelow` of rest density where the
//       particle is: always drawn by the particle pipeline, so the tip of a
//       jet and a splash stay points of light
//   11  bulk liquid while a surface pass is on (`io.surface`): splatted by
//       passes/fluid-splat.wgsl, skipped by the particle pipeline
//
// The density is the grid mass the last substep scattered, interpolated at
// the particle with the solver's own kernel. An empty slot is parked far
// below the scene, where its quad is clipped.

#include "common/mpm.wgsl"
#include "common/particle.wgsl"

@group(0) @binding(0) var<uniform> params: MpmParams;
@group(0) @binding(1) var<storage, read_write> particles: array<MpmParticle>;
@group(0) @binding(2) var<uniform> io: MpmIoParams;
@group(0) @binding(4) var<storage, read> gridVel: array<vec4f>;
@group(0) @binding(6) var<storage, read_write> drawn: array<GpuParticle>;

const MPM_EFFECT_LIQUID = 9.0;
const MPM_EFFECT_SPRAY = 10.0;
const MPM_EFFECT_SURFACE = 11.0;

/// Grid mass at a position over the rest mass of a node (`mpmDensityRatio`).
fn densityRatio(pos: vec3f) -> f32 {
  let s = mpmStencil(pos, params.cellM, params.gridN);
  var mass = 0.0;
  for (var k = 0; k < 3; k++) {
    for (var j = 0; j < 3; j++) {
      for (var i = 0; i < 3; i++) {
        let w = s.w[i].x * s.w[j].y * s.w[k].z;
        mass += w * gridVel[mpmNodeIndex(s.base + vec3i(i, j, k), params.gridN)].w;
      }
    }
  }
  // gridVel.w is in particle masses; a node at rest density holds this many.
  let restPerNode = params.restDensity * params.cellM * params.cellM * params.cellM / params.particleMass;
  return mass / restPerNode;
}

@compute @workgroup_size(64)
fn exportParticles(@builtin(global_invocation_id) gid: vec3u) {
  let index = gid.x;
  if (index >= io.capacity) { return; }
  let p = particles[index];
  var out: GpuParticle;
  if (p.state == 0.0) {
    out.pos = vec3f(0.0, -1.0e6, 0.0);
    out.phase = MPM_EFFECT_LIQUID;
  } else {
    var kind = MPM_EFFECT_LIQUID;
    if (io.sprayBelow > 0.0 && densityRatio(p.pos) < io.sprayBelow) {
      kind = MPM_EFFECT_SPRAY;
    } else if (io.surface != 0u) {
      kind = MPM_EFFECT_SURFACE;
    }
    out.pos = io.exportOrigin + p.pos * io.exportScale;
    out.phase = kind + clamp(length(p.vel) / params.maxSpeed, 0.0, 0.999);
  }
  drawn[index] = out;
}
