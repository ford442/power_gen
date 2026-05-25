/**
 * MultiDeviceShaders - Extracted shader methods for SEG WebGPU visualizer
 * Contains all 17 shader getter methods: roller, particle, core, field line,
 * energy arc, coil, seg-enhanced, compute, and grid shaders.
 */
export class MultiDeviceShaders {
  constructor() {
    // No state needed - all shaders are pure functions returning template literals
  }

  get rollerVertShader() {
    return /* wgsl */ `
      struct Uniforms {
        viewProj: mat4x4f,
        time: f32,
        cameraPos: vec3f
      }
      
      // Canonical 48-byte DeviceUniforms struct (12 x f32)
      // Memory layout matches CPU write order exactly
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
      
      struct InstanceData {
        position: vec3f,
        ringIndex: f32,
        rotation: vec4f,
        copperColor: vec3f,
        greenEmissive: f32
      }
      
      @binding(0) @group(0) var<uniform> uniforms: Uniforms;
      @binding(1) @group(0) var<uniform> device: DeviceUniforms;
      @binding(2) @group(0) var<storage> instances: array<InstanceData>;
      
      struct VertexInput {
        @location(0) position: vec3f,
        @location(1) normal: vec3f
      }
      
      struct VertexOutput {
        @builtin(position) position: vec4f,
        @location(0) worldPos: vec3f,
        @location(1) normal: vec3f,
        @location(2) copperColor: vec3f,
        @location(3) greenEmissive: f32,
        @location(4) ringIndex: f32
      }
      
      fn quatMul(q: vec4f, v: vec3f) -> vec3f {
        let t = 2.0 * cross(q.xyz, v);
        return v + q.w * t + cross(q.xyz, t);
      }
      
      @vertex
      fn main(input: VertexInput, @builtin(instance_index) instanceIdx: u32) -> VertexOutput {
        let instance = instances[instanceIdx];
        
        // Apply self-rotation
        let rotatedPos = quatMul(instance.rotation, input.position);
        let rotatedNormal = quatMul(instance.rotation, input.normal);
        
        // Reconstruct device position from individual fields
        let devicePos = vec3f(device.posX, device.posY, device.posZ);
        // Apply orbital position
        let worldPos = rotatedPos + instance.position + devicePos;
        
        var output: VertexOutput;
        output.position = uniforms.viewProj * vec4f(worldPos, 1.0);
        output.worldPos = worldPos;
        output.normal = rotatedNormal;
        output.copperColor = instance.copperColor;
        output.greenEmissive = instance.greenEmissive;
        output.ringIndex = instance.ringIndex;
        
        return output;
      }
    `;
  }
  
  // Roller fragment shader with copper material + green underglow
  get rollerFragShader() {
    return /* wgsl */ `
      struct MaterialUniforms {
        baseColor: vec3f,
        pad1: f32,
        glowColor: vec3f,
        emission: f32
      }
      
      @binding(3) @group(0) var<uniform> material: MaterialUniforms;
      
      struct FragmentInput {
        @location(0) worldPos: vec3f,
        @location(1) normal: vec3f,
        @location(2) copperColor: vec3f,
        @location(3) greenEmissive: f32,
        @location(4) ringIndex: f32
      }
      
      @fragment
      fn main(input: FragmentInput) -> @location(0) vec4f {
        let normal = normalize(input.normal);
        
        // View direction
        let viewDir = normalize(vec3f(0.0, 5.0, 10.0) - input.worldPos);
        
        // Basic lighting
        let lightDir = normalize(vec3f(1.0, 1.0, 1.0));
        let diff = max(dot(normal, lightDir), 0.0);
        let ambient = 0.3;
        
        // Copper material color
        let copper = input.copperColor;
        
        // Specular highlight for metallic look
        let halfDir = normalize(lightDir + viewDir);
        let spec = pow(max(dot(normal, halfDir), 0.0), 32.0);
        
        // Base copper color with lighting
        var color = copper * (ambient + diff * 0.7) + vec3f(1.0) * spec * 0.5;
        
        // GREEN EMISSIVE GLOW on bottom half of roller (LED underglow effect)
        // worldNormal.y < 0 means bottom half
        let bottomGlow = max(0.0, -normal.y) * input.greenEmissive * 1.8;
        let greenGlow = vec3f(0.0, 1.2, 0.6) * bottomGlow;
        
        // Add material emission
        color = color + material.glowColor * material.emission * 0.3;
        
        // Add the green LED underglow
        color = color + greenGlow;
        
        return vec4f(color, 1.0);
      }
    `;
  }
  
  // Particle vertex shader
  get particleVertShader() {
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
      
      @binding(0) @group(0) var<uniform> uniforms: Uniforms;
      @binding(1) @group(0) var<uniform> device: DeviceUniforms;
      
      struct VertexOutput {
        @builtin(position) position: vec4f,
        @location(0) particlePhase: f32,
        @location(1) uv: vec2f
      }
      
      const quadVerts = array<vec2f, 4>(
        vec2f(-1.0, -1.0),
        vec2f( 1.0, -1.0),
        vec2f(-1.0,  1.0),
        vec2f( 1.0,  1.0)
      );
      
      @vertex
      fn main(
        @location(0) pos: vec3f,
        @location(1) phase: f32,
        @builtin(vertex_index) vertIdx: u32,
        @builtin(instance_index) instIdx: u32
      ) -> VertexOutput {
        let quadPos = quadVerts[vertIdx];
        
        let devicePos = vec3f(device.posX, device.posY, device.posZ);
        let toCamera = normalize(uniforms.cameraPos - pos - devicePos);
        let up = vec3f(0.0, 1.0, 0.0);
        let right = normalize(cross(up, toCamera));
        let billboardUp = cross(toCamera, right);
        
        // Particle size varies by mode
        var size: f32 = 0.07;
        if (device.ringIndex > 0.5 && device.ringIndex < 1.5) {
          size = 0.11;   // larger water droplets for Heron
        } else if (device.ringIndex >= 3.5) {
          size = 0.08;   // Peltier particles
        } else if (device.ringIndex >= 2.5) {
          size = 0.05;   // small photon dots for Solar
        }
        
        let worldPos = pos + devicePos + 
                       right * quadPos.x * size + 
                       billboardUp * quadPos.y * size;
        
        var output: VertexOutput;
        output.position = uniforms.viewProj * vec4f(worldPos, 1.0);
        output.particlePhase = phase;
        output.uv = quadPos * 0.5 + 0.5;
        
        return output;
      }
    `;
  }
  
  // Particle fragment shader
  get particleFragShader() {
    return /* wgsl */ `
      struct MaterialUniforms {
        baseColor: vec3f,
        pad1: f32,
        glowColor: vec3f,
        emission: f32
      }
      
      @binding(3) @group(0) var<uniform> material: MaterialUniforms;
      
      struct FragmentInput {
        @location(0) particlePhase: f32,
        @location(1) uv: vec2f
      }
      
      @fragment
      fn main(input: FragmentInput) -> @location(0) vec4f {
        let dist = length(input.uv - vec2f(0.5));
        if (dist > 0.5) {
          discard;
        }

        // Bright core + soft halo for additive blending
        let core = exp(-dist * dist * 22.0);
        let halo = exp(-dist * dist * 6.0) * 0.35;
        let alpha = (core + halo) * 2.2;
        
        let mode = device.ringIndex;
        let t = uniforms.time;
        let phase = input.particlePhase;
        var color: vec3f;
        
        if (mode < 0.5) {
          // SEG: cyan / electric-blue magnetic field lines
          let pulse = 0.6 + 0.4 * sin(t * 5.0 + phase * 6.28);
          color = mix(vec3f(0.0, 0.65, 1.0), vec3f(0.3, 1.0, 0.85), pulse);
        } else if (mode < 1.5) {
          // Heron: blue water droplets with slight white specular centre
          let h = clamp(input.uv.y * 0.5 + 0.5, 0.0, 1.0);
          let d = dist;
          color = mix(vec3f(0.0, 0.22, 0.70), vec3f(0.55, 0.82, 1.0), h * (1.0 - d));
        } else if (mode < 2.5) {
          // Kelvin: translucent water drops; rare bright spark particles
          let spark = step(0.97, fract(sin(f32(input.uv.x * 100.0)
                    + phase * 3137.1) * 43758.5453));
          color = mix(vec3f(0.72, 0.82, 0.96), vec3f(0.85, 0.15, 1.0), spark);
        } else if (mode < 3.5) {
          // Solar: warm yellow photons
          let intensity = 0.55 + 0.45 * device.batteryCharge;
          color = vec3f(1.0, 0.88, 0.28) * intensity;
        } else {
          // Peltier TEG: Colors based on thermal regions
          if (phase < 0.4) {
            // Hot particles: Red/Orange
            color = vec3f(1.0, 0.25 + 0.1 * sin(t * 3.0 + phase * 10.0), 0.0);
          } else if (phase < 0.8) {
            // Cold particles: Blue/Cyan
            color = vec3f(0.0, 0.5 + 0.2 * sin(t * 2.0 + phase * 8.0), 1.0);
          } else {
            // Electricity particles: Flashing Yellow/Green
            let spark = step(0.82, fract(sin(t * 18.0 + phase * 127.3) * 43758.5453));
            color = mix(vec3f(0.4, 0.95, 0.2), vec3f(1.0, 1.0, 0.6), spark * 0.7);
          }
        }
        
        // Add glow
        let glow = material.glowColor * material.emission * 0.5;
        color = color + glow;
        
        return vec4f(color, alpha);
      }
    `;
  }
  
  // Core vertex shader
  get coreVertShader() {
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
  
  // Core fragment shader
  get coreFragShader() {
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
  
  // Field line vertex shader
  get fieldLineVertShader() {
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
      
      struct FieldParticle {
        position: vec3f,
        velocity: vec3f,
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
  
  // Field line fragment shader
  get fieldLineFragShader() {
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
  
  // Energy arc vertex shader
  get energyArcVertShader() {
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
      
      struct ArcParticle {
        position: vec3f,
        velocity: vec3f,
        life: f32,
        intensity: f32
      }
      
      @binding(0) @group(0) var<uniform> uniforms: Uniforms;
      @binding(1) @group(0) var<uniform> device: DeviceUniforms;
      @binding(4) @group(0) var<storage> particles: array<ArcParticle>;
      
      struct VertexOutput {
        @builtin(position) position: vec4f,
        @location(0) color: vec3f,
        @location(1) intensity: f32
      }
      
      @vertex
      fn main(@builtin(vertex_index) vertIdx: u32, @builtin(instance_index) instIdx: u32) -> VertexOutput {
        let particle = particles[instIdx];
        // Reconstruct device position from individual fields
        let devicePos = vec3f(device.posX, device.posY, device.posZ);
        let worldPos = particle.position + devicePos;
        
        var output: VertexOutput;
        output.position = uniforms.viewProj * vec4f(worldPos, 1.0);
        
        // Electric arc colors - cyan/blue energy
        output.color = vec3f(0.3, 0.8, 1.0);
        output.intensity = particle.intensity;
        
        return output;
      }
    `;
  }
  
  // Energy arc fragment shader
  get energyArcFragShader() {
    return /* wgsl */ `
      struct FragmentInput {
        @location(0) color: vec3f,
        @location(1) intensity: f32
      }
      
      @fragment
      fn main(input: FragmentInput) -> @location(0) vec4f {
        let glow = input.color * input.intensity * 2.0;
        return vec4f(glow, input.intensity);
      }
    `;
  }
  
  // ============================================
  // Electromagnet coil shaders
  // ============================================
  
  get coilVertShader() {
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
  
  get coilFragShader() {
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

      @binding(0) @group(0) var<uniform> uniforms: Uniforms;
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
        let active = input.activeIntensity;
        let orangeGlow = vec3f(1.0, 0.55, 0.0) * active * 4.0;
        let whiteCore  = vec3f(1.0, 0.90, 0.7) * active * 1.5;
        color = color + orangeGlow + whiteCore;

        // Per-coil time-based shimmer using the traveling wave baked into active
        let shimmer = 1.0 + 0.12 * sin(uniforms.time * 8.0 + input.coilIndex * 0.78);
        color = color * (1.0 + (shimmer - 1.0) * active);

        return vec4f(color, 1.0);
      }
    `;
  }
  
  // ============================================
  // Enhanced SEG shaders (PBR + UV + pole bands)
  // ============================================

  get segEnhancedVertShader() {
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

      struct InstanceData {
        position: vec3f,
        ringIndex: f32,
        rotation: vec4f,
        copperColor: vec3f,
        greenEmissive: f32
      }

      @binding(0) @group(0) var<uniform> uniforms: Uniforms;
      @binding(1) @group(0) var<uniform> device: DeviceUniforms;
      @binding(2) @group(0) var<storage> instances: array<InstanceData>;

      struct VertexInput {
        @location(0) position: vec3f,
        @location(1) normal: vec3f,
        @location(2) uv: vec2f
      }

      struct VertexOutput {
        @builtin(position) position: vec4f,
        @location(0) worldPos: vec3f,
        @location(1) normal: vec3f,
        @location(2) uv: vec2f,
        @location(3) copperColor: vec3f,
        @location(4) greenEmissive: f32,
        @location(5) ringIndex: f32,
        @location(6) bandIndex: f32
      }

      fn quatMul(q: vec4f, v: vec3f) -> vec3f {
        let t = 2.0 * cross(q.xyz, v);
        return v + q.w * t + cross(q.xyz, t);
      }

      @vertex
      fn main(input: VertexInput, @builtin(instance_index) instanceIdx: u32) -> VertexOutput {
        let instance = instances[instanceIdx];
        let rotatedPos = quatMul(instance.rotation, input.position);
        let rotatedNormal = quatMul(instance.rotation, input.normal);
        let devicePos = vec3f(device.posX, device.posY, device.posZ);
        let worldPos = rotatedPos + instance.position + devicePos;

        let bandIdx = floor(input.uv.y * 6.0);

        var output: VertexOutput;
        output.position = uniforms.viewProj * vec4f(worldPos, 1.0);
        output.worldPos = worldPos;
        output.normal = rotatedNormal;
        output.uv = input.uv;
        output.copperColor = instance.copperColor;
        output.greenEmissive = instance.greenEmissive;
        output.ringIndex = instance.ringIndex;
        output.bandIndex = bandIdx;
        return output;
      }
    `;
  }

  get segEnhancedFragShader() {
    return /* wgsl */ `
      struct Uniforms {
        viewProj: mat4x4f,
        time: f32,
        cameraPos: vec3f
      }

      struct MaterialUniforms {
        baseColor: vec3f,
        pad1: f32,
        glowColor: vec3f,
        emission: f32
      }

      struct LightingConfig {
        keyDir: vec3f,
        keyColor: vec3f,
        keyIntensity: f32,
        fillDir: vec3f,
        fillColor: vec3f,
        fillIntensity: f32,
        rimDir: vec3f,
        rimColor: vec3f,
        rimIntensity: f32,
        ambient: f32,
        envMapStrength: f32,
      }

      @binding(0) @group(0) var<uniform> uniforms: Uniforms;
      @binding(3) @group(0) var<uniform> material: MaterialUniforms;
      @binding(5) @group(0) var<uniform> lighting: LightingConfig;

      struct FragmentInput {
        @location(0) worldPos: vec3f,
        @location(1) normal: vec3f,
        @location(2) uv: vec2f,
        @location(3) copperColor: vec3f,
        @location(4) greenEmissive: f32,
        @location(5) ringIndex: f32,
        @location(6) bandIndex: f32
      }

      fn hash3(p: vec3f) -> vec3f {
        let q = vec3f(
          dot(p, vec3f(127.1, 311.7, 74.7)),
          dot(p, vec3f(269.5, 183.3, 246.1)),
          dot(p, vec3f(113.5, 271.9, 124.6))
        );
        return fract(sin(q) * 43758.5453);
      }

      fn surfaceVariation(worldPos: vec3f, scale: f32) -> f32 {
        let h = hash3(floor(worldPos * scale));
        return h.x * 0.15 + h.y * 0.1;
      }

      fn fresnelSchlick(cosTheta: f32, f0: vec3f) -> vec3f {
        return f0 + (vec3f(1.0) - f0) * pow(1.0 - cosTheta, 5.0);
      }

      fn distributionGGX(NdotH: f32, roughness: f32) -> f32 {
        let a = roughness * roughness;
        let a2 = a * a;
        let denom = NdotH * NdotH * (a2 - 1.0) + 1.0;
        return a2 / (3.14159265 * denom * denom);
      }

      fn geometrySmith(NdotV: f32, NdotL: f32, roughness: f32) -> f32 {
        let k = (roughness + 1.0) * (roughness + 1.0) / 8.0;
        let ggx1 = NdotV / (NdotV * (1.0 - k) + k);
        let ggx2 = NdotL / (NdotL * (1.0 - k) + k);
        return ggx1 * ggx2;
      }

      fn poleBandColor(bandIndex: f32, baseColor: vec3f) -> vec3f {
        let idx = u32(bandIndex) % 4u;
        switch(idx) {
          case 0u: { return vec3f(0.85, 0.48, 0.22); }
          case 1u: { return vec3f(0.55, 0.30, 0.15); }
          case 2u: { return vec3f(0.72, 0.74, 0.76); }
          case 3u: { return vec3f(0.78, 0.58, 0.22); }
          default: { return baseColor; }
        }
      }

      @fragment
      fn main(input: FragmentInput) -> @location(0) vec4f {
        let N = normalize(input.normal);
        let V = normalize(uniforms.cameraPos - input.worldPos);
        let NdotV = max(dot(N, V), 0.0);

        var baseColor: vec3f;
        var metallic: f32;
        var roughness: f32;
        var emissive: f32;

        if (input.bandIndex >= 0.0 && input.bandIndex < 6.0) {
          baseColor = poleBandColor(input.bandIndex, input.copperColor);
          let isNeodymium = (u32(input.bandIndex) % 4u) == 2u;
          metallic = select(0.95, 0.88, isNeodymium);
          roughness = select(0.30, 0.20, isNeodymium);
          emissive = select(0.0, 0.15, isNeodymium);
        } else if (input.ringIndex < -0.5) {
          baseColor = vec3f(0.65, 0.67, 0.70);
          metallic = 0.96;
          roughness = 0.15;
          emissive = 0.0;
        } else if (input.ringIndex > 10.0) {
          baseColor = vec3f(0.78, 0.58, 0.22);
          metallic = 0.90;
          roughness = 0.22;
          emissive = 0.0;
        } else {
          baseColor = input.copperColor;
          metallic = 0.95;
          roughness = 0.30;
          emissive = input.greenEmissive;
        }

        let variation = surfaceVariation(input.worldPos, 8.0);
        baseColor = baseColor * (0.92 + variation);
        roughness = clamp(roughness + variation * 0.1, 0.05, 1.0);

        let f0 = mix(vec3f(0.04), baseColor, metallic);
        let albedo = mix(baseColor, vec3f(0.0), metallic);

        let L1 = normalize(-lighting.keyDir);
        let H1 = normalize(V + L1);
        let NdotL1 = max(dot(N, L1), 0.0);
        let NdotH1 = max(dot(N, H1), 0.0);
        let D1 = distributionGGX(NdotH1, roughness);
        let G1 = geometrySmith(NdotV, NdotL1, roughness);
        let F1 = fresnelSchlick(max(dot(H1, V), 0.0), f0);
        let specular1 = (D1 * G1 * F1) / (4.0 * NdotV * NdotL1 + 0.001);
        let kD1 = (vec3f(1.0) - F1) * (1.0 - metallic);

        let L2 = normalize(-lighting.fillDir);
        let H2 = normalize(V + L2);
        let NdotL2 = max(dot(N, L2), 0.0);
        let NdotH2 = max(dot(N, H2), 0.0);
        let D2 = distributionGGX(NdotH2, roughness);
        let G2 = geometrySmith(NdotV, NdotL2, roughness);
        let F2 = fresnelSchlick(max(dot(H2, V), 0.0), f0);
        let specular2 = (D2 * G2 * F2) / (4.0 * NdotV * NdotL2 + 0.001);
        let kD2 = (vec3f(1.0) - F2) * (1.0 - metallic);

        let rimFactor = pow(1.0 - NdotV, 3.0) * lighting.rimIntensity;
        let rimLight = lighting.rimColor * rimFactor;

        let diffuse = albedo * 3.14159265 * (
          kD1 * NdotL1 * lighting.keyColor * lighting.keyIntensity +
          kD2 * NdotL2 * lighting.fillColor * lighting.fillIntensity * 0.5
        );

        let specular = (
          specular1 * lighting.keyColor * lighting.keyIntensity * NdotL1 +
          specular2 * lighting.fillColor * lighting.fillIntensity * NdotL2 * 0.3
        );

        let ambient = albedo * lighting.ambient * vec3f(0.15, 0.18, 0.22);
        var color = ambient + diffuse + specular + rimLight;

        let bottomGlow = max(0.0, -N.y) * input.greenEmissive * 1.5;
        color += vec3f(0.0, 1.0, 0.5) * bottomGlow;
        color += baseColor * emissive * 0.5;

        let energyArc = smoothstep(0.7, 1.0, input.greenEmissive) * 0.3;
        color += vec3f(0.3, 0.8, 1.0) * energyArc * NdotV;

        color = color * (2.51 * color + 0.03) / (color * (2.43 * color + 0.59) + 0.14);

        let vignette = 1.0 - dot(input.uv - 0.5, input.uv - 0.5) * 0.3;
        color *= vignette;

        return vec4f(color, 1.0);
      }
    `;
  }

  // ============================================
  // Compute shader — GPU particle physics
  // ============================================
  get computeShader() {
    return /* wgsl */ `
      struct ComputeUniforms {
        time: f32,
        mode: f32,
        particleCount: f32,
        speedMult: f32,
      }

      @binding(0) @group(0) var<storage, read_write> particles: array<vec4f>;
      @binding(1) @group(0) var<uniform> uniforms: ComputeUniforms;

      const PI: f32 = 3.14159265359;

      fn posSEG(phase: f32, t: f32, idx: u32) -> vec3f {
        let cycleT  = fract(t * 0.12 + phase);
        let radius  = 8.5 - cycleT * 8.0;
        let angle   = phase * 6.28318 + cycleT * 18.84956;
        let height  = sin(cycleT * 6.28318 * 2.0 + phase * 6.28318) * 2.8;
        return vec3f(cos(angle) * radius, height, sin(angle) * radius);
      }

      fn posHeron(phase: f32, t: f32, idx: u32) -> vec3f {
        let cycleT  = fract(t * 0.22 + phase);
        let spread  = phase * 6.28318;
        let spreadR = fract(f32(idx) * 0.618034) * 0.55;
        var pos: vec3f;
        if (cycleT < 0.35) {
          let k = cycleT / 0.35;
          pos = vec3f(sin(spread) * spreadR * k * 1.4,
                      5.6 + k * 3.1 - k * k * 1.2,
                      cos(spread) * spreadR * k * 1.4);
        } else if (cycleT < 0.72) {
          let k = (cycleT - 0.35) / 0.37;
          pos = vec3f(sin(spread) * spreadR * (1.4 - k * 0.9),
                      8.5 - k * 4.2,
                      cos(spread) * spreadR * (1.4 - k * 0.9));
        } else {
          let k = (cycleT - 0.72) / 0.28;
          pos = vec3f(sin(spread) * spreadR * (0.5 - k * 0.5),
                      4.5 - k * 6.5,
                      cos(spread) * spreadR * (0.5 - k * 0.5));
        }
        return pos;
      }

      fn posKelvin(phase: f32, t: f32, idx: u32) -> vec3f {
        let cycleT = fract(t * 0.32 + phase);
        let side   = select(-1.0, 1.0, (idx & 1u) == 1u);
        let wobble = sin(t * 4.0 + phase * 20.0) * 0.09;
        var pos: vec3f;
        if (cycleT < 0.82) {
          let k = cycleT / 0.82;
          pos = vec3f(side * 2.5 + wobble, 5.5 - k * 8.8, wobble * 0.4);
        } else {
          let k = (cycleT - 0.82) / 0.18;
          pos = vec3f(side * 2.5 * (1.0 - k * 1.9), -3.2 + k * 1.4, 0.0);
        }
        return pos;
      }

      fn posSolar(phase: f32, t: f32, idx: u32, speedMult: f32) -> vec3f {
        let ledIdx = idx % 6u;
        let ledX   = (f32(ledIdx) - 2.5) * 1.6;
        let ledPos = vec3f(ledX, 3.5, 1.5);
        let panelX = (fract(f32(idx) * 0.61803) - 0.5) * 9.0;
        let panelZ = (fract(f32(idx) * 0.38490) - 0.5) * 9.0;
        let panelPos = vec3f(panelX, 0.05, panelZ);
        let speed = 1.0 + speedMult * 1.5;
        let life  = fract(t * speed * 0.18 + phase);
        return mix(ledPos, panelPos, min(life * 1.05, 1.0));
      }

      fn posPeltier(phase: f32, t: f32, idx: u32) -> vec3f {
        let isSetupA = (idx % 2u) == 0u;
        let xOffset = select(3.5, -3.5, isSetupA);
        let cycleT = fract(t * 0.4 + phase);
        var pos: vec3f;
        if (phase < 0.4) {
          let isBottom = isSetupA;
          let yStart = select(4.0, -4.0, isBottom);
          let currentY = mix(yStart, 0.0, cycleT);
          let px = xOffset + sin(phase * 123.45) * 1.5;
          let pz = cos(f32(idx) * 0.123) * 1.5;
          pos = vec3f(px, currentY, pz);
        } else if (phase < 0.8) {
          let isTop = isSetupA;
          let yStart = select(-4.0, 4.0, isTop);
          let currentY = mix(yStart, 0.0, cycleT);
          let px = xOffset + sin(phase * 123.45) * 1.5;
          let pz = cos(f32(idx) * 0.123) * 1.5;
          pos = vec3f(px, currentY, pz);
        } else {
          let angle = phase * 62.83 + f32(idx) * 0.1;
          let radius = 1.0 + cycleT * 3.0;
          let px = xOffset + cos(angle) * radius;
          let pz = sin(angle) * radius;
          let py = sin(t * 5.0 + phase * 20.0) * 0.15;
          pos = vec3f(px, py, pz);
        }
        return pos;
      }

      @compute @workgroup_size(64)
      fn main(@builtin(global_invocation_id) id: vec3u) {
        let idx = id.x;
        if (idx >= u32(uniforms.particleCount)) { return; }

        let p = particles[idx];
        let phase = p.w;
        let t = uniforms.time;
        let mode = uniforms.mode;

        var newPos: vec3f;
        if (mode < 0.5) {
          newPos = posSEG(phase, t, idx);
        } else if (mode < 1.5) {
          newPos = posHeron(phase, t, idx);
        } else if (mode < 2.5) {
          newPos = posKelvin(phase, t, idx);
        } else if (mode < 3.5) {
          newPos = posSolar(phase, t, idx, uniforms.speedMult);
        } else {
          newPos = posPeltier(phase, t, idx);
        }

        particles[idx] = vec4f(newPos, phase);
      }
    `;
  }

  // Sky background vertex shader (fullscreen triangle, no vertex buffer needed)
  get skyVertShader() {
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
        output.position = vec4f(pos[vertexIndex], 0.9999, 1.0);
        output.uv = pos[vertexIndex] * 0.5 + 0.5;
        return output;
      }
    `;
  }

  // Sky background fragment shader: deep-space gradient + subtle nebula glow
  get skyFragShader() {
    return /* wgsl */ `
      struct Uniforms {
        viewProj: mat4x4f,
        time: f32,
        cameraPos: vec3f
      }

      @binding(0) @group(0) var<uniform> uniforms: Uniforms;

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

  // Grid vertex shader
  get gridVertShader() {
    return /* wgsl */ `
      struct Uniforms {
        viewProj: mat4x4f,
        time: f32,
        cameraPos: vec3f
      }
      
      @binding(0) @group(0) var<uniform> uniforms: Uniforms;
      
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
  
  // Grid fragment shader with distance-based fade
  get gridFragShader() {
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
}
