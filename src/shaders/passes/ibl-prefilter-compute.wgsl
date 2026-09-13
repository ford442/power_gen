// ============================================================================
// IBL specular prefilter (GGX split-sum) — compute path, ADR-0005 Workstream 2
// ============================================================================
// GPU port of the CPU bake in src/ibl-prefilter.ts. Same analytic studio
// environment, same octahedral layout, same array-layer scheme, so the sampling
// side (pbr-eval.wgsl: sampleIblLayer / iblSpecularRadiance / iblIrradiance) is
// unchanged and the two paths are interchangeable at runtime.
//
// One dispatch per output layer:
//   layer 0 .. IBL_SPEC_LEVELS-1 : GGX radiance for roughness i/(n-1)
//   layer IBL_SPEC_LEVELS        : cosine-convolved irradiance (E/pi)
// `params.job` carries which layer this dispatch writes. Keeping the layers as
// separate dispatches (rather than one 3D dispatch) keeps each submission short
// — the drama look's level 1 is 48 taps per texel — and lets the host interleave
// them without a long-running compute that can trip a watchdog.
//
// The split-sum's second (DFG) term stays the analytic Lazarov fit in
// pbr-eval.wgsl, so no BRDF LUT is baked here.
//
// Bindings — see docs/BINDINGS.md ("iblPrefilter" group):
//   0 IblPrefilterParams (uniform)   1 rgba16float 2d-array storage output

struct IblPrefilterParams {
  // xyz = normalized light direction, w = intensity
  keyDir      : vec4f,
  fillDir     : vec4f,
  rimDir      : vec4f,
  // xyz = linear colour, w unused (ground.w = ground intensity)
  keyColor    : vec4f,
  fillColor   : vec4f,
  rimColor    : vec4f,
  groundColor : vec4f,
  // xyz = sky gradient colour, skyTop.w = 1 when the preset has a sky block
  skyTop      : vec4f,
  skyHorizon  : vec4f,
  // x = layer index, y = roughness, z = sample count, w = 1 for the irradiance layer
  job         : vec4f,
}

@group(0) @binding(0) var<uniform> params : IblPrefilterParams;
@group(0) @binding(1) var outTex : texture_storage_2d_array<rgba16float, write>;

const TWO_PI : f32 = 6.283185307179586;

// ── octahedral decode ───────────────────────────────────────────────────────
// Inverse of octEncodeDir in common/pbr-eval.wgsl, and a direct transcription
// of octDecode in src/ibl-prefilter.ts. Folds about Y so the +Y hemisphere
// occupies the centre of the map.
fn octDecode(uv: vec2f) -> vec3f {
  let p = uv * 2.0 - vec2f(1.0);
  var x = p.x;
  var z = p.y;
  let y = 1.0 - abs(p.x) - abs(p.y);
  if (y < 0.0) {
    let ax = x;
    x = (1.0 - abs(z)) * select(-1.0, 1.0, ax >= 0.0);
    z = (1.0 - abs(ax)) * select(-1.0, 1.0, z >= 0.0);
  }
  let v = vec3f(x, y, z);
  let l = length(v);
  if (l <= 1e-8) { return vec3f(0.0, 1.0, 0.0); }
  return v / l;
}

/** Van der Corput radical inverse (base 2) — the Hammersley sequence's y. */
fn radicalInverseVdC(bitsIn: u32) -> f32 {
  var bits = bitsIn;
  bits = (bits << 16u) | (bits >> 16u);
  bits = ((bits & 0x55555555u) << 1u) | ((bits & 0xAAAAAAAAu) >> 1u);
  bits = ((bits & 0x33333333u) << 2u) | ((bits & 0xCCCCCCCCu) >> 2u);
  bits = ((bits & 0x0F0F0F0Fu) << 4u) | ((bits & 0xF0F0F0F0u) >> 4u);
  bits = ((bits & 0x00FF00FFu) << 8u) | ((bits & 0xFF00FF00u) >> 8u);
  return f32(bits) * 2.3283064365386963e-10;
}

/** Orthonormal basis around `n` (Duff et al., branchless) — matches basisFrom(). */
fn basisFrom(n: vec3f) -> mat2x3f {
  let s = select(-1.0, 1.0, n.z >= 0.0);
  let a = -1.0 / (s + n.z);
  let b = n.x * n.y * a;
  return mat2x3f(
    vec3f(1.0 + s * n.x * n.x * a, s * b, -s * n.x),
    vec3f(b, s + n.y * n.y * a, -n.y)
  );
}

// ── source environment ──────────────────────────────────────────────────────
// Transcription of envRadiance() in src/ibl-prefilter.ts. Any edit here must be
// mirrored there (and vice versa) or the compute and CPU bakes diverge and the
// look changes with the code path. The shaping constants below are compared
// against the TS ones by scripts/check-post-contracts.mjs, which cannot run
// WGSL and so cannot catch a structural change — keep the two functions
// line-for-line alike so a reviewer can diff them by eye.

fn addLobe(dir: vec3f, lightDir: vec3f, color: vec3f, intensity: f32,
           cosOuter: f32, cosInner: f32, gain: f32) -> vec3f {
  let d = dot(dir, lightDir);
  let w = smoothstep(cosOuter, cosInner, d) * intensity * gain;
  if (w <= 0.0) { return vec3f(0.0); }
  return color * w;
}

fn envRadiance(dir: vec3f) -> vec3f {
  let keyI = params.keyDir.w;
  let fillI = params.fillDir.w;
  let rimI = params.rimDir.w;
  let groundI = params.groundColor.w;

  let up = clamp(dir.y * 0.5 + 0.5, 0.0, 1.0);

  // Ceiling / floor wash.
  let skyMix = 0.55;
  let skyScale = fillI * 0.42 + keyI * 0.28;
  let groundScale = groundI * 3.2;

  let skyCol = (params.fillColor.rgb * (1.0 - skyMix) + params.keyColor.rgb * skyMix) * skyScale;
  let ceiling = skyCol * 0.65 + vec3f(0.92, 0.94, 0.97) * 0.35;
  let ground = params.groundColor.rgb * groundScale;
  // A touch of the sky-dome gradient keeps reflections coherent with the
  // background the rollers actually sit in front of.
  let domeCol = (params.skyHorizon.rgb * (1.0 - up) + params.skyTop.rgb * up) * params.skyTop.w;

  var outCol = (ground * (1.0 - up) + ceiling * up) * 0.78 + domeCol * 0.28;

  // Directional softboxes: key reads as a broad blob on chrome, rim as a tight
  // edge streak.
  outCol += addLobe(dir, params.keyDir.xyz, params.keyColor.rgb, keyI, 0.82, 0.965, 1.55);
  outCol += addLobe(dir, params.fillDir.xyz, params.fillColor.rgb, fillI, 0.62, 0.94, 0.85);
  outCol += addLobe(dir, params.rimDir.xyz, params.rimColor.rgb, rimI, 0.90, 0.995, 1.15);

  // Floor bounce of the key, so the underside of the rollers is not dead black.
  if (dir.y < 0.0) {
    let bounce = -dir.y * keyI * 0.16;
    outCol += params.groundColor.rgb * params.keyColor.rgb * bounce;
  }
  return outCol;
}

// ── prefilter kernels ───────────────────────────────────────────────────────

/** GGX split-sum with V = R = N (the standard approximation). */
fn prefilterGGX(N: vec3f, roughness: f32, sampleCount: u32) -> vec3f {
  let a = roughness * roughness;
  let basis = basisFrom(N);
  let T = basis[0];
  let B = basis[1];

  var acc = vec3f(0.0);
  var totalWeight = 0.0;

  for (var s: u32 = 0u; s < sampleCount; s = s + 1u) {
    let u1 = f32(s) / f32(sampleCount);
    let u2 = radicalInverseVdC(s);
    let phi = TWO_PI * u1;
    let cosTheta = sqrt((1.0 - u2) / (1.0 + (a * a - 1.0) * u2));
    let sinTheta = sqrt(max(0.0, 1.0 - cosTheta * cosTheta));

    let H = T * (sinTheta * cos(phi)) + B * (sinTheta * sin(phi)) + N * cosTheta;
    let NdotH = dot(N, H);
    let L = normalize(2.0 * NdotH * H - N);
    let NdotL = dot(N, L);
    if (NdotL <= 0.0) { continue; }
    acc += envRadiance(L) * NdotL;
    totalWeight += NdotL;
  }

  if (totalWeight > 0.0) { return acc / totalWeight; }
  return envRadiance(N);
}

/** Cosine-importance-sampled irradiance, stored as E/pi. */
fn prefilterIrradiance(N: vec3f, sampleCount: u32) -> vec3f {
  let basis = basisFrom(N);
  let T = basis[0];
  let B = basis[1];

  var acc = vec3f(0.0);
  for (var s: u32 = 0u; s < sampleCount; s = s + 1u) {
    let u1 = f32(s) / f32(sampleCount);
    let u2 = radicalInverseVdC(s);
    let r = sqrt(u1);
    let phi = TWO_PI * u2;
    let L = normalize(
      T * (r * cos(phi)) + B * (r * sin(phi)) + N * sqrt(max(0.0, 1.0 - u1))
    );
    acc += envRadiance(L);
  }
  return acc / f32(sampleCount);
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let dims = textureDimensions(outTex);
  if (gid.x >= dims.x || gid.y >= dims.y) { return; }

  let size = vec2f(f32(dims.x), f32(dims.y));
  // Texel centres, matching the CPU bake's (x + 0.5) / size.
  let uv = (vec2f(f32(gid.x), f32(gid.y)) + vec2f(0.5)) / size;
  let N = octDecode(uv);

  let layer = i32(params.job.x);
  let roughness = params.job.y;
  let sampleCount = u32(max(params.job.z, 1.0));
  let isIrradiance = params.job.w > 0.5;

  var rgb: vec3f;
  if (isIrradiance) {
    rgb = prefilterIrradiance(N, sampleCount);
  } else if (sampleCount <= 1u) {
    // Level 0 is a single mirror tap.
    rgb = envRadiance(N);
  } else {
    rgb = prefilterGGX(N, roughness, sampleCount);
  }

  textureStore(outTex, vec2i(i32(gid.x), i32(gid.y)), layer, vec4f(rgb, 1.0));
}
