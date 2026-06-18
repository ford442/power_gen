export function getCoreVertShader() {
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
      
      @binding(0) @group(0) var<uniform> uniforms: Uniforms;
      @binding(1) @group(0) var<uniform> device: DeviceUniforms;
      
      struct VertexInput {
        @location(0) position: vec3f,
        @location(1) normal: vec3f
      }
      
      struct VertexOutput {
        @builtin(position) position: vec4f,
        @location(0) worldPos: vec3f,
        @location(1) normal: vec3f
      }
      
      @vertex
      fn main(input: VertexInput) -> VertexOutput {
        // Reconstruct device position from individual fields
        let devicePos = vec3f(device.posX, device.posY, device.posZ);
        let worldPos = input.position + devicePos;
        
        var output: VertexOutput;
        output.position = uniforms.viewProj * vec4f(worldPos, 1.0);
        output.worldPos = worldPos;
        output.normal = input.normal;
        
        return output;
      }
    `;
  }

export function getCoreFragShader() {
    return /* wgsl */ `
      struct CoreMaterialUniforms {
        baseColor: vec3f,
        emission: f32,
        coreColor: vec3f,
        glowIntensity: f32
      }
      
      @binding(3) @group(0) var<uniform> material: CoreMaterialUniforms;
      
      struct FragmentInput {
        @location(0) worldPos: vec3f,
        @location(1) normal: vec3f
      }
      
      @fragment
      fn main(input: FragmentInput) -> @location(0) vec4f {
        let normal = normalize(input.normal);
        let lightDir = normalize(vec3f(1.0, 1.0, 1.0));
        let diff = max(dot(normal, lightDir), 0.0);
        
        // Central core with green glow
        let baseColor = material.baseColor;
        let glowColor = material.coreColor * material.glowIntensity;
        
        let color = baseColor * (0.3 + diff * 0.7) + glowColor;
        
        return vec4f(color, 1.0);
      }
    `;
  }

