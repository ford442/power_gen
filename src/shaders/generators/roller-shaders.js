export function getRollerVertShader() {
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

export function getRollerFragShader() {
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

