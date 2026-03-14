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

  var worldPos: vec3f;

  if (uniforms.mode < 2.5) {
    // Existing swirling particle behavior for seg/heron/kelvin modes
    let angle = atan2(pos.z, pos.x) + uniforms.time * 0.5 + phase * 6.28;
    let radius = length(pos.xz) - uniforms.time * 0.3 * (0.5 + phase);
    let height = pos.y + sin(uniforms.time * 3.0 + radius * 2.0) * 0.3;

    worldPos = vec3f(
      cos(angle) * radius + corner.x,
      height + corner.y,
      sin(angle) * radius
    );
  } else {
    // Solar mode: particles are photons traveling from LEDs to solar cells
    let right = vec3f(1.0, 0.0, 0.0);
    let up = vec3f(0.0, 1.0, 0.0);
    worldPos = pos + right * corner.x + up * corner.y;
  }

  return uniforms.viewProj * vec4f(worldPos, 1.0);
}

@fragment fn fragmentMain(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let coord = pos.xy % 2.0 - vec2f(1.0);
  let dist = length(coord);

  if (dist > 1.0) {
    discard;
  }

  let alpha = 1.0 - dist;

  var color = vec3f(0.0, 0.8, 1.0);
  var outAlpha = alpha * 0.6;

  if (uniforms.mode >= 2.5) {
    // Solar mode: warm photon glow
    let intensity = 0.5 + uniforms._pad * 0.5;
    color = vec3f(1.0, 0.9, 0.2) * intensity;
    outAlpha = alpha * (0.6 + uniforms._pad * 0.3);
  }

  return vec4f(color, outAlpha);
}
