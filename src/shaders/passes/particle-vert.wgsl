#include "common/frame-uniforms.wgsl"
#include "common/device-uniforms.wgsl"
#include "common/particle.wgsl"

      @binding(0) @group(0) var<uniform> uniforms: Uniforms;
      @binding(1) @group(0) var<uniform> device: DeviceUniforms;
      @binding(4) @group(0) var<storage, read> particles: array<GpuParticle>;
      
      struct VertexOutput {
        @builtin(position) position: vec4f,
        @location(0) particlePhase: f32,
        @location(1) uv: vec2f,
        @location(2) effectType: f32,
        @location(3) speed: f32,
        @location(4) life: f32
      }
      
      fn quadVert(idx: u32) -> vec2f {
        return vec2f(
          select(-1.0, 1.0, (idx & 1u) == 1u),
          select(-1.0, 1.0, idx >= 2u)
        );
      }

      fn modePathPos(mode: f32, phase: f32, t: f32) -> vec3f {
        if (mode < 0.5) {
          let cycleT = fract(t * 0.12 + phase);
          let radius = 8.5 - cycleT * 8.0;
          let angle = phase * 6.28318 + cycleT * 18.84956;
          let height = sin(cycleT * 12.56636 + phase * 6.28318) * 2.8;
          return vec3f(cos(angle) * radius, height, sin(angle) * radius);
        } else if (mode < 1.5) {
          let cycleT = fract(t * 0.22 + phase);
          let spread = phase * 6.28318;
          let spreadR = fract(phase * 71.0) * 0.55;
          if (cycleT < 0.35) {
            let k = cycleT / 0.35;
            return vec3f(sin(spread) * spreadR * k * 1.4, 5.6 + k * 3.1 - k * k * 1.2, cos(spread) * spreadR * k * 1.4);
          } else if (cycleT < 0.72) {
            let k = (cycleT - 0.35) / 0.37;
            return vec3f(sin(spread) * spreadR * (1.4 - k * 0.9), 8.5 - k * 4.2, cos(spread) * spreadR * (1.4 - k * 0.9));
          }
          let k = (cycleT - 0.72) / 0.28;
          return vec3f(sin(spread) * spreadR * (0.5 - k * 0.5), 4.5 - k * 6.5, cos(spread) * spreadR * (0.5 - k * 0.5));
        } else if (mode < 2.5) {
          let cycleT = fract(t * 0.32 + phase);
          let side = select(-1.0, 1.0, fract(phase * 123.0) > 0.5);
          let wobble = sin(t * 4.0 + phase * 20.0) * 0.09;
          if (cycleT < 0.82) {
            let k = cycleT / 0.82;
            return vec3f(side * 2.5 + wobble, 5.5 - k * 8.8, wobble * 0.4);
          }
          let k = (cycleT - 0.82) / 0.18;
          return vec3f(side * 2.5 * (1.0 - k * 1.9), -3.2 + k * 1.4, 0.0);
        } else if (mode < 3.5) {
          let ledIdx = floor(fract(phase * 71.0) * 6.0);
          let angle = (ledIdx / 6.0) * 6.28318;
          let ledPos = vec3f(cos(angle) * 2.8, 3.5, sin(angle) * 2.8);
          let u = fract(t * 0.22 + phase);
          let panel = vec3f((fract(phase * 37.0) - 0.5) * 5.0, 0.12, (fract(phase * 23.0) - 0.5) * 5.0);
          return mix(ledPos, panel, min(u * 1.05, 1.0));
        }
        let z = (phase * 2.0 - 1.0) * 3.0;
        let y = sin(t * 2.0 + phase * 11.0) * 0.8;
        return vec3f(0.6 * sin(t * 0.9 + phase * 8.0), y, z);
      }

      fn velocityForParticle(pos: vec3f, mode: f32, phase: f32, effectType: f32, t: f32) -> vec3f {
        if (effectType < 0.5) {
          let dt = 0.015;
          let p1 = modePathPos(mode, phase, t + dt);
          let p0 = modePathPos(mode, phase, t - dt);
          return (p1 - p0) / (2.0 * dt);
        } else if (effectType < 1.5) {
          let radial = normalize(vec3f(pos.x, 0.2, pos.z) + vec3f(1e-4, 0.0, 0.0));
          return radial * 3.8 + vec3f(0.0, 1.2, 0.0);
        } else if (effectType < 2.5) {
          return vec3f(sin(t * 2.0 + phase * 9.0), cos(t * 1.5 + phase * 13.0), cos(t * 2.4 + phase * 7.0)) * 0.7;
        } else if (effectType < 3.5) {
          return vec3f(cos(t * 6.0 + phase * 12.0), sin(t * 9.0 + phase * 8.0), 0.0) * 2.5;
        } else if (effectType < 4.5) {
          return vec3f(sin(t * 1.3 + phase * 6.0), 0.6 * cos(t * 1.9 + phase * 4.5), cos(t * 1.1 + phase * 7.0)) * 0.5;
        } else if (effectType < 5.5) {
          let radial = normalize(vec3f(pos.x, 0.02, pos.z) + vec3f(1e-4, 0.0, 0.0));
          return radial * (1.2 + phase * 2.6) + vec3f(0.0, 0.08, 0.0);
        } else if (effectType < 6.5) {
          let side = select(-1.0, 1.0, fract(phase * 129.0) > 0.5);
          return vec3f(side * (2.5 + 1.6 * sin(t * 6.5 + phase * 19.0)), sin(t * 12.0 + phase * 21.0) * 1.2, cos(t * 8.0 + phase * 17.0) * 0.9);
        } else if (effectType < 7.5) {
          return vec3f(cos(t * 7.0 + phase * 31.0), -1.0 - 0.5 * sin(t * 4.5 + phase * 9.0), sin(t * 6.2 + phase * 27.0)) * 0.45;
        }
        return vec3f(0.0, 0.0, 0.0);
      }
      
      @vertex
      fn main(
        @builtin(vertex_index) vertIdx: u32,
        @builtin(instance_index) instIdx: u32
      ) -> VertexOutput {
        let particle = particles[instIdx];
        let pos = particle.pos;
        let encodedPhase = particle.phase;
        let effectType = floor(encodedPhase);
        let phase = fract(encodedPhase);
        let quadPos = quadVert(vertIdx);
        
        let devicePos = vec3f(device.posX, device.posY, device.posZ);
        let mode = device.ringIndex;
        let vel = velocityForParticle(pos, mode, phase, effectType, uniforms.time);
        let speed = length(vel);
        let velDir = normalize(vel + vec3f(1e-5, 0.0, 0.0));
        let toCamera = normalize(uniforms.cameraPos - pos - devicePos);
        let up = vec3f(0.0, 1.0, 0.0);
        let fallbackRight = normalize(cross(up, toCamera) + vec3f(1e-4, 0.0, 0.0));
        var right = normalize(cross(toCamera, velDir));
        if (length(right) < 0.01) {
          right = fallbackRight;
        }
        let billboardUp = normalize(cross(right, toCamera));
        
        // Particle size varies by mode
        var size: f32 = 0.07;
        if (mode > 0.5 && mode < 1.5) {
          size = 0.11;   // larger water droplets for Heron
        } else if (mode >= 3.5) {
          size = 0.08;   // Peltier particles
        } else if (mode >= 2.5) {
          size = 0.05;   // small photon dots for Solar
        }

        var stretch = 1.0 + speed * 0.8;
        if (effectType > 0.5 && effectType < 1.5) {
          stretch = 2.0 + speed * 1.5;
          size *= 0.75;
        } else if (effectType > 1.5 && effectType < 2.5) {
          stretch = 1.2;
          size *= 2.6;
        } else if (effectType > 6.5 && effectType < 7.5) {
          stretch = 1.6;
          size *= 1.8;
        } else if (effectType > 5.5 && effectType < 6.5) {
          stretch = 3.1;
          size *= 0.72;
        } else if (effectType > 4.5 && effectType < 5.5) {
          stretch = 0.9;
          size *= 3.2;
        } else if (effectType > 3.5 && effectType < 4.5) {
          stretch = 1.15;
          size *= 4.0;
        } else if (effectType > 2.5 && effectType < 3.5) {
          stretch = 2.6;
          size *= 0.6;
        }
        
        let worldPos = pos + devicePos + 
                       right * quadPos.x * size + 
                       velDir * quadPos.y * size * stretch;
        
        var output: VertexOutput;
        output.position = uniforms.viewProj * vec4f(worldPos, 1.0);
        output.particlePhase = phase;
        output.uv = quadPos * 0.5 + 0.5;
        output.effectType = effectType;
        output.speed = speed;
        output.life = fract(uniforms.time * 0.5 + phase);
        
        return output;
      }
