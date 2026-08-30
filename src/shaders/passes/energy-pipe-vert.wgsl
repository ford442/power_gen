#include "common/frame-uniforms.wgsl"
#include "common/pipe-particle.wgsl"

@binding(0) @group(0) var<uniform> uniforms: Uniforms;
@binding(1) @group(0) var<uniform> pipe: PipeUniforms;
@binding(2) @group(0) var<storage> particles: array<PipeParticle>;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) color: vec3f,
  @location(1) alpha: f32,
  @location(2) uv: vec2f
}

@vertex
fn main(@builtin(vertex_index) vertIdx: u32, @builtin(instance_index) instIdx: u32) -> VertexOutput {
  let p = particles[instIdx];
  let worldPos = vec3f(p.posX, p.posY, p.posZ);

  let q = vec2f(
    select(-1.0, 1.0, (vertIdx & 1u) == 1u),
    select(-1.0, 1.0, vertIdx >= 2u)
  );
  let vel = vec3f(p.velX, p.velY, p.velZ);
  let speed = length(vel);
  let velDir = normalize(vel + vec3f(1e-5, 0.0, 0.0));
  let toCam = normalize(uniforms.cameraPos - worldPos);
  let right = normalize(cross(toCam, velDir));
  let up = normalize(cross(right, toCam));
  let size = 0.14 + pipe.flow * 0.22;
  let stretch = 1.0 + speed * 1.6;
  let offset = right * q.x * size + up * q.y * size * stretch;
  let pos = worldPos + offset;

  var out: VertexOutput;
  out.position = uniforms.viewProj * vec4f(pos, 1.0);
  out.color = pipe.color;
  out.alpha = p.life * p.strength * (0.35 + pipe.flow * 0.85);
  out.uv = q * 0.5 + 0.5;
  return out;
}
