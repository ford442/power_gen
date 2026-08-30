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
      
      struct CoilInstance {
        position: vec3f,
        angle: f32,
        activeIntensity: f32,
        coilIndex: f32,
        pad1: f32,
        pad2: f32
      }
      
      @binding(0) @group(0) var<uniform> uniforms: Uniforms;
      @binding(1) @group(0) var<uniform> device: DeviceUniforms;
      @binding(2) @group(0) var<storage> instances: array<CoilInstance>;
      
      struct VertexInput {
        @location(0) position: vec3f,
        @location(1) normal: vec3f
      }
      
      struct VertexOutput {
        @builtin(position) position: vec4f,
        @location(0) worldPos: vec3f,
        @location(1) normal: vec3f,
        @location(2) activeIntensity: f32,
        @location(3) coilIndex: f32
      }
      
      @vertex
      fn main(input: VertexInput, @builtin(instance_index) instanceIdx: u32) -> VertexOutput {
        let instance = instances[instanceIdx];
        
        // Rotate cylinder to face tangent to the ring
        let ca = cos(instance.angle);
        let sa = sin(instance.angle);
        // Rotate around Y axis to align with ring tangent
        let rotPos = vec3f(
          input.position.x * ca + input.position.z * sa,
          input.position.y,
          -input.position.x * sa + input.position.z * ca
        );
        let rotNormal = vec3f(
          input.normal.x * ca + input.normal.z * sa,
          input.normal.y,
          -input.normal.x * sa + input.normal.z * ca
        );
        
        let devicePos = vec3f(device.posX, device.posY, device.posZ);
        let worldPos = rotPos + instance.position + devicePos;
        
        var output: VertexOutput;
        output.position = uniforms.viewProj * vec4f(worldPos, 1.0);
        output.worldPos = worldPos;
        output.normal = rotNormal;
        output.activeIntensity = instance.activeIntensity;
        output.coilIndex = instance.coilIndex;
        
        return output;
      }
