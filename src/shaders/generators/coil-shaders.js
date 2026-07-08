export function getCoilVertShader() {
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
    `;
  }

export function getCoilFragShader() {
    return /* wgsl */ `
      struct Uniforms {
        viewProj: mat4x4f,
        time: f32,
        cameraPos: vec3f
      }

      struct CoilMaterialUniforms {
        baseColor: vec3f,
        pad1: f32,
        glowColor: vec3f,
        emission: f32
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

      @binding(0) @group(0) var<uniform> uniforms: Uniforms;
      @binding(1) @group(0) var<uniform> device: DeviceUniforms;
      @binding(3) @group(0) var<uniform> material: CoilMaterialUniforms;

      struct FragmentInput {
        @location(0) worldPos: vec3f,
        @location(1) normal: vec3f,
        @location(2) activeIntensity: f32,
        @location(3) coilIndex: f32
      }

      @fragment
      fn main(input: FragmentInput) -> @location(0) vec4f {
        let normal = normalize(input.normal);
        let lightDir = normalize(vec3f(1.0, 1.0, 1.0));
        let diff = max(dot(normal, lightDir), 0.0);
        let ambient = 0.3;

        // Copper base color
        var color = material.baseColor * (ambient + diff * 0.7);

        // Add specular for metallic look
        let viewDir = normalize(vec3f(0.0, 5.0, 10.0) - input.worldPos);
        let halfDir = normalize(lightDir + viewDir);
        let spec = pow(max(dot(normal, halfDir), 0.0), 32.0);
        color = color + vec3f(1.0) * spec * 0.5;

        // Orange emissive glow when active — boosted multipliers for punch
        let activeLevel = input.activeIntensity;
        let energy = clamp(device.timeScale, 0.0, 1.0);
        let flicker = 0.72 + 0.28 * sin(uniforms.time * 5.4 + input.coilIndex * 0.78);
        let travel = 0.5 + 0.5 * sin(uniforms.time * 9.8 - input.coilIndex * 0.55 + input.worldPos.y * 6.0);
        let verticalFalloff = exp(-abs(input.worldPos.y) * 0.35);
        let drive = activeLevel * (0.7 + energy * 1.3) * flicker * (0.55 + 0.45 * travel) * verticalFalloff;
        let orangeGlow = vec3f(1.0, 0.55, 0.0) * drive * 4.2;
        let whiteCore = vec3f(1.0, 0.90, 0.7) * drive * 1.6;
        color = color + orangeGlow + whiteCore;

        // Per-coil time-based shimmer using traveling wave + low-frequency wobble.
        let shimmer = 1.0 + (0.08 + energy * 0.12) * sin(uniforms.time * 2.4 + input.coilIndex * 0.35);
        color = color * (1.0 + (shimmer - 1.0) * activeLevel);

        return vec4f(color, 1.0);
      }
    `;
  }

