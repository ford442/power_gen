struct Uniforms {
  viewProj: mat4x4f,
  time: f32,
  mode: f32,
  particleCount: f32,
  _pad: f32,   // batteryCharge
}

@binding(0) @group(0) var<uniform> uniforms: Uniforms;

struct ParticleVert {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,        // corner UV in -1..1 for circular clip
  @location(1) particlePhase: f32,
}

@vertex fn vertexMain(
  @location(0) pos: vec3f,        // particle world position (per instance)
  @location(1) phase: f32,        // particle phase seed  (per instance)
  @builtin(vertex_index)   vertIdx:    u32,
  @builtin(instance_index) instanceIdx: u32
) -> ParticleVert {
  var output: ParticleVert;

  // Billboard quad corners (screen-aligned)
  let corners = array<vec2f, 4>(
    vec2f(-1.0, -1.0),
    vec2f( 1.0, -1.0),
    vec2f(-1.0,  1.0),
    vec2f( 1.0,  1.0)
  );
  let corner = corners[vertIdx];

  // Particle size varies by mode
  var size: f32 = 0.07;
  if (uniforms.mode > 0.5 && uniforms.mode < 1.5) {
    size = 0.11;   // larger water droplets for Heron
  } else if (uniforms.mode >= 2.5) {
    size = 0.05;   // small photon dots for Solar
  }

  // Screen-aligned billboard: offset in view-space X and Y directions.
  // Extract view right (column 0) and up (column 1) from viewProj.
  let right = vec3f(uniforms.viewProj[0][0], uniforms.viewProj[1][0], uniforms.viewProj[2][0]);
  let up    = vec3f(uniforms.viewProj[0][1], uniforms.viewProj[1][1], uniforms.viewProj[2][1]);

  let worldPos = pos + right * (corner.x * size) + up * (corner.y * size);

  output.position    = uniforms.viewProj * vec4f(worldPos, 1.0);
  output.uv          = corner;
  output.particlePhase = phase;
  return output;
}

@fragment fn fragmentMain(input: ParticleVert) -> @location(0) vec4f {
  // Circular particle – discard corners outside unit circle
  let d = length(input.uv);
  if (d > 1.0) { discard; }

  let alpha  = (1.0 - d) * 0.85;
  let mode   = uniforms.mode;
  let charge = clamp(uniforms._pad, 0.0, 1.0);
  var color: vec3f;

  if (mode < 0.5) {
    // SEG: cyan / electric-blue magnetic field lines
    let pulse = 0.6 + 0.4 * sin(uniforms.time * 5.0 + input.particlePhase * 6.28);
    color = mix(vec3f(0.0, 0.65, 1.0), vec3f(0.3, 1.0, 0.85), pulse);
  } else if (mode < 1.5) {
    // Heron: blue water droplets with slight white specular centre
    let h = clamp(input.uv.y * 0.5 + 0.5, 0.0, 1.0);
    color = mix(vec3f(0.0, 0.22, 0.70), vec3f(0.55, 0.82, 1.0), h * (1.0 - d));
  } else if (mode < 2.5) {
    // Kelvin: translucent water drops; rare bright spark particles
    let spark = step(0.97, fract(sin(f32(input.uv.x * 100.0)
                  + input.particlePhase * 3137.1) * 43758.5453));
    color = mix(vec3f(0.72, 0.82, 0.96), vec3f(0.85, 0.15, 1.0), spark);
  } else {
    // Solar: warm yellow photons, brightness proportional to charge
    let intensity = 0.55 + 0.45 * charge;
    color = vec3f(1.0, 0.88, 0.28) * intensity;
  }

  return vec4f(color, alpha);
}
