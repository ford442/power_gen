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
