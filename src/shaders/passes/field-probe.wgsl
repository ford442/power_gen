// =============================================================
// Field probe (ADR-0017): the exact B (tesla) at up to 64 points, summed over
// the same packed sources as the volume — no texture, no interpolation. The
// golden test (test:field-volume) runs this shader's text against the CPU
// reference at 20 points per bench; `window.fieldVolume.probeGpu()` reads it
// back on a live GPU.
//
// Bindings: docs/BINDINGS.md → `fieldProbe`.
// =============================================================
#include "common/field-sources.wgsl"

struct FieldProbeParams {
  info: vec4f, // x = metres per scene unit, y = source count, z = point count
}

@group(0) @binding(0) var<uniform> probe: FieldProbeParams;
@group(0) @binding(1) var<storage, read> sources: array<FieldSource>;
@group(0) @binding(2) var<storage, read> points: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> results: array<vec4f>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= u32(probe.info.z)) {
    return;
  }
  let p = points[i].xyz * probe.info.x;
  let count = u32(probe.info.y);
  var B = vec3f(0.0);
  for (var s = 0u; s < count; s++) {
    B += fieldSourceB(p, sources[s]);
  }
  results[i] = vec4f(B, length(B));
}
