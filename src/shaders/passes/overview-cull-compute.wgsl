// =============================================================
// Overview frustum cull → draw-indirect (ADR-0005 WS4)
//
// One thread per device slot on the overview ring (target 8–12 devices).
// Writes, per slot:
//   * `drawArgs[i]` — particle billboard draw-indirect args. instanceCount is
//     0 when the device is culled/disabled, else the LOD'd particle count.
//     The slot index is stable so the render loop can encode `drawIndirect`
//     at a fixed byte offset without knowing the cull result (no readback).
//   * a compacted entry in `output.indices` for profiling / pipe budgeting.
//
// Bindings: docs/BINDINGS.md → `overviewCull`.
// =============================================================

#include "common/overview-cull.wgsl"

@binding(0) @group(0) var<storage, read> bounds: array<DeviceBounds>;
@binding(1) @group(0) var<uniform> uniforms: CullUniforms;
@binding(2) @group(0) var<storage, read_write> drawArgs: array<DrawArgs>;
@binding(3) @group(0) var<storage, read_write> output: CullOutput;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let idx = id.x;
  if (idx >= uniforms.deviceCount) { return; }

  let b = bounds[idx];
  let enabled = (b.flags & CULL_FLAG_ENABLED) != 0u;
  let visible = enabled && sphereInFrustum(
    uniforms.viewProj,
    b.center,
    b.radius * max(1.0, uniforms.margin)
  );

  var instances = 0u;
  if (visible) {
    instances = overviewLodCount(b.baseCount, b.lodLevel);
  }

  var args: DrawArgs;
  args.vertexCount = uniforms.vertexCount;
  args.instanceCount = instances;
  args.firstVertex = 0u;
  args.firstInstance = 0u;
  drawArgs[idx] = args;

  if (instances > 0u) {
    let slot = atomicAdd(&output.visibleCount, 1u);
    output.indices[slot] = idx;
    atomicAdd(&output.drawnInstances, instances);
  }
}
