export function getSegEnhancedVertShader() {
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

export function getSegEnhancedFragShader() {
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

