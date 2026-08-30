#include "common/frame-uniforms.wgsl"
#include "common/device-uniforms.wgsl"

      struct MaterialUniforms {
        baseColor: vec3f,
        pad1: f32,
        glowColor: vec3f,
        emission: f32
      }
      
      @binding(0) @group(0) var<uniform> uniforms: Uniforms;
      @binding(1) @group(0) var<uniform> device: DeviceUniforms;
      @binding(3) @group(0) var<uniform> material: MaterialUniforms;
      
      struct FragmentInput {
        @location(0) particlePhase: f32,
        @location(1) uv: vec2f,
        @location(2) effectType: f32,
        @location(3) speed: f32,
        @location(4) life: f32
      }
      
      @fragment
      fn main(input: FragmentInput) -> @location(0) vec4f {
        let uv = input.uv * 2.0 - 1.0;
        let dist = length(uv);
        if (dist > 1.0) {
          discard;
        }

        let effectType = input.effectType;
        var alpha: f32;
        let mode = device.ringIndex;
        let energy = clamp(device.timeScale, 0.0, 1.0);
        let overdrive = pow(energy, 1.7);
        let t = uniforms.time;
        let phase = input.particlePhase;
        var color: vec3f;

        if (effectType > 6.5 && effectType < 7.5) {
          // Solar refraction caustic photons at panel interface.
          let core = exp(-dist * dist * 20.0);
          let halo = exp(-dist * dist * 7.0) * 0.45;
          alpha = (core + halo) * (0.55 + 0.45 * energy);
          color = mix(vec3f(0.45, 0.72, 1.0), vec3f(1.0, 0.86, 0.40), 0.5 + 0.5 * sin(t * 5.0 + phase * 17.0));
        } else if (effectType > 5.5 && effectType < 6.5) {
          // Kelvin branching discharges (lightning-inspired blue-white channels).
          let trunk = exp(-abs(uv.x) * 18.0) * exp(-abs(uv.y) * 3.8);
          let branch = exp(-abs(uv.x + sin(t * 8.0 + phase * 12.0) * 0.35) * 10.0) * exp(-abs(uv.y) * 5.2);
          let flare = exp(-dist * dist * 16.0) * 0.35;
          alpha = (trunk + branch * 0.7 + flare) * (0.9 + overdrive * 1.25);
          color = vec3f(0.75, 0.88, 1.0) * (0.7 + 0.3 * (0.5 + 0.5 * sin(t * 16.0 + phase * 22.0)));
        } else if (effectType > 4.5 && effectType < 5.5) {
          // Heron impact ripples: expanding annular profile at basin.
          let ring = exp(-pow((dist - (0.35 + input.life * 0.45)) * 9.0, 2.0));
          let center = exp(-dist * dist * 18.0) * 0.25;
          alpha = (ring + center) * (0.35 + energy * 0.75);
          color = mix(vec3f(0.18, 0.40, 0.78), vec3f(0.65, 0.85, 1.0), input.life);
        } else if (effectType > 3.5 && effectType < 4.5) {
          // Heat-haze veil: broad, low-frequency flicker around high-energy parts.
          let shell = exp(-dist * dist * 1.8);
          let wobble = 0.55 + 0.45 * sin(t * 2.2 + phase * 8.0 + uv.x * 6.0);
          alpha = shell * wobble * (0.08 + energy * 0.22);
          color = mix(vec3f(1.0, 0.45, 0.15), vec3f(0.25, 0.75, 1.0), clamp(uv.y * 0.5 + 0.5, 0.0, 1.0)) * (0.12 + energy * 0.45);
        } else if (effectType > 2.5 && effectType < 3.5) {
          // Filaments: tight electric strands.
          let strand = exp(-abs(uv.x) * 22.0) * exp(-abs(uv.y) * 4.0);
          let haze = exp(-dist * dist * 8.0) * 0.2;
          alpha = strand + haze;
          color = vec3f(0.7, 0.9, 1.0) + vec3f(0.25, 0.0, 0.45) * (0.5 + 0.5 * sin(t * 17.0 + phase * 29.0));
        } else if (effectType > 1.5 && effectType < 2.5) {
          // Corona: broad soft additive sheath (layered green plasma).
          let shell = exp(-dist * dist * 2.2);
          let core = exp(-dist * dist * 9.0) * 0.42;
          let flicker = 0.5 + 0.5 * sin(t * 11.0 + phase * 13.0);
          alpha = (shell * 0.85 + core) * flicker * (0.65 + overdrive * 0.9);
          color = mix(vec3f(0.12, 0.82, 0.48), vec3f(0.55, 1.0, 0.92), input.life);
          color += vec3f(0.08, 0.45, 0.95) * shell * 0.35;
        } else if (effectType > 0.5 && effectType < 1.5) {
          // Spark bursts: sharper, elongated, dangerous look.
          let line = exp(-abs(uv.x) * 8.0) * exp(-abs(uv.y) * 2.2);
          let flare = exp(-dist * dist * 30.0);
          alpha = (line * 0.9 + flare * 0.7) * (1.1 + input.speed * 0.08 + overdrive * 1.1);
          color = mix(vec3f(0.6, 0.85, 1.0), vec3f(1.0, 0.95, 0.65), clamp(input.life * 1.2, 0.0, 1.0));
          if (mode < 2.5 || mode > 3.5) {
            color = mix(color, vec3f(0.7, 0.2, 1.0), 0.25);
          }
        } else {
          // Bright core + soft halo for additive blending
          let core = exp(-dist * dist * 22.0);
          let halo = exp(-dist * dist * 6.0) * 0.35;
          alpha = (core + halo) * 2.2;
        
          if (mode < 0.5) {
            // SEG: spiral flux particles — cyan core + green magnetic fringe
            let pulse = 0.55 + 0.45 * sin(t * 5.0 + phase * 6.28);
            let magFringe = 0.5 + 0.5 * sin(phase * 12.56 + t * 2.5);
            color = mix(vec3f(0.0, 0.55, 1.0), vec3f(0.25, 1.0, 0.62), pulse);
            color += vec3f(0.05, 0.35, 0.18) * magFringe * energy;
            alpha *= 0.85 + energy * 0.55 + overdrive * 0.35;
          } else if (mode < 1.5) {
            // Heron: blue water droplets with slight white specular centre
            let h = clamp(input.uv.y * 0.5 + 0.5, 0.0, 1.0);
            color = mix(vec3f(0.0, 0.22, 0.70), vec3f(0.55, 0.82, 1.0), h * (1.0 - dist));
          } else if (mode < 2.5) {
            // Kelvin: translucent water drops; rare bright spark particles
            let spark = step(0.97, fract(sin(f32(input.uv.x * 100.0) + phase * 3137.1) * 43758.5453));
            color = mix(vec3f(0.72, 0.82, 0.96), vec3f(0.85, 0.15, 1.0), spark);
          } else if (mode < 3.5) {
            // Solar: warm yellow photons
            let intensity = 0.55 + 0.45 * device.batteryCharge;
            color = vec3f(1.0, 0.88, 0.28) * intensity;
          } else {
            // Peltier TEG: Colors based on thermal regions
            if (phase < 0.4) {
              color = vec3f(1.0, 0.25 + 0.1 * sin(t * 3.0 + phase * 10.0), 0.0);
            } else if (phase < 0.8) {
              color = vec3f(0.0, 0.5 + 0.2 * sin(t * 2.0 + phase * 8.0), 1.0);
            } else {
              let spark = step(0.82, fract(sin(t * 18.0 + phase * 127.3) * 43758.5453));
              color = mix(vec3f(0.4, 0.95, 0.2), vec3f(1.0, 1.0, 0.6), spark * 0.7);
            }

            alpha *= 0.9 + overdrive * 1.2;
          }
        }
        
        // Add glow
        let glow = material.glowColor * material.emission * (0.35 + energy * 0.85);
        color = color + glow;
        color = color * alpha;

        return vec4f(color, alpha);
      }
