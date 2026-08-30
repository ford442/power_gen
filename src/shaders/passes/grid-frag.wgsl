struct FragmentInput {
        @location(0) uv: vec2f
      }

      @fragment
      fn main(input: FragmentInput) -> @location(0) vec4f {
        let gridSize = 20.0;
        let worldPos = input.uv * gridSize - gridSize * 0.5;

        let lineWidth = 0.05;
        let gridX = abs(fract(worldPos.x) - 0.5);
        let gridY = abs(fract(worldPos.y) - 0.5);
        let isMinor = clamp(step(gridX, lineWidth) + step(gridY, lineWidth), 0.0, 1.0);

        // Major grid every 5 m (educational scale reference)
        let majorX = abs(fract(worldPos.x / 5.0) - 0.5);
        let majorY = abs(fract(worldPos.y / 5.0) - 0.5);
        let isMajor = clamp(step(majorX, lineWidth * 1.4) + step(majorY, lineWidth * 1.4), 0.0, 1.0);

        var lineColor = vec3f(0.12, 0.22, 0.38);
        lineColor = mix(lineColor, vec3f(0.20, 0.34, 0.55), isMajor * 0.85);
        let isLine = max(isMinor, isMajor * 0.9);

        // Distance fade: lines vanish at the edges and near the SEG centre
        let distFromCenter = length(worldPos);
        let distFade = 1.0 - smoothstep(4.5, 10.5, distFromCenter);
        let nearFade  = smoothstep(0.8, 2.5, distFromCenter);
        let alpha = 0.42 * distFade * nearFade * isLine;

        return vec4f(lineColor, alpha);
      }
