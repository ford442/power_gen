import fluxLinesWgsl from '../../shaders/flux-lines.wgsl?raw';

export function getFieldLineVertShader() {
    return /* wgsl */ `
      struct Uniforms {
        viewProj: mat4x4f,
        time: f32,
        cameraPos: vec3f
      }
      
      // Canonical 48-byte DeviceUniforms struct (12 x f32)
      struct DeviceUniforms {
        renderMode: f32,              // [0]
        posX: f32,                    // [1]
        posY: f32,                    // [2]
        posZ: f32,                    // [3]
        rotation: vec4f,              // [4-7]
        timeScale: f32,               // [8]
        ringIndex: f32,               // [9]
        batteryCharge: f32,           // [10]
        isSolar: f32                  // [11]
      }
      
      // @align(4) on velocity matches the 32-byte CPU-written layout:
      // position@0(12B), velocity@12(12B), life@24(4B), strength@28(4B)
      struct FieldParticle {
        position:          vec3f,
        @align(4) velocity: vec3f,
        life:              f32,
        strength:          f32
      }
      
      @binding(0) @group(0) var<uniform> uniforms: Uniforms;
      @binding(1) @group(0) var<uniform> device: DeviceUniforms;
      @binding(4) @group(0) var<storage> particles: array<FieldParticle>;
      
      struct VertexOutput {
        @builtin(position) position: vec4f,
        @location(0) color: vec3f,
        @location(1) alpha: f32
      }
      
      @vertex
      fn main(@builtin(vertex_index) vertIdx: u32, @builtin(instance_index) instIdx: u32) -> VertexOutput {
        let particle = particles[instIdx];
        
        // Reconstruct device position from individual fields
        let devicePos = vec3f(device.posX, device.posY, device.posZ);
        let worldPos = particle.position + devicePos;
        
        var output: VertexOutput;
        output.position = uniforms.viewProj * vec4f(worldPos, 1.0);
        
        // Green energy field lines
        let copper = vec3f(0.85, 0.48, 0.25);
        let greenEnergy = vec3f(0.2, 1.0, 0.5);
        output.color = mix(copper, greenEnergy, particle.strength);
        output.alpha = particle.life * particle.strength;
        
        return output;
      }
    `;
  }

export function getFieldLineFragShader() {
    return /* wgsl */ `
      struct FragmentInput {
        @location(0) color: vec3f,
        @location(1) alpha: f32
      }
      
      @fragment
      fn main(input: FragmentInput) -> @location(0) vec4f {
        return vec4f(input.color, input.alpha * 0.6);
      }
    `;
  }

export function getFluxLineTracerShader() {
    return fluxLinesWgsl;
  }

export function getFluxSegmentVertShader() {
    return /* wgsl */ `
      struct Uniforms {
        viewProj: mat4x4f,
        time: f32,
        cameraPos: vec3f
      }

      struct DeviceUniforms {
        renderMode: f32,
        posX: f32,
        posY: f32,
        posZ: f32,
        rotation: vec4f,
        timeScale: f32,
        ringIndex: f32,
        batteryCharge: f32,
        isSolar: f32
      }

      // 32-byte layout (matches flux-lines.wgsl with @align(4) on endPos)
      struct FluxSegment {
        startPos: vec3f,
        @align(4) endPos: vec3f,
        strength: f32,
        age: f32,
      }

      @binding(0) @group(0) var<uniform> uniforms: Uniforms;
      @binding(1) @group(0) var<uniform> device: DeviceUniforms;
      @binding(2) @group(0) var<storage> segments: array<FluxSegment>;

      struct VertexOutput {
        @builtin(position) position: vec4f,
        @location(0) strength: f32,
        @location(1) alpha: f32,
      }

      @vertex
      fn main(@builtin(vertex_index) vertIdx: u32,
              @builtin(instance_index) instIdx: u32) -> VertexOutput {
        let seg = segments[instIdx];
        let devicePos = vec3f(device.posX, device.posY, device.posZ);

        // Transform both endpoints to clip space
        let sc = uniforms.viewProj * vec4f(seg.startPos + devicePos, 1.0);
        let ec = uniforms.viewProj * vec4f(seg.endPos   + devicePos, 1.0);

        // Screen-space direction (NDC)
        let sn = sc.xy / sc.w;
        let en = ec.xy / ec.w;
        let dir = en - sn;
        let len = length(dir);
        let unitDir = select(vec2f(1.0, 0.0), dir / len, len > 0.0001);
        let perp = vec2f(-unitDir.y, unitDir.x);

        // Half-width: 0.002..0.008 px driven by field strength (sqrt scale)
        let t = clamp(sqrt(seg.strength * 2.0e6), 0.0, 1.0);
        let halfWidth = 0.002 + t * 0.006;

        // Vertices 0,1 at start; 2,3 at end.  Sides alternate left/right.
        let atEnd = (vertIdx >= 2u);
        let side  = select(-1.0, 1.0, (vertIdx & 1u) == 1u);

        var pos = select(sc, ec, atEnd);
        pos.x  += perp.x * halfWidth * side * pos.w;
        pos.y  += perp.y * halfWidth * side * pos.w;

        // Age-pulsed alpha: crawling tesla-bug effect
        let agePulse = 0.5 + 0.5 * sin(seg.age * 6.2832);
        let alpha = clamp(t * 0.8 + 0.1, 0.1, 0.9) * agePulse;

        var out: VertexOutput;
        out.position = pos;
        out.strength = seg.strength;
        out.alpha    = alpha;
        return out;
      }
    `;
  }

export function getFluxSegmentFragShader() {
    return /* wgsl */ `
      struct FragInput {
        @location(0) strength: f32,
        @location(1) alpha: f32,
      }

      // deep blue (0,0.1,0.8) → cyan (0,0.8,1) → soft white (0.8,1,1) → white-hot (1.2,1.2,1.2)
      fn fluxColor(strength: f32) -> vec3f {
        let t = clamp(sqrt(strength * 2.0e6), 0.0, 1.0);
        if (t < 0.33) {
          let s = t / 0.33;
          return mix(vec3f(0.0, 0.1, 0.8), vec3f(0.0, 0.8, 1.0), s);
        } else if (t < 0.66) {
          let s = (t - 0.33) / 0.33;
          return mix(vec3f(0.0, 0.8, 1.0), vec3f(0.8, 1.0, 1.0), s);
        } else {
          let s = (t - 0.66) / 0.34;
          return mix(vec3f(0.8, 1.0, 1.0), vec3f(1.2, 1.2, 1.2), s);
        }
      }

      @fragment
      fn main(input: FragInput) -> @location(0) vec4f {
        return vec4f(fluxColor(input.strength), input.alpha);
      }
    `;
  }

