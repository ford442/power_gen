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
