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

  let rollerCount = 12.0;
  let ringRadius = 4.0;

  // Calculate roller position around ring
  let angle = f32(instanceIdx) * (6.28318530718 / rollerCount) + uniforms.time * 0.2;
  let center = vec3f(cos(angle) * ringRadius, 0.0, sin(angle) * ringRadius);

  // Spin roller
  let spinAngle = uniforms.time * 3.0 + f32(instanceIdx) * 0.5;
  let c = cos(spinAngle);
  let s = sin(spinAngle);
  let rotPos = vec3f(
    position.x * c - position.z * s,
    position.y,
    position.x * s + position.z * c
  );

  // Tilt roller
  let tiltAngle = 0.1 * sin(uniforms.time + f32(instanceIdx));
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
  output.instanceId = f32(instanceIdx);

  return output;
}

@fragment fn fragmentMain(
  @location(0) normal: vec3f,
  @location(1) worldPos: vec3f,
  @location(2) instanceId: f32
) -> @location(0) vec4f {
  let n = normalize(normal);
  let viewPos = vec3f(
    cos(uniforms.time * 0.1) * 12.0,
    3.0,
    sin(uniforms.time * 0.1) * 12.0
  );
  let viewDir = normalize(viewPos - worldPos);

  let fieldPattern = sin(worldPos.y * 4.0 + uniforms.time * 4.0) *
                     cos(length(worldPos.xz) * 5.0 - uniforms.time * 3.0 + instanceId);
  let baseColor = vec3f(0.7, 0.75, 0.8);
  let magneticColor = vec3f(0.0, 0.9, 1.0);
  let fresnel = pow(1.0 - abs(dot(n, viewDir)), 2.0);

  var finalColor: vec3f;

  if (uniforms.mode < 0.5) {
    // SEG mode
    let fieldGlow = magneticColor * (fieldPattern * 0.3 + 0.5) * fresnel * 2.0;
    let rollerColor = baseColor + vec3f(0.0, 0.1, 0.1) * (instanceId / 12.0);
    finalColor = rollerColor + fieldGlow;
  } else if (uniforms.mode < 1.5) {
    // Heron's Fountain mode
    let waterPattern = sin(worldPos.y * 8.0 + uniforms.time * 2.0) * 0.5 + 0.5;
    finalColor = mix(vec3f(0.0, 0.2, 0.6), vec3f(0.0, 0.6, 1.0), waterPattern) + fresnel * 0.5;
  } else {
    // Kelvin's Thunderstorm mode
    let electric = fract(sin(dot(worldPos.xz, vec2f(12.9898, 78.233))) * 43758.5453);
    let spark = step(0.98, electric);
    finalColor = mix(vec3f(0.4, 0.0, 0.6), vec3f(1.0, 0.5, 1.0), spark) +
                 fresnel * vec3f(0.5, 0.0, 0.5);
  }

  let halfDir = normalize(viewDir + vec3f(0.0, 1.0, 0.0));
  let spec = pow(max(dot(n, halfDir), 0.0), 64.0);
  finalColor += vec3f(spec * 0.5);

  return vec4f(finalColor, 1.0);
}
