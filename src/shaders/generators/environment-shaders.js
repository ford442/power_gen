export function getSkyVertShader() {
    return /* wgsl */ `
      struct VertexOutput {
        @builtin(position) position: vec4f,
        @location(0) uv: vec2f
      }

      @vertex
      fn main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
        // Oversized triangle that covers the entire clip-space screen
        var pos = array<vec2f, 3>(
          vec2f(-1.0, -1.0),
          vec2f( 3.0, -1.0),
          vec2f(-1.0,  3.0)
        );
        var output: VertexOutput;
        // Oversized triangle that covers the entire clip-space screen;
        // z=0.9999 places it just behind all scene geometry at the far plane
        output.position = vec4f(pos[vertexIndex], 0.9999, 1.0);
        output.uv = pos[vertexIndex] * 0.5 + 0.5;
        return output;
      }
    `;
  }

export function getSkyFragShader() {
    return /* wgsl */ `
      struct FragmentInput {
        @location(0) uv: vec2f
      }

      @fragment
      fn main(input: FragmentInput) -> @location(0) vec4f {
        let y = input.uv.y;

        // Vertical gradient: near-black deep space at top, dark teal/navy at horizon
        let topColor     = vec3f(0.008, 0.008, 0.035);
        let horizonColor = vec3f(0.025, 0.055, 0.110);
        var color = mix(horizonColor, topColor, y);

        // Subtle radial nebula bloom near screen centre
        let center = vec2f(0.5, 0.5);
        let dist = length(input.uv - center);
        let nebula = exp(-dist * dist * 3.5) * 0.08;
        color += vec3f(0.08, 0.20, 0.55) * nebula;

        // Soft energy aura rising from below (device glow)
        let lowCenter = vec2f(0.5, 0.18);
        let lowDist = length(input.uv - lowCenter);
        let energyGlow = exp(-lowDist * lowDist * 4.5) * 0.055;
        color += vec3f(0.15, 0.45, 1.00) * energyGlow;

        return vec4f(color, 1.0);
      }
    `;
  }

export function getGridVertShader() {
    return /* wgsl */ `
      struct VertexOutput {
        @builtin(position) position: vec4f,
        @location(0) uv: vec2f
      }
      
      @vertex
      fn main(@location(0) pos: vec2f) -> VertexOutput {
        var output: VertexOutput;
        output.position = vec4f(pos, 0.0, 1.0);
        output.uv = pos * 0.5 + 0.5;
        return output;
      }
    `;
  }

export function getGridFragShader() {
    return /* wgsl */ `
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

        let isLine = clamp(step(gridX, lineWidth) + step(gridY, lineWidth), 0.0, 1.0);

        let lineColor = vec3f(0.12, 0.22, 0.38);

        // Distance fade: lines vanish at the edges and near the SEG centre
        let distFromCenter = length(worldPos);
        let distFade = 1.0 - smoothstep(4.5, 10.5, distFromCenter);
        let nearFade  = smoothstep(0.8, 2.5, distFromCenter);
        let alpha = 0.40 * distFade * nearFade * isLine;

        return vec4f(lineColor, alpha);
      }
    `;
  }

