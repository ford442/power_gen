struct Uniforms {
  viewProj: mat4x4f,
  time: f32,
  mode: f32,
  particleCount: f32,
  _pad: f32,
}

@binding(0) @group(0) var<uniform> uniforms: Uniforms;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) normal: vec3f,
  @location(1) worldPos: vec3f,
  @location(2) instanceId: f32,
}

@vertex fn vertexMain(
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @builtin(instance_index) instanceIdx: u32
) -> VertexOutput {
  var output: VertexOutput;

  var rollerCount: f32;
  var ringRadius: f32;
  var ringId: f32;
  var localIdx: f32;

  let globalIdx = f32(instanceIdx);

  // Determine which ring and local index
  if (globalIdx < 12.0) {
    // Inner ring: 12 rollers at radius 3.5
    ringId = 0.0;
    rollerCount = 12.0;
    ringRadius = 3.5;
    localIdx = globalIdx;
  } else if (globalIdx < 34.0) {
    // Middle ring: 22 rollers at radius 5.5
    ringId = 1.0;
    rollerCount = 22.0;
    ringRadius = 5.5;
    localIdx = globalIdx - 12.0;
  } else {
    // Outer ring: 32 rollers at radius 7.5
    ringId = 2.0;
    rollerCount = 32.0;
    ringRadius = 7.5;
    localIdx = globalIdx - 34.0;
  }

  // Calculate roller position around ring
  let angle = localIdx * (6.28318530718 / rollerCount) + uniforms.time * 0.2;
  let center = vec3f(cos(angle) * ringRadius, 0.0, sin(angle) * ringRadius);

  // Spin roller
  let spinAngle = uniforms.time * 3.0 + globalIdx * 0.5;
  let c = cos(spinAngle);
  let s = sin(spinAngle);
  let rotPos = vec3f(
    position.x * c - position.z * s,
    position.y,
    position.x * s + position.z * c
  );

  // Tilt roller
  let tiltAngle = 0.1 * sin(uniforms.time + globalIdx);
  let ct = cos(tiltAngle);
  let st = sin(tiltAngle);
  let tiltedPos = vec3f(
    rotPos.x,
    rotPos.y * ct - rotPos.z * st,
    rotPos.y * st + rotPos.z * ct
  );

  let worldPos = tiltedPos + center;

  output.position = uniforms.viewProj * vec4f(worldPos, 1.0);
  output.normal = normal;
  output.worldPos = worldPos;
  output.instanceId = globalIdx;

  return output;
}

@fragment fn fragmentMain(
  @location(0) normal: vec3f,
  @location(1) worldPos: vec3f,
  @location(2) instanceId: f32
) -> @location(0) vec4f {
  let n = normalize(normal);
  let viewPos = vec3f(
    cos(uniforms.time * 0.1) * 16.0,
    4.0,
    sin(uniforms.time * 0.1) * 16.0
  );
  let viewDir = normalize(viewPos - worldPos);

  let fieldPattern = sin(worldPos.y * 4.0 + uniforms.time * 4.0) *
                     cos(length(worldPos.xz) * 5.0 - uniforms.time * 3.0 + instanceId);
  let magneticColor = vec3f(0.0, 0.9, 1.0);
  let fresnel = pow(1.0 - abs(dot(n, viewDir)), 2.0);

  var ringColor: vec3f;
  var baseColor: vec3f;

  // Ring-specific colors
  if (instanceId < 12.0) {
    // Inner ring: golden
    ringColor = vec3f(1.0, 0.8, 0.2);
    baseColor = vec3f(0.8, 0.7, 0.4);
  } else if (instanceId < 34.0) {
    // Middle ring: silver
    ringColor = vec3f(0.8, 0.9, 1.0);
    baseColor = vec3f(0.7, 0.75, 0.8);
  } else {
    // Outer ring: copper
    ringColor = vec3f(1.0, 0.6, 0.2);
    baseColor = vec3f(0.9, 0.5, 0.3);
  }

  var finalColor: vec3f;

  if (uniforms.mode < 0.5) {
    // SEG mode
    let fieldGlow = magneticColor * (fieldPattern * 0.3 + 0.5) * fresnel * 2.0;
    finalColor = baseColor + ringColor * 0.3 + fieldGlow;
  } else if (uniforms.mode < 1.5) {
    // Heron's Fountain mode
    let waterPattern = sin(worldPos.y * 8.0 + uniforms.time * 2.0) * 0.5 + 0.5;
    finalColor = mix(vec3f(0.0, 0.2, 0.6), vec3f(0.0, 0.6, 1.0), waterPattern) + fresnel * 0.5;
  } else if (uniforms.mode < 2.5) {
    // Kelvin's Thunderstorm mode
    let electric = fract(sin(dot(worldPos.xz, vec2f(12.9898, 78.233))) * 43758.5453);
    let spark = step(0.98, electric);
    finalColor = mix(vec3f(0.4, 0.0, 0.6), vec3f(1.0, 0.5, 1.0), spark) +
                 fresnel * vec3f(0.5, 0.0, 0.5);
  } else {
    // LEDs + Solar Cells mode
    let charge = clamp(uniforms._pad, 0.0, 1.0);
    let ledGlow = mix(vec3f(0.7, 0.7, 0.2), vec3f(1.0, 1.0, 0.8), charge);
    let panelBase = vec3f(0.08, 0.12, 0.22);
    let grid = step(0.95, fract(worldPos.x * 1.0)) * step(0.95, fract(worldPos.z * 1.0));
    let panelColor = mix(panelBase, vec3f(0.2, 0.5, 0.9), grid);

    // Use ring assignment to simulate LEDs (inner), panels (middle), and battery cells (outer)
    if (instanceId < 12.0) {
      finalColor = ledGlow + fresnel * vec3f(0.8, 0.7, 0.3);
    } else if (instanceId < 34.0) {
      finalColor = panelColor + fresnel * vec3f(0.2, 0.3, 0.4) * (0.3 + charge * 0.7);
    } else {
      // battery cells visualized as metallic blocks
      let batteryColor = mix(vec3f(0.2, 0.2, 0.2), vec3f(0.2, 1.0, 0.2), charge);
      finalColor = batteryColor + fresnel * vec3f(0.4, 0.6, 0.3);
    }
  }

  let halfDir = normalize(viewDir + vec3f(0.0, 1.0, 0.0));
  let spec = pow(max(dot(n, halfDir), 0.0), 64.0);
  finalColor += vec3f(spec * 0.5);

  return vec4f(finalColor, 1.0);
}
