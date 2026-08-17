// ============================================================================
// Screen-space reflections (view-space ray march) — ADR-0005 Workstream 2
// ============================================================================
// Runs after the scene pass and before bloom composite. Reconstructs view-space
// position and normal from the existing depth buffer (there is no G-buffer in
// this renderer), marches the reflected ray, and writes a reflection colour +
// confidence into a half-resolution rgba16float storage texture that
// bloom-composite samples after its SSAO / contact-shadow term.
//
// Because depth is the only geometric input, per-pixel roughness / metalness are
// unknown: the reflection is weighted by a Fresnel-style grazing term plus hit
// confidence, and the global strength comes from the lighting preset
// (`ssrStrength`) scaled by the quality-tier gate. That reads correctly on the
// SEG chrome/nickel rollers, which are the surfaces this pass exists for.
//
// Bindings — see docs/BINDINGS.md ("ssr" group):
//   0 depth (texture_depth_2d, full-res)   1 scene colour (full-res)
//   2 filtering sampler                    3 SsrParams
//   4 reflection output (storage, half-res)

struct SsrParams {
  invProj      : mat4x4f,  // clip → view (matches the camera's GL-style proj)
  proj         : mat4x4f,  // view → clip
  outSize      : vec2f,    // reflection target size in texels
  depthSize    : vec2f,    // depth / scene texture size in texels
  maxSteps     : f32,      // hard cap on march iterations
  marchStride  : f32,      // view-space units per first step
  maxDistance  : f32,      // view-space ray length budget
  thickness    : f32,      // depth-buffer "shell" thickness for a hit test
  strength     : f32,      // preset ssrStrength × quality gate (0 disables)
  edgeFade     : f32,      // screen-border fade width in UV
  jitter       : f32,      // per-pixel ray offset to break up banding
  _pad0        : f32,
}

@group(0) @binding(0) var ssrDepthTex   : texture_depth_2d;
@group(0) @binding(1) var ssrSceneTex   : texture_2d<f32>;
@group(0) @binding(2) var ssrSampler    : sampler;
@group(0) @binding(3) var<uniform> ssr  : SsrParams;
@group(0) @binding(4) var ssrOut        : texture_storage_2d<rgba16float, write>;

const SSR_MAX_STEPS: i32 = 64;

fn hash21(p: vec2f) -> f32 {
  let h = dot(p, vec2f(127.1, 311.7));
  return fract(sin(h) * 43758.5453123);
}

/** Load raw depth (NDC z, as written by the camera's GL-style projection). */
fn loadDepth(uv: vec2f) -> f32 {
  let dim = vec2f(ssr.depthSize);
  let c = vec2i(clamp(uv * dim, vec2f(0.0), dim - vec2f(1.0)));
  return textureLoad(ssrDepthTex, c, 0);
}

/** Unproject a UV + depth-buffer sample back into view space. */
fn viewPosFromUv(uv: vec2f, depth: f32) -> vec3f {
  let ndc = vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, depth, 1.0);
  let p = ssr.invProj * ndc;
  return p.xyz / p.w;
}

/** Project a view-space point back to (uv, ndcDepth). */
fn uvFromViewPos(vp: vec3f) -> vec3f {
  let clip = ssr.proj * vec4f(vp, 1.0);
  if (abs(clip.w) < 1e-6) { return vec3f(-1.0, -1.0, 1.0); }
  let ndc = clip.xyz / clip.w;
  return vec3f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5, ndc.z);
}

/**
 * Depth-derived view-space normal. Picks the nearer neighbour on each axis so
 * silhouettes do not smear a normal across a depth discontinuity.
 */
fn viewNormal(uv: vec2f, centerPos: vec3f) -> vec3f {
  let ts = 1.0 / vec2f(ssr.depthSize);

  let rUv = uv + vec2f(ts.x, 0.0);
  let lUv = uv - vec2f(ts.x, 0.0);
  let dUv = uv + vec2f(0.0, ts.y);
  let uUv = uv - vec2f(0.0, ts.y);

  let pr = viewPosFromUv(rUv, loadDepth(rUv));
  let pl = viewPosFromUv(lUv, loadDepth(lUv));
  let pd = viewPosFromUv(dUv, loadDepth(dUv));
  let pu = viewPosFromUv(uUv, loadDepth(uUv));

  var dx = pr - centerPos;
  if (abs(pl.z - centerPos.z) < abs(pr.z - centerPos.z)) { dx = centerPos - pl; }
  var dy = pd - centerPos;
  if (abs(pu.z - centerPos.z) < abs(pd.z - centerPos.z)) { dy = centerPos - pu; }

  var n = normalize(cross(dx, dy));
  // View space looks down -Z, so a valid normal must face the camera.
  if (dot(n, centerPos) > 0.0) { n = -n; }
  return n;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let outDim = vec2u(u32(ssr.outSize.x), u32(ssr.outSize.y));
  if (gid.x >= outDim.x || gid.y >= outDim.y) { return; }
  let coord = vec2i(i32(gid.x), i32(gid.y));

  if (ssr.strength <= 0.001) {
    textureStore(ssrOut, coord, vec4f(0.0));
    return;
  }

  let uv = (vec2f(f32(gid.x), f32(gid.y)) + vec2f(0.5)) / ssr.outSize;
  let depth = loadDepth(uv);

  // Far plane / sky — nothing to reflect from.
  if (depth >= 0.9999) {
    textureStore(ssrOut, coord, vec4f(0.0));
    return;
  }

  let originPos = viewPosFromUv(uv, depth);
  let N = viewNormal(uv, originPos);
  let V = normalize(-originPos);
  let NdotV = dot(N, V);
  if (NdotV <= 0.02) {
    textureStore(ssrOut, coord, vec4f(0.0));
    return;
  }

  let R = normalize(reflect(-V, N));

  // Rays travelling back toward the camera cannot be resolved from a single
  // depth layer — fade them out rather than smearing a wrong hit.
  let backFacing = clamp(dot(R, V), 0.0, 1.0);
  let dirFade = 1.0 - backFacing * backFacing;
  if (dirFade <= 0.01) {
    textureStore(ssrOut, coord, vec4f(0.0));
    return;
  }

  let steps = i32(clamp(ssr.maxSteps, 8.0, f32(SSR_MAX_STEPS)));
  let jitter = mix(1.0, hash21(uv * ssr.depthSize), clamp(ssr.jitter, 0.0, 1.0));
  // Geometric step growth: dense near the origin (contact reflections), coarse
  // far away, so `maxDistance` is covered without burning the step budget.
  let growth = 1.0 + 2.0 / f32(steps);

  var travelled = ssr.marchStride * (0.5 + 0.5 * jitter);
  var stepLen = ssr.marchStride;
  var hitUv = vec2f(0.0);
  var hit = false;
  var hitDist = 0.0;

  for (var i = 0; i < steps; i = i + 1) {
    if (travelled > ssr.maxDistance) { break; }

    let samplePos = originPos + R * travelled;
    // Behind the camera — the projection would wrap the ray to the far side.
    if (samplePos.z >= -0.001) { break; }

    let proj = uvFromViewPos(samplePos);
    if (proj.x < 0.0 || proj.x > 1.0 || proj.y < 0.0 || proj.y > 1.0) { break; }

    let sceneDepth = loadDepth(proj.xy);
    if (sceneDepth < 0.9999) {
      let scenePos = viewPosFromUv(proj.xy, sceneDepth);
      // Positive delta ⇒ the ray is behind the depth-buffer surface.
      let delta = scenePos.z - samplePos.z;
      if (delta > 0.0 && delta < ssr.thickness + stepLen) {
        // Binary refine so the hit lands on the surface, not the step grid.
        var lo = max(travelled - stepLen, 0.0);
        var hi = travelled;
        for (var b = 0; b < 5; b = b + 1) {
          let mid = (lo + hi) * 0.5;
          let mp = originPos + R * mid;
          let mProj = uvFromViewPos(mp);
          let mDepth = loadDepth(mProj.xy);
          let mScene = viewPosFromUv(mProj.xy, mDepth);
          if (mScene.z - mp.z > 0.0) { hi = mid; } else { lo = mid; }
        }
        hitUv = uvFromViewPos(originPos + R * hi).xy;
        hitDist = hi;
        hit = true;
        break;
      }
    }

    stepLen = stepLen * growth;
    travelled = travelled + stepLen;
  }

  if (!hit) {
    textureStore(ssrOut, coord, vec4f(0.0));
    return;
  }

  // Fade at the screen border, with ray length, and at head-on incidence
  // (Schlick-style grazing weight standing in for the missing roughness).
  let border = min(min(hitUv.x, 1.0 - hitUv.x), min(hitUv.y, 1.0 - hitUv.y));
  let edge = smoothstep(0.0, max(ssr.edgeFade, 0.001), border);
  let distFade = 1.0 - smoothstep(ssr.maxDistance * 0.55, ssr.maxDistance, hitDist);
  let fresnel = 0.06 + 0.94 * pow(1.0 - NdotV, 4.0);

  let weight = clamp(edge * distFade * dirFade * fresnel, 0.0, 1.0);
  let color = textureSampleLevel(ssrSceneTex, ssrSampler, hitUv, 0.0).rgb;

  textureStore(ssrOut, coord, vec4f(color * weight, weight));
}
