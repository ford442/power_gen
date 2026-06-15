/**
 * MultiDeviceShaders - Extracted shader methods for SEG WebGPU visualizer
 * Contains all 17 shader getter methods: roller, particle, core, field line,
 * energy arc, coil, seg-enhanced, compute, and grid shaders.
 */
import fluxLinesWgsl from './shaders/flux-lines.wgsl?raw';

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
  
  // Roller fragment shader with PBR metallic material + green underglow
  get rollerFragShader() {
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

      struct MaterialUniforms {
        baseColor: vec3f,
        pad1: f32,
        glowColor: vec3f,
        emission: f32
      }

      struct MaterialEntry {
        baseMetal: vec4f,    // rgb: base, a: metallic
        accentRough: vec4f,  // rgb: accent/decal, a: roughness
        detailParams: vec4f  // x: detailScale, y: oxide strength, z: wear amount
      }

      struct Light {
        dir: vec3f,
        color: vec3f,
        intensity: f32,
      }

      struct LightingConfig {
        key: Light,
        fill: Light,
        rim: Light,
        ground: Light,
        ambient: f32,
        envMapStrength: f32,
      }

      const PI: f32 = 3.14159265;
      const MATERIAL_COUNT: u32 = 14u;

      @binding(0) @group(0) var<uniform> uniforms: Uniforms;
      @binding(1) @group(0) var<uniform> device: DeviceUniforms;
      @binding(3) @group(0) var<uniform> material: MaterialUniforms;
      @binding(5) @group(0) var<uniform> lighting: LightingConfig;
      @binding(6) @group(0) var<storage, read> materialTable: array<MaterialEntry>;

      struct FragmentInput {
        @location(0) worldPos: vec3f,
        @location(1) normal: vec3f,
        @location(2) copperColor: vec3f,
        @location(3) greenEmissive: f32,
        @location(4) ringIndex: f32
      }

      // PBR functions
      fn fresnelSchlick(cosTheta: f32, f0: vec3f) -> vec3f {
        return f0 + (vec3f(1.0) - f0) * pow(1.0 - cosTheta, 5.0);
      }

      fn distributionGGX(NdotH: f32, roughness: f32) -> f32 {
        let a = roughness * roughness;
        let a2 = a * a;
        let denom = NdotH * NdotH * (a2 - 1.0) + 1.0;
        return a2 / (PI * denom * denom);
      }

      fn geometrySmith(NdotV: f32, NdotL: f32, roughness: f32) -> f32 {
        let k = (roughness + 1.0) * (roughness + 1.0) / 8.0;
        let ggx1 = NdotV / (NdotV * (1.0 - k) + k);
        let ggx2 = NdotL / (NdotL * (1.0 - k) + k);
        return ggx1 * ggx2;
      }

      fn hash3(p: vec3f) -> vec3f {
        let q = vec3f(
          dot(p, vec3f(127.1, 311.7, 74.7)),
          dot(p, vec3f(269.5, 183.3, 246.1)),
          dot(p, vec3f(113.5, 271.9, 124.6))
        );
        return fract(sin(q) * 43758.5453);
      }

      fn noise3(p: vec3f) -> f32 {
        return hash3(floor(p)).x;
      }

      fn fbm(p: vec3f) -> f32 {
        var v = 0.0;
        var amp = 0.5;
        var pp = p;
        for (var i = 0; i < 4; i++) {
          v += (noise3(pp) * 2.0 - 1.0) * amp;
          pp = pp * 2.03 + vec3f(1.7, 2.3, 0.9);
          amp *= 0.5;
        }
        return clamp(v * 0.5 + 0.5, 0.0, 1.0);
      }

      fn triplanarMask(p: vec3f, n: vec3f, scale: f32) -> f32 {
        let an = abs(n);
        let w = an / (an.x + an.y + an.z + 1e-4);
        let nx = fbm(vec3f(p.y, p.z, p.x) * scale);
        let ny = fbm(vec3f(p.x, p.z, p.y) * scale);
        let nz = fbm(vec3f(p.x, p.y, p.z) * scale);
        return nx * w.x + ny * w.y + nz * w.z;
      }

      fn cylindricalUV(p: vec3f) -> vec2f {
        let u = fract(atan2(p.z, p.x) / (2.0 * PI) + 0.5);
        let v = fract(p.y * 0.33 + 0.5);
        return vec2f(u, v);
      }

      fn detailNormal(n: vec3f, p: vec3f, detailScale: f32) -> vec3f {
        let upRef = select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(n.y) > 0.94);
        let t = normalize(cross(upRef, n));
        let b = normalize(cross(n, t));
        let dn1 = fbm(p * detailScale + vec3f(0.3, 4.2, 1.1)) - 0.5;
        let dn2 = fbm(p * detailScale + vec3f(3.7, 0.8, 2.4)) - 0.5;
        return normalize(n + t * dn1 * 0.24 + b * dn2 * 0.24);
      }

      fn blackbody(temp: f32) -> vec3f {
        let t = clamp(temp, 800.0, 3500.0) / 1000.0;
        let warm = vec3f(1.0, 0.4 + t * 0.3, 0.1 + t * 0.6);
        return warm * max(0.0, t - 0.8);
      }

      fn getMaterialId(mode: i32, renderMode: i32) -> u32 {
        if (mode == 1) { return 8u; }   // Heron vessel
        if (mode == 2) { return 10u; }  // Kelvin cans
        if (mode == 3) { return 7u; }   // Solar cell body
        if (mode == 4) { return 9u; }   // Peltier ceramic
        if (mode >= 5) { return 1u; }   // MHD steel
        if (renderMode == 1) { return 1u; }  // SEG base
        if (renderMode == 2) { return 2u; }  // SEG stator
        if (renderMode == 3) { return 0u; }  // Wiring copper
        return 0u;
      }

      fn getMaterial(id: u32) -> MaterialEntry {
        return materialTable[min(id, MATERIAL_COUNT - 1u)];
      }

      @fragment
      fn main(input: FragmentInput) -> @location(0) vec4f {
        let mode = i32(round(device.ringIndex));
        let renderMode = i32(round(device.renderMode));
        let energy = clamp(device.timeScale, 0.0, 1.0);
        let overdrive = pow(energy, 1.8);
        let materialId = getMaterialId(mode, renderMode);
        let mat = getMaterial(materialId);
        let devicePos = vec3f(device.posX, device.posY, device.posZ);
        let localPos = input.worldPos - devicePos;
        let cylUV = cylindricalUV(localPos);

        var baseColor = mat.baseMetal.rgb;
        var metallic = mat.baseMetal.a;
        var roughness = clamp(mat.accentRough.a, 0.05, 1.0);

        let brushed = fbm(localPos * (mat.detailParams.x * 0.32));
        let oxidation = fbm(localPos * (mat.detailParams.x * 0.75 + 9.0));
        baseColor = mix(baseColor, mat.accentRough.rgb, oxidation * mat.detailParams.y);
        baseColor *= 0.90 + brushed * 0.16;
        roughness = clamp(roughness + oxidation * 0.08 + brushed * 0.06, 0.05, 1.0);

        var detailN = detailNormal(normalize(input.normal), localPos, mat.detailParams.x);

        var decalMask = 0.0;
        let triMask = triplanarMask(localPos, detailN, 0.9);

        if (renderMode == 1 || renderMode == 2) {
          let theta = atan2(localPos.z, localPos.x) / (2.0 * PI) + 0.5;
          let rivetSector = abs(fract(theta * 24.0) - 0.5);
          let rivetRadial = abs(length(localPos.xz) - 3.2);
          let rivets = smoothstep(0.08, 0.01, rivetSector) * smoothstep(0.12, 0.0, rivetRadial);
          decalMask += rivets * 0.8;
        }

        if (mode == 1) {
          let labelBand = smoothstep(0.40, 0.44, cylUV.y) * (1.0 - smoothstep(0.56, 0.60, cylUV.y));
          let stamp = step(0.74, fract(cylUV.x * 14.0 + triMask * 0.5));
          decalMask += labelBand * stamp * 0.7;
          let meniscus = smoothstep(0.47, 0.50, cylUV.y) * (1.0 - smoothstep(0.50, 0.54, cylUV.y));
          let causticBands = 0.5 + 0.5 * sin(cylUV.x * 48.0 + uniforms.time * 2.1 + triMask * 2.0);
          baseColor = mix(baseColor, vec3f(0.86, 0.92, 0.97), meniscus * (0.28 + energy * 0.25));
          baseColor += vec3f(0.12, 0.22, 0.30) * causticBands * pow(energy, 1.3) * 0.32;
          metallic = mix(metallic, 0.08, 0.7);
          roughness = mix(roughness, 0.10, 0.55 + energy * 0.25);
        } else if (mode == 2) {
          let canBand = smoothstep(0.30, 0.34, cylUV.y) * (1.0 - smoothstep(0.66, 0.70, cylUV.y));
          let stripe = step(0.82, fract(cylUV.x * 28.0));
          decalMask += canBand * stripe * 0.65;
          let dripTip = smoothstep(0.86, 0.90, cylUV.y) * (1.0 - smoothstep(0.95, 0.99, cylUV.y));
          baseColor = mix(baseColor, vec3f(0.78, 0.82, 0.88), dripTip * (0.35 + energy * 0.45));
        } else if (mode == 3) {
          let lens = sin(cylUV.x * 180.0) * sin(cylUV.y * 160.0);
          detailN = normalize(detailN + vec3f(0.0, lens * 0.14, 0.0));
          baseColor += vec3f(0.05, 0.08, 0.11) * (lens * 0.5 + 0.5);
          let thermalGradient = clamp(cylUV.y * 1.15 - 0.1, 0.0, 1.0);
          baseColor = mix(baseColor, vec3f(0.35, 0.16, 0.08), thermalGradient * device.batteryCharge * 0.33);
        } else if (mode == 4) {
          let grid = fract(cylUV * vec2f(18.0, 10.0));
          let junction = step(0.92, grid.x) + step(0.92, grid.y);
          decalMask += min(junction, 1.0) * 0.55;
          baseColor = mix(baseColor, vec3f(0.70, 0.20, 0.14), junction * 0.18);
          let traceRaw = abs(sin(localPos.x * 9.0 + localPos.y * 6.0 + uniforms.time * 4.0));
          let traceFw = max(fwidth(traceRaw), 0.01);
          let trace = 1.0 - smoothstep(0.20 - traceFw, 0.20 + traceFw, traceRaw);
          baseColor += mix(vec3f(0.90, 0.32, 0.10), vec3f(0.18, 0.58, 1.0), clamp(localPos.y * 0.4 + 0.5, 0.0, 1.0))
            * trace * pow(energy, 1.35) * 0.30;
        } else if (mode >= 5) {
          let channelRaw = abs(sin(localPos.x * 5.0 - localPos.z * 8.5 + uniforms.time * 3.6));
          let channelFw = max(fwidth(channelRaw), 0.01);
          let channel = 1.0 - smoothstep(0.26 - channelFw, 0.26 + channelFw, channelRaw);
          baseColor += vec3f(0.18, 0.72, 1.0) * channel * pow(energy, 1.4) * 0.42;
        }

        baseColor = mix(baseColor, vec3f(0.93, 0.93, 0.90), decalMask * 0.35);
        roughness = clamp(roughness - decalMask * 0.08, 0.05, 1.0);

        let V = normalize(uniforms.cameraPos - input.worldPos);
        let NdotV = max(dot(detailN, V), 0.0);
        let edgeWear = pow(1.0 - NdotV, 2.0) * mat.detailParams.z;
        baseColor = mix(baseColor, mat.accentRough.rgb, edgeWear * 0.65);
        if (renderMode == 1 || renderMode == 2) {
          baseColor *= 1.0 - edgeWear * 0.12;
        }

        // PBR common
        let f0 = mix(vec3f(0.04), baseColor, metallic);
        let albedo = mix(baseColor, vec3f(0.0), metallic);

        // Key light (main directional)
        let L1 = normalize(lighting.key.dir);
        let H1 = normalize(V + L1);
        let NdotL1 = max(dot(detailN, L1), 0.0);
        let NdotH1 = max(dot(detailN, H1), 0.0);
        let D1 = distributionGGX(NdotH1, roughness);
        let G1 = geometrySmith(NdotV, NdotL1, roughness);
        let F1 = fresnelSchlick(max(dot(H1, V), 0.0), f0);
        let specular1 = (D1 * G1 * F1) / (4.0 * NdotV * NdotL1 + 0.001);
        let kD1 = (vec3f(1.0) - F1) * (1.0 - metallic);

        // Fill light (softer, opposite side)
        let L2 = normalize(lighting.fill.dir);
        let H2 = normalize(V + L2);
        let NdotL2 = max(dot(detailN, L2), 0.0);
        let NdotH2 = max(dot(detailN, H2), 0.0);
        let D2 = distributionGGX(NdotH2, roughness);
        let G2 = geometrySmith(NdotV, NdotL2, roughness);
        let F2 = fresnelSchlick(max(dot(H2, V), 0.0), f0);
        let specular2 = (D2 * G2 * F2) / (4.0 * NdotV * NdotL2 + 0.001);
        let kD2 = (vec3f(1.0) - F2) * (1.0 - metallic);

        // Rim light
        let rimFactor = pow(1.0 - NdotV, 3.0) * lighting.rim.intensity;
        let rimLight = lighting.rim.color * rimFactor;

        // Ground bounce light from below
        let Lg = normalize(lighting.ground.dir);
        let NdotLg = max(dot(detailN, Lg), 0.0);

        // Combine
        let diffuse = albedo * PI * (
          kD1 * NdotL1 * lighting.key.color * lighting.key.intensity +
          kD2 * NdotL2 * lighting.fill.color * lighting.fill.intensity * 0.5 +
          lighting.ground.color * lighting.ground.intensity * NdotLg
        );

        let specular = (
          specular1 * lighting.key.color * lighting.key.intensity * NdotL1 +
          specular2 * lighting.fill.color * lighting.fill.intensity * NdotL2 * 0.3
        );

        // Cheap IBL approximation (environment reflection term)
        let envReflect = fresnelSchlick(NdotV, f0) * lighting.envMapStrength * 0.3;

        let ambient = albedo * lighting.ambient * vec3f(0.15, 0.18, 0.22);
        var color = ambient + diffuse + specular + rimLight + envReflect;

        // Add material emission
        color = color + material.glowColor * material.emission * (0.2 + energy * 0.8);

        if (mode == 2) {
          let coronaPulse = 0.5 + 0.5 * sin(uniforms.time * 10.0 + localPos.y * 4.0);
          let branchRaw = abs(sin(localPos.y * 7.0 + localPos.x * 3.2 + uniforms.time * 14.0));
          let branchFw = max(fwidth(branchRaw), 0.015);
          let branch = 1.0 - smoothstep(0.18 - branchFw, 0.18 + branchFw, branchRaw);
          color += vec3f(0.65, 0.88, 1.2) * overdrive * coronaPulse * 1.4;
          color += vec3f(0.80, 0.92, 1.18) * branch * pow(energy, 1.5) * 1.1;
        } else if (mode == 1) {
          let fresnel = pow(1.0 - NdotV, 4.0);
          let shimmer = 0.5 + 0.5 * sin(uniforms.time * 2.3 + cylUV.x * 18.0);
          let caustic = 0.5 + 0.5 * sin(cylUV.x * 56.0 + uniforms.time * 3.0 + triMask * 3.0);
          color += vec3f(0.40, 0.70, 0.95) * energy * shimmer * 0.35;
          color += vec3f(0.72, 0.88, 1.0) * fresnel * (0.10 + pow(energy, 1.35) * 0.75);
          color += vec3f(0.20, 0.45, 0.85) * caustic * pow(energy, 1.4) * 0.28;
        } else if (mode == 3) {
          let thermal = (localPos.y * 0.08 + 0.5) * energy;
          let fresnel = pow(1.0 - NdotV, 5.0);
          let lensSparkle = 0.5 + 0.5 * sin(cylUV.x * 240.0 + cylUV.y * 220.0 + uniforms.time * 4.0);
          color += vec3f(1.0, 0.78, 0.36) * clamp(thermal, 0.0, 1.0) * 0.55;
          color += vec3f(0.35, 0.58, 1.0) * fresnel * (0.12 + device.batteryCharge * 0.65);
          color += vec3f(1.0, 0.86, 0.52) * lensSparkle * pow(max(energy, device.batteryCharge), 1.45) * 0.20;
        } else if (mode == 4) {
          let thermoPulse = 0.5 + 0.5 * sin(uniforms.time * 3.5 + localPos.x * 5.0);
          color += mix(vec3f(1.0, 0.25, 0.08), vec3f(0.05, 0.55, 1.0), clamp(localPos.y * 0.3 + 0.5, 0.0, 1.0))
            * energy * thermoPulse * 0.45;
        } else if (mode >= 5) {
          let flowRaw = abs(sin(localPos.x * 4.5 - localPos.z * 7.5 + uniforms.time * 5.0));
          let flowFw = max(fwidth(flowRaw), 0.015);
          let flowLine = 1.0 - smoothstep(0.24 - flowFw, 0.24 + flowFw, flowRaw);
          color += vec3f(0.15, 0.68, 1.0) * flowLine * pow(energy, 1.45) * 0.95;
        }

        // ACES tonemapping
        color = color * (2.51 * color + 0.03) / (color * (2.43 * color + 0.59) + 0.14);
        
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
      @binding(4) @group(0) var<storage, read> particles: array<vec4f>;
      
      struct VertexOutput {
        @builtin(position) position: vec4f,
        @location(0) particlePhase: f32,
        @location(1) uv: vec2f,
        @location(2) effectType: f32,
        @location(3) speed: f32,
        @location(4) life: f32
      }
      
      const quadVerts = array<vec2f, 4>(
        vec2f(-1.0, -1.0),
        vec2f( 1.0, -1.0),
        vec2f(-1.0,  1.0),
        vec2f( 1.0,  1.0)
      );

      fn posPeltierPath(phase: f32, t: f32, idx: u32) -> vec3f {
        let isSetupA = (idx % 2u) == 0u;
        let xOffset = select(3.5, -3.5, isSetupA);
        let cycleT = fract(t * 0.4 + phase);
        if (phase < 0.4) {
          let yStart = select(4.0, -4.0, isSetupA);
          return vec3f(xOffset + sin(phase * 123.45) * 1.5, mix(yStart, 0.0, cycleT), cos(f32(idx) * 0.123) * 1.5);
        } else if (phase < 0.8) {
          let yStart = select(-4.0, 4.0, isSetupA);
          return vec3f(xOffset + sin(phase * 123.45) * 1.5, mix(yStart, 0.0, cycleT), cos(f32(idx) * 0.123) * 1.5);
        }
        let angle = phase * 62.83 + f32(idx) * 0.1;
        let radius = 1.0 + cycleT * 3.0;
        return vec3f(
          xOffset + cos(angle) * radius,
          sin(t * 5.0 + phase * 20.0) * 0.15,
          sin(angle) * radius
        );
      }

      fn posMhdPath(phase: f32, t: f32, idx: u32) -> vec3f {
        let cycleT = fract(t * 0.7 + fract(phase * 123.45));
        let zPos = 8.0 - 16.0 * cycleT;
        let chargeMultiplier = select(-1.0, 1.0, phase < 0.5);
        var xDeflection = 0.0;
        if (zPos < 2.0) {
          xDeflection = chargeMultiplier * clamp((2.0 - zPos) / 4.0, 0.0, 1.0) * 4.0;
        }
        return vec3f(
          sin(f32(idx) * 123.45) * 0.8 + xDeflection,
          cos(f32(idx) * 0.123) * 0.8,
          zPos
        );
      }

      fn modePathPos(mode: f32, phase: f32, t: f32, idx: u32) -> vec3f {
        if (mode < 0.5) {
          let cycleT = fract(t * 0.12 + phase);
          let radius = 8.5 - cycleT * 8.0;
          let angle = phase * 6.28318 + cycleT * 18.84956;
          let height = sin(cycleT * 12.56636 + phase * 6.28318) * 2.8;
          return vec3f(cos(angle) * radius, height, sin(angle) * radius);
        } else if (mode < 1.5) {
          let cycleT = fract(t * 0.22 + phase);
          let spread = phase * 6.28318;
          let spreadR = fract(phase * 71.0) * 0.55;
          if (cycleT < 0.35) {
            let k = cycleT / 0.35;
            return vec3f(sin(spread) * spreadR * k * 1.4, 5.6 + k * 3.1 - k * k * 1.2, cos(spread) * spreadR * k * 1.4);
          } else if (cycleT < 0.72) {
            let k = (cycleT - 0.35) / 0.37;
            return vec3f(sin(spread) * spreadR * (1.4 - k * 0.9), 8.5 - k * 4.2, cos(spread) * spreadR * (1.4 - k * 0.9));
          }
          let k = (cycleT - 0.72) / 0.28;
          return vec3f(sin(spread) * spreadR * (0.5 - k * 0.5), 4.5 - k * 6.5, cos(spread) * spreadR * (0.5 - k * 0.5));
        } else if (mode < 2.5) {
          let cycleT = fract(t * 0.32 + phase);
          let side = select(-1.0, 1.0, fract(phase * 123.0) > 0.5);
          let wobble = sin(t * 4.0 + phase * 20.0) * 0.09;
          if (cycleT < 0.82) {
            let k = cycleT / 0.82;
            return vec3f(side * 2.5 + wobble, 5.5 - k * 8.8, wobble * 0.4);
          }
          let k = (cycleT - 0.82) / 0.18;
          return vec3f(side * 2.5 * (1.0 - k * 1.9), -3.2 + k * 1.4, 0.0);
        } else if (mode < 3.5) {
          let angle = fract(phase + t * 0.2) * 6.28318;
          let radius = 2.8 + fract(phase * 37.0) * 0.9;
          let y = 3.1 + sin(t * 1.3 + phase * 17.0) * 0.25;
          return vec3f(cos(angle) * radius, y, sin(angle) * radius);
        } else if (mode < 4.5) {
          return posPeltierPath(phase, t, idx);
        }
        return posMhdPath(phase, t, idx);
      }

      fn velocityForParticle(pos: vec3f, mode: f32, phase: f32, effectType: f32, t: f32, idx: u32) -> vec3f {
        if (effectType < 0.5) {
          let dt = 0.015;
          let p1 = modePathPos(mode, phase, t + dt, idx);
          let p0 = modePathPos(mode, phase, t - dt, idx);
          return (p1 - p0) / (2.0 * dt);
        } else if (effectType < 1.5) {
          let radial = normalize(vec3f(pos.x, 0.2, pos.z) + vec3f(1e-4, 0.0, 0.0));
          return radial * 3.8 + vec3f(0.0, 1.2, 0.0);
        } else if (effectType < 2.5) {
          return vec3f(sin(t * 2.0 + phase * 9.0), cos(t * 1.5 + phase * 13.0), cos(t * 2.4 + phase * 7.0)) * 0.7;
        } else if (effectType < 3.5) {
          return vec3f(cos(t * 6.0 + phase * 12.0), sin(t * 9.0 + phase * 8.0), 0.0) * 2.5;
        } else if (effectType < 4.5) {
          return vec3f(sin(t * 1.3 + phase * 6.0), 0.6 * cos(t * 1.9 + phase * 4.5), cos(t * 1.1 + phase * 7.0)) * 0.5;
        } else if (effectType < 5.5) {
          let radial = normalize(vec3f(pos.x, 0.02, pos.z) + vec3f(1e-4, 0.0, 0.0));
          return radial * (1.2 + phase * 2.6) + vec3f(0.0, 0.08, 0.0);
        } else if (effectType < 6.5) {
          let side = select(-1.0, 1.0, fract(phase * 129.0) > 0.5);
          return vec3f(side * (2.5 + 1.6 * sin(t * 6.5 + phase * 19.0)), sin(t * 12.0 + phase * 21.0) * 1.2, cos(t * 8.0 + phase * 17.0) * 0.9);
        } else if (effectType < 7.5) {
          return vec3f(cos(t * 7.0 + phase * 31.0), -1.0 - 0.5 * sin(t * 4.5 + phase * 9.0), sin(t * 6.2 + phase * 27.0)) * 0.45;
        }
        return vec3f(0.0, 0.0, 0.0);
      }
      
      @vertex
      fn main(
        @builtin(vertex_index) vertIdx: u32,
        @builtin(instance_index) instIdx: u32
      ) -> VertexOutput {
        let particle = particles[instIdx];
        let pos = particle.xyz;
        let encodedPhase = particle.w;
        let effectType = floor(encodedPhase);
        let phase = fract(encodedPhase);
        let quadPos = quadVerts[vertIdx];
        
        let devicePos = vec3f(device.posX, device.posY, device.posZ);
        let mode = device.ringIndex;
        let vel = velocityForParticle(pos, mode, phase, effectType, uniforms.time, instIdx);
        let speed = length(vel);
        let velDir = normalize(vel + vec3f(1e-5, 0.0, 0.0));
        let toCamera = normalize(uniforms.cameraPos - pos - devicePos);
        let up = vec3f(0.0, 1.0, 0.0);
        let fallbackRight = normalize(cross(up, toCamera) + vec3f(1e-4, 0.0, 0.0));
        var right = normalize(cross(toCamera, velDir));
        if (length(right) < 0.01) {
          right = fallbackRight;
        }
        let billboardUp = normalize(cross(right, toCamera));
        
        // Particle size varies by mode
        var size: f32 = 0.07;
        if (mode > 0.5 && mode < 1.5) {
          size = 0.11;   // larger water droplets for Heron
        } else if (mode >= 3.5) {
          size = 0.08;   // Peltier particles
        } else if (mode >= 2.5) {
          size = 0.05;   // small photon dots for Solar
        }

        var stretch = 1.0 + speed * 0.8;
        if (mode < 0.5) {
          // SEG field particles: fine dust, less speed streaking.
          stretch = 1.0 + speed * 0.35;
          size *= 0.55;
        }
        if (effectType > 0.5 && effectType < 1.5) {
          stretch = 2.0 + speed * 1.5;
          size *= 0.75;
        } else if (effectType > 1.5 && effectType < 2.5) {
          stretch = 1.2;
          size *= 1.4;
        } else if (effectType > 6.5 && effectType < 7.5) {
          stretch = 1.6;
          size *= 1.8;
        } else if (effectType > 5.5 && effectType < 6.5) {
          stretch = 3.1;
          size *= 0.72;
        } else if (effectType > 4.5 && effectType < 5.5) {
          stretch = 0.9;
          size *= 3.2;
        } else if (effectType > 3.5 && effectType < 4.5) {
          stretch = 1.15;
          size *= 4.0;
        } else if (effectType > 2.5 && effectType < 3.5) {
          stretch = 2.6;
          size *= 0.6;
        }
        
        let worldPos = pos + devicePos + 
                       right * quadPos.x * size + 
                       velDir * quadPos.y * size * stretch;
        
        var output: VertexOutput;
        output.position = uniforms.viewProj * vec4f(worldPos, 1.0);
        output.particlePhase = phase;
        output.uv = quadPos * 0.5 + 0.5;
        output.effectType = effectType;
        output.speed = speed;
        output.life = fract(uniforms.time * 0.5 + phase);
        
        return output;
      }
    `;
  }
  
  // Particle fragment shader
  get particleFragShader() {
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

      struct MaterialUniforms {
        baseColor: vec3f,
        pad1: f32,
        glowColor: vec3f,
        emission: f32
      }
      
      @binding(0) @group(0) var<uniform> uniforms: Uniforms;
      @binding(1) @group(0) var<uniform> device: DeviceUniforms;
      @binding(3) @group(0) var<uniform> material: MaterialUniforms;
      
      struct FragmentInput {
        @location(0) particlePhase: f32,
        @location(1) uv: vec2f,
        @location(2) effectType: f32,
        @location(3) speed: f32,
        @location(4) life: f32
      }
      
      @fragment
      fn main(input: FragmentInput) -> @location(0) vec4f {
        let uv = input.uv * 2.0 - 1.0;
        let dist = length(uv);
        if (dist > 1.0) {
          discard;
        }

        let effectType = input.effectType;
        var alpha: f32;
        let mode = device.ringIndex;
        let energy = clamp(device.timeScale, 0.0, 1.0);
        let overdrive = pow(energy, 1.7);
        let t = uniforms.time;
        let phase = input.particlePhase;
        var color: vec3f;

        if (effectType > 6.5 && effectType < 7.5) {
          // Solar refraction caustic photons at panel interface.
          let core = exp(-dist * dist * 20.0);
          let halo = exp(-dist * dist * 7.0) * 0.45;
          alpha = (core + halo) * (0.55 + 0.45 * energy);
          color = mix(vec3f(0.45, 0.72, 1.0), vec3f(1.0, 0.86, 0.40), 0.5 + 0.5 * sin(t * 5.0 + phase * 17.0));
        } else if (effectType > 5.5 && effectType < 6.5) {
          // Kelvin branching discharges (lightning-inspired blue-white channels).
          let trunk = exp(-abs(uv.x) * 18.0) * exp(-abs(uv.y) * 3.8);
          let branch = exp(-abs(uv.x + sin(t * 8.0 + phase * 12.0) * 0.35) * 10.0) * exp(-abs(uv.y) * 5.2);
          let flare = exp(-dist * dist * 16.0) * 0.35;
          alpha = (trunk + branch * 0.7 + flare) * (0.9 + overdrive * 1.25);
          color = vec3f(0.75, 0.88, 1.0) * (0.7 + 0.3 * (0.5 + 0.5 * sin(t * 16.0 + phase * 22.0)));
        } else if (effectType > 4.5 && effectType < 5.5) {
          // Heron impact ripples: expanding annular profile at basin.
          let ring = exp(-pow((dist - (0.35 + input.life * 0.45)) * 9.0, 2.0));
          let center = exp(-dist * dist * 18.0) * 0.25;
          alpha = (ring + center) * (0.35 + energy * 0.75);
          color = mix(vec3f(0.18, 0.40, 0.78), vec3f(0.65, 0.85, 1.0), input.life);
        } else if (effectType > 3.5 && effectType < 4.5) {
          // Heat-haze veil: broad, low-frequency flicker around high-energy parts.
          let shell = exp(-dist * dist * 1.8);
          let wobble = 0.55 + 0.45 * sin(t * 2.2 + phase * 8.0 + uv.x * 6.0);
          alpha = shell * wobble * (0.08 + energy * 0.22);
          color = mix(vec3f(1.0, 0.45, 0.15), vec3f(0.25, 0.75, 1.0), clamp(uv.y * 0.5 + 0.5, 0.0, 1.0)) * (0.12 + energy * 0.45);
        } else if (effectType > 2.5 && effectType < 3.5) {
          // Filaments: tight electric strands.
          let strand = exp(-abs(uv.x) * 22.0) * exp(-abs(uv.y) * 4.0);
          let haze = exp(-dist * dist * 8.0) * 0.2;
          alpha = strand + haze;
          color = vec3f(0.7, 0.9, 1.0) + vec3f(0.25, 0.0, 0.45) * (0.5 + 0.5 * sin(t * 17.0 + phase * 29.0));
        } else if (effectType > 1.5 && effectType < 2.5) {
          // Corona: faint blue-white plasma halo around stator rings.
          let shell = exp(-dist * dist * 2.6);
          let core = exp(-dist * dist * 10.0) * 0.35;
          alpha = (shell + core) * (0.28 + 0.35 * (0.5 + 0.5 * sin(t * 9.0 + phase * 11.0))) * (0.18 + overdrive * 0.45);
          color = mix(vec3f(0.45, 0.72, 0.95), vec3f(0.82, 0.92, 1.0), input.life);
        } else if (effectType > 0.5 && effectType < 1.5) {
          // Spark bursts: fine charge filaments, not giant glowing orbs.
          let line = exp(-abs(uv.x) * 8.0) * exp(-abs(uv.y) * 2.2);
          let flare = exp(-dist * dist * 30.0);
          alpha = (line * 0.9 + flare * 0.7) * (0.35 + input.speed * 0.04 + overdrive * 0.55);
          color = mix(vec3f(0.6, 0.85, 1.0), vec3f(1.0, 0.95, 0.65), clamp(input.life * 1.2, 0.0, 1.0));
          // Keep the magenta tint only for non-SEG devices; SEG stays blue-white/copper.
          if ((mode < 2.5 || mode > 3.5) && mode >= 0.5) {
            color = mix(color, vec3f(0.7, 0.2, 1.0), 0.25);
          }
        } else {
          // Bright core + soft halo for additive blending
          let core = exp(-dist * dist * 22.0);
          let halo = exp(-dist * dist * 6.0) * 0.35;
          alpha = (core + halo) * 0.55;
        
          if (mode < 0.5) {
            // SEG: subtle steel-blue magnetic dust / field lines.
            let pulse = 0.6 + 0.4 * sin(t * 5.0 + phase * 6.28);
            color = mix(vec3f(0.55, 0.72, 0.88), vec3f(0.78, 0.88, 0.95), pulse);
          } else if (mode < 1.5) {
            // Heron: blue water droplets with slight white specular centre
            let h = clamp(input.uv.y * 0.5 + 0.5, 0.0, 1.0);
            color = mix(vec3f(0.0, 0.22, 0.70), vec3f(0.55, 0.82, 1.0), h * (1.0 - dist));
          } else if (mode < 2.5) {
            // Kelvin: translucent water drops; rare bright spark particles
            let spark = step(0.97, fract(sin(f32(input.uv.x * 100.0) + phase * 3137.1) * 43758.5453));
            color = mix(vec3f(0.72, 0.82, 0.96), vec3f(0.85, 0.15, 1.0), spark);
          } else if (mode < 3.5) {
            // Solar: warm yellow photons
            let intensity = 0.55 + 0.45 * device.batteryCharge;
            color = vec3f(1.0, 0.88, 0.28) * intensity;
          } else {
            // Peltier TEG: Colors based on thermal regions
            if (phase < 0.4) {
              color = vec3f(1.0, 0.25 + 0.1 * sin(t * 3.0 + phase * 10.0), 0.0);
            } else if (phase < 0.8) {
              color = vec3f(0.0, 0.5 + 0.2 * sin(t * 2.0 + phase * 8.0), 1.0);
            } else {
              let spark = step(0.82, fract(sin(t * 18.0 + phase * 127.3) * 43758.5453));
              color = mix(vec3f(0.4, 0.95, 0.2), vec3f(1.0, 1.0, 0.6), spark * 0.7);
            }

            alpha *= 0.9 + overdrive * 1.2;
          }
        }
        
        // Add glow
        let glow = material.glowColor * material.emission * (0.35 + energy * 0.85);
        color = color + glow;
        color = color * alpha;

        return vec4f(color, alpha);
      }
    `;
  }
  
  // Field line vertex shader
  get fluxLineTracerShader() {
    return fluxLinesWgsl;
  }

  // ── RK4 Flux Segment ribbon vertex shader ────────────────────────────────
  // Reads FluxSegment data from storage buffer @binding(2) and expands each
  // segment into a world-space ribbon (triangle-strip, 4 verts/instance).
  //
  // The ribbon is oriented with the B-field tangent and the view ray so it
  // always faces the camera.  Width is computed in pixels and then converted
  // back to world space using the projection matrix, giving a line thickness
  // that stays constant regardless of zoom, distance, or camera angle.  |B|
  // drives both width and color, and segment age drives a crawling energy
  // pulse.  Round caps/edges are handled in the fragment shader via (u,v)
  // coordinates passed from the vertex stage.
  get fluxSegmentVertShader() {
    return /* wgsl */ `
      struct Uniforms {
        viewProj: mat4x4f,
        time: f32,
        resolution: vec2f,
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

      // Scalar fields keep the struct tightly packed at 32 bytes (matches
      // flux-lines.wgsl); vec3f members would require 16-byte-aligned offsets
      // in storage address space.
      struct FluxSegment {
        startX:   f32,
        startY:   f32,
        startZ:   f32,
        endX:     f32,
        endY:     f32,
        endZ:     f32,
        strength: f32,
        age:      f32,
      }

      @binding(0) @group(0) var<uniform> uniforms: Uniforms;
      @binding(1) @group(0) var<uniform> device: DeviceUniforms;
      @binding(2) @group(0) var<storage> segments: array<FluxSegment>;

      struct VertexOutput {
        @builtin(position) position: vec4f,
        @location(0) strength: f32,
        @location(1) alpha: f32,
        @location(2) u: f32,
        @location(3) v: f32,
      }

      const BASE_PX_HALF_WIDTH: f32 = 0.8;
      const MAX_PX_HALF_WIDTH:  f32 = 2.2;
      const WORLD_UP: vec3f = vec3f(0.0, 1.0, 0.0);

      @vertex
      fn main(@builtin(vertex_index) vertIdx: u32,
              @builtin(instance_index) instIdx: u32) -> VertexOutput {
        let seg = segments[instIdx];
        let devicePos = vec3f(device.posX, device.posY, device.posZ);
        let startWorld = vec3f(seg.startX, seg.startY, seg.startZ) + devicePos;
        let endWorld   = vec3f(seg.endX,   seg.endY,   seg.endZ) + devicePos;

        // Tangent along the local B-field direction.
        let tangent = normalize(endWorld - startWorld);

        // View-aligned width direction: perpendicular to tangent and to the
        // view ray, so the ribbon always faces the camera.
        let centerWorld = (startWorld + endWorld) * 0.5;
        let viewDir = normalize(uniforms.cameraPos - centerWorld);
        let widthDirRaw = cross(tangent, viewDir);

        // Near grazing angles the cross product collapses and becomes noisy.
        // Blend to a world-up ribbon basis to keep the line stable when the
        // camera aligns with the field direction.
        let upFallback = cross(tangent, WORLD_UP);
        let widthMag = length(widthDirRaw);
        var widthDir: vec3f;
        if (widthMag < 0.001 || length(upFallback) < 0.001) {
          widthDir = vec3f(1.0, 0.0, 0.0);
        } else {
          let grazing = 1.0 - clamp(widthMag / 0.02, 0.0, 1.0);
          widthDir = normalize(mix(normalize(widthDirRaw), normalize(upFallback), grazing));
        }

        // View-consistent half-width in pixels, driven by |B|.
        let t = clamp(sqrt(seg.strength * 2.0e6), 0.0, 1.0);
        let pxHalfWidth = mix(BASE_PX_HALF_WIDTH, MAX_PX_HALF_WIDTH, t);
        let ndcHalfWidth = pxHalfWidth * (2.0 / uniforms.resolution.y);

        // Convert NDC half-width back to world space using the projection of
        // the width direction.  This gives an exact pixel width independent of
        // distance, zoom, or field-of-view.
        let clipCenter = uniforms.viewProj * vec4f(centerWorld, 1.0);
        let clipWidth  = (uniforms.viewProj * vec4f(widthDir, 0.0)).xy;
        let projScale  = length(clipWidth);
        let safeW      = max(clipCenter.w, 1e-6);
        let halfWidthWorld = select(
          ndcHalfWidth * safeW / projScale,
          0.0,
          projScale < 1e-6 || safeW <= 0.0
        );

        // Triangle-strip layout: 0,1 at start; 2,3 at end.  Sides alternate.
        let atEnd = (vertIdx >= 2u);
        let side  = select(-1.0, 1.0, (vertIdx & 1u) == 1u);
        let end   = select(-1.0, 1.0, atEnd);

        let baseWorld = select(startWorld, endWorld, atEnd);
        let worldPos = baseWorld + widthDir * halfWidthWorld * side;

        // Age-pulsed alpha: crawling energy effect. Restrained baseline so the
        // field lines read as fine B-field filaments rather than neon tubes.
        let agePulse = 0.5 + 0.5 * sin(seg.age * 6.2832);
        let alpha = clamp(t * 0.55 + 0.06, 0.06, 0.55) * agePulse;

        var out: VertexOutput;
        out.position = uniforms.viewProj * vec4f(worldPos, 1.0);
        out.strength = seg.strength;
        out.alpha    = alpha;
        out.u        = side;
        out.v        = end;
        return out;
      }
    `;
  }

  // ── RK4 Flux Segment fragment shader ─────────────────────────────────────
  // |B|-driven color ramp: deep blue → cyan → light-blue → white-hot.
  // Applies soft round caps/edges using (u,v) coordinates from the vertex
  // stage, hiding small gaps between adjacent segments and giving the lines
  // a smooth, glowing, tube-like appearance.
  get fluxSegmentFragShader() {
    return /* wgsl */ `
      struct FragInput {
        @location(0) strength: f32,
        @location(1) alpha: f32,
        @location(2) u: f32,
        @location(3) v: f32,
      }

      // Desaturated steel-blue → soft white. No 1.2× overbright white-hot push.
      fn fluxColor(strength: f32) -> vec3f {
        let t = clamp(sqrt(strength * 2.0e6), 0.0, 1.0);
        if (t < 0.33) {
          let s = t / 0.33;
          return mix(vec3f(0.05, 0.12, 0.55), vec3f(0.35, 0.65, 0.85), s);
        } else if (t < 0.66) {
          let s = (t - 0.33) / 0.33;
          return mix(vec3f(0.35, 0.65, 0.85), vec3f(0.85, 0.92, 0.96), s);
        } else {
          let s = (t - 0.66) / 0.34;
          return mix(vec3f(0.85, 0.92, 0.96), vec3f(1.0, 1.0, 1.0), s);
        }
      }

      @fragment
      fn main(input: FragInput) -> @location(0) vec4f {
        // Round the ribbon cross-section and caps.  u spans the width, v spans
        // the length; fading outside the unit circle creates anti-aliased,
        // tube-like segments that blend smoothly at joints.
        let r = length(vec2f(input.u, input.v));
        let edgeAlpha = 1.0 - smoothstep(0.92, 1.0, r);
        return vec4f(fluxColor(input.strength), input.alpha * edgeAlpha);
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
      
      // Scalar fields keep the struct tightly packed at 32 bytes, matching the
      // CPU-written layout; vec3f members would require 16-byte-aligned offsets
      // in storage address space.
      struct ArcParticle {
        posX:      f32,
        posY:      f32,
        posZ:      f32,
        velX:      f32,
        velY:      f32,
        velZ:      f32,
        life:      f32,
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
        let worldPos = vec3f(particle.posX, particle.posY, particle.posZ) + devicePos;

        var output: VertexOutput;
        output.position = uniforms.viewProj * vec4f(worldPos, 1.0);

        // Electric arc colors - desaturated blue-white filaments.
        output.color = vec3f(0.72, 0.88, 1.0);
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
        let glow = input.color * input.intensity * 0.55;
        return vec4f(glow, input.intensity * 0.45);
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

        // bandIndex is now computed in the fragment shader from uv + normal
        // because the roller mesh encodes end-face radial layers and barrel
        // axial segments differently.  Pass 0 here; roller logic ignores it.
        let bandIdx = 0.0;

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

      struct MaterialEntry {
        baseMetal: vec4f,
        accentRough: vec4f,
        detailParams: vec4f
      }

      struct Light {
        dir: vec3f,
        color: vec3f,
        intensity: f32,
      }

      struct LightingConfig {
        key: Light,
        fill: Light,
        rim: Light,
        ground: Light,
        ambient: f32,
        envMapStrength: f32,
        shadowStrength: f32,
      }

      struct RollerShadowData {
        pos: vec4f,   // xyz = world position, w = ring index
      }

      @binding(0) @group(0) var<uniform> uniforms: Uniforms;
      @binding(1) @group(0) var<uniform> device: DeviceUniforms;
      @binding(3) @group(0) var<uniform> material: MaterialUniforms;
      @binding(5) @group(0) var<uniform> lighting: LightingConfig;
      @binding(6) @group(0) var<storage, read> materialTable: array<MaterialEntry>;
      @binding(7) @group(0) var<storage, read> rollerShadows: array<RollerShadowData>;

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

      // FBM noise for copper oxidation variation
      fn oxidationFBM(p: vec3f) -> f32 {
        var value = 0.0;
        var amplitude = 0.5;
        var pos = p;
        for (var i = 0; i < 4; i++) {
          let h = hash3(floor(pos * 3.0));
          value += (h.x * 2.0 - 1.0) * amplitude;
          pos = pos * 2.1 + vec3f(1.7, 2.3, 0.9);
          amplitude *= 0.5;
        }
        return value * 0.5 + 0.5; // Normalize to [0,1]
      }

      // Anisotropic GGX for brushed-metal specular
      fn distributionGGXAniso(NdotH: f32, TdotH: f32, BdotH: f32, roughX: f32, roughY: f32) -> f32 {
        let ax = roughX * roughX;
        let ay = roughY * roughY;
        let d = (TdotH * TdotH) / (ax * ax) + (BdotH * BdotH) / (ay * ay) + NdotH * NdotH;
        return 1.0 / (3.14159265 * ax * ay * d * d);
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

      fn fbm(p: vec3f) -> f32 {
        var value = 0.0;
        var amplitude = 0.5;
        var pos = p;
        for (var i = 0; i < 4; i++) {
          let h = hash3(floor(pos * 3.0));
          value += (h.x * 2.0 - 1.0) * amplitude;
          pos = pos * 2.1 + vec3f(1.7, 2.3, 0.9);
          amplitude *= 0.5;
        }
        return clamp(value * 0.5 + 0.5, 0.0, 1.0);
      }

      fn blackbody(temp: f32) -> vec3f {
        let t = clamp(temp, 800.0, 3500.0) / 1000.0;
        let warm = vec3f(1.0, 0.4 + t * 0.3, 0.1 + t * 0.6);
        return warm * max(0.0, t - 0.8);
      }

      fn triplanarMask(p: vec3f, n: vec3f, scale: f32) -> f32 {
        let an = abs(n);
        let w = an / (an.x + an.y + an.z + 1e-4);
        let nx = fbm(vec3f(p.y, p.z, p.x) * scale);
        let ny = fbm(vec3f(p.x, p.z, p.y) * scale);
        let nz = fbm(vec3f(p.x, p.y, p.z) * scale);
        return nx * w.x + ny * w.y + nz * w.z;
      }

      fn cylindricalUV(p: vec3f) -> vec2f {
        let u = fract(atan2(p.z, p.x) / (2.0 * 3.14159265) + 0.5);
        let v = fract(p.y * 0.33 + 0.5);
        return vec2f(u, v);
      }

      // Tangent direction for radial brushed-metal surfaces.
      // Horizontal faces get an azimuthal tangent; vertical cylindrical faces get
      // a radial-outward tangent. Falls back to the view-space horizontal axis
      // when the surface is not ring-like.
      fn radialTangent(localPos: vec3f, N: vec3f) -> vec3f {
        let radial = normalize(vec3f(localPos.x, 0.0, localPos.z) + vec3f(1e-5));
        let azimuthal = vec3f(-radial.z, 0.0, radial.x);
        let isHorizontal = abs(N.y) > 0.65;
        return select(radial, azimuthal, isHorizontal);
      }

      // Signed-distance to a regular hexagon (2D, centred at origin, circumradius = 1).
      fn hexDist(p: vec2f) -> f32 {
        let k = vec2f(-0.5, 0.86602540378);
        var q = abs(p);
        q = q - 2.0 * min(dot(k, q), 0.0) * k;
        q = q - vec2f(clamp(q.x, -k.y, k.y), 0.0);
        return length(q) * sign(q.y);
      }

      // Ring of hex bolt heads in the XZ plane.
      fn boltRingDecal(localPos: vec3f, boltCount: i32, boltRadius: f32, headSize: f32) -> f32 {
        let theta = atan2(localPos.z, localPos.x) / (2.0 * 3.14159265) + 0.5;
        let countF = f32(boltCount);
        let idx = i32(round(theta * countF));
        let boltTheta = f32(idx) / countF * 2.0 * 3.14159265;
        let c = cos(boltTheta);
        let s = sin(boltTheta);
        let center = vec2f(c * boltRadius, s * boltRadius);
        let p = (localPos.xz - center) / max(headSize, 1e-4);
        let d = hexDist(p);
        return 1.0 - smoothstep(-0.05, 0.12, d);
      }

      // ----------------------------------------------------------------------------
      // Prototype-accurate SEG roller layering
      // ----------------------------------------------------------------------------
      // These constants MUST stay in sync with generatePoleBandedRoller() in
      // seg-geometry-generators.js.
      const ROLLER_RADIUS: f32 = 0.75;
      const ROLLER_HEIGHT: f32 = 2.8;
      const ROLLER_SEGMENTS: f32 = 8.0;
      const ROLLER_GROOVE_WIDTH: f32 = 0.045;
      const ROLLER_GROOVE_DEPTH: f32 = 0.035;

      // End-face radial layer boundaries (fraction of outer radius):
      //   0.0-0.30  neodymium core
      //   0.30-0.52  nylon / teflon regulator
      //   0.52-0.74  iron / nickel accelerator
      //   0.74-1.00  copper / aluminum outer sleeve
      const LAYER_R0: f32 = 0.30;
      const LAYER_R1: f32 = 0.52;
      const LAYER_R2: f32 = 0.74;
      const LAYER_R3: f32 = 1.00;

      fn rollerLayerId(radialT: f32) -> i32 {
        if (radialT < LAYER_R0) { return 0; }
        if (radialT < LAYER_R1) { return 1; }
        if (radialT < LAYER_R2) { return 2; }
        return 3;
      }

      // Layer color for the two prototype presets.
      // preset 0 = Searl showroom mock-up (nickel/brass/copper finish)
      // preset 1 = Roschin-Godin lab rig (aluminum sleeves, ceramic, wear)
      fn rollerLayerColor(layerId: i32, preset: i32) -> vec3f {
        var c: vec3f;
        if (preset == 0) {
          if (layerId == 0) { c = vec3f(0.74, 0.76, 0.78); }      // neodymium
          else if (layerId == 1) { c = vec3f(0.92, 0.90, 0.85); } // nylon
          else if (layerId == 2) { c = vec3f(0.88, 0.89, 0.91); } // bright nickel
          else { c = vec3f(0.85, 0.55, 0.28); }                   // polished copper
        } else {
          if (layerId == 0) { c = vec3f(0.62, 0.64, 0.66); }      // ceramic magnet
          else if (layerId == 1) { c = vec3f(0.90, 0.88, 0.82); } // off-white nylon
          else if (layerId == 2) { c = vec3f(0.55, 0.56, 0.58); } // steel/iron
          else { c = vec3f(0.78, 0.79, 0.80); }                   // aluminum sleeve
        }
        return c;
      }

      fn rollerLayerMetallic(layerId: i32, preset: i32) -> f32 {
        if (preset == 0) {
          if (layerId == 0) { return 0.88; }
          if (layerId == 1) { return 0.05; }
          if (layerId == 2) { return 0.96; }
          return 0.95;
        }
        if (layerId == 0) { return 0.12; }
        if (layerId == 1) { return 0.05; }
        if (layerId == 2) { return 0.72; }
        return 0.55;
      }

      fn rollerLayerRoughness(layerId: i32, preset: i32) -> f32 {
        if (preset == 0) {
          if (layerId == 0) { return 0.24; }
          if (layerId == 1) { return 0.55; }
          if (layerId == 2) { return 0.13; }
          return 0.22;
        }
        if (layerId == 0) { return 0.48; }
        if (layerId == 1) { return 0.62; }
        if (layerId == 2) { return 0.38; }
        return 0.34;
      }

      // ----------------------------------------------------------------------------
      // Unified analytic contact shadows + per-roller moving penumbra
      // ----------------------------------------------------------------------------
      fn groundHubShadow(r: f32, h: f32) -> f32 {
        let contact = exp(-pow(r / 0.70, 2.0));
        let broad   = exp(-pow(r / 1.80, 2.0)) * 0.45;
        return (contact + broad) * exp(-h * 1.6);
      }

      fn groundOrbitShadow(r: f32, orbitRadius: f32, h: f32) -> f32 {
        let dr = r - orbitRadius;
        let contact = exp(-pow(dr / 0.48, 2.0));
        let broad   = exp(-pow(dr / 1.15, 2.0)) * 0.35;
        return (contact + broad) * exp(-h * 1.9);
      }

      fn accumulateRollerPenumbra(worldPos: vec3f) -> f32 {
        var shadow = 0.0;
        for (var i = 0u; i < 36u; i++) {
          let rp = rollerShadows[i].pos;
          let d = worldPos.xz - rp.xz;
          let distSq = dot(d, d);
          if (distSq > 16.0) { continue; }
          let distH = sqrt(distSq);
          let dh = worldPos.y - rp.y;
          if (dh < -0.4) { continue; }
          let penumbraRadius = 0.95 + max(0.0, dh) * 0.85;
          let s = smoothstep(penumbraRadius, 0.0, distH);
          shadow += s * exp(-max(0.0, dh) * 1.8) * 0.10;
        }
        return shadow;
      }

      fn unifiedContactShadow(worldPos: vec3f, N: vec3f) -> f32 {
        let r = length(worldPos.xz);
        let h = max(0.0, worldPos.y + 0.35);
        let upWeight = clamp(N.y, 0.0, 1.0);

        var groundShadow = 0.0;
        groundShadow += groundHubShadow(r, h) * 0.55;
        groundShadow += groundOrbitShadow(r, 2.5, h) * 0.40;
        groundShadow += groundOrbitShadow(r, 4.0, h) * 0.32;
        groundShadow += groundOrbitShadow(r, 5.5, h) * 0.26;

        let penumbra = accumulateRollerPenumbra(worldPos);
        let total = clamp((groundShadow * upWeight + penumbra) * lighting.shadowStrength, 0.0, 0.78);
        return 1.0 - total;
      }

      fn sharedMaterialId(mode: i32, renderMode: i32, ringIndex: f32, bandIndex: f32) -> u32 {
        if (mode == 1) { return 8u; }
        if (mode == 2) { return 10u; }
        if (mode == 3) { return 7u; }
        if (mode == 4) { return 9u; }
        if (mode >= 5) { return 1u; }
        if (renderMode == 1) { return 13u; }
        if (renderMode == 2) { return 2u; }
        if (renderMode == 3) { return 0u; }
        if (ringIndex < -0.5) { return 1u; }
        if (ringIndex > 10.0) { return 2u; }
        return 0u;
      }

      @fragment
      fn main(input: FragmentInput) -> @location(0) vec4f {
        let mode = i32(round(device.ringIndex));
        let renderMode = i32(round(device.renderMode));
        let energy = clamp(device.timeScale, 0.0, 1.0);
        let overdrive = pow(energy, 1.8);
        var mat = materialTable[sharedMaterialId(mode, renderMode, input.ringIndex, 0.0)];
        let devicePos = vec3f(device.posX, device.posY, device.posZ);
        let localPos = input.worldPos - devicePos;
        let cylUV = cylindricalUV(localPos);
        var N = normalize(input.normal);
        let V = normalize(uniforms.cameraPos - input.worldPos);

        var baseColor: vec3f;
        var metallic: f32;
        var roughness: f32;
        var emissive: f32;
        var isCopper = false;
        var layerId: i32 = -1;
        var segmentId: i32 = -1;

        // Prototype preset encoded in material pad1 (0 = Searl mock-up, 1 = Roschin-Godin)
        let prototypePreset = i32(round(material.pad1));

        if (renderMode == 0) {
          let capThreshold = 0.85;
          let isCap = abs(N.y) > capThreshold;
          let radialT = length(localPos.xz) / ROLLER_RADIUS;
          layerId = rollerLayerId(radialT);

          // Axial segment / groove detection on the barrel.
          let yRel = localPos.y + ROLLER_HEIGHT * 0.5;
          let segmentPitch = (ROLLER_HEIGHT - ROLLER_GROOVE_WIDTH * (ROLLER_SEGMENTS - 1.0)) / ROLLER_SEGMENTS + ROLLER_GROOVE_WIDTH;
          let cyclePos = fract(yRel / segmentPitch) * segmentPitch;
          let bandHeight = segmentPitch - ROLLER_GROOVE_WIDTH;
          segmentId = i32(clamp(floor(yRel / segmentPitch), 0.0, ROLLER_SEGMENTS - 1.0));
          let distToBoundary = min(cyclePos, abs(cyclePos - bandHeight));
          let isGroove = distToBoundary < ROLLER_GROOVE_WIDTH * 0.5 &&
                         yRel > ROLLER_GROOVE_WIDTH && yRel < ROLLER_HEIGHT - ROLLER_GROOVE_WIDTH;

          // Pull material table index from layer composition.
          if (isCap) {
            // layer 0=neo, 1=nylon, 2=iron, 3=outer
            var layerMatId = select(select(select(4u, 3u, layerId == 1), 1u, layerId == 2), 0u, layerId == 3);
            // For Roschin-Godin use the anodized-can/aluminum preset for the outer sleeve.
            if (prototypePreset == 1 && layerId == 3) { layerMatId = 10u; }
            mat = materialTable[layerMatId];
          }

          if (isCap) {
            baseColor = rollerLayerColor(layerId, prototypePreset);
            metallic = rollerLayerMetallic(layerId, prototypePreset);
            roughness = rollerLayerRoughness(layerId, prototypePreset);
            emissive = select(0.0, 0.22, layerId == 0) * energy;
            isCopper = (layerId == 3) && (prototypePreset == 0);

            // Slight step-normal at radial layer transitions.
            let layerEdgeDist = min(abs(radialT - LAYER_R0), min(abs(radialT - LAYER_R1), abs(radialT - LAYER_R2)));
            let nearEdge = smoothstep(0.025, 0.0, layerEdgeDist);
            let radialDir = normalize(vec3f(localPos.x, 0.0, localPos.z));
            N = normalize(mix(N, radialDir * sign(N.y), nearEdge * 0.25));
          } else {
            // Barrel is the outer sleeve, interrupted by dark oxidized grooves.
            baseColor = rollerLayerColor(3, prototypePreset);
            metallic = rollerLayerMetallic(3, prototypePreset);
            roughness = rollerLayerRoughness(3, prototypePreset);
            emissive = 0.0;
            isCopper = (prototypePreset == 0);

            if (isGroove) {
              baseColor *= 0.50;
              roughness = min(roughness + 0.28, 0.95);
              emissive = 0.18 * energy;

              // Bend normal inward to emphasize the machined recess.
              let grooveT = smoothstep(ROLLER_GROOVE_WIDTH * 0.5, 0.0, distToBoundary);
              let radialDir = normalize(vec3f(localPos.x, 0.0, localPos.z));
              N = normalize(mix(N, -radialDir, grooveT * 0.55));
            }
          }
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
          isCopper = true;
        }

        // Blend with shared material table so all devices use consistent physical presets.
        // Keep @binding(3) material live for auto pipeline layout (Tint strips unused bindings).
        baseColor += material.glowColor * material.emission * 0.0005;
        baseColor = mix(baseColor, mat.baseMetal.rgb, 0.65);
        metallic = mix(metallic, mat.baseMetal.a, 0.65);
        roughness = mix(roughness, mat.accentRough.a, 0.65);

        // Offset FBM by layer and segment so wear/oxidation respects boundaries
        // rather than smearing continuously across them.
        let layerOffset = vec3f(f32(layerId + 1) * 7.31, f32(segmentId + 1) * 11.73, 0.0);
        let brushed = fbm(localPos * (mat.detailParams.x * 0.35) + layerOffset);
        let oxidation = fbm(localPos * (mat.detailParams.x * 0.75 + 9.0) + layerOffset * 1.3);
        baseColor = mix(baseColor, mat.accentRough.rgb, oxidation * mat.detailParams.y);
        baseColor *= 0.90 + brushed * 0.15;
        roughness = clamp(roughness + brushed * 0.08 + oxidation * 0.08, 0.05, 1.0);

        var decalMask = 0.0;
        var radialBrush = 0.0;
        var creviceAO = 0.0;
        let triMask = triplanarMask(localPos, N, 0.85);

        let theta = atan2(localPos.z, localPos.x) / (2.0 * 3.14159265) + 0.5;
        let polarR = length(localPos.xz);

        // Base-plate bolt ring: hex heads around the perimeter of the chassis.
        if (renderMode == 1) {
          let bolts = boltRingDecal(localPos, 24, 3.65, 0.13);
          decalMask += bolts;
          // Perturb normal so bolt heads catch the key light.
          let boltTangent = normalize(vec3f(-localPos.z, 0.0, localPos.x));
          N = normalize(mix(N, boltTangent * 0.25 + vec3f(0.0, 0.35, 0.0), bolts * 0.45));
        }

        if (renderMode == 1 || renderMode == 2) {
          let rivetSector = abs(fract(theta * 24.0) - 0.5);
          let rivetRadial = abs(polarR - 3.2);
          let rivets = smoothstep(0.08, 0.01, rivetSector) * smoothstep(0.12, 0.0, rivetRadial);
          decalMask += rivets * 0.8;
        }

        // Radial machining scratches for rings, plates, and roller end-caps.
        let isCapLike = (renderMode == 0) && (abs(N.y) > 0.85);
        if (renderMode == 2 || input.ringIndex > 10.0 || isCapLike) {
          let scratchFreq = 112.0;
          let scratchNoise = fbm(vec3f(theta * scratchFreq, polarR * 5.0, localPos.y * 10.0));
          let scratch = abs(sin(theta * scratchFreq + scratchNoise * 1.8));
          radialBrush = smoothstep(0.38, 0.58, scratch);
        }

        // Structural plate rib valley shadow (8 radial ribs).
        if (input.ringIndex > 10.0) {
          let ribSector = abs(fract(theta * 8.0 + 0.5) - 0.5);
          let ribShadow = smoothstep(0.14, 0.0, ribSector) * smoothstep(0.45, 0.0, abs(N.y));
          creviceAO += ribShadow * 0.38;
        }

        if (mode == 1) {
          let labelBand = smoothstep(0.40, 0.44, cylUV.y) * (1.0 - smoothstep(0.56, 0.60, cylUV.y));
          let stamp = step(0.72, fract(cylUV.x * 15.0 + triMask * 0.5));
          decalMask += labelBand * stamp * 0.75;
          let meniscus = smoothstep(0.47, 0.50, cylUV.y) * (1.0 - smoothstep(0.50, 0.54, cylUV.y));
          baseColor = mix(baseColor, vec3f(0.86, 0.92, 0.97), meniscus * 0.33);
        } else if (mode == 2) {
          let canBand = smoothstep(0.32, 0.36, cylUV.y) * (1.0 - smoothstep(0.64, 0.68, cylUV.y));
          let stripe = step(0.80, fract(cylUV.x * 26.0));
          decalMask += canBand * stripe * 0.68;
        } else if (mode == 3) {
          let lens = sin(cylUV.x * 180.0) * sin(cylUV.y * 160.0);
          N = normalize(N + vec3f(0.0, lens * 0.10, 0.0));
          baseColor += vec3f(0.05, 0.08, 0.11) * (lens * 0.5 + 0.5);
        } else if (mode == 4) {
          let grid = fract(cylUV * vec2f(18.0, 10.0));
          let junction = min(step(0.92, grid.x) + step(0.92, grid.y), 1.0);
          decalMask += junction * 0.55;
          baseColor = mix(baseColor, vec3f(0.70, 0.20, 0.14), junction * 0.20);
        }

        baseColor = mix(baseColor, vec3f(0.93, 0.93, 0.90), decalMask * 0.35);
        roughness = clamp(roughness - decalMask * 0.08, 0.05, 1.0);

        let NdotV = max(dot(N, V), 0.0);

        // Edge wear: combine grazing Fresnel with physical rim proximity so edges
        // read even at a distance.
        var rimDist = 1000.0;
        if (renderMode == 2) {
          rimDist = min(abs(polarR - 2.4), min(abs(polarR - 4.1), abs(polarR - 5.8)));
        } else if (input.ringIndex > 10.0) {
          rimDist = min(abs(polarR - 6.5), abs(polarR - 0.8));
        } else if (renderMode == 1) {
          rimDist = 4.1 - polarR;
        }
        let rimWear = smoothstep(0.30, 0.0, rimDist);
        let edgeWear = pow(1.0 - NdotV, 2.0) * mat.detailParams.z + rimWear * 0.55;

        // Aged copper / brass patina: greenish oxidation concentrated in crevices
        // and on horizontal-facing copper-bearing surfaces.
        if (isCopper || input.ringIndex > 10.0 || renderMode == 2) {
          let oxide = oxidationFBM(localPos * 0.55 + vec3f(3.7, 1.2, 5.3));
          let patina = oxide * (1.0 - NdotV) * 0.65;
          baseColor = mix(baseColor, vec3f(0.20, 0.30, 0.16), patina * 0.42);
        }

        // Crevice / contact ambient occlusion.
        creviceAO += (1.0 - NdotV) * 0.15;
        creviceAO += fbm(localPos * 6.0) * 0.06;
        creviceAO = clamp(creviceAO, 0.0, 0.55);

        baseColor = mix(baseColor, mat.accentRough.rgb, edgeWear * 0.55);
        if (renderMode == 1 || renderMode == 2 || input.ringIndex > 10.0) {
          baseColor *= 1.0 - edgeWear * 0.12;
        }

        // Construct tangent/bitangent for anisotropic specular (brushed-metal).
        // Use a radial tangent for ring-like surfaces, otherwise fall back to the
        // generic view-space horizontal reference.
        let upRef = select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(N.y) > 0.99);
        let isRadialSurface = (renderMode == 2) || (input.ringIndex > 10.0) || isCapLike;
        let T = normalize(select(cross(upRef, N), radialTangent(localPos, N), isRadialSurface));
        let B = cross(N, T);

        // Anisotropic roughness (brushed along tangent direction).
        var roughX = roughness * 0.65; // Tighter along brush direction
        var roughY = roughness * 1.45; // Wider perpendicular to brush
        roughX = mix(roughX, roughX * 0.55, radialBrush * 0.65);
        roughY = mix(roughY, roughY * 1.25, radialBrush * 0.65);

        let f0 = mix(vec3f(0.04), baseColor, metallic);
        let albedo = mix(baseColor, vec3f(0.0), metallic);

        // Key light with anisotropic specular
        let L1 = normalize(lighting.key.dir);
        let H1 = normalize(V + L1);
        let NdotL1 = max(dot(N, L1), 0.0);
        let NdotH1 = max(dot(N, H1), 0.0);
        let TdotH1 = dot(T, H1);
        let BdotH1 = dot(B, H1);
        let D1 = distributionGGXAniso(NdotH1, TdotH1, BdotH1, roughX, roughY);
        let G1 = geometrySmith(NdotV, NdotL1, roughness);
        let F1 = fresnelSchlick(max(dot(H1, V), 0.0), f0);
        let specular1 = (D1 * G1 * F1) / (4.0 * NdotV * NdotL1 + 0.001);
        let kD1 = (vec3f(1.0) - F1) * (1.0 - metallic);

        // Fill light with anisotropic specular
        let L2 = normalize(lighting.fill.dir);
        let H2 = normalize(V + L2);
        let NdotL2 = max(dot(N, L2), 0.0);
        let NdotH2 = max(dot(N, H2), 0.0);
        let TdotH2 = dot(T, H2);
        let BdotH2 = dot(B, H2);
        let D2 = distributionGGXAniso(NdotH2, TdotH2, BdotH2, roughX, roughY);
        let G2 = geometrySmith(NdotV, NdotL2, roughness);
        let F2 = fresnelSchlick(max(dot(H2, V), 0.0), f0);
        let specular2 = (D2 * G2 * F2) / (4.0 * NdotV * NdotL2 + 0.001);
        let kD2 = (vec3f(1.0) - F2) * (1.0 - metallic);

        let rimFactor = pow(1.0 - NdotV, 3.0) * lighting.rim.intensity;
        let rimLight = lighting.rim.color * rimFactor;

        // Ground bounce light from below
        let Lg = normalize(lighting.ground.dir);
        let NdotLg = max(dot(N, Lg), 0.0);

        let diffuse = albedo * 3.14159265 * (
          kD1 * NdotL1 * lighting.key.color * lighting.key.intensity +
          kD2 * NdotL2 * lighting.fill.color * lighting.fill.intensity * 0.5 +
          lighting.ground.color * lighting.ground.intensity * NdotLg
        );

        let specular = (
          specular1 * lighting.key.color * lighting.key.intensity * NdotL1 +
          specular2 * lighting.fill.color * lighting.fill.intensity * NdotL2 * 0.3
        );

        // Cheap IBL approximation (environment reflection term)
        let envReflect = fresnelSchlick(NdotV, f0) * lighting.envMapStrength * 0.3;

        let ambient = albedo * lighting.ambient * vec3f(0.15, 0.18, 0.22);
        var color = ambient + diffuse + specular + rimLight + envReflect;

        // Subtle bearing-edge glow: warm copper at the rim plus a faint blue-white
        // brush discharge that only appears at high RPM / overdrive.
        let bottomGlow = max(0.0, -N.y) * input.greenEmissive * (0.35 + overdrive * 0.8);
        color += vec3f(0.95, 0.62, 0.28) * bottomGlow * 0.25;

        if (renderMode == 0 && abs(N.y) < 0.85) {
          let yEdge = 1.0 - abs(localPos.y) / (ROLLER_HEIGHT * 0.5);
          let edgeProximity = smoothstep(0.18, 0.0, yEdge);
          let brushDischarge = edgeProximity * smoothstep(0.30, 0.70, overdrive);
          color += vec3f(0.62, 0.82, 1.0) * brushDischarge * 0.18 * energy;
        }
        color += baseColor * emissive * (0.4 + energy * 0.7);
        if (isCopper) {
          let hot = mix(850.0, 3300.0, clamp(energy * 0.8 + input.greenEmissive * 0.7, 0.0, 1.0));
          color += blackbody(hot) * (0.08 + overdrive * 0.38);
        }

        // Fine charge filaments at the roller surface, not giant glowing orbs.
        let energyArc = smoothstep(0.7, 1.0, input.greenEmissive) * (0.04 + overdrive * 0.35);
        color += vec3f(0.65, 0.85, 1.0) * energyArc * NdotV;

        // Faint blue-white plasma halo on stator rings, scaling with energy/speed.
        if (renderMode == 2) {
          let statorHalo = pow(1.0 - NdotV, 2.5) * (0.03 + overdrive * 0.10) * smoothstep(0.0, 0.30, energy);
          color += vec3f(0.55, 0.78, 1.0) * statorHalo;
        }

        // Unified contact shadow / ambient-occlusion: analytic ground shadows from
        // hub + orbit rings plus a moving per-roller penumbra, blended with
        // procedural crevice AO.
        let contactShadow = unifiedContactShadow(input.worldPos, N);
        color *= contactShadow * (1.0 - creviceAO * 0.55);

        color = color * (2.51 * color + 0.03) / (color * (2.43 * color + 0.59) + 0.14);

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

        // Harmonic turbulence: high-frequency jitter gives electrified, organic motion
        let jitter1    = sin(t * 7.3  + phase * 31.4) * 0.12;
        let jitter2    = cos(t * 11.7 + phase * 17.8) * 0.08;
        let jitter3    = sin(t * 5.1  + phase * 43.2) * 0.06;
        let turbAngle  = angle  + jitter2;
        let turbRadius = radius + sin(t * 3.7 + phase * 23.5) * (radius * 0.04);
        let turbHeight = height + jitter1 + jitter3;

        return vec3f(cos(turbAngle) * turbRadius, turbHeight, sin(turbAngle) * turbRadius);
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

      fn posMhd(phase: f32, t: f32, idx: u32) -> vec3f {
        let speed = 0.7;
        let cycleT = fract(t * speed + fract(phase * 123.45));
        let zPos = 8.0 - 16.0 * cycleT;
        let isPositive = phase < 0.5;
        let chargeMultiplier = select(-1.0, 1.0, isPositive);
        let px = sin(f32(idx) * 123.45) * 0.8;
        let py = cos(f32(idx) * 0.123) * 0.8;
        var xDeflection = 0.0;
        if (zPos < 2.0) {
          let exposure = clamp((2.0 - zPos) / 4.0, 0.0, 1.0);
          xDeflection = chargeMultiplier * exposure * 4.0;
        }
        return vec3f(px + xDeflection, py, zPos);
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
        } else if (mode < 4.5) {
          newPos = posPeltier(phase, t, idx);
        } else {
          newPos = posMhd(phase, t, idx);
        }

        particles[idx] = vec4f(newPos, phase);
      }
    `;
  }

  // ============================================
  // SEG roller GPU compute shader
  // Computes all 36 roller positions, quaternions and colors on the GPU
  // so the CPU only needs to calculate 36 angles for coil-energy lookups.
  // ============================================
  get segRollerComputeShader() {
    return /* wgsl */ `
      struct RollerInstance {
        position:     vec3f,
        ringIndex:    f32,
        rotation:     vec4f,
        copperColor:  vec3f,
        greenEmissive: f32,
      }

      struct RollerUniforms {
        time:      f32,
        speedMult: f32,
        pad0:      f32,
        pad1:      f32,
      }

      @group(0) @binding(0) var<storage, read_write> rollers: array<RollerInstance>;
      @group(0) @binding(1) var<uniform>             uniforms: RollerUniforms;

      const PI: f32 = 3.14159265359;

      // Pole-band colours (copper / oxide / neodymium / brass)
      const POLE_COLORS = array<vec3f, 4>(
        vec3f(0.85, 0.48, 0.22),
        vec3f(0.55, 0.30, 0.15),
        vec3f(0.72, 0.74, 0.76),
        vec3f(0.78, 0.58, 0.22),
      );

      // Deterministic per-roller hashes.
      fn hash1f(p: f32) -> f32 {
        return fract(sin(p * 127.1) * 43758.5453);
      }
      fn hash2f(p: vec2f) -> vec2f {
        return fract(sin(vec2f(dot(p, vec2f(127.1, 311.7)), dot(p, vec2f(269.5, 183.3)))) * 43758.5453);
      }

      @compute @workgroup_size(64)
      fn main(@builtin(global_invocation_id) gid: vec3u) {
        let idx = gid.x;
        if (idx >= 36u) { return; }

        // Map flat roller index to ring + local index
        // Ring 0: idx  0-7  (8  rollers, r=2.5, speed=2.0)
        // Ring 1: idx  8-19 (12 rollers, r=4.0, speed=1.0)
        // Ring 2: idx 20-35 (16 rollers, r=5.5, speed=0.5)
        var ringIdx: u32;
        var localI:  u32;
        if (idx < 8u) {
          ringIdx = 0u;  localI = idx;
        } else if (idx < 20u) {
          ringIdx = 1u;  localI = idx - 8u;
        } else {
          ringIdx = 2u;  localI = idx - 20u;
        }

        let counts = array<u32, 3>(8u, 12u, 16u);
        let radii  = array<f32, 3>(2.5, 4.0, 5.5);
        let scales = array<f32, 3>(0.6, 0.8, 1.0);
        let speeds = array<f32, 3>(2.0, 1.0, 0.5);

        let count  = counts[ringIdx];
        let radius = radii[ringIdx];
        let scale  = scales[ringIdx];
        let speed  = speeds[ringIdx];

        // uniforms.time is already the speed-scaled visualizer time
        let t = uniforms.time;

        // Per-ring startup ramp (mirrors CPU formula)
        let startupRamp = min(t * (0.25 + f32(ringIdx) * 0.1), 1.0);

        // Unique per-roller seed.
        let rollerHash = hash1f(f32(idx) * 0.731 + f32(ringIdx) * 1.93);
        let rollerHash2 = hash2f(vec2f(f32(idx), f32(ringIdx) * 3.7));

        // Per-roller speed jitter: fast component + slow wander + per-ring drift.
        let jitterSeed = f32(idx) * 127.3 + f32(ringIdx) * 53.7;
        let speedJitter = 1.0
          + 0.03 * sin(t * 1.3 + sin(jitterSeed) * 12.7)
          + 0.02 * sin(t * 0.47 + rollerHash * 20.0)
          + 0.01 * sin(t * 0.11 + f32(ringIdx) * 7.0);

        // Each ring has a distinct fixed phase so the three rings feel coupled
        // but not identically clockwork.
        let ringPhaseOffsets = array<f32, 3>(0.0, 0.31, 0.67);
        let baseAngle = (f32(localI) / f32(count)) * PI * 2.0 + ringPhaseOffsets[ringIdx];

        // Uncogged orbital angle used to compute detent modulation.
        let uncoggedAngle = baseAngle + t * 0.5 * speed * speedJitter * startupRamp;

        // Magnetic detent / cogging: occasional micro speed variation at fixed
        // angular positions, stronger as speed increases.
        let cogCount = 6.0 + f32(ringIdx) * 3.0 + rollerHash * 4.0;
        let cogAmp = 0.018 * smoothstep(0.5, 2.0, uniforms.speedMult);
        let cogTimeScale = 1.0 - cogAmp * (0.5 + 0.5 * cos(uncoggedAngle * cogCount * 2.0));

        let angle = baseAngle + t * 0.5 * speed * speedJitter * cogTimeScale * startupRamp;

        // Very low-amplitude radial compliance and vertical runout, as if the
        // rollers ride a real bearing race with slight eccentricity.
        let radialFreq = 0.6 + rollerHash * 0.5;
        let radialAmp = 0.018 * (1.0 + 0.25 * uniforms.speedMult);
        let radialOffset = sin(t * radialFreq + rollerHash * 4.0) * radialAmp;

        let bobFreq = 0.9 + rollerHash * 0.4;
        let bobAmp = 0.012 * (1.0 + 0.35 * uniforms.speedMult);
        let yBob = sin(t * bobFreq + rollerHash * 6.28) * bobAmp;

        let rEff = radius + radialOffset;
        let x = cos(angle) * rEff;
        let z = sin(angle) * rEff;
        let y = yBob;

        // Gear-ratio self-rotation angle.
        let gearRatio    = radius / scale;
        let selfRotAngle = angle * gearRatio * 0.5;

        // Per-roller micro tilt / coning: the spin axis wobbles slightly away
        // from the perfect tangent, varying with orbital angle and time.
        let up = vec3f(0.0, 1.0, 0.0);
        let radialDir = vec3f(cos(angle), 0.0, sin(angle));
        let tangent = normalize(cross(up, radialDir));

        let coneSpeed = 0.12 + rollerHash * 0.12;
        let coneAngleA = angle * 2.0 + t * coneSpeed + rollerHash * 6.28;
        let coneAngleB = angle * 3.0 - t * coneSpeed * 0.7 + rollerHash2.y * 6.28;
        let coneAmp = 0.035 * smoothstep(0.5, 3.0, uniforms.speedMult);
        let radialTilt = sin(coneAngleA) * coneAmp;
        let vertTilt = cos(coneAngleB) * coneAmp * 0.6;

        let tiltedAxis = normalize(tangent + radialDir * radialTilt + up * vertTilt);
        let halfAngle = selfRotAngle / 2.0;

        // Emissive boost proportional to speed (neodymium rollers glow brighter).
        // Restrained baseline: no green underglow until high RPM, then a faint
        // bearing-edge glow rather than a neon floor wash.
        let colorIdx  = (localI + ringIdx * 3u) % 4u;
        let baseEmit  = select(0.0, 0.15, colorIdx == 2u);
        let speedFactor = smoothstep(2.0, 7.0, uniforms.speedMult);
        // Clamp emissive to avoid overflow at very high speeds
        let emissive  = min(baseEmit * speedFactor, 0.35);

        var r: RollerInstance;
        r.position     = vec3f(x, y, z);
        r.ringIndex    = f32(ringIdx);
        r.rotation     = vec4f(
          tiltedAxis.x * sin(halfAngle),
          tiltedAxis.y * sin(halfAngle),
          tiltedAxis.z * sin(halfAngle),
          cos(halfAngle)
        );
        r.copperColor  = POLE_COLORS[colorIdx];
        r.greenEmissive = emissive;

        rollers[idx] = r;
      }
    `;
  }

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
        // Oversized triangle that covers the entire clip-space screen;
        // z=0.9999 places it just behind all scene geometry at the far plane
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

        // Subtle time-based shimmer (keeps @binding(0) live for auto layout)
        color += vec3f(0.02, 0.04, 0.08) * sin(uniforms.time * 0.25 + input.uv.x * 6.0) * 0.04;

        return vec4f(color, 1.0);
      }
    `;
  }

  // Grid vertex shader
  get gridVertShader() {
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
  
  // Grid fragment shader with distance-based fade
  get gridFragShader() {
    return /* wgsl */ `
      struct FragmentInput {
        @location(0) uv: vec2f
      }

      struct Uniforms {
        viewProj: mat4x4f,
        time: f32,
        cameraPos: vec3f
      }

      @binding(0) @group(0) var<uniform> uniforms: Uniforms;

      @fragment
      fn main(input: FragmentInput) -> @location(0) vec4f {
        let gridSize = 20.0;
        let worldPos = input.uv * gridSize - gridSize * 0.5;
        // Tie uniforms into the layout (prevents binding strip + subtle pulse)
        let pulse = 1.0 + sin(uniforms.time * 0.5) * 0.02;

        let lineWidth = 0.05;
        let gridX = abs(fract(worldPos.x) - 0.5);
        let gridY = abs(fract(worldPos.y) - 0.5);

        let isLine = clamp(step(gridX, lineWidth) + step(gridY, lineWidth), 0.0, 1.0);

        let lineColor = vec3f(0.12, 0.22, 0.38);

        // Distance fade: lines vanish at the edges and near the SEG centre
        let distFromCenter = length(worldPos);
        let distFade = 1.0 - smoothstep(4.5, 10.5, distFromCenter);
        let nearFade  = smoothstep(0.8, 2.5, distFromCenter);
        let alpha = 0.40 * distFade * nearFade * isLine * pulse;

        return vec4f(lineColor, alpha);
      }
    `;
  }

  // ============================================
  // Bloom post-processing shaders
  // ============================================

  // Shared fullscreen-triangle vertex shader for bloom passes
  get bloomVertShader() {
    return /* wgsl */ `
      struct VertexOutput {
        @builtin(position) position: vec4f,
        @location(0) uv: vec2f
      }

      @vertex
      fn main(@builtin(vertex_index) vi: u32) -> VertexOutput {
        var pos = array<vec2f, 3>(
          vec2f(-1.0, -1.0),
          vec2f( 3.0, -1.0),
          vec2f(-1.0,  3.0)
        );
        var o: VertexOutput;
        o.position = vec4f(pos[vi], 0.0, 1.0);
        o.uv = pos[vi] * 0.5 + 0.5;
        return o;
      }
    `;
  }

  // Pass 1: extract bright areas from scene with soft-knee thresholding
  get bloomExtractShader() {
    return /* wgsl */ `
      struct BloomParams {
        texelSizeX: f32,
        texelSizeY: f32,
        threshold:  f32,
        knee:       f32,
        strength:   f32,
        radius:     f32,
        power:      f32,
        grain:      f32,
        aberration: f32,
        vignette:   f32,
        reserved0:  f32,
        reserved1:  f32,
      }

      @group(0) @binding(0) var sceneTex    : texture_2d<f32>;
      @group(0) @binding(1) var bloomSampler: sampler;
      @group(0) @binding(2) var<uniform> params: BloomParams;

      struct FragInput {
        @location(0) uv: vec2f,
      }

      fn luminance(c: vec3f) -> f32 {
        return dot(c, vec3f(0.2126, 0.7152, 0.0722));
      }

      fn extractBright(c: vec3f, threshold: f32, knee: f32) -> vec3f {
        let lum  = luminance(c);
        let w    = clamp((lum - threshold + knee) / max(knee, 0.001), 0.0, 1.0);
        return c * w;
      }

      @fragment
      fn main(input: FragInput) -> @location(0) vec4f {
        let scene = textureSample(sceneTex, bloomSampler, input.uv).rgb;
        return vec4f(extractBright(scene, params.threshold, params.knee), 1.0);
      }
    `;
  }

  // Pass 2/3: separable blur (horizontal then vertical)
  get bloomBlurShader() {
    return /* wgsl */ `
      struct BloomParams {
        texelSizeX: f32,
        texelSizeY: f32,
        threshold:  f32,
        knee:       f32,
        strength:   f32,
        radius:     f32,
        power:      f32,
        grain:      f32,
        aberration: f32,
        vignette:   f32,
        reserved0:  f32,
        reserved1:  f32,
      }

      @group(0) @binding(0) var bloomInput : texture_2d<f32>;
      @group(0) @binding(1) var bloomSampler: sampler;
      @group(0) @binding(2) var<uniform> params: BloomParams;
      @group(0) @binding(3) var<uniform> direction: vec2f;

      struct FragInput {
        @location(0) uv: vec2f,
      }

      @fragment
      fn main(input: FragInput) -> @location(0) vec4f {
        let radius = max(params.radius, 0.25);
        let axis = direction * vec2f(params.texelSizeX, params.texelSizeY) * radius;

        let weights = array<f32, 5>(0.227027, 0.1945946, 0.1216216, 0.054054, 0.016216);
        var blur = textureSample(bloomInput, bloomSampler, input.uv).rgb * weights[0];
        for (var i = 1; i < 5; i++) {
          let o = axis * f32(i);
          blur += textureSample(bloomInput, bloomSampler, input.uv + o).rgb * weights[i];
          blur += textureSample(bloomInput, bloomSampler, input.uv - o).rgb * weights[i];
        }
        return vec4f(blur, 1.0);
      }
    `;
  }

  // Pass 4: composite scene + bloom, ACES tonemap + charged post FX
  get bloomCompositeShader() {
    return /* wgsl */ `
      struct BloomParams {
        texelSizeX: f32,
        texelSizeY: f32,
        threshold:  f32,
        knee:       f32,
        strength:   f32,
        radius:     f32,
        power:      f32,
        grain:      f32,
        aberration: f32,
        vignette:   f32,
        reserved0:  f32,
        reserved1:  f32,
      }

      @group(0) @binding(0) var sceneTexC  : texture_2d<f32>;
      @group(0) @binding(1) var bloomTexC  : texture_2d<f32>;
      @group(0) @binding(2) var compSampler: sampler;
      @group(0) @binding(3) var<uniform> params: BloomParams;
      @group(0) @binding(4) var depthTexC: texture_depth_2d;

      struct FragInput {
        @location(0) uv: vec2f,
      }

      fn acesTonemap(x: vec3f) -> vec3f {
        let a = 2.51; let b = 0.03; let c = 2.43; let d = 0.59; let e = 0.14;
        return clamp((x * (a * x + b)) / (x * (c * x + d) + e), vec3f(0.0), vec3f(1.0));
      }

      fn hash21(p: vec2f) -> f32 {
        let h = dot(p, vec2f(127.1, 311.7));
        return fract(sin(h) * 43758.5453123);
      }

      fn contactShadow(uv: vec2f) -> f32 {
        let texDim = textureDimensions(depthTexC, 0);
        let coord = vec2i(clamp(uv * vec2f(texDim), vec2f(0.0), vec2f(texDim) - vec2f(1.0)));
        let tx = vec2i(max(i32(params.radius * 1.2), 1), 0);
        let ty = vec2i(0, max(i32(params.radius * 1.2), 1));
        let d0 = textureLoad(depthTexC, coord, 0);
        let dx1 = textureLoad(depthTexC, clamp(coord + tx, vec2i(0), vec2i(texDim) - vec2i(1)), 0);
        let dx2 = textureLoad(depthTexC, clamp(coord - tx, vec2i(0), vec2i(texDim) - vec2i(1)), 0);
        let dy1 = textureLoad(depthTexC, clamp(coord + ty, vec2i(0), vec2i(texDim) - vec2i(1)), 0);
        let dy2 = textureLoad(depthTexC, clamp(coord - ty, vec2i(0), vec2i(texDim) - vec2i(1)), 0);

        let grad = abs(d0 - dx1) + abs(d0 - dx2) + abs(d0 - dy1) + abs(d0 - dy2);
        let contact = smoothstep(0.008, 0.06, grad) * (1.0 - smoothstep(0.94, 0.999, d0));
        return clamp(contact, 0.0, 1.0);
      }

      @fragment
      fn main(input: FragInput) -> @location(0) vec4f {
        let center = input.uv - vec2f(0.5);
        let radial = length(center);
        let aberr = params.aberration * (0.4 + params.power * 0.6);
        let aberrOffset = center * aberr * params.texelSizeX * 45.0;
        let sceneR = textureSample(sceneTexC, compSampler, input.uv + aberrOffset).r;
        let sceneG = textureSample(sceneTexC, compSampler, input.uv).g;
        let sceneB = textureSample(sceneTexC, compSampler, input.uv - aberrOffset).b;
        let scene = vec3f(sceneR, sceneG, sceneB);
        let bloom = textureSample(bloomTexC, compSampler, input.uv).rgb;

        var combined = scene + bloom * params.strength;
        let shadow = contactShadow(input.uv);
        combined *= (1.0 - shadow * (0.20 + params.power * 0.18));
        let tm = acesTonemap(combined);

        let grain = (hash21(input.uv * vec2f(1920.0, 1080.0) + vec2f(params.power * 13.7, params.power * 29.3)) - 0.5) * params.grain;
        let vCoord = input.uv * 2.0 - 1.0;
        let vigDist = dot(vCoord * vec2f(0.48, 0.58), vCoord * vec2f(0.48, 0.58));
        let vignette = 1.0 - smoothstep(0.52, 1.05, vigDist);
        let pulse = 1.0 + params.vignette * params.power * 0.4 * (1.0 - radial);
        let graded = (tm + vec3f(grain)) * mix(0.24, 1.0, vignette * pulse);
        return vec4f(clamp(graded, vec3f(0.0), vec3f(1.0)), 1.0);
      }
    `;
  }
}
