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
      
      // Scalar fields keep this at the CPU-written 32-byte stride. A second
      // vec3f member cannot start at offset 12 in storage address space.
      struct FieldParticle {
        posX: f32,
        posY: f32,
        posZ: f32,
        velX: f32,
        velY: f32,
        velZ: f32,
        life: f32,
        strength: f32
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
        let worldPos = vec3f(particle.posX, particle.posY, particle.posZ) + devicePos;
        
        var output: VertexOutput;
        output.position = uniforms.viewProj * vec4f(worldPos, 1.0);
        
        // Mode-tinted flow paths
        let mode = device.ringIndex;
        var color: vec3f;
        if (mode > 2.5 && mode < 3.5) {
          color = mix(vec3f(1.0, 0.85, 0.35), vec3f(0.45, 0.75, 1.0), particle.strength);
        } else if (mode > 1.5 && mode < 2.5) {
          color = mix(vec3f(0.55, 0.35, 0.95), vec3f(0.75, 0.9, 1.0), particle.strength);
        } else if (mode > 0.5 && mode < 1.5) {
          color = mix(vec3f(0.2, 0.45, 0.85), vec3f(0.65, 0.9, 1.0), particle.strength);
        } else {
          let copper = vec3f(0.85, 0.48, 0.25);
          let greenEnergy = vec3f(0.2, 1.0, 0.5);
          color = mix(copper, greenEnergy, particle.strength);
        }
        output.color = color;
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

      // Scalar fields keep this at the CPU-written 32-byte stride. A second
      // vec3f member cannot start at offset 12 in storage address space.
      struct FluxSegment {
        startX: f32,
        startY: f32,
        startZ: f32,
        endX: f32,
        endY: f32,
        endZ: f32,
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
        @location(2) phase: f32,
        @location(3) edge: f32,
        @location(4) ringHue: f32,
      }

      @vertex
      fn main(@builtin(vertex_index) vertIdx: u32,
              @builtin(instance_index) instIdx: u32) -> VertexOutput {
        let seg = segments[instIdx];
        let devicePos = vec3f(device.posX, device.posY, device.posZ);

        // Transform both endpoints to clip space
        let startPos = vec3f(seg.startX, seg.startY, seg.startZ);
        let endPos = vec3f(seg.endX, seg.endY, seg.endZ);
        let sc = uniforms.viewProj * vec4f(startPos + devicePos, 1.0);
        let ec = uniforms.viewProj * vec4f(endPos   + devicePos, 1.0);

        // Screen-space direction (NDC)
        let sn = sc.xy / sc.w;
        let en = ec.xy / ec.w;
        let dir = en - sn;
        let len = length(dir);
        let unitDir = select(vec2f(1.0, 0.0), dir / len, len > 0.0001);
        let perp = vec2f(-unitDir.y, unitDir.x);

        // Half-width: scales with |B| and live energy level
        let t = clamp(sqrt(seg.strength * 2.0e6), 0.0, 1.0);
        let energy = clamp(device.timeScale, 0.0, 1.0);
        let halfWidth = 0.0028 + t * 0.011 + energy * 0.004;

        // Ring index tint (inner=cyan, mid=blue, outer=amber)
        let lineIdx = instIdx / 120u;
        let ringIdx = min(2u, lineIdx / 56u);
        let ringHue = f32(ringIdx) / 3.0;

        // Vertices 0,1 at start; 2,3 at end.  Sides alternate left/right.
        let atEnd = (vertIdx >= 2u);
        let side  = select(-1.0, 1.0, (vertIdx & 1u) == 1u);

        var pos = select(sc, ec, atEnd);
        pos.x  += perp.x * halfWidth * side * pos.w;
        pos.y  += perp.y * halfWidth * side * pos.w;

        // Traveling pulse along the line + energy breathing
        let travelPhase = fract(seg.age * 0.22 + uniforms.time * 0.42);
        let pulse = 0.50 + 0.50 * sin(travelPhase * 6.2832);
        let alpha = clamp(t * 0.90 + 0.10 + energy * 0.30, 0.14, 1.0) * pulse;

        var out: VertexOutput;
        out.position = pos;
        out.strength = seg.strength;
        out.alpha    = alpha;
        out.phase    = travelPhase;
        out.edge     = abs(side);
        out.ringHue  = ringHue;
        return out;
      }
    `;
  }

export function getFluxSegmentFragShader() {
    return /* wgsl */ `
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
    `;
  }
