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
