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

  // ── Prefiltered environment (GGX split-sum) ───────────────────────────────
  // `iblEnvTex` is a 2D array texture baked on the CPU at startup by
  // src/ibl-prefilter.js: layers 0..IBL_SPEC_LEVELS-1 hold octahedral GGX
  // radiance for roughness i/(n-1), the last layer holds cosine irradiance.
  // These constants are asserted against the JS ones by assertIblShaderContract.
  const IBL_TEX_SIZE: f32 = 64.0;
  const IBL_SPEC_LEVELS: f32 = 6.0;

  /**
   * Diffuse IBL gain. The polynomial this replaced folded no albedo into its
   * irradiance term, so the honest E·albedo result is scaled to keep the
   * ADR-0005 exposure calibration (see docs/LIGHTING_RIG.md).
   */
  const IBL_DIFFUSE_SCALE: f32 = 0.45;

  /** Octahedral encode — inverse of `octDecode` in src/ibl-prefilter.js. */
  fn octEncodeDir(d: vec3f) -> vec2f {
    let n = d / (abs(d.x) + abs(d.y) + abs(d.z) + 1e-6);
    var p = vec2f(n.x, n.z);
    if (n.y <= 0.0) {
      let s = vec2f(select(-1.0, 1.0, p.x >= 0.0), select(-1.0, 1.0, p.y >= 0.0));
      p = (vec2f(1.0) - abs(vec2f(p.y, p.x))) * s;
    }
    return p * 0.5 + vec2f(0.5);
  }

  fn sampleIblLayer(dir: vec3f, layer: i32) -> vec3f {
    let uv = octEncodeDir(normalize(dir));
    // Half-texel inset: without it linear filtering bleeds across the
    // octahedron's outer seam and rings the horizon.
    let inset = uv * (1.0 - 1.0 / IBL_TEX_SIZE) + vec2f(0.5 / IBL_TEX_SIZE);
    return textureSampleLevel(iblEnvTex, iblEnvSampler, inset, layer, 0.0).rgb;
  }

  /** Blend the two roughness layers straddling `roughness`. */
  fn iblSpecularRadiance(R: vec3f, roughness: f32) -> vec3f {
    let l = clamp(roughness, 0.0, 1.0) * (IBL_SPEC_LEVELS - 1.0);
    let lo = floor(l);
    let hi = min(lo + 1.0, IBL_SPEC_LEVELS - 1.0);
    return mix(sampleIblLayer(R, i32(lo)), sampleIblLayer(R, i32(hi)), l - lo);
  }

  fn iblIrradiance(N: vec3f) -> vec3f {
    return sampleIblLayer(N, i32(IBL_SPEC_LEVELS));
  }

  /**
   * Split-sum DFG term, Lazarov's analytic fit — saves a BRDF LUT texture and
   * matches the reference integral to well under a quantisation step at 8 bit.
   */
  fn envBRDFApprox(f0: vec3f, roughness: f32, NdotV: f32) -> vec3f {
    let c0 = vec4f(-1.0, -0.0275, -0.572, 0.022);
    let c1 = vec4f(1.0, 0.0425, 1.04, -0.04);
    let r = vec4f(roughness) * c0 + c1;
    let a004 = min(r.x * r.x, exp2(-9.28 * NdotV)) * r.x + r.y;
    let ab = vec2f(-1.04, 1.04) * a004 + r.zw;
    return f0 * ab.x + vec3f(ab.y);
  }

  /**
   * Analytic studio env radiance (softbox ceiling + floor bounce).
   * `mip` 0 = sharp reflection, 1 = fully filtered irradiance — stands in for
   * 2–3 prefiltered env mips without a PMREM atlas (ADR-0003 / ADR-0005).
   *
   * Retained as the fallback path: used when `lighting.iblLevels` is 0, i.e.
   * the prefiltered array texture has not been baked yet.
   */
  fn envRadiance(dir: vec3f, lighting: LightingConfig, mip: f32) -> vec3f {
    let d = normalize(dir);
    let upBlend = clamp(d.y * 0.5 + 0.5, 0.0, 1.0);
    let skyCol = mix(lighting.fill.color, lighting.key.color, 0.55) *
                 (lighting.fill.intensity * 0.42 + lighting.key.intensity * 0.28);
    let ceilingCol = mix(skyCol, vec3f(0.92, 0.94, 0.97), 0.35);
    let groundCol = lighting.ground.color * lighting.ground.intensity * 3.2;
    let sharp = mix(groundCol, ceilingCol + vec3f(0.06, 0.08, 0.12), upBlend);
    // Horizon fill + key bleed for mid mips (readable metal lobes under studio/drama)
    let mid = mix(
      mix(groundCol, ceilingCol, 0.55),
      lighting.key.color * lighting.key.intensity * 0.18 +
        lighting.rim.color * lighting.rim.intensity * 0.12,
      0.28
    );
    let irr = mix(groundCol * 0.9, ceilingCol * 0.95, 0.58);
    let m = clamp(mip, 0.0, 1.0);
    let a = mix(sharp, mid, smoothstep(0.0, 0.45, m));
    return mix(a, irr, smoothstep(0.35, 1.0, m));
  }

  /**
   * Fallback IBL: roughness selects analytic env mips; metals keep crisp
   * Fresnel lobes; dielectrics get a soft diffuse irradiance term.
   * Only reached when the prefiltered chain is unavailable.
   */
  fn approximateIBL(N: vec3f, V: vec3f, roughness: f32, metallic: f32,
                    f0: vec3f, lighting: LightingConfig) -> vec3f {
    let Nn = normalize(N);
    let R = reflect(-V, Nn);
    let Nup = clamp(Nn.y * 0.5 + 0.5, 0.0, 1.0);
    let NdotV = max(dot(Nn, V), 0.0);
    let fresnel = fresnelSchlick(NdotV, f0);

    // Specular: blend sharp / mid / irradiance mips from roughness²
    let mip = roughness * roughness;
    let mip0 = envRadiance(R, lighting, 0.0);
    let mip1 = envRadiance(normalize(mix(R, Nn, 0.32)), lighting, 0.42);
    let mip2 = envRadiance(Nn, lighting, 1.0);
    let specEnv = mix(mix(mip0, mip1, smoothstep(0.0, 0.4, mip)),
                      mip2, smoothstep(0.3, 1.0, mip));

    // Metals stay brighter; rough fade softens grazing without killing lobes
    let roughFade = mix(1.0, 0.55, mip * 0.9);
    let specWeight = mix(0.42, 1.05, metallic);
    let ao = mix(1.0, 0.72 + Nup * 0.28, lighting.shadowStrength * 0.35);
    let specularIBL = specEnv * fresnel * roughFade * specWeight;

    // Cheap diffuse irradiance for non-metals (no albedo here — scaled gently)
    let diffIrr = envRadiance(Nn, lighting, 0.92);
    let fresnelAvg = (fresnel.r + fresnel.g + fresnel.b) * 0.333333;
    let diffuseIBL = diffIrr * (1.0 - metallic) * (1.0 - fresnelAvg) * 0.16;

    return (specularIBL + diffuseIBL) * lighting.envMapStrength * ao;
  }

  /**
   * Split-sum IBL against the prefiltered env array texture.
   * Falls back to `approximateIBL` until the CPU bake has been uploaded
   * (`lighting.iblLevels` is written by the render loop once it has).
   */
  fn evaluateIBL(N: vec3f, V: vec3f, albedo: vec3f, roughness: f32, metallic: f32,
                 f0: vec3f, lighting: LightingConfig) -> vec3f {
    if (lighting.iblLevels < 0.5) {
      return approximateIBL(N, V, roughness, metallic, f0, lighting);
    }

    let Nn = normalize(N);
    let R = reflect(-V, Nn);
    let NdotV = max(dot(Nn, V), 0.001);

    let specular = iblSpecularRadiance(R, roughness) * envBRDFApprox(f0, roughness, NdotV);

    let F = fresnelSchlick(NdotV, f0);
    let kD = (vec3f(1.0) - F) * (1.0 - metallic);
    let diffuse = iblIrradiance(Nn) * albedo * kD * IBL_DIFFUSE_SCALE;

    // Same hemispherical occlusion the analytic path applied, so switching
    // between the two does not change how grounded the device looks.
    let Nup = clamp(Nn.y * 0.5 + 0.5, 0.0, 1.0);
    let ao = mix(1.0, 0.72 + Nup * 0.28, lighting.shadowStrength * 0.35);

    return (specular + diffuse) * lighting.envMapStrength * ao;
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

    let ibl = evaluateIBL(N, V, albedo, roughness, metallic, f0, lighting);
    let crevice = mix(1.0, 0.55 + NdotV * 0.45, lighting.shadowStrength * 0.25);
    let ambient = albedo * lighting.ambient * vec3f(0.12, 0.14, 0.18) * crevice;

    return ambient + diffuse + specular + rimLight + ibl;
  }

  fn acesTonemap(color: vec3f) -> vec3f {
    return color * (2.51 * color + 0.03) / (color * (2.43 * color + 0.59) + 0.14);
  }
