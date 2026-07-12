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
