struct Uniforms {
  viewProj: mat4x4f,
  time: f32,
  mode: f32,
  particleCount: f32,
  _pad: f32,
}

@binding(0) @group(0) var<uniform> uniforms: Uniforms;

@vertex fn vertexMain(
  @location(0) pos: vec3f,
  @location(1) phase: f32,
  @builtin(vertex_index) vertIdx: u32,
  @builtin(instance_index) instanceIdx: u32
) -> @builtin(position) vec4f {
  let size = 0.03;
  let corners = array<vec2f, 4>(
    vec2f(-1.0, -1.0),
    vec2f(1.0, -1.0),
    vec2f(-1.0, 1.0),
    vec2f(1.0, 1.0)
  );
  let corner = corners[vertIdx] * size;

  let angle = atan2(pos.z, pos.x) + uniforms.time * 0.5 + phase * 6.28;
  let radius = length(pos.xz) - uniforms.time * 0.3 * (0.5 + phase);
  let height = pos.y + sin(uniforms.time * 3.0 + radius * 2.0) * 0.3;

  let worldPos = vec3f(
    cos(angle) * radius + corner.x,
    height + corner.y,
    sin(angle) * radius
  );

  return uniforms.viewProj * vec4f(worldPos, 1.0);
}

@fragment fn fragmentMain(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let coord = pos.xy % 2.0 - vec2f(1.0);
  let dist = length(coord);

  if (dist > 1.0) {
    discard;
  }

  let alpha = 1.0 - dist;
  return vec4f(0.0, 0.8, 1.0, alpha * 0.6);
}
