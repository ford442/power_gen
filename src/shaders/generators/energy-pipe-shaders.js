/**
 * Animated energy-transfer pipes between devices in world space.
 * Particles travel along cubic Bézier arcs; color comes from pipe uniforms.
 */

import energyPipeComputeWgsl from '../passes/energy-pipe-compute.wgsl?raw';
import frameUniformsWgsl from '../common/frame-uniforms.wgsl?raw';
import pipeParticleWgsl from '../common/pipe-particle.wgsl?raw';

export function getEnergyPipeComputeShader() {
  return energyPipeComputeWgsl;
}

export function getEnergyPipeVertShader() {
  return /* wgsl */ `
${frameUniformsWgsl}
${pipeParticleWgsl}

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
  `;
}

export function getEnergyPipeFragShader() {
  return /* wgsl */ `
    struct FragmentInput {
      @location(0) color: vec3f,
      @location(1) alpha: f32,
      @location(2) uv: vec2f
    }

    @fragment
    fn main(input: FragmentInput) -> @location(0) vec4f {
      let d = length(input.uv * 2.0 - 1.0);
      if (d > 1.0) { discard; }
      let core = exp(-d * d * 9.0);
      let halo = exp(-d * d * 3.0) * 0.45;
      let glow = (core + halo) * input.alpha;
      return vec4f(input.color * (1.2 + glow * 0.8), glow);
    }
  `;
}
