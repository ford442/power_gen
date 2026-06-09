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

      const PI: f32 = 3.14159265;
      const MATERIAL_COUNT: u32 = 13u;

      @binding(0) @group(0) var<uniform> uniforms: Uniforms;
      @binding(1) @group(0) var<uniform> device: DeviceUniforms;
      @binding(3) @group(0) var<uniform> material: MaterialUniforms;
      @binding(5) @group(0) var<storage, read> materialTable: array<MaterialEntry>;

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

      fn getMaterialId(mode: i32, renderMode: i32, ringIndex: f32) -> u32 {
        if (mode == 1) { return 8u; }   // Heron vessel
        if (mode == 2) { return 10u; }  // Kelvin cans
        if (mode == 3) { return 7u; }   // Solar cell body
        if (mode == 4) { return 9u; }   // Peltier ceramic
        if (mode >= 5) { return 1u; }   // MHD steel
        if (renderMode == 1) { return 1u; }  // SEG base
        if (renderMode == 2) { return 2u; }  // SEG stator
        if (renderMode == 3) { return 0u; }  // Wiring copper
        if (ringIndex < -0.5) { return 1u; } // Shaft
        if (ringIndex > 10.0) { return 2u; } // Brass ring
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
        let materialId = getMaterialId(mode, renderMode, input.ringIndex);
        let mat = getMaterial(materialId);
        let devicePos = vec3f(device.posX, device.posY, device.posZ);
        let localPos = input.worldPos - devicePos;
        let cylUV = cylindricalUV(localPos);

        var baseColor = mat.baseMetal.rgb;
        var metallic = mat.baseMetal.a;
        var roughness = clamp(mat.accentRough.a, 0.05, 1.0);

        if (mode == 0 && materialId == 0u) {
          baseColor = mix(baseColor, input.copperColor, 0.55);
          let rollerTemp = mix(820.0, 3200.0, clamp(energy * 0.75 + input.greenEmissive * 0.9, 0.0, 1.0));
          baseColor = mix(baseColor, baseColor + blackbody(rollerTemp) * 0.45, energy);
        }

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
        let L1 = normalize(vec3f(1.0, 1.0, 1.0));
        let H1 = normalize(V + L1);
        let NdotL1 = max(dot(detailN, L1), 0.0);
        let NdotH1 = max(dot(detailN, H1), 0.0);
        let D1 = distributionGGX(NdotH1, roughness);
        let G1 = geometrySmith(NdotV, NdotL1, roughness);
        let F1 = fresnelSchlick(max(dot(H1, V), 0.0), f0);
        let specular1 = (D1 * G1 * F1) / (4.0 * NdotV * NdotL1 + 0.001);
        let kD1 = (vec3f(1.0) - F1) * (1.0 - metallic);

        // Fill light (softer, opposite side)
        let L2 = normalize(vec3f(-0.5, 0.3, -0.5));
        let H2 = normalize(V + L2);
        let NdotL2 = max(dot(detailN, L2), 0.0);
        let NdotH2 = max(dot(detailN, H2), 0.0);
        let D2 = distributionGGX(NdotH2, roughness);
        let G2 = geometrySmith(NdotV, NdotL2, roughness);
        let F2 = fresnelSchlick(max(dot(H2, V), 0.0), f0);
        let specular2 = (D2 * G2 * F2) / (4.0 * NdotV * NdotL2 + 0.001);
        let kD2 = (vec3f(1.0) - F2) * (1.0 - metallic);

        // Rim light
        let rimFactor = pow(1.0 - NdotV, 3.0) * (0.6 + overdrive * 0.5);
        let rimLight = vec3f(0.4, 0.5, 0.6) * rimFactor;

        // Combine
        let diffuse = albedo * PI * (
          kD1 * NdotL1 * vec3f(1.0, 0.95, 0.9) * 1.2 +
          kD2 * NdotL2 * vec3f(0.6, 0.7, 0.9) * 0.4
        );

        let specular = (
          specular1 * vec3f(1.0, 0.95, 0.9) * 1.2 * NdotL1 +
          specular2 * vec3f(0.6, 0.7, 0.9) * 0.4 * NdotL2
        );

        let ambient = albedo * 0.3 * vec3f(0.15, 0.18, 0.22);
        var color = ambient + diffuse + specular + rimLight;
        
        // GREEN EMISSIVE GLOW on bottom half of roller (LED underglow effect)
        let bottomGlow = max(0.0, -detailN.y) * input.greenEmissive * (1.8 + overdrive * 2.8);
        let greenGlow = vec3f(0.0, 1.2, 0.6) * bottomGlow;
        let plasmaRim = vec3f(0.25, 1.0, 0.65) * pow(1.0 - NdotV, 4.0) * (0.25 + overdrive * 1.2);
        
        // Add material emission
        color = color + material.glowColor * material.emission * (0.2 + energy * 0.8);
        
        // Add the green LED underglow
        color = color + greenGlow + plasmaRim;

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

      fn modePathPos(mode: f32, phase: f32, t: f32) -> vec3f {
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
        }
        let z = (phase * 2.0 - 1.0) * 3.0;
        let y = sin(t * 2.0 + phase * 11.0) * 0.8;
        return vec3f(0.6 * sin(t * 0.9 + phase * 8.0), y, z);
      }

      fn velocityForParticle(pos: vec3f, mode: f32, phase: f32, effectType: f32, t: f32) -> vec3f {
        if (effectType < 0.5) {
          let dt = 0.015;
          let p1 = modePathPos(mode, phase, t + dt);
          let p0 = modePathPos(mode, phase, t - dt);
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
        let vel = velocityForParticle(pos, mode, phase, effectType, uniforms.time);
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
        if (effectType > 0.5 && effectType < 1.5) {
          stretch = 2.0 + speed * 1.5;
          size *= 0.75;
        } else if (effectType > 1.5 && effectType < 2.5) {
          stretch = 1.2;
          size *= 2.6;
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
          // Corona: broad soft additive sheath.
          let shell = exp(-dist * dist * 2.6);
          let core = exp(-dist * dist * 10.0) * 0.35;
          alpha = (shell + core) * (0.45 + 0.55 * (0.5 + 0.5 * sin(t * 9.0 + phase * 11.0))) * (0.75 + overdrive);
          color = mix(vec3f(0.15, 0.7, 1.0), vec3f(0.65, 0.95, 1.0), input.life);
        } else if (effectType > 0.5 && effectType < 1.5) {
          // Spark bursts: sharper, elongated, dangerous look.
          let line = exp(-abs(uv.x) * 8.0) * exp(-abs(uv.y) * 2.2);
          let flare = exp(-dist * dist * 30.0);
          alpha = (line * 0.9 + flare * 0.7) * (1.1 + input.speed * 0.08 + overdrive * 1.1);
          color = mix(vec3f(0.6, 0.85, 1.0), vec3f(1.0, 0.95, 0.65), clamp(input.life * 1.2, 0.0, 1.0));
          if (mode < 2.5 || mode > 3.5) {
            color = mix(color, vec3f(0.7, 0.2, 1.0), 0.25);
          }
        } else {
          // Bright core + soft halo for additive blending
          let core = exp(-dist * dist * 22.0);
          let halo = exp(-dist * dist * 6.0) * 0.35;
          alpha = (core + halo) * 2.2;
        
          if (mode < 0.5) {
            // SEG: cyan / electric-blue magnetic field lines
            let pulse = 0.6 + 0.4 * sin(t * 5.0 + phase * 6.28);
            color = mix(vec3f(0.0, 0.65, 1.0), vec3f(0.3, 1.0, 0.85), pulse);
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
      
      // Scalar fields keep the struct tightly packed at 32 bytes, matching the
      // CPU-written layout (position, velocity, life, strength = 8 x f32).
      // vec3f members would force 16-byte-aligned offsets in storage address space.
      struct FieldParticle {
        posX:     f32,
        posY:     f32,
        posZ:     f32,
        velX:     f32,
        velY:     f32,
        velZ:     f32,
        life:     f32,
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

  // ── RK4 Flux Line Tracer compute shader ──────────────────────────────────
  // Returns the full flux-lines.wgsl content.  The pipeline uses the
  // `traceBidirectional` entry point (1 thread per line, 2 workgroups).
  get fluxLineTracerShader() {
    return fluxLinesWgsl;
  }

  // ── RK4 Flux Segment billboard vertex shader ──────────────────────────────
  // Reads FluxSegment data from storage buffer @binding(2) and expands each
  // segment to a screen-space quad (triangle-strip, 4 verts/instance).
  // Width is |B|-driven; age drives a crawling pulse.
  get fluxSegmentVertShader() {
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
      }

      @vertex
      fn main(@builtin(vertex_index) vertIdx: u32,
              @builtin(instance_index) instIdx: u32) -> VertexOutput {
        let seg = segments[instIdx];
        let devicePos = vec3f(device.posX, device.posY, device.posZ);
        let startPos = vec3f(seg.startX, seg.startY, seg.startZ);
        let endPos   = vec3f(seg.endX,   seg.endY,   seg.endZ);

        // Transform both endpoints to clip space
        let sc = uniforms.viewProj * vec4f(startPos + devicePos, 1.0);
        let ec = uniforms.viewProj * vec4f(endPos   + devicePos, 1.0);

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

  // ── RK4 Flux Segment fragment shader ─────────────────────────────────────
  // |B|-driven color ramp: deep blue → cyan → light-blue → white-hot
  get fluxSegmentFragShader() {
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
        let coilActive = input.activeIntensity;
        let energy = clamp(device.timeScale, 0.0, 1.0);
        let flicker = 0.72 + 0.28 * sin(uniforms.time * 5.4 + input.coilIndex * 0.78);
        let travel = 0.5 + 0.5 * sin(uniforms.time * 9.8 - input.coilIndex * 0.55 + input.worldPos.y * 6.0);
        let verticalFalloff = exp(-abs(input.worldPos.y) * 0.35);
        let drive = coilActive * (0.7 + energy * 1.3) * flicker * (0.55 + 0.45 * travel) * verticalFalloff;
        let orangeGlow = vec3f(1.0, 0.55, 0.0) * drive * 4.2;
        let whiteCore = vec3f(1.0, 0.90, 0.7) * drive * 1.6;
        color = color + orangeGlow + whiteCore;

        // Per-coil time-based shimmer using traveling wave + low-frequency wobble.
        let shimmer = 1.0 + (0.08 + energy * 0.12) * sin(uniforms.time * 2.4 + input.coilIndex * 0.35);
        color = color * (1.0 + (shimmer - 1.0) * coilActive);

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
      @binding(1) @group(0) var<uniform> device: DeviceUniforms;
      @binding(3) @group(0) var<uniform> material: MaterialUniforms;
      @binding(5) @group(0) var<uniform> lighting: LightingConfig;
      @binding(6) @group(0) var<storage, read> materialTable: array<MaterialEntry>;

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

      fn sharedMaterialId(mode: i32, renderMode: i32, ringIndex: f32, bandIndex: f32) -> u32 {
        if (mode == 1) { return 8u; }
        if (mode == 2) { return 10u; }
        if (mode == 3) { return 7u; }
        if (mode == 4) { return 9u; }
        if (mode >= 5) { return 1u; }
        if (renderMode == 1) { return 1u; }
        if (renderMode == 2) { return 2u; }
        if (renderMode == 3) { return 0u; }
        if (ringIndex < -0.5) { return 1u; }
        if (ringIndex > 10.0) { return 2u; }
        if (bandIndex >= 0.0 && bandIndex < 6.0 && (u32(bandIndex) % 4u) == 2u) { return 4u; }
        return 0u;
      }

      @fragment
      fn main(input: FragmentInput) -> @location(0) vec4f {
        let mode = i32(round(device.ringIndex));
        let renderMode = i32(round(device.renderMode));
        let energy = clamp(device.timeScale, 0.0, 1.0);
        let overdrive = pow(energy, 1.8);
        let mat = materialTable[sharedMaterialId(mode, renderMode, input.ringIndex, input.bandIndex)];
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

        if (input.bandIndex >= 0.0 && input.bandIndex < 6.0) {
          baseColor = poleBandColor(input.bandIndex, input.copperColor);
          let isNeodymium = (u32(input.bandIndex) % 4u) == 2u;
          isCopper = (u32(input.bandIndex) % 4u) == 0u || (u32(input.bandIndex) % 4u) == 1u;
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
          isCopper = true;
        }

        // Blend with shared material table so all devices use consistent physical presets.
        baseColor = mix(baseColor, mat.baseMetal.rgb, 0.65);
        metallic = mix(metallic, mat.baseMetal.a, 0.65);
        roughness = mix(roughness, mat.accentRough.a, 0.65);

        let brushed = fbm(localPos * (mat.detailParams.x * 0.35));
        let oxidation = fbm(localPos * (mat.detailParams.x * 0.75 + 9.0));
        baseColor = mix(baseColor, mat.accentRough.rgb, oxidation * mat.detailParams.y);
        baseColor *= 0.90 + brushed * 0.15;
        roughness = clamp(roughness + brushed * 0.08 + oxidation * 0.08, 0.05, 1.0);

        var decalMask = 0.0;
        let triMask = triplanarMask(localPos, N, 0.85);

        if (renderMode == 1 || renderMode == 2) {
          let theta = atan2(localPos.z, localPos.x) / (2.0 * 3.14159265) + 0.5;
          let rivetSector = abs(fract(theta * 24.0) - 0.5);
          let rivetRadial = abs(length(localPos.xz) - 3.2);
          let rivets = smoothstep(0.08, 0.01, rivetSector) * smoothstep(0.12, 0.0, rivetRadial);
          decalMask += rivets * 0.8;
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
        let edgeWear = pow(1.0 - NdotV, 2.0) * mat.detailParams.z;
        baseColor = mix(baseColor, mat.accentRough.rgb, edgeWear * 0.62);
        if (renderMode == 1 || renderMode == 2) {
          baseColor *= 1.0 - edgeWear * 0.1;
        }

        // Construct tangent/bitangent for anisotropic specular (brushed-metal)
        let upRef = select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(N.y) > 0.99);
        let T = normalize(cross(upRef, N));
        let B = cross(N, T);

        // Anisotropic roughness (brushed along tangent direction)
        let roughX = roughness * 0.7; // Tighter along brush direction
        let roughY = roughness * 1.3; // Wider perpendicular to brush

        let f0 = mix(vec3f(0.04), baseColor, metallic);
        let albedo = mix(baseColor, vec3f(0.0), metallic);

        // Key light with anisotropic specular
        let L1 = normalize(-lighting.keyDir);
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
        let L2 = normalize(-lighting.fillDir);
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

        // Cheap IBL approximation (environment reflection term)
        let envReflect = fresnelSchlick(NdotV, f0) * lighting.envMapStrength * 0.3;

        let ambient = albedo * lighting.ambient * vec3f(0.15, 0.18, 0.22);
        var color = ambient + diffuse + specular + rimLight + envReflect;

        let bottomGlow = max(0.0, -N.y) * input.greenEmissive * (1.5 + overdrive * 2.5);
        color += vec3f(0.0, 1.0, 0.5) * bottomGlow;
        color += baseColor * emissive * (0.4 + energy * 0.7);
        if (isCopper) {
          let hot = mix(850.0, 3300.0, clamp(energy * 0.8 + input.greenEmissive * 0.7, 0.0, 1.0));
          color += blackbody(hot) * (0.12 + overdrive * 0.55);
        }

        let energyArc = smoothstep(0.7, 1.0, input.greenEmissive) * (0.25 + overdrive * 0.8);
        color += vec3f(0.3, 0.8, 1.0) * energyArc * NdotV;

        // Contact shadow / ambient-occlusion hint: darken surfaces near Y = 0
        let contactAO = 0.55 + 0.45 * smoothstep(0.0, 2.2, abs(input.worldPos.y));
        color *= contactAO;

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

        // Per-roller speed jitter (same hash as CPU)
        let jitterSeed  = f32(idx) * 127.3 + f32(ringIdx) * 53.7;
        let speedJitter = 1.0 + 0.04 * sin(t * 1.3 + sin(jitterSeed) * 12.7);

        let baseAngle = (f32(localI) / f32(count)) * PI * 2.0;
        let angle = baseAngle
                  + t * 0.5 * speed * speedJitter * startupRamp
                  + f32(ringIdx) * 0.22;

        let x = cos(angle) * radius;
        let z = sin(angle) * radius;

        // Gear-ratio self-rotation quaternion (mirrors CPU)
        let gearRatio    = radius / scale;
        let selfRotAngle = angle * gearRatio * 0.5;
        let tangentAngle = angle + PI / 2.0;
        let rollAxisX    = cos(tangentAngle);
        let rollAxisZ    = sin(tangentAngle);
        let halfAngle    = selfRotAngle / 2.0;

        // Emissive boost proportional to speed (neodymium rollers glow brighter)
        let colorIdx  = (localI + ringIdx * 3u) % 4u;
        let baseEmit  = select(0.0, 0.3, colorIdx == 2u);
        // Clamp emissive to avoid overflow at very high speeds
        let emissive  = min(baseEmit * max(1.0, uniforms.speedMult * 0.5), 1.0);

        var r: RollerInstance;
        r.position     = vec3f(x, 0.0, z);
        r.ringIndex    = f32(ringIdx);
        r.rotation     = vec4f(
          rollAxisX * sin(halfAngle),
          0.0,
          rollAxisZ * sin(halfAngle),
          cos(halfAngle)
        );
        r.copperColor  = POLE_COLORS[colorIdx];
        r.greenEmissive = emissive;

        rollers[idx] = r;
      }
    `;
  }

  // ============================================
  // SEG field-line GPU advect compute shader
  // Replaces the 1200-particle CPU loop (sin/cos/random per frame) with a
  // single GPU dispatch.  Scalar fields keep the struct tightly packed at
  // 32 bytes to match the CPU-written FieldParticle layout — vec3f members
  // would require 16-byte-aligned offsets in storage address space.
  // ============================================
  get segFieldAdvectShader() {
    return /* wgsl */ `
      struct FieldParticle {
        posX:     f32,
        posY:     f32,
        posZ:     f32,
        velX:     f32,
        velY:     f32,
        velZ:     f32,
        life:     f32,
        strength: f32,
      }

      struct FieldUniforms {
        time:          f32,
        speedMult:     f32,
        particleCount: u32,
        pad:           f32,
      }

      @group(0) @binding(0) var<storage, read_write> particles: array<FieldParticle>;
      @group(0) @binding(1) var<uniform>             uniforms:  FieldUniforms;

      const PI: f32 = 3.14159265359;

      @compute @workgroup_size(64)
      fn main(@builtin(global_invocation_id) gid: vec3u) {
        let i = gid.x;
        if (i >= uniforms.particleCount) { return; }

        // uniforms.time is already the speed-scaled visualizer time
        let t      = uniforms.time;
        let sm     = uniforms.speedMult;
        let ringIdx = i % 3u;
        let r      = array<f32, 3>(2.5, 4.0, 5.5)[ringIdx];

        // Advect along the circular magnetic flux ring (mirrors CPU formula)
        let angle       = (f32(i) / f32(uniforms.particleCount)) * PI * 20.0
                        + t * (0.5 + f32(ringIdx) * 0.3);
        let heightOffset = sin(t * 0.5 + f32(i) * 0.1) * 0.8;

        let px = cos(angle) * r;
        let pz = sin(angle) * r;
        let py = heightOffset;

        // Velocity tangent to the ring
        let speed = 1.0 + f32(ringIdx) * 0.5;
        let vx = -sin(angle) * speed;
        let vy =  cos(t * 2.0 + f32(i) * 0.05) * 0.1;
        let vz =  cos(angle)  * speed;

        // Life and strength boosted at higher speeds for denser/brighter field lines
        let lifePulse = sin(t * 2.0 + f32(i) * 0.5) * 0.5 + 0.5;
        let life      = clamp(lifePulse * min(sm * 0.4 + 0.6, 1.0), 0.0, 1.0);
        let strength  = clamp(0.3 + 0.7 * sin(angle * 3.0 + t), 0.0, 1.0)
                      * min(1.0, 0.5 + sm * 0.15);

        var p: FieldParticle;
        p.posX = px;
        p.posY = py;
        p.posZ = pz;
        p.velX = vx;
        p.velY = vy;
        p.velZ = vz;
        p.life     = life;
        p.strength = strength;

        particles[i] = p;
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
