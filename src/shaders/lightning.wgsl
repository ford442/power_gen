// Emissive line-strip bolt for Kelvin's discharge. Vertices are generated on
// the CPU by midpoint displacement when the air breaks down; brightness fades
// with kelvinSpark (1 at the flash, decaying to 0).

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
@binding(0) @group(0) var<uniform> u: Uniforms;

@vertex fn vertexMain(@location(0) pos: vec3f) -> @builtin(position) vec4f {
  return u.viewProj * vec4f(pos, 1.0);
}

@fragment fn fragmentMain() -> @location(0) vec4f {
  let i = clamp(u.kelvinSpark, 0.0, 1.0);
  return vec4f(vec3f(0.75, 0.88, 1.0) * (0.6 + 0.4 * i), i);
}
