// Screen-space liquid surface, step 3 — composite (ADR-0022, docs/FLUIDS.md).
//
// Shades the filtered liquid depth as a surface and blends it over the scene
// colour, before TAA, SSR and bloom so all three see it:
//
//   normal       from depth differences, taking the smaller step on each axis
//                so a silhouette does not tilt the normal
//   refraction   the scene colour behind, looked up off-centre along the
//                normal, further for thicker liquid
//   absorption   Beer–Lambert on the thickness, per colour channel
//   reflection   the prefiltered environment the metal reads (frame group),
//                weighted by Schlick's Fresnel term for water (F0 = 0.02)
//   highlight    GGX from the key light
//
// A pixel is left alone where there is no liquid or the scene is in front of
// it. Thin liquid fades in over `edgeThickness`.

#include "common/fluid-surface.wgsl"

// Frame group: only the lighting and the environment are read here — the
// camera comes in `surface`, in the terms the splat used.
// Declared ahead of the PBR chunks: pbr-eval.wgsl samples these directly.
@group(0) @binding(7) var iblEnvTex: texture_2d_array<f32>;
@group(0) @binding(8) var iblEnvSampler: sampler;

#include "common/pbr-lighting.wgsl"
#include "common/pbr-brdf.wgsl"
#include "common/pbr-eval.wgsl"

@group(0) @binding(5) var<uniform> lighting: LightingConfig;

@group(1) @binding(0) var<uniform> surface: FluidSurfaceParams;
@group(1) @binding(1) var liquidDepth: texture_depth_2d;
@group(1) @binding(2) var liquidThickness: texture_2d<f32>;
@group(1) @binding(3) var sceneColor: texture_2d<f32>;
@group(1) @binding(4) var sceneDepth: texture_depth_2d;
@group(1) @binding(5) var linearSampler: sampler;

/// Water's normal-incidence reflectance.
const FLUID_F0 = 0.02;
/// The refraction lookup never moves further than this, in uv.
const FLUID_MAX_REFRACT_UV = 0.06;

struct CompositeVertex {
  @builtin(position) position: vec4f,
}

@vertex
fn vsComposite(@builtin(vertex_index) vertexIndex: u32) -> CompositeVertex {
  return CompositeVertex(fluidFullscreen(vertexIndex));
}

/// Liquid distance at a pixel, or a very large one where there is none.
fn liquidDistance(pixel: vec2i) -> f32 {
  let size = vec2i(surface.targetSize);
  if (any(pixel < vec2i(0)) || any(pixel >= size)) { return 1.0e9; }
  let d = textureLoad(liquidDepth, pixel, 0);
  return select(d * surface.zFar, 1.0e9, d >= FLUID_EMPTY);
}

/// Distance along the view axis of the opaque scene at a pixel.
fn sceneDistance(pixel: vec2i) -> f32 {
  let size = vec2i(surface.targetSize);
  let d = textureLoad(sceneDepth, clamp(pixel, vec2i(0), size - vec2i(1)), 0);
  return surface.depthAB.y / (d + surface.depthAB.x);
}

@fragment
fn fsComposite(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let pixel = vec2i(frag.xy);
  let distance = liquidDistance(pixel);
  if (distance > 1.0e8) { discard; }
  // The opaque scene is in front of the liquid here.
  if (sceneDistance(pixel) < distance - 0.5 * surface.radius) { discard; }

  // View-space surface position and its neighbours.
  let centre = fluidViewPos(frag.xy, distance, surface);
  let zl = liquidDistance(pixel - vec2i(1, 0));
  let zr = liquidDistance(pixel + vec2i(1, 0));
  let zu = liquidDistance(pixel - vec2i(0, 1));
  let zd = liquidDistance(pixel + vec2i(0, 1));
  var ddx = fluidViewPos(frag.xy + vec2f(1.0, 0.0), distance, surface) - centre;
  if (min(zl, zr) < 1.0e8) {
    if (abs(zr - distance) < abs(zl - distance)) {
      ddx = fluidViewPos(frag.xy + vec2f(1.0, 0.0), zr, surface) - centre;
    } else {
      ddx = centre - fluidViewPos(frag.xy - vec2f(1.0, 0.0), zl, surface);
    }
  }
  var ddy = fluidViewPos(frag.xy + vec2f(0.0, 1.0), distance, surface) - centre;
  if (min(zu, zd) < 1.0e8) {
    if (abs(zd - distance) < abs(zu - distance)) {
      ddy = fluidViewPos(frag.xy + vec2f(0.0, 1.0), zd, surface) - centre;
    } else {
      ddy = centre - fluidViewPos(frag.xy - vec2f(0.0, 1.0), zu, surface);
    }
  }
  // Pixel y runs down, so ddy points down: this order faces the camera.
  var normalView = normalize(cross(ddy, ddx));
  if (normalView.z < 0.0) { normalView = -normalView; }
  let viewDirView = normalize(-centre);
  let N = normalize(surface.camRight * normalView.x + surface.camUp * normalView.y + surface.camBack * normalView.z);
  let V = normalize(surface.camRight * viewDirView.x + surface.camUp * viewDirView.y + surface.camBack * viewDirView.z);
  let NdotV = max(dot(N, V), 0.0);

  let uv = frag.xy / surface.targetSize;
  let thickness = textureSampleLevel(liquidThickness, linearSampler, uv, 0.0).r;
  let thicknessM = thickness * surface.metresPerUnit;

  // Refraction: the background seen through the liquid, displaced along the
  // normal. If the displaced lookup lands on something in front of the
  // liquid, it would smear that object into the water: look straight through.
  let bend = clamp(vec2f(normalView.x, -normalView.y) * surface.refraction * thicknessM / max(distance, 1.0),
                   vec2f(-FLUID_MAX_REFRACT_UV), vec2f(FLUID_MAX_REFRACT_UV));
  var uvBehind = clamp(uv + bend, vec2f(0.0), vec2f(1.0));
  if (sceneDistance(vec2i(uvBehind * surface.targetSize)) < distance) { uvBehind = uv; }
  let behind = textureSampleLevel(sceneColor, linearSampler, uvBehind, 0.0).rgb;

  // Absorption, and the light the liquid scatters back where it absorbs.
  let transmit = exp(-surface.absorption * thicknessM);
  let hasIbl = lighting.iblLevels > 0.5;
  let irradiance = select(envRadiance(N, lighting, 1.0), iblIrradiance(N), hasIbl) * lighting.envMapStrength
    + vec3f(lighting.ambient);
  let body = behind * transmit + surface.scatter * irradiance * (vec3f(1.0) - transmit);

  // Reflection of the environment and the key light's highlight.
  let R = reflect(-V, N);
  let rough = clamp(surface.roughness, 0.02, 1.0);
  let environment = select(envRadiance(R, lighting, rough * rough), iblSpecularRadiance(R, rough), hasIbl)
    * lighting.envMapStrength;
  let fresnel = fresnelSchlick(NdotV, vec3f(FLUID_F0));
  let L = lightDirFromPos(lighting.key.posOrDir);
  let highlight = specularGGX(N, V, L, vec3f(1.0, 0.0, 0.0), vec3f(0.0, 0.0, 1.0), rough, rough, rough,
                              vec3f(FLUID_F0), false) * lighting.key.color * lighting.key.intensity;

  let color = body * (vec3f(1.0) - fresnel) + environment * fresnel + highlight;
  let alpha = clamp(thickness / max(surface.edgeThickness, 1.0e-5), 0.0, 1.0);
  return vec4f(color, alpha);
}
