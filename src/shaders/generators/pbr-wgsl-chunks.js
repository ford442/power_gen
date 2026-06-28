/**
 * Reusable WGSL snippets for Cook-Torrance / GGX PBR across SEG shaders.
 * Included via string concatenation in seg-enhanced-shaders.js and roller-shaders.js.
 */

/** Noise, normal perturbation, and surface micro-detail. */
export const PBR_SURFACE_WGSL = /* wgsl */ `
  fn hash3(p: vec3f) -> vec3f {
    let q = vec3f(
      dot(p, vec3f(127.1, 311.7, 74.7)),
      dot(p, vec3f(269.5, 183.3, 246.1)),
      dot(p, vec3f(113.5, 271.9, 124.6))
    );
    return fract(sin(q) * 43758.5453);
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

  fn detailNormal(n: vec3f, p: vec3f, detailScale: f32) -> vec3f {
    let upRef = select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(n.y) > 0.94);
    let t = normalize(cross(upRef, n));
    let b = cross(n, t);
    let dn1 = fbm(p * detailScale + vec3f(0.3, 4.2, 1.1)) - 0.5;
    let dn2 = fbm(p * detailScale + vec3f(3.7, 0.8, 2.4)) - 0.5;
    return normalize(n + t * dn1 * 0.22 + b * dn2 * 0.22);
  }

  /** Axial brushing for cylindrical rollers / rings (tangent along Y). */
  fn brushedMetalNormal(n: vec3f, p: vec3f, brushScale: f32, strength: f32) -> vec3f {
    let upRef = select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(n.y) > 0.94);
    let tangent = normalize(cross(upRef, n));
    let bitangent = cross(n, tangent);
    let brush = fbm(vec3f(p.y * brushScale, atan2(p.z, p.x) * 2.0, 0.0)) - 0.5;
    let micro = fbm(p * brushScale * 2.5) - 0.5;
    return normalize(n + tangent * brush * strength + bitangent * micro * strength * 0.35);
  }

  /** Circular knurling for plate edges and ring faces. */
  fn knurlNormal(n: vec3f, p: vec3f, freq: f32, strength: f32) -> vec3f {
    let theta = atan2(p.z, p.x);
    let knurl = sin(theta * freq + p.y * freq * 0.4) * 0.5;
    let upRef = select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(n.y) > 0.94);
    let t = normalize(cross(upRef, n));
    return normalize(n + t * knurl * strength);
  }
`;

/** BRDF + lighting evaluation. */
export const PBR_BRDF_WGSL = /* wgsl */ `
  fn fresnelSchlick(cosTheta: f32, f0: vec3f) -> vec3f {
    return f0 + (vec3f(1.0) - f0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
  }

  fn distributionGGX(NdotH: f32, roughness: f32) -> f32 {
    let a = roughness * roughness;
    let a2 = a * a;
    let denom = NdotH * NdotH * (a2 - 1.0) + 1.0;
    return a2 / (3.14159265 * denom * denom + 1e-5);
  }

  fn distributionGGXAniso(NdotH: f32, TdotH: f32, BdotH: f32, roughX: f32, roughY: f32) -> f32 {
    let ax = roughX * roughX;
    let ay = roughY * roughY;
    let d = (TdotH * TdotH) / (ax * ax + 1e-5) + (BdotH * BdotH) / (ay * ay + 1e-5) + NdotH * NdotH;
    return 1.0 / (3.14159265 * ax * ay * d * d + 1e-5);
  }

  fn geometrySmith(NdotV: f32, NdotL: f32, roughness: f32) -> f32 {
    let k = (roughness + 1.0) * (roughness + 1.0) / 8.0;
    let ggx1 = NdotV / (NdotV * (1.0 - k) + k + 1e-5);
    let ggx2 = NdotL / (NdotL * (1.0 - k) + k + 1e-5);
    return ggx1 * ggx2;
  }

  fn blackbody(temp: f32) -> vec3f {
    let t = clamp(temp, 800.0, 3500.0) / 1000.0;
    let warm = vec3f(1.0, 0.4 + t * 0.3, 0.1 + t * 0.6);
    return warm * max(0.0, t - 0.8);
  }
`;

/** Lighting uniform block — matches CPU upload in multi-device-visualizer.js (48 floats). */
export const PBR_LIGHTING_STRUCT_WGSL = /* wgsl */ `
  struct LightData {
    posOrDir: vec3f,
    _pad0: f32,
    color: vec3f,
    intensity: f32,
  }

  struct LightingConfig {
    key: LightData,
    fill: LightData,
    rim: LightData,
    ground: LightData,
    ambient: f32,
    envMapStrength: f32,
    shadowStrength: f32,
    _padEnd: f32,
  }
`;

/** Directional PBR + hemispherical IBL approximation. */
export const PBR_EVAL_WGSL = /* wgsl */ `
  struct PBRResult {
    color: vec3f,
  }

  fn lightDirFromPos(pos: vec3f) -> vec3f {
    return normalize(pos);
  }

  fn specularGGX(N: vec3f, V: vec3f, L: vec3f, T: vec3f, B: vec3f,
                 roughness: f32, roughX: f32, roughY: f32, f0: vec3f,
                 aniso: bool) -> vec3f {
    let H = normalize(V + L);
    let NdotV = max(dot(N, V), 0.001);
    let NdotL = max(dot(N, L), 0.0);
    let NdotH = max(dot(N, H), 0.0);
    var D: f32;
    if (aniso) {
      D = distributionGGXAniso(NdotH, dot(T, H), dot(B, H), roughX, roughY);
    } else {
      D = distributionGGX(NdotH, roughness);
    }
    let G = geometrySmith(NdotV, NdotL, roughness);
    let F = fresnelSchlick(max(dot(H, V), 0.0), f0);
    return (D * G * F) / (4.0 * NdotV * NdotL + 0.001) * NdotL;
  }

  /** Studio-style split-sum hemispherical IBL (softbox ceiling + floor bounce). */
  fn approximateIBL(N: vec3f, V: vec3f, roughness: f32, metallic: f32,
                    f0: vec3f, lighting: LightingConfig) -> vec3f {
    let R = reflect(-V, N);
    let upBlend = clamp(R.y * 0.5 + 0.5, 0.0, 1.0);
    let Nup = clamp(N.y * 0.5 + 0.5, 0.0, 1.0);

    // Overhead softbox + side fill reflection
    let skyCol = mix(lighting.fill.color, lighting.key.color, 0.55) *
                 (lighting.fill.intensity * 0.42 + lighting.key.intensity * 0.28);
    let ceilingCol = mix(skyCol, vec3f(0.92, 0.94, 0.97), 0.35);
    let groundCol = lighting.ground.color * lighting.ground.intensity * 3.2;
    let envColor = mix(groundCol, ceilingCol + vec3f(0.06, 0.08, 0.12), upBlend);

    let NdotV = max(dot(N, V), 0.0);
    let fresnel = fresnelSchlick(NdotV, f0);
    let roughFade = 1.0 - roughness * roughness * 0.82;
    let specWeight = mix(0.38, 1.0, metallic);
    let ao = mix(1.0, 0.72 + Nup * 0.28, lighting.shadowStrength * 0.35);
    return envColor * fresnel * roughFade * specWeight * lighting.envMapStrength * ao;
  }

  fn evaluatePBR(N: vec3f, V: vec3f, albedo: vec3f, metallic: f32, roughness: f32,
                 T: vec3f, B: vec3f, lighting: LightingConfig, aniso: bool) -> vec3f {
    let f0 = mix(vec3f(0.04), albedo, metallic);
    let roughX = roughness * 0.55;
    let roughY = roughness * 1.45;

    let Lk = lightDirFromPos(lighting.key.posOrDir);
    let Lf = lightDirFromPos(lighting.fill.posOrDir);
    let specK = specularGGX(N, V, Lk, T, B, roughness, roughX, roughY, f0, aniso);
    let specF = specularGGX(N, V, Lf, T, B, roughness, roughX, roughY, f0, aniso);
    let specular = specK * lighting.key.color * lighting.key.intensity +
                   specF * lighting.fill.color * lighting.fill.intensity * 0.45;

    let NdotLk = max(dot(N, Lk), 0.0);
    let NdotLf = max(dot(N, Lf), 0.0);
    let Fk = fresnelSchlick(max(dot(normalize(V + Lk), V), 0.0), f0);
    let Ff = fresnelSchlick(max(dot(normalize(V + Lf), V), 0.0), f0);
    let kDk = (vec3f(1.0) - Fk) * (1.0 - metallic);
    let kDf = (vec3f(1.0) - Ff) * (1.0 - metallic);
    let diffuse = albedo * 3.14159265 * (
      kDk * NdotLk * lighting.key.color * lighting.key.intensity +
      kDf * NdotLf * lighting.fill.color * lighting.fill.intensity * 0.4
    );

    let NdotV = max(dot(N, V), 0.0);
    let rimFactor = pow(1.0 - NdotV, 3.2) * lighting.rim.intensity;
    let rimLight = lighting.rim.color * rimFactor;

    let ibl = approximateIBL(N, V, roughness, metallic, f0, lighting);
    let crevice = mix(1.0, 0.55 + NdotV * 0.45, lighting.shadowStrength * 0.25);
    let ambient = albedo * lighting.ambient * vec3f(0.12, 0.14, 0.18) * crevice;

    return ambient + diffuse + specular + rimLight + ibl;
  }

  fn acesTonemap(color: vec3f) -> vec3f {
    return color * (2.51 * color + 0.03) / (color * (2.43 * color + 0.59) + 0.14);
  }
`;
