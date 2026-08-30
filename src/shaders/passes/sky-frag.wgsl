struct SkyParams {
        mode: f32,       // 0=drama/space, 1=studio, 2=lab
        energyGlow: f32,
        _pad0: f32,
        _pad1: f32,
      }

      @group(0) @binding(0) var<uniform> sky: SkyParams;

      struct FragmentInput {
        @location(0) uv: vec2f
      }

      @fragment
      fn main(input: FragmentInput) -> @location(0) vec4f {
        let y = input.uv.y;
        var color: vec3f;

        if (sky.mode < 0.5) {
          // Drama — deep space with subtle nebula
          let topColor = vec3f(0.008, 0.008, 0.035);
          let horizonColor = vec3f(0.025, 0.055, 0.110);
          color = mix(horizonColor, topColor, y);
          let dist = length(input.uv - vec2f(0.5, 0.5));
          color += vec3f(0.08, 0.20, 0.55) * exp(-dist * dist * 3.5) * 0.08;
        } else if (sky.mode < 1.5) {
          // Studio — neutral grey sweep (photography backdrop)
          let topColor = vec3f(0.42, 0.44, 0.48);
          let horizonColor = vec3f(0.62, 0.64, 0.68);
          color = mix(horizonColor, topColor, pow(y, 0.85));
          let sweep = smoothstep(0.15, 0.85, input.uv.x) * 0.04;
          color += vec3f(sweep);
        } else {
          // Lab — bright even white-grey
          let topColor = vec3f(0.72, 0.74, 0.78);
          let horizonColor = vec3f(0.82, 0.84, 0.87);
          color = mix(horizonColor, topColor, pow(y, 0.7));
        }

        // Soft device energy aura from below
        let lowCenter = vec2f(0.5, 0.18);
        let lowDist = length(input.uv - lowCenter);
        let energyGlow = exp(-lowDist * lowDist * 4.5) * (0.04 + sky.energyGlow * 0.12);
        color += vec3f(0.15, 0.45, 1.00) * energyGlow;

        return vec4f(color, 1.0);
      }
