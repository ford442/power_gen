/**
 * MultiDeviceShaders - Extracted shader methods for SEG WebGPU visualizer
 * Contains all 17 shader getter methods: roller, particle, core, field line,
 * energy arc, coil, seg-enhanced, compute, and grid shaders.
 */
import fluxLinesWgsl from './shaders/flux-lines.wgsl?raw';


import { getRollerVertShader, getRollerFragShader } from './shaders/generators/roller-shaders.js';
import { getParticleVertShader, getParticleFragShader } from './shaders/generators/particle-shaders.js';
import { getCoreVertShader, getCoreFragShader } from './shaders/generators/core-shaders.js';
import { getFieldLineVertShader, getFieldLineFragShader, getFluxLineTracerShader, getFluxSegmentVertShader, getFluxSegmentFragShader } from './shaders/generators/field-line-shaders.js';
import { getEnergyArcVertShader, getEnergyArcFragShader } from './shaders/generators/energy-arc-shaders.js';
import { getCoilVertShader, getCoilFragShader } from './shaders/generators/coil-shaders.js';
import { getSegEnhancedVertShader, getSegEnhancedFragShader } from './shaders/generators/seg-enhanced-shaders.js';
import { getComputeShader, getSegRollerComputeShader, getSegFieldAdvectShader } from './shaders/generators/compute-shaders.js';
import { getSkyVertShader, getSkyFragShader, getGridVertShader, getGridFragShader } from './shaders/generators/environment-shaders.js';
import { getBloomVertShader, getBloomExtractShader, getBloomBlurShader, getBloomCompositeShader } from './shaders/generators/bloom-shaders.js';

export class MultiDeviceShaders {
  constructor() {}

  get rollerVertShader() {
    return getRollerVertShader();
  }

  get rollerFragShader() {
    return getRollerFragShader();
  }

  get particleVertShader() {
    return getParticleVertShader();
  }

  get particleFragShader() {
    return getParticleFragShader();
  }

  get coreVertShader() {
    return getCoreVertShader();
  }

  get coreFragShader() {
    return getCoreFragShader();
  }

  get fieldLineVertShader() {
    return getFieldLineVertShader();
  }

  get fieldLineFragShader() {
    return getFieldLineFragShader();
  }

  get fluxLineTracerShader() {
    return getFluxLineTracerShader();
  }

  get fluxSegmentVertShader() {
    return getFluxSegmentVertShader();
  }

  get fluxSegmentFragShader() {
    return getFluxSegmentFragShader();
  }

  get energyArcVertShader() {
    return getEnergyArcVertShader();
  }

  get energyArcFragShader() {
    return getEnergyArcFragShader();
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
      @binding(4) @group(0) var<uniform> segLayoutData: array<vec4f, 16>;

      fn layoutRingField(ringIdx: u32, fieldOffset: u32) -> f32 {
        let i = 8u + ringIdx * 12u + fieldOffset;
        return segLayoutData[i >> 2u][i & 3u];
      }

      fn layoutRefMeshRadius() -> f32 { return segLayoutData[1][0]; }
      fn layoutRefMeshHeight() -> f32 { return segLayoutData[1][1]; }

      fn rollerMeshScale(ringIdx: u32) -> vec3f {
        let rollerR = layoutRingField(ringIdx, 3u);
        let rollerH = layoutRingField(ringIdx, 4u);
        let sXZ = rollerR / max(layoutRefMeshRadius(), 1e-4);
        let sY = rollerH / max(layoutRefMeshHeight(), 1e-4);
        return vec3f(sXZ, sY, sXZ);
      }

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
        let ringIdx = u32(clamp(instance.ringIndex, 0.0, 2.0));
        let meshScale = rollerMeshScale(ringIdx);
        let scaledPos = input.position * meshScale;
        let scaledNormal = normalize(input.normal * meshScale);
        let rotatedPos = quatMul(instance.rotation, scaledPos);
        let rotatedNormal = quatMul(instance.rotation, scaledNormal);
        let devicePos = vec3f(device.posX, device.posY, device.posZ);
        let worldPos = rotatedPos + instance.position + devicePos;

  get coilFragShader() {
    return getCoilFragShader();
  }

  get segEnhancedVertShader() {
    return getSegEnhancedVertShader();
  }

  get segEnhancedFragShader() {
    return /* wgsl */ `
      struct Uniforms {
        viewProj: mat4x4f,
        time: f32,
        cameraPos: vec3f,
        speedMult: f32
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

      struct InstanceData {
        position: vec3f,
        ringIndex: f32,
        rotation: vec4f,
        copperColor: vec3f,
        greenEmissive: f32
      }

      @binding(0) @group(0) var<uniform> uniforms: Uniforms;
      @binding(1) @group(0) var<uniform> device: DeviceUniforms;
      @binding(3) @group(0) var<uniform> material: MaterialUniforms;
      @binding(5) @group(0) var<uniform> lighting: LightingConfig;
      @binding(6) @group(0) var<storage, read> materialTable: array<MaterialEntry>;
      @binding(7) @group(0) var<storage, read> rollerShadowInstances: array<InstanceData>;
      @binding(4) @group(0) var<uniform> segLayoutData: array<vec4f, 16>;

      fn layoutRingCount() -> u32 { return u32(segLayoutData[0][1]); }
      fn layoutActiveRollers() -> u32 { return u32(segLayoutData[0][2]); }
      fn layoutMaxRollers() -> u32 { return u32(segLayoutData[0][3]); }
      fn layoutRefMeshRadius() -> f32 { return segLayoutData[1][0]; }
      fn layoutRefMeshHeight() -> f32 { return segLayoutData[1][1]; }
      fn layoutRingField(ringIdx: u32, fieldOffset: u32) -> f32 {
        let i = 8u + ringIdx * 12u + fieldOffset;
        return segLayoutData[i >> 2u][i & 3u];
      }

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
        let maxR = min(layoutActiveRollers(), layoutMaxRollers());
        let devicePos = vec3f(device.posX, device.posY, device.posZ);
        for (var i = 0u; i < maxR; i++) {
          let rp = rollerShadowInstances[i].position + devicePos;
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
        let ringN = layoutRingCount();
        for (var ri = 0u; ri < ringN; ri++) {
          let orbitR = layoutRingField(ri, 2u);
          let weight = 0.40 - f32(ri) * 0.07;
          groundShadow += groundOrbitShadow(r, orbitR, h) * weight;
        }

        let penumbra = accumulateRollerPenumbra(worldPos);
        let total = clamp((groundShadow * upWeight + penumbra) * lighting.shadowStrength, 0.0, 0.78);
        return 1.0 - total;
      }

      fn sharedMaterialId(mode: i32, renderMode: i32, ringIndex: f32, bandIndex: f32) -> u32 {
        if (renderMode == 3) {
          // Pickup coil assembly: connection ring (copper) or C-core parts.
          if (ringIndex < 0.5) { return 7u; }
          if (ringIndex < 1.5) { return 14u; }  // C-core laminated iron
          if (ringIndex < 2.5) { return 15u; }  // enameled winding copper
          return 16u;                            // mounting foot steel
        }
        if (mode == 1) { return 8u; }
        if (mode == 2) { return 10u; }
        if (mode == 3) { return 7u; }
        if (mode == 4) { return 9u; }
        if (mode >= 5) { return 1u; }
        if (renderMode == 1) { return 13u; }
        if (renderMode == 2) { return 2u; }
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
          let ringIdx = u32(clamp(input.ringIndex, 0.0, 2.0));
          let worldRollerR = layoutRingField(ringIdx, 3u);
          let radialT = length(localPos.xz) / max(worldRollerR, 1e-4);
          layerId = rollerLayerId(radialT);

          // Axial segment / groove detection on the barrel.
          let worldRollerH = layoutRingField(ringIdx, 4u);
          let yRel = localPos.y + worldRollerH * 0.5;
          let segmentPitch = (worldRollerH - ROLLER_GROOVE_WIDTH * (ROLLER_SEGMENTS - 1.0)) / ROLLER_SEGMENTS + ROLLER_GROOVE_WIDTH;
          let cyclePos = fract(yRel / segmentPitch) * segmentPitch;
          let bandHeight = segmentPitch - ROLLER_GROOVE_WIDTH;
          segmentId = i32(clamp(floor(yRel / segmentPitch), 0.0, ROLLER_SEGMENTS - 1.0));
          let distToBoundary = min(cyclePos, abs(cyclePos - bandHeight));
          let isGroove = distToBoundary < ROLLER_GROOVE_WIDTH * 0.5 &&
                         yRel > ROLLER_GROOVE_WIDTH && yRel < worldRollerH - ROLLER_GROOVE_WIDTH;

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
        } else if (renderMode == 3 && input.ringIndex > 0.5) {
          // C-shaped pickup coil parts use material-table physical presets.
          baseColor = mat.baseMetal.rgb;
          metallic = mat.baseMetal.a;
          roughness = mat.accentRough.a;
          emissive = 0.0;
          isCopper = (input.ringIndex > 1.5 && input.ringIndex < 2.5);
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

          // Cold-zone frost sheen on base-plate rim at sustained overdrive.
          if (energy > 0.82) {
            let frost = smoothstep(0.82, 0.96, energy) * smoothstep(6.5, 3.5, polarR);
            baseColor = mix(baseColor, vec3f(0.78, 0.90, 0.96), frost * 0.28);
            roughness = mix(roughness, 0.18, frost * 0.25);
          }
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
          let ringIdxGlow = u32(clamp(input.ringIndex, 0.0, 2.0));
          let worldRollerHGlow = layoutRingField(ringIdxGlow, 4u);
          let yEdge = 1.0 - abs(localPos.y) / max(worldRollerHGlow * 0.5, 1e-4);
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

  get computeShader() {
    return getComputeShader();
  }

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
      @group(0) @binding(2) var<uniform>             segLayoutData: array<vec4f, 16>;

      const PI: f32 = 3.14159265359;

      fn layoutRingCount() -> u32 { return u32(segLayoutData[0][1]); }
      fn layoutActiveRollers() -> u32 { return u32(segLayoutData[0][2]); }
      fn layoutMaxRollers() -> u32 { return u32(segLayoutData[0][3]); }
      fn layoutRingField(ringIdx: u32, fieldOffset: u32) -> f32 {
        let i = 8u + ringIdx * 12u + fieldOffset;
        return segLayoutData[i >> 2u][i & 3u];
      }

      fn mapRollerIndex(idx: u32) -> vec2u {
        var ringIdx: u32 = 0u;
        var localI: u32 = idx;
        let ringN = layoutRingCount();
        for (var ri = 0u; ri < ringN; ri++) {
          let count = u32(layoutRingField(ri, 0u));
          if (localI < count) {
            return vec2u(ri, localI);
          }
          localI -= count;
        }
        return vec2u(0u, 0u);
      }

      // Pole-band colours (copper / oxide / neodymium / brass)
      const POLE_COLORS = array<vec3f, 4>(
        vec3f(0.85, 0.48, 0.22),
        vec3f(0.55, 0.30, 0.15),
        vec3f(0.72, 0.74, 0.76),
        vec3f(0.78, 0.58, 0.22),
      );

      fn hash1f(p: f32) -> f32 {
        return fract(sin(p * 127.1) * 43758.5453);
      }
      fn hash2f(p: vec2f) -> vec2f {
        return fract(sin(vec2f(dot(p, vec2f(127.1, 311.7)), dot(p, vec2f(269.5, 183.3)))) * 43758.5453);
      }

      @compute @workgroup_size(64)
      fn main(@builtin(global_invocation_id) gid: vec3u) {
        let idx = gid.x;
        if (idx >= layoutMaxRollers()) { return; }

        let mapped = mapRollerIndex(idx);
        let ringIdx = mapped.x;
        let localI  = mapped.y;

        let count  = u32(layoutRingField(ringIdx, 0u));
        let radius = layoutRingField(ringIdx, 2u);
        let rollerR = layoutRingField(ringIdx, 3u);
        let speed  = layoutRingField(ringIdx, 5u);

        if (idx >= layoutActiveRollers() || localI >= count) {
          var inactive: RollerInstance;
          inactive.position = vec3f(0.0);
          inactive.ringIndex = f32(ringIdx);
          inactive.rotation = vec4f(0.0, 0.0, 0.0, 1.0);
          inactive.copperColor = vec3f(0.0);
          inactive.greenEmissive = 0.0;
          rollers[idx] = inactive;
          return;
        }

        let t = uniforms.time;
        let startupRamp = min(t * (0.25 + f32(ringIdx) * 0.1), 1.0);

        let rollerHash = hash1f(f32(idx) * 0.731 + f32(ringIdx) * 1.93);
        let rollerHash2 = hash2f(vec2f(f32(idx), f32(ringIdx) * 3.7));

        let jitterSeed = f32(idx) * 127.3 + f32(ringIdx) * 53.7;
        let speedJitter = 1.0
          + 0.03 * sin(t * 1.3 + sin(jitterSeed) * 12.7)
          + 0.02 * sin(t * 0.47 + rollerHash * 20.0)
          + 0.01 * sin(t * 0.11 + f32(ringIdx) * 7.0);

        let ringPhaseOffsets = array<f32, 3>(0.0, 0.31, 0.67);
        let baseAngle = (f32(localI) / f32(count)) * PI * 2.0 + ringPhaseOffsets[ringIdx];

        let uncoggedAngle = baseAngle + t * 0.5 * speed * speedJitter * startupRamp;

        let cogCount = 6.0 + f32(ringIdx) * 3.0 + rollerHash * 4.0;
        let cogAmp = 0.018 * smoothstep(0.5, 2.0, uniforms.speedMult);
        let cogTimeScale = 1.0 - cogAmp * (0.5 + 0.5 * cos(uncoggedAngle * cogCount * 2.0));

        let angle = baseAngle + t * 0.5 * speed * speedJitter * cogTimeScale * startupRamp;

        let radialFreq = 0.6 + rollerHash * 0.5;
        let radialAmp = 0.018 * (1.0 + 0.25 * uniforms.speedMult);
        let radialOffset = sin(t * radialFreq + rollerHash * 4.0) * radialAmp;

        let bobFreq = 0.9 + rollerHash * 0.4;
        let bobAmp = 0.012 * (1.0 + 0.35 * uniforms.speedMult);
        let yBob = sin(t * bobFreq + rollerHash * 6.28) * bobAmp;

        let rEff = radius + radialOffset;
        let x = cos(angle) * rEff;
        let z = sin(angle) * rEff;
        // Rollers stand slightly taller than stator; centre at half height.
        let rollerH = layoutRingField(ringIdx, 4u);
        let y = yBob + rollerH * 0.5;

        let gearRatio = radius / max(rollerR, 1e-4);
        let selfRotAngle = angle * gearRatio * 0.5;

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

        let colorIdx  = (localI + ringIdx * 3u) % 4u;
        let baseEmit  = select(0.0, 0.15, colorIdx == 2u);
        let speedFactor = smoothstep(2.0, 7.0, uniforms.speedMult);
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

  get segFieldAdvectShader() {
    return getSegFieldAdvectShader();
  }

  get skyVertShader() {
    return getSkyVertShader();
  }

  get skyFragShader() {
    return getSkyFragShader();
  }

  get gridVertShader() {
    return getGridVertShader();
  }

  get gridFragShader() {
    return getGridFragShader();
  }

  get bloomVertShader() {
    return getBloomVertShader();
  }

  get bloomExtractShader() {
    return getBloomExtractShader();
  }

  get bloomBlurShader() {
    return getBloomBlurShader();
  }

  get bloomCompositeShader() {
    return getBloomCompositeShader();
  }

}
