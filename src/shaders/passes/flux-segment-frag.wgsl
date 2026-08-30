struct FragInput {
        @location(0) strength: f32,
        @location(1) alpha: f32,
        @location(2) phase: f32,
        @location(3) edge: f32,
        @location(4) ringHue: f32,
      }

      // deep blue → cyan → soft white → white-hot, biased by traveling phase + ring
      fn fluxColor(strength: f32, phase: f32, ringHue: f32) -> vec3f {
        let t = clamp(sqrt(strength * 2.0e6), 0.0, 1.0);
        var col: vec3f;
        if (t < 0.33) {
          let s = t / 0.33;
          col = mix(vec3f(0.0, 0.12, 0.85), vec3f(0.0, 0.82, 1.0), s);
        } else if (t < 0.66) {
          let s = (t - 0.33) / 0.33;
          col = mix(vec3f(0.0, 0.82, 1.0), vec3f(0.75, 1.0, 1.0), s);
        } else {
          let s = (t - 0.66) / 0.34;
          col = mix(vec3f(0.75, 1.0, 1.0), vec3f(1.25, 1.2, 1.1), s);
        }
        // Per-ring hue shift (inner cyan → outer warm)
        let ringTint = mix(vec3f(0.0, 0.15, 0.35), vec3f(0.35, 0.22, 0.0), ringHue);
        col = mix(col, col + ringTint, 0.28);
        let pulse = 0.82 + 0.18 * sin(phase * 6.2832);
        return col * pulse;
      }

      @fragment
      fn main(input: FragInput) -> @location(0) vec4f {
        let core = fluxColor(input.strength, input.phase, input.ringHue);
        // Soft tube profile: brighter core, softer edges
        let edgeFalloff = 1.0 - smoothstep(0.35, 1.0, input.edge);
        let a = input.alpha * (0.55 + 0.45 * edgeFalloff);
        return vec4f(core * (0.85 + a * 0.45), a);
      }
