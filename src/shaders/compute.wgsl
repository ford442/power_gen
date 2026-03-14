@binding(0) @group(0) var<storage, read_write> particles: array<vec4f>;
@binding(1) @group(0) var<uniform> uniforms: vec4f;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let idx = id.x;
  let count = u32(uniforms.z);

  if (idx >= count) {
    return;
  }

  var p = particles[idx];
  let time = uniforms.x;
  let mode = uniforms.y;
  let battery = uniforms.w;

  if (mode < 0.5) {
    // SEG mode - spiral inward
    let dist = length(vec2f(p.x, p.z));
    let angle = atan2(p.z, p.x) + 0.02 + sin(time + p.y) * 0.01;
    let newDist = dist * 0.998;
    p.x = cos(angle) * newDist;
    p.z = sin(angle) * newDist;
    p.y += sin(time * 2.0 + dist) * 0.005;

    if (newDist < 0.8) {
      // Reset particle at boundary
      let theta = fract(f32(idx) * 0.61803398875) * 6.28318530718;
      let r = 5.0 + fract(f32(idx) * 0.31415) * 2.0;
      p.x = r * cos(theta);
      p.z = r * sin(theta);
      p.y = (fract(f32(idx) * 0.1234) - 0.5) * 6.0;
    }
  } else if (mode < 1.5) {
    // Heron's Fountain mode - fountain flow
    p.y += 0.05;
    p.x += sin(time + p.w * 10.0) * 0.02;
    p.z += cos(time + p.w * 10.0) * 0.02;

    if (p.y > 4.0) {
      // Reset at fountain base
      p.y = -2.0;
      let theta = fract(f32(idx) * 0.618) * 6.28;
      let r = fract(f32(idx) * 0.314) * 1.5;
      p.x = cos(theta) * r;
      p.z = sin(theta) * r;
    }
  } else if (mode < 2.5) {
    // Kelvin's Thunderstorm mode - electric discharge
    let dist = length(vec2f(p.x, p.z));

    if (dist < 0.1) {
      // Discharge and reset
      p.x = (fract(f32(idx) * 0.123) - 0.5) * 8.0;
      p.z = (fract(f32(idx) * 0.456) - 0.5) * 8.0;
      p.y = 5.0 + fract(f32(idx) * 0.789) * 2.0;
    } else {
      p.y -= 0.1;
      p.x += (fract(sin(f32(idx) + time)) - 0.5) * 0.1;
      p.z += (fract(cos(f32(idx) + time)) - 0.5) * 0.1;
    }
  } else {
    // Solar LEDs + panels mode - particles represent photons from LEDs to solar cells
    let ledCount = 6u;
    let ledIdx = u32(fract(p.w) * f32(ledCount));
    let ledAngle = f32(ledIdx) * 6.28318530718 / f32(ledCount);
    let ledPos = vec3f(cos(ledAngle) * 3.0, 3.5, sin(ledAngle) * 3.0);

    // Target point on the solar panel plane (y=0)
    let target = vec3f(
      (fract(f32(idx) * 0.618) - 0.5) * 6.0,
      0.0,
      (fract(f32(idx) * 0.314) - 0.5) * 4.0
    );

    // Progress along the ray based on time and particle-specific phase
    let progress = fract(time * 0.5 + p.w * 10.0);
    let speedMod = mix(0.5, 1.5, battery);
    let t = progress * speedMod;
    t = clamp(t, 0.0, 1.0);

    p.xyz = mix(ledPos, target, t);

    // Reset phase when the particle reaches the panel so it can restart
    if (progress > 0.98) {
      p.w = fract(p.w * 1.618 + 0.33);
    }
  }

  particles[idx] = p;
}

