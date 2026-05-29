// Particle billboards. Reads the stateful particle records (position, phase,
// velocity, aux) produced by compute.wgsl and colours them by physical state.

struct Uniforms {
  viewProj:       mat4x4f,
  time:           f32,
  mode:           f32,
  particleCount:  f32,
  battery:        f32,
  dt:             f32,
  segOmega:       f32,
  fieldStrength:  f32,
  heronVExit:     f32,
  heronHead:      f32,
  kelvinE:        f32,
  kelvinVoltageN: f32,
  kelvinSpark:    f32,
  solarN2:        f32,
  corona:         f32,
  simClock:       f32,
  spare:          f32,
}

@binding(0) @group(0) var<uniform> uniforms: Uniforms;

struct ParticleVert {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,          // corner UV in -1..1 for circular clip
  @location(1) particlePhase: f32,
  @location(2) speed: f32,         // |velocity| – state-driven shading
  @location(3) aux: f32,           // Kelvin: signed charge; Solar: reflected flag
}

@vertex fn vertexMain(
  @location(0) pos: vec3f,          // particle world position (per instance)
  @location(1) phase: f32,          // particle phase seed  (per instance)
  @location(2) vel: vec3f,          // particle velocity     (per instance)
  @location(3) aux: f32,            // per-mode scalar        (per instance)
  @builtin(vertex_index)   vertIdx:    u32,
  @builtin(instance_index) instanceIdx: u32
) -> ParticleVert {
  var output: ParticleVert;

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
  } else if (uniforms.mode >= 2.5 && uniforms.mode < 4.5) {
    size = 0.05;   // small photon dots for Solar / Peltier
  } else if (uniforms.mode >= 4.5) {
    size = 0.09;   // medium metallic globs for MHD molten bismuth
  }

  let right = vec3f(uniforms.viewProj[0][0], uniforms.viewProj[1][0], uniforms.viewProj[2][0]);
  let up    = vec3f(uniforms.viewProj[0][1], uniforms.viewProj[1][1], uniforms.viewProj[2][1]);

  let worldPos = pos + right * (corner.x * size) + up * (corner.y * size);

  output.position      = uniforms.viewProj * vec4f(worldPos, 1.0);
  output.uv            = corner;
  output.particlePhase = phase;
  output.speed         = length(vel);
  output.aux           = aux;
  return output;
}
@fragment fn fragmentMain(input: ParticleVert) -> @location(0) vec4f {
  let d = length(input.uv);
  if (d > 1.0) { discard; }

  var alpha = (1.0 - d) * 0.85;
  let mode = uniforms.mode;
  let charge = clamp(uniforms.battery, 0.0, 1.0);
  var color: vec3f;

  if (mode < 0.5) {
    // SEG: cyan/electric-blue field tracers
    let pulse = 0.6 + 0.4 * sin(uniforms.time * 5.0 + input.particlePhase * 6.28);
    let base = mix(vec3f(0.0, 0.65, 1.0), vec3f(0.3, 1.0, 0.85), pulse);
    color = base * (0.7 + 0.6 * uniforms.corona);

  } else if (mode < 1.5) {
    // Heron: water droplets. Fast jets are bright/white, slow droplets near apex stay deep blue.
    let sprayWhite = clamp(input.speed / 9.0, 0.0, 1.0);
    let deep = vec3f(0.0, 0.22, 0.70);
    let bright = vec3f(0.6, 0.85, 1.0);
    color = mix(deep, bright, sprayWhite * (1.0 - d * 0.4));

  } else if (mode < 2.5) {
    // Kelvin: charged water droplets. Glow strength follows field voltage.
    // Sign of charge tints the droplet (warm = +, cool = -).
    let qmag = clamp(abs(input.aux), 0.0, 1.0);
    let cool = vec3f(0.72, 0.82, 0.96);
    let warm = vec3f(0.95, 0.45, 0.35);
    let glow = mix(cool, warm, step(0.0, input.aux));
    color = mix(cool, glow, qmag * (0.35 + 0.65 * uniforms.kelvinVoltageN));
    alpha = alpha * (0.75 + 0.25 * qmag);

  } else if (mode < 4.5) {
    // Solar / Peltier: warm yellow photons.
    // Reflected rays (aux > 0.5) produce a hot white glare.
    let intensity = 0.55 + 0.45 * charge;
    let travel = vec3f(1.0, 0.88, 0.28) * intensity;
    let glare = vec3f(1.0, 0.98, 0.85);
    color = mix(travel, glare, step(0.5, input.aux));

  } else {
    // MHD Generator: molten bismuth with charge separation
    let bismuthSilver = mix(vec3f(0.6, 0.6, 0.65), vec3f(0.8, 0.7, 0.8), input.uv.y * 0.5 + 0.5);
    let pulse = 0.6 + 0.4 * sin(uniforms.time * 4.0 + input.particlePhase * 10.0);

    if (input.particlePhase < 0.5) {
      // Positive ions → hot plasma red
      color = mix(bismuthSilver, vec3f(1.0, 0.25, 0.1), pulse);
    } else {
      // Electrons → electric blue
      color = mix(bismuthSilver, vec3f(0.15, 0.45, 1.0), pulse);
    }
  }

  return vec4f(color, alpha);
}
