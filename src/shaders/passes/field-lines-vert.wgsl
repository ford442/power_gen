// =============================================================
// Field-line / particle-trail billboards (ADR-0017). The flux-segment
// billboard (flux-segment-vert.wgsl) with two differences: strength is |B|
// in mT normalised by the bench's reference field (log scale, so a dipole's
// 1/r³ fall-off stays readable), and unused slots (age < 0) are moved outside
// the clip volume. Shares flux-segment-frag.wgsl.
//
// Bindings: docs/BINDINGS.md → `fieldLines`. (Not field-line-vert.wgsl — that is the
// SEG field-particle billboard.)
// =============================================================
#include "common/field-line-segment.wgsl"

struct Uniforms {
  viewProj: mat4x4f,
  time: f32,
  cameraPos: vec3f,
}

struct DeviceUniforms {
  renderMode: f32,
  posX: f32,
  posY: f32,
  posZ: f32,
  rotation: vec4f,
  timeScale: f32,
  ringIndex: f32,
  batteryCharge: f32,
  isSolar: f32,
}

struct FieldLineParams {
  // x = reference |B| (mT) drawn mid-scale, y = width scale, z = alpha scale,
  // w = 0 for field lines (travelling pulse), 1 for particle trails (fade by age)
  style: vec4f,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(1) @binding(1) var<uniform> device: DeviceUniforms;
@group(1) @binding(2) var<storage, read> segments: array<FieldLineSegment>;
@group(1) @binding(3) var<uniform> style: FieldLineParams;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) strength: f32,
  @location(1) alpha: f32,
  @location(2) phase: f32,
  @location(3) edge: f32,
  @location(4) ringHue: f32,
}

@vertex
fn main(@builtin(vertex_index) vertIdx: u32, @builtin(instance_index) instIdx: u32) -> VertexOutput {
  let seg = segments[instIdx];
  var out: VertexOutput;
  if (seg.age < 0.0) {
    out.position = vec4f(2.0, 2.0, 2.0, 1.0);
    out.strength = 0.0;
    out.alpha = 0.0;
    out.phase = 0.0;
    out.edge = 0.0;
    out.ringHue = 0.0;
    return out;
  }
  let devicePos = vec3f(device.posX, device.posY, device.posZ);
  let sc = uniforms.viewProj * vec4f(vec3f(seg.startX, seg.startY, seg.startZ) + devicePos, 1.0);
  let ec = uniforms.viewProj * vec4f(vec3f(seg.endX, seg.endY, seg.endZ) + devicePos, 1.0);
  let sn = sc.xy / sc.w;
  let en = ec.xy / ec.w;
  let dir = en - sn;
  let len = length(dir);
  let unitDir = select(vec2f(1.0, 0.0), dir / len, len > 0.0001);
  let perp = vec2f(-unitDir.y, unitDir.x);

  let trail = style.style.w > 0.5;
  // 0.5 at the reference field, ±0.25 per factor of 4.
  let t = select(clamp(0.5 + 0.125 * log2(max(seg.strength, 1e-9) / max(style.style.x, 1e-9)), 0.0, 1.0),
                 clamp(seg.strength, 0.0, 1.0), trail);
  let halfWidth = (0.0022 + t * 0.008) * style.style.y;
  let atEnd = vertIdx >= 2u;
  let side = select(-1.0, 1.0, (vertIdx & 1u) == 1u);
  var pos = select(sc, ec, atEnd);
  pos.x += perp.x * halfWidth * side * pos.w;
  pos.y += perp.y * halfWidth * side * pos.w;

  let travel = fract(seg.age * 2.0 - uniforms.time * 0.35);
  let pulse = select(0.55 + 0.45 * sin(travel * 6.2832), 1.0 - seg.age, trail);
  out.position = pos;
  // flux-segment-frag.wgsl maps strength through sqrt(s · 2e6); invert that.
  out.strength = t * t / 2.0e6;
  out.alpha = clamp(0.18 + t * 0.8, 0.12, 1.0) * pulse * style.style.z;
  out.phase = travel;
  out.edge = abs(side);
  out.ringHue = select(0.33, 0.85, trail);
  return out;
}
