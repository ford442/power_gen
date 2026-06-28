import {
  PBR_SURFACE_WGSL,
  PBR_BRDF_WGSL,
  PBR_LIGHTING_STRUCT_WGSL,
  PBR_EVAL_WGSL
} from './pbr-wgsl-chunks.js';

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

      struct SEGLayoutRing {
        count: f32,
        fullCount: f32,
        orbitRadius: f32,
        rollerRadius: f32,
        rollerHeight: f32,
        speed: f32,
        statorInner: f32,
        statorOuter: f32,
        rollerOffset: f32,
        _pad0: f32,
        _pad1: f32,
        _pad2: f32
      }

      struct SEGLayoutUniforms {
        worldScale: f32,
        ringCount: f32,
        totalRollers: f32,
        maxRollers: f32,
        refRollerRadius: f32,
        refRollerHeight: f32,
        statorHeight: f32,
        fluxLinesPerRing: f32,
        ring0: SEGLayoutRing,
        ring1: SEGLayoutRing,
        ring2: SEGLayoutRing
      }

      @binding(0) @group(0) var<uniform> uniforms: Uniforms;
      @binding(1) @group(0) var<uniform> device: DeviceUniforms;
      @binding(2) @group(0) var<storage> instances: array<InstanceData>;
      @binding(4) @group(0) var<uniform> segLayout: SEGLayoutUniforms;

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
        @location(6) scaleXZ: f32,
        @location(7) scaleY: f32
      }

      fn quatMul(q: vec4f, v: vec3f) -> vec3f {
        let t = 2.0 * cross(q.xyz, v);
        return v + q.w * t + cross(q.xyz, t);
      }

      fn ringForInstance(idx: u32) -> SEGLayoutRing {
        if (idx >= u32(segLayout.ring2.rollerOffset)) { return segLayout.ring2; }
        if (idx >= u32(segLayout.ring1.rollerOffset)) { return segLayout.ring1; }
        return segLayout.ring0;
      }

      @vertex
      fn main(input: VertexInput, @builtin(instance_index) instanceIdx: u32) -> VertexOutput {
        let instance = instances[instanceIdx];
        let ring = ringForInstance(instanceIdx);

        let scaleXZ = ring.rollerRadius / max(segLayout.refRollerRadius, 1e-4);
        let scaleY = ring.rollerHeight / max(segLayout.refRollerHeight, 1e-4);
        let scaledPos = vec3f(input.position.x * scaleXZ, input.position.y * scaleY, input.position.z * scaleXZ);
        let scaledNormal = normalize(vec3f(input.normal.x / scaleXZ, input.normal.y / scaleY, input.normal.z / scaleXZ));

        let rotatedPos = quatMul(instance.rotation, scaledPos);
        let rotatedNormal = quatMul(instance.rotation, scaledNormal);
        let devicePos = vec3f(device.posX, device.posY, device.posZ);
        let worldPos = rotatedPos + instance.position + devicePos;

        var output: VertexOutput;
        output.position = uniforms.viewProj * vec4f(worldPos, 1.0);
        output.worldPos = worldPos;
        output.normal = rotatedNormal;
        output.uv = input.uv;
        output.copperColor = instance.copperColor;
        output.greenEmissive = instance.greenEmissive;
        output.ringIndex = instance.ringIndex;
        output.scaleXZ = scaleXZ;
        output.scaleY = scaleY;
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
        prototypePreset: f32,
        glowColor: vec3f,
        emission: f32
      }

      struct MaterialEntry {
        baseMetal: vec4f,
        accentRough: vec4f,
        detailParams: vec4f
      }

      ${PBR_LIGHTING_STRUCT_WGSL}
      ${PBR_SURFACE_WGSL}
      ${PBR_BRDF_WGSL}
      ${PBR_EVAL_WGSL}

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
        @location(6) scaleXZ: f32,
        @location(7) scaleY: f32
      }

      const ROLLER_RADIUS: f32 = 0.75;
      const ROLLER_HEIGHT: f32 = 2.8;
      const ROLLER_SEGMENTS: f32 = 8.0;
      const ROLLER_GROOVE_WIDTH: f32 = 0.045;
      const LAYER_R1: f32 = 0.30;
      const LAYER_R2: f32 = 0.52;
      const LAYER_R3: f32 = 0.74;
      const MAT_ALUMINUM: u32 = 17u;
      const MAT_MAGNET: u32 = 18u;

      struct RollerSurface {
        color: vec3f,
        metallic: f32,
        roughness: f32,
        emissive: f32,
      }

      fn capLayerColor(layerId: u32, lab: bool) -> vec3f {
        if (lab) {
          switch(layerId) {
            case 0u: { return vec3f(0.62, 0.64, 0.66); }
            case 1u: { return vec3f(0.90, 0.88, 0.82); }
            case 2u: { return vec3f(0.55, 0.56, 0.58); }
            default: { return vec3f(0.78, 0.79, 0.80); }
          }
        }
        switch(layerId) {
          case 0u: { return vec3f(0.74, 0.76, 0.78); }
          case 1u: { return vec3f(0.92, 0.90, 0.85); }
          case 2u: { return vec3f(0.88, 0.89, 0.91); }
          default: { return vec3f(0.85, 0.55, 0.28); }
        }
      }

      fn rollerCapShading(localPos: vec3f, energy: f32, lab: bool) -> RollerSurface {
        let radial = length(localPos.xz) / ROLLER_RADIUS;
        var layerId: u32 = 3u;
        if (radial < LAYER_R1) { layerId = 0u; }
        else if (radial < LAYER_R2) { layerId = 1u; }
        else if (radial < LAYER_R3) { layerId = 2u; }

        var surf: RollerSurface;
        surf.color = capLayerColor(layerId, lab);
        surf.metallic = 0.92;
        surf.roughness = 0.20;
        surf.emissive = 0.0;
        if (layerId == 0u) { surf.emissive = 0.22 * energy; surf.metallic = 0.88; surf.roughness = 0.16; }
        if (layerId == 1u) { surf.metallic = 0.05; surf.roughness = 0.72; }

        let layerOffset = vec3f(f32(layerId + 1u) * 7.31, radial * 11.73, 0.0);
        let brushed = fbm(localPos * 4.5 + layerOffset);
        surf.color *= 0.90 + brushed * 0.12;
        return surf;
      }

      fn rollerBarrelShading(localPos: vec3f, poleTint: vec3f, energy: f32, lab: bool,
                             isMagnetStrip: bool) -> RollerSurface {
        let yRel = localPos.y + ROLLER_HEIGHT * 0.5;
        let segmentPitch = ROLLER_HEIGHT / ROLLER_SEGMENTS;
        let cyclePos = fract(yRel / segmentPitch) * segmentPitch;
        let bandHeight = segmentPitch - ROLLER_GROOVE_WIDTH;
        let distToBoundary = min(cyclePos, abs(cyclePos - bandHeight));
        let isGroove = distToBoundary < ROLLER_GROOVE_WIDTH * 0.5 &&
                       yRel > ROLLER_GROOVE_WIDTH && yRel < ROLLER_HEIGHT - ROLLER_GROOVE_WIDTH;

        let theta = atan2(localPos.z, localPos.x);
        let poleBand = step(0.0, cos(theta));
        let northColor = select(vec3f(0.92, 0.58, 0.35), vec3f(0.78, 0.80, 0.82), lab);
        let southColor = select(vec3f(0.38, 0.45, 0.68), vec3f(0.48, 0.50, 0.54), lab);
        var baseColor = mix(southColor, northColor, poleBand);
        baseColor = mix(baseColor, poleTint, 0.45);

        var surf: RollerSurface;
        surf.color = baseColor;
        surf.metallic = 0.94;
        surf.roughness = 0.24;
        surf.emissive = 0.0;

        if (isMagnetStrip) {
          surf.color = mix(vec3f(0.22, 0.24, 0.28), baseColor, 0.35);
          surf.metallic = 0.42;
          surf.roughness = 0.38;
          surf.emissive = 0.12 * energy;
        }
        if (isGroove) {
          surf.color *= 0.48;
          surf.roughness = 0.58;
          surf.emissive = max(surf.emissive, 0.18 * energy);
        }

        let layerOffset = vec3f(3.7, yRel * 2.1, theta * 1.3);
        let brushed = fbm(localPos * 3.2 + layerOffset);
        let oxidation = fbm(localPos * 5.5 + layerOffset * 1.3);
        surf.color = mix(surf.color, vec3f(0.35, 0.28, 0.22), oxidation * 0.22);
        surf.color *= 0.88 + brushed * 0.14;
        return surf;
      }

      fn sharedMaterialId(mode: i32, renderMode: i32, ringIndex: f32) -> u32 {
        if (mode == 1) { return 8u; }
        if (mode == 2) { return 10u; }
        if (mode == 3) { return 7u; }
        if (mode == 4) { return 9u; }
        if (mode >= 5) { return 1u; }
        if (renderMode == 1) { return 13u; }
        if (renderMode == 2) { return MAT_ALUMINUM; }
        if (renderMode == 3) { return 0u; }
        if (ringIndex < -0.5) { return 1u; }
        if (ringIndex > 10.0) { return MAT_ALUMINUM; }
        return 0u;
      }

      @fragment
      fn main(input: FragmentInput) -> @location(0) vec4f {
        let mode = i32(round(device.ringIndex));
        let renderMode = i32(round(device.renderMode));
        let energy = clamp(device.timeScale, 0.0, 1.0);
        let overdrive = pow(energy, 1.8);
        let lab = material.prototypePreset > 0.5;

        let devicePos = vec3f(device.posX, device.posY, device.posZ);
        let localPos = input.worldPos - devicePos;
        let V = normalize(uniforms.cameraPos - input.worldPos);

        var baseColor: vec3f;
        var metallic: f32;
        var roughness: f32;
        var emissive: f32;
        var isCopper = false;
        var useAniso = false;
        var useBrush = false;

        let radial = length(localPos.xz);
        let isCap = abs(input.normal.y) > 0.85;
        let isShaft = radial < ROLLER_RADIUS * 0.22 && abs(input.normal.y) < 0.2;
        let isBearing = radial > ROLLER_RADIUS * 0.86 && radial < ROLLER_RADIUS * 1.10 && isCap;
        let isMagnetStrip = renderMode == 0 && !isCap && !isShaft &&
                            radial > ROLLER_RADIUS * 1.006 && abs(input.normal.y) < 0.85;

        if (renderMode == 0 && isCap) {
          let cap = rollerCapShading(localPos, energy, lab);
          baseColor = cap.color; metallic = cap.metallic; roughness = cap.roughness; emissive = cap.emissive;
        } else if (renderMode == 0 && isShaft) {
          baseColor = vec3f(0.68, 0.70, 0.73); metallic = 0.97; roughness = 0.14;
        } else if (renderMode == 0 && isBearing) {
          baseColor = vec3f(0.78, 0.80, 0.83); metallic = 0.96; roughness = 0.12;
          useBrush = true;
        } else if (renderMode == 0 && !isShaft) {
          let barrel = rollerBarrelShading(localPos, input.copperColor, energy, lab, isMagnetStrip);
          baseColor = barrel.color; emissive = barrel.emissive; metallic = barrel.metallic;
          roughness = barrel.roughness; isCopper = !isMagnetStrip; useAniso = true; useBrush = true;
        } else if (renderMode == 2) {
          baseColor = vec3f(0.82, 0.84, 0.87); metallic = 0.88; roughness = 0.26;
          useAniso = true; useBrush = true;
        } else if (renderMode == 1) {
          if (input.ringIndex > 12.5) {
            baseColor = vec3f(0.50, 0.48, 0.46); metallic = 0.06; roughness = 0.88;
          } else {
            baseColor = vec3f(0.10, 0.11, 0.14); metallic = 0.72; roughness = 0.38;
          }
        } else if (input.ringIndex > 11.5 && input.ringIndex < 12.5) {
          baseColor = vec3f(0.46, 0.50, 0.56); metallic = 0.82; roughness = 0.32;
        } else if (input.ringIndex < -0.5) {
          baseColor = vec3f(0.65, 0.67, 0.70); metallic = 0.96; roughness = 0.14; useBrush = true;
        } else if (input.ringIndex > 10.0) {
          baseColor = vec3f(0.80, 0.82, 0.85); metallic = 0.90; roughness = 0.20; useAniso = true;
        } else {
          baseColor = input.copperColor; metallic = 0.94; roughness = 0.28;
          emissive = input.greenEmissive; isCopper = true; useAniso = true;
        }

        let matId = select(sharedMaterialId(mode, renderMode, input.ringIndex), MAT_MAGNET, isMagnetStrip);
        let mat = materialTable[min(matId, 18u)];
        baseColor = mix(baseColor, mat.baseMetal.rgb, 0.42);
        metallic = mix(metallic, mat.baseMetal.a, 0.42);
        roughness = mix(roughness, mat.accentRough.a, 0.42);

        let detailScale = mat.detailParams.x;
        let brushed = fbm(localPos * (detailScale * 0.32));
        let oxidation = fbm(localPos * (detailScale * 0.75 + 9.0));
        baseColor = mix(baseColor, mat.accentRough.rgb, oxidation * mat.detailParams.y * 0.45);
        baseColor *= 0.88 + brushed * 0.14;
        roughness = clamp(roughness + brushed * 0.05 + oxidation * 0.07, 0.04, 1.0);

        var N = normalize(input.normal);
        if (useBrush) {
          N = brushedMetalNormal(N, localPos, detailScale * 0.55, 0.14);
        } else {
          N = detailNormal(N, localPos, detailScale);
        }
        if (renderMode == 1 || renderMode == 2) {
          N = knurlNormal(N, localPos, 48.0, 0.06);
        }

        let upRef = select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(N.y) > 0.99);
        let T = normalize(cross(upRef, N));
        let B = cross(N, T);
        let albedo = mix(baseColor, vec3f(0.0), metallic);

        var color = evaluatePBR(N, V, albedo, metallic, roughness, T, B, lighting, useAniso);

        // PBR-friendly emissive / corona (additive after lighting)
        let NdotV = max(dot(N, V), 0.0);
        let bottomGlow = max(0.0, -N.y) * input.greenEmissive * (1.2 + overdrive * 2.0);
        color += vec3f(0.0, 1.0, 0.5) * bottomGlow * (0.6 + NdotV * 0.4);
        color += baseColor * emissive * (0.35 + energy * 0.65);
        if (isCopper) {
          let hot = mix(850.0, 3300.0, clamp(energy * 0.8 + input.greenEmissive * 0.7, 0.0, 1.0));
          color += blackbody(hot) * (0.10 + overdrive * 0.45) * (0.3 + NdotV * 0.7);
        }
        if (input.ringIndex > 11.5 && input.ringIndex < 12.5) {
          color += vec3f(0.04, 0.12, 0.28) * (0.08 + overdrive * 0.12) * NdotV;
        }
        let energyArc = smoothstep(0.65, 1.0, input.greenEmissive) * (0.20 + overdrive * 0.65);
        color += vec3f(0.3, 0.8, 1.0) * energyArc * NdotV;

        let contactAO = 0.52 + 0.48 * smoothstep(0.0, 2.4, abs(input.worldPos.y - devicePos.y));
        color *= contactAO;

        // HDR scene output — tonemap + bloom handled in post composite pass
        return vec4f(max(color, vec3f(0.0)), 1.0);
      }
    `;
  }
