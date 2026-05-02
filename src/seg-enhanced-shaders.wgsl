// ============================================================================
// SEG Enhanced WGSL Shader Code
// ============================================================================
// Drop-in shader enhancements for the SEG visualization.
// These snippets replace or augment sections of the existing roller.wgsl,
// particles.wgsl, and magnetic-field.wgsl shaders.
//
// Key visual improvements:
//   - Roller pole band patterning (alternating N/S magnetic segments)
//   - Metallic PBR material response (specular highlights, Fresnel)
//   - Multi-material support for 4-layer SEG composition
//   - Wire/cable rendering
//   - Improved copper aging/oxidation variation
//
// INTEGRATION: Copy the relevant sections into your existing .wgsl files
// or use the complete vertex/fragment shader pairs below.
// ============================================================================

// ----------------------------------------------------------------------------
// SHARED BINDINGS (add to your existing shader bindings)
// ----------------------------------------------------------------------------
// These bindings extend the existing uniform layout.
// Add them after your existing @group(0) bindings.

// Binding 4: Material properties for multi-material rendering
struct MaterialProperties {
  // Per-material: baseColor(3), metallic(1), roughness(1), emissive(1), pad(2)
  data: array<vec4f, 8>,  // 8 materials x vec4f
}
@binding(4) @group(0) var<storage> materials: MaterialProperties;

// Binding 5: Enhanced lighting config
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
@binding(5) @group(0) var<uniform> lighting: LightingConfig;

// ----------------------------------------------------------------------------
// VERTEX SHADER: Enhanced Roller (with UV support)
// ----------------------------------------------------------------------------
// Replaces the existing roller vertex shader.
// Adds UV coordinate passthrough for material mapping.
// ----------------------------------------------------------------------------
struct EnhancedVertexInput {
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,       // NEW: UV coordinates
}

struct EnhancedVertexOutput {
  @builtin(position) position: vec4f,
  @location(0) worldPos: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,       // NEW: UV for fragment shader
  @location(3) copperColor: vec3f,
  @location(4) greenEmissive: f32,
  @location(5) ringIndex: f32,
  @location(6) bandIndex: f32,  // NEW: which pole band this vertex belongs to
}

@vertex
fn enhancedRollerVertex(
  input: EnhancedVertexInput,
  @builtin(instance_index) instanceIdx: u32
) -> EnhancedVertexOutput {
  let instance = instances[instanceIdx];

  // Apply self-rotation
  let rotatedPos = quatMul(instance.rotation, input.position);
  let rotatedNormal = quatMul(instance.rotation, input.normal);

  let devicePos = vec3f(device.posX, device.posY, device.posZ);
  let worldPos = rotatedPos + instance.position + devicePos;

  // Derive band index from UV y coordinate (for pole-banded rollers)
  let bandIdx = floor(input.uv.y * 6.0); // 6 bands

  var output: EnhancedVertexOutput;
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

// ----------------------------------------------------------------------------
// FRAGMENT SHADER: Enhanced PBR Material
// ----------------------------------------------------------------------------
// Replaces the existing roller fragment shader with physically-based
// metallic material rendering that makes the SEG look like real hardware.
// ----------------------------------------------------------------------------
struct EnhancedFragmentInput {
  @location(0) worldPos: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  @location(3) copperColor: vec3f,
  @location(4) greenEmissive: f32,
  @location(5) ringIndex: f32,
  @location(6) bandIndex: f32,
}

// Simplex noise for material variation (prevents uniform plastic look)
fn hash3(p: vec3f) -> vec3f {
  let q = vec3f(
    dot(p, vec3f(127.1, 311.7, 74.7)),
    dot(p, vec3f(269.5, 183.3, 246.1)),
    dot(p, vec3f(113.5, 271.9, 124.6))
  );
  return fract(sin(q) * 43758.5453);
}

// Micro-surface variation for realistic metal
fn surfaceVariation(worldPos: vec3f, scale: f32) -> f32 {
  let h = hash3(floor(worldPos * scale));
  return h.x * 0.15 + h.y * 0.1; // Subtle variation
}

// Fresnel Schlick approximation for metallic reflections
fn fresnelSchlick(cosTheta: f32, f0: vec3f) -> vec3f {
  return f0 + (vec3f(1.0) - f0) * pow(1.0 - cosTheta, 5.0);
}

// Normal Distribution Function (GGX/Trowbridge-Reitz)
fn distributionGGX(NdotH: f32, roughness: f32) -> f32 {
  let a = roughness * roughness;
  let a2 = a * a;
  let denom = NdotH * NdotH * (a2 - 1.0) + 1.0;
  return a2 / (3.14159265 * denom * denom);
}

// Geometry function (Schlick-GGX)
fn geometrySmith(NdotV: f32, NdotL: f32, roughness: f32) -> f32 {
  let k = (roughness + 1.0) * (roughness + 1.0) / 8.0;
  let ggx1 = NdotV / (NdotV * (1.0 - k) + k);
  let ggx2 = NdotL / (NdotL * (1.0 - k) + k);
  return ggx1 * ggx2;
}

// Pole band color lookup (alternating magnetic segments)
fn poleBandColor(bandIndex: f32, baseColor: vec3f) -> vec3f {
  let idx = u32(bandIndex) % 4u;
  switch(idx) {
    case 0u: { return vec3f(0.85, 0.48, 0.22); } // Fresh copper (N pole)
    case 1u: { return vec3f(0.55, 0.30, 0.15); } // Copper oxide (S pole)
    case 2u: { return vec3f(0.72, 0.74, 0.76); } // Neodymium (silver core)
    case 3u: { return vec3f(0.78, 0.58, 0.22); } // Brass (separator)
    default: { return baseColor; }
  }
}

@fragment
fn enhancedRollerFragment(input: EnhancedFragmentInput) -> @location(0) vec4f {
  let N = normalize(input.normal);
  let V = normalize(uniforms.cameraPos - input.worldPos);
  let NdotV = max(dot(N, V), 0.0);

  // ============================================
  // MATERIAL SELECTION based on band and ring
  // ============================================

  // Choose material properties
  var baseColor: vec3f;
  var metallic: f32;
  var roughness: f32;
  var emissive: f32;

  // Determine if this is a roller (has bandIndex in valid range) or other geometry
  if (input.bandIndex >= 0.0 && input.bandIndex < 6.0) {
    // ROLLER: Use pole band coloring
    baseColor = poleBandColor(input.bandIndex, input.copperColor);
    let isNeodymium = (u32(input.bandIndex) % 4u) == 2u;
    metallic = select(0.95, 0.88, isNeodymium);
    roughness = select(0.30, 0.20, isNeodymium);
    emissive = select(0.0, 0.15, isNeodymium);
  } else if (input.ringIndex < -0.5) {
    // STEEL SHAFT (ringIndex hack: -1)
    baseColor = vec3f(0.65, 0.67, 0.70);
    metallic = 0.96;
    roughness = 0.15;
    emissive = 0.0;
  } else if (input.ringIndex > 10.0) {
    // PLATE/STRUCTURAL (ringIndex hack: 11)
    baseColor = vec3f(0.78, 0.58, 0.22); // Brass
    metallic = 0.90;
    roughness = 0.22;
    emissive = 0.0;
  } else {
    // DEFAULT: Standard copper
    baseColor = input.copperColor;
    metallic = 0.95;
    roughness = 0.30;
    emissive = input.greenEmissive;
  }

  // Add micro-surface variation so metals don't look like plastic
  let variation = surfaceVariation(input.worldPos, 8.0);
  baseColor = baseColor * (0.92 + variation);
  roughness = clamp(roughness + variation * 0.1, 0.05, 1.0);

  // ============================================
  // PBR LIGHTING (metallic workflow)
  // ============================================

  // Common PBR parameters
  let f0 = mix(vec3f(0.04), baseColor, metallic);
  let albedo = mix(baseColor, vec3f(0.0), metallic);

  // Key light (main directional)
  let L1 = normalize(-lighting.keyDir);
  let H1 = normalize(V + L1);
  let NdotL1 = max(dot(N, L1), 0.0);
  let NdotH1 = max(dot(N, H1), 0.0);

  let D1 = distributionGGX(NdotH1, roughness);
  let G1 = geometrySmith(NdotV, NdotL1, roughness);
  let F1 = fresnelSchlick(max(dot(H1, V), 0.0), f0);

  let numerator1 = D1 * G1 * F1;
  let denominator1 = 4.0 * NdotV * NdotL1 + 0.001;
  let specular1 = numerator1 / denominator1;

  let kS1 = F1;
  let kD1 = (vec3f(1.0) - kS1) * (1.0 - metallic);

  // Fill light (softer, from opposite side)
  let L2 = normalize(-lighting.fillDir);
  let H2 = normalize(V + L2);
  let NdotL2 = max(dot(N, L2), 0.0);
  let NdotH2 = max(dot(N, H2), 0.0);

  let D2 = distributionGGX(NdotH2, roughness);
  let G2 = geometrySmith(NdotV, NdotL2, roughness);
  let F2 = fresnelSchlick(max(dot(H2, V), 0.0), f0);

  let numerator2 = D2 * G2 * F2;
  let denominator2 = 4.0 * NdotV * NdotL2 + 0.001;
  let specular2 = numerator2 / denominator2;

  let kS2 = F2;
  let kD2 = (vec3f(1.0) - kS2) * (1.0 - metallic);

  // Rim light (backlight for edge highlighting)
  let rimFactor = pow(1.0 - NdotV, 3.0) * lighting.rimIntensity;
  let rimLight = lighting.rimColor * rimFactor;

  // Combine lights
  let diffuse = albedo * 3.14159265 * (
    kD1 * NdotL1 * lighting.keyColor * lighting.keyIntensity +
    kD2 * NdotL2 * lighting.fillColor * lighting.fillIntensity * 0.5
  );

  let specular = (
    specular1 * lighting.keyColor * lighting.keyIntensity * NdotL1 +
    specular2 * lighting.fillColor * lighting.fillIntensity * NdotL2 * 0.3
  );

  // Ambient
  let ambient = albedo * lighting.ambient * vec3f(0.15, 0.18, 0.22);

  // Combine
  var color = ambient + diffuse + specular + rimLight;

  // ============================================
  // EMISSIVE / GLOW EFFECTS
  // ============================================

  // Green LED underglow on bottom half (from original)
  let bottomGlow = max(0.0, -N.y) * input.greenEmissive * 1.5;
  color += vec3f(0.0, 1.0, 0.5) * bottomGlow;

  // Neodymium subtle glow
  color += baseColor * emissive * 0.5;

  // Energy arc effect when running at high speed
  let energyArc = smoothstep(0.7, 1.0, input.greenEmissive) * 0.3;
  color += vec3f(0.3, 0.8, 1.0) * energyArc * NdotV;

  // ============================================
  // TONEMAPPING AND OUTPUT
  // ============================================

  // ACES filmic tonemapping for metallic highlights
  color = color * (2.51 * color + 0.03) / (color * (2.43 * color + 0.59) + 0.14);

  // Slight vignette (subtle)
  let vignette = 1.0 - dot(input.uv - 0.5, input.uv - 0.5) * 0.3;
  color *= vignette;

  return vec4f(color, 1.0);
}

// ----------------------------------------------------------------------------
// FRAGMENT SHADER: Wire/Cable Renderer
// ----------------------------------------------------------------------------
// Simple shader for the wire harnesses between electromagnets.
// Uses UV x-coordinate for striped insulation pattern.
// ----------------------------------------------------------------------------
struct WireFragmentInput {
  @location(0) worldPos: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
}

@fragment
fn wireFragment(input: WireFragmentInput) -> @location(0) vec4f {
  let N = normalize(input.normal);
  let V = normalize(uniforms.cameraPos - input.worldPos);

  // Wire insulation stripe pattern (copper + black alternating)
  let stripe = step(0.5, fract(input.uv.x * 20.0));
  let wireColor = mix(
    vec3f(0.15, 0.15, 0.15),  // Black insulation
    vec3f(0.82, 0.50, 0.25),  // Copper wire
    stripe
  );

  // Simple diffuse + specular
  let L = normalize(vec3f(1.0, 1.0, 0.5));
  let diff = max(dot(N, L), 0.0);
  let ambient = 0.25;

  let H = normalize(V + L);
  let spec = pow(max(dot(N, H), 0.0), 64.0);

  let color = wireColor * (ambient + diff * 0.6) + vec3f(1.0) * spec * 0.4;

  return vec4f(color, 1.0);
}

// ----------------------------------------------------------------------------
// FRAGMENT SHADER: Plate/Structural Component
// ----------------------------------------------------------------------------
// Specialized shader for the upper/lower plates with cutouts and bolts.
// Handles brass material with machined surface details.
// ----------------------------------------------------------------------------
struct PlateFragmentInput {
  @location(0) worldPos: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  @location(3) ringIndex: f32,
}

@fragment
fn plateFragment(input: PlateFragmentInput) -> @location(0) vec4f {
  let N = normalize(input.normal);
  let V = normalize(uniforms.cameraPos - input.worldPos);
  let NdotV = max(dot(N, V), 0.0);

  // Machined brass material
  let brassColor = vec3f(0.76, 0.56, 0.20);
  let steelColor = vec3f(0.68, 0.70, 0.72);

  // Subtle machining marks (anisotropic-like variation)
  let radialUV = length(input.uv - 0.5) * 2.0;
  let machining = sin(radialUV * 80.0) * 0.03;

  // Bolt heads show as slightly raised steel circles (detected by UV)
  let boltPattern = step(0.85, hash3(vec3f(floor(input.uv * 12.0), 0.0)).x);
  let baseColor = mix(brassColor + machining, steelColor, boltPattern * 0.3);

  // Metallic PBR
  let metallic = 0.92;
  let roughness = mix(0.20, 0.12, boltPattern); // Bolts are shinier
  let f0 = mix(vec3f(0.04), baseColor, metallic);

  let L = normalize(-lighting.keyDir);
  let H = normalize(V + L);
  let NdotL = max(dot(N, L), 0.0);
  let NdotH = max(dot(N, H), 0.0);

  let D = distributionGGX(NdotH, roughness);
  let G = geometrySmith(NdotV, NdotL, roughness);
  let F = fresnelSchlick(max(dot(H, V), 0.0), f0);

  let specular = (D * G * F) / (4.0 * NdotV * NdotL + 0.001);
  let diffuse = baseColor * (1.0 - metallic) * NdotL * lighting.keyIntensity;

  // Rim light for edge definition
  let rim = pow(1.0 - NdotV, 4.0) * 0.5;

  var color = diffuse + specular * lighting.keyColor * NdotL + lighting.rimColor * rim;
  color += baseColor * lighting.ambient * 0.2;

  // ACES tonemapping
  color = color * (2.51 * color + 0.03) / (color * (2.43 * color + 0.59) + 0.14);

  return vec4f(color, 1.0);
}

// ----------------------------------------------------------------------------
// COMPUTE SHADER: Enhanced Particle Motion
// ----------------------------------------------------------------------------
// Extends the particle compute shader with magnetic field influence
// that looks more realistic - particles follow field lines around
// the roller rings rather than just orbiting.
// ----------------------------------------------------------------------------
@compute @workgroup_size(64)
fn enhancedParticleCompute(
  @builtin(global_invocation_id) gid: vec3u
) {
  let idx = gid.x;
  if (idx >= u32(particleUniforms.particleCount)) { return; }

  var p = particles[idx];

  // Distance from center
  let dist = length(p.position.xz);

  // Find nearest ring
  let ringRadii = array<f32, 3>(2.5, 4.0, 5.5);
  let ringSpeeds = array<f32, 3>(2.0, 1.0, 0.5);
  var nearestRing = 0;
  var nearestDist = 999.0;
  for (var i = 0; i < 3; i++) {
    let d = abs(dist - ringRadii[i]);
    if (d < nearestDist) {
      nearestDist = d;
      nearestRing = i;
    }
  }

  // Particle follows magnetic field lines (helical path around ring)
  let ringR = ringRadii[nearestRing];
  let speed = ringSpeeds[nearestRing] * 0.5;
  let angle = atan2(p.position.z, p.position.x);

  // Orbital motion
  let newAngle = angle + particleUniforms.deltaTime * speed * (1.0 + 0.1 * p.phase);
  let radialWobble = sin(p.phase * 6.28 + particleUniforms.time * 3.0) * 0.15;

  p.position.x = cos(newAngle) * (ringR + radialWobble);
  p.position.z = sin(newAngle) * (ringR + radialWobble);

  // Vertical oscillation (field line height variation)
  let fieldHeight = sin(newAngle * 3.0 + p.phase * 10.0) * 0.8;
  p.position.y = fieldHeight + cos(particleUniforms.time * 2.0 + p.phase) * 0.2;

  // Radial drift toward ring
  let toRing = ringR - dist;
  p.position.x += cos(angle) * toRing * particleUniforms.deltaTime * 2.0;
  p.position.z += sin(angle) * toRing * particleUniforms.deltaTime * 2.0;

  particles[idx] = p;
}

// ----------------------------------------------------------------------------
// LIGHTING CONFIGURATION (CPU-side setup)
// ----------------------------------------------------------------------------
// Copy this into your JavaScript to configure the enhanced lighting:
/*
const lightingConfig = {
  key: {
    position: [5.0, 8.0, 5.0],    // Main light from upper-right
    color: [1.0, 0.98, 0.95],     // Warm white (slightly incandescent)
    intensity: 1.2
  },
  fill: {
    position: [-4.0, 3.0, -3.0],  // Fill from opposite side
    color: [0.75, 0.85, 1.0],     // Cool blue (sky fill)
    intensity: 0.4
  },
  rim: {
    position: [0.0, 2.0, -8.0],   // Backlight for edge definition
    color: [0.4, 0.8, 1.0],       // Cyan rim for metallic edge pop
    intensity: 0.8
  },
  ground: {
    position: [0.0, -5.0, 0.0],   // Bounce light from floor
    color: [0.3, 0.25, 0.2],      // Warm ground bounce
    intensity: 0.15
  }
};

// Upload to GPU uniform buffer (192 bytes):
const lightingData = new Float32Array(48);
// Key light (offset 0-11):
lightingData[0] = lightingConfig.key.position[0];
lightingData[1] = lightingConfig.key.position[1];
lightingData[2] = lightingConfig.key.position[2];
lightingData[3] = 0; // padding
lightingData[4] = lightingConfig.key.color[0];
lightingData[5] = lightingConfig.key.color[1];
lightingData[6] = lightingConfig.key.color[2];
lightingData[7] = lightingConfig.key.intensity;
// Fill light (offset 8-15):
lightingData[8] = lightingConfig.fill.position[0];
lightingData[9] = lightingConfig.fill.position[1];
lightingData[10] = lightingConfig.fill.position[2];
lightingData[11] = 0;
lightingData[12] = lightingConfig.fill.color[0];
lightingData[13] = lightingConfig.fill.color[1];
lightingData[14] = lightingConfig.fill.color[2];
lightingData[15] = lightingConfig.fill.intensity;
// Rim light (offset 16-23):
lightingData[16] = lightingConfig.rim.position[0];
lightingData[17] = lightingConfig.rim.position[1];
lightingData[18] = lightingConfig.rim.position[2];
lightingData[19] = 0;
lightingData[20] = lightingConfig.rim.color[0];
lightingData[21] = lightingConfig.rim.color[1];
lightingData[22] = lightingConfig.rim.color[2];
lightingData[23] = lightingConfig.rim.intensity;
// Ground (offset 24-31):
lightingData[24] = lightingConfig.ground.position[0];
lightingData[25] = lightingConfig.ground.position[1];
lightingData[26] = lightingConfig.ground.position[2];
lightingData[27] = 0;
lightingData[28] = lightingConfig.ground.color[0];
lightingData[29] = lightingConfig.ground.color[1];
lightingData[30] = lightingConfig.ground.color[2];
lightingData[31] = lightingConfig.ground.intensity;
// Ambient + env (offset 32-35):
lightingData[32] = 0.3;  // ambient
lightingData[33] = 0.5;  // envMapStrength
lightingData[34] = 0;
lightingData[35] = 0;

device.queue.writeBuffer(lightingUniformBuffer, 0, lightingData);
*/

// ----------------------------------------------------------------------------
// PIPELINE SETUP (CPU-side JavaScript)
// ----------------------------------------------------------------------------
// Pipeline configuration for the enhanced shaders:
/*
const enhancedPipeline = device.createRenderPipeline({
  layout: 'auto',
  vertex: {
    module: device.createShaderModule({ code: enhancedVertexShaderCode }),
    entryPoint: 'enhancedRollerVertex',
    buffers: [{
      arrayStride: 32,  // 3*4 + 3*4 + 2*4 = position + normal + uv
      attributes: [
        { shaderLocation: 0, offset: 0, format: 'float32x3' },   // position
        { shaderLocation: 1, offset: 12, format: 'float32x3' },  // normal
        { shaderLocation: 2, offset: 24, format: 'float32x2' }   // uv
      ]
    }]
  },
  fragment: {
    module: device.createShaderModule({ code: enhancedFragmentShaderCode }),
    entryPoint: 'enhancedRollerFragment',
    targets: [{
      format: navigator.gpu.getPreferredCanvasFormat(),
      blend: {
        color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' }
      }
    }]
  },
  primitive: { topology: 'triangle-list', cullMode: 'back' },
  depthStencil: { depthWriteEnabled: true, depthCompare: 'less', format: 'depth24plus' }
});
*/
