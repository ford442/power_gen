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
    `;
  }

