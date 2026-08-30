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
