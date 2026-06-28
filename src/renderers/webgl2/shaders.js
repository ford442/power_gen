/**
 * GLSL shaders — WebGL2 equivalents of multi-device-shaders.js / particles.wgsl.
 *
 * WebGPU → WebGL2 mapping:
 *   @group(0) @binding(0) uniform  → uniform mat4 u_viewProj + scalars
 *   storage buffer instances       → instanced vertex attributes (divisor=1)
 *   compute shader                 → CPU stepParticles() in shared/particle-physics.js
 */

export const SKY_VERT = `#version 300 es
precision highp float;
out vec2 v_uv;
void main() {
  vec2 corners[3] = vec2[3](vec2(-1.0,-1.0), vec2(3.0,-1.0), vec2(-1.0,3.0));
  v_uv = corners[gl_VertexID];
  gl_Position = vec4(corners[gl_VertexID], 0.999, 1.0);
}`;

export const SKY_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform float u_time;
uniform float u_skyMode; // 0=drama, 1=studio, 2=lab
void main() {
  float t = clamp(v_uv.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 col;
  if (u_skyMode < 0.5) {
    vec3 horizon = vec3(0.04, 0.08, 0.16);
    vec3 zenith  = vec3(0.008, 0.012, 0.04);
    col = mix(horizon, zenith, pow(t, 0.6));
    col += vec3(0.02, 0.04, 0.06) * sin(u_time * 0.2 + v_uv.x * 3.0);
  } else if (u_skyMode < 1.5) {
    col = mix(vec3(0.62, 0.64, 0.68), vec3(0.42, 0.44, 0.48), pow(t, 0.85));
  } else {
    col = mix(vec3(0.82, 0.84, 0.87), vec3(0.72, 0.74, 0.78), pow(t, 0.7));
  }
  float lowDist = length(v_uv - vec2(0.5, 0.18));
  col += vec3(0.15, 0.45, 1.0) * exp(-lowDist * lowDist * 4.5) * 0.05;
  fragColor = vec4(col, 1.0);
}`;

export const GRID_VERT = `#version 300 es
precision highp float;
layout(location=0) in vec3 a_pos;
uniform mat4 u_viewProj;
out vec3 v_worldPos;
void main() {
  v_worldPos = a_pos;
  gl_Position = u_viewProj * vec4(a_pos, 1.0);
}`;

export const GRID_FRAG = `#version 300 es
precision highp float;
in vec3 v_worldPos;
out vec4 fragColor;
uniform vec3 u_cameraPos;
void main() {
  float d = length(v_worldPos.xz);
  float grid = max(
    smoothstep(0.95, 1.0, abs(sin(v_worldPos.x * 0.5))),
    smoothstep(0.95, 1.0, abs(sin(v_worldPos.z * 0.5)))
  );
  float fade = exp(-d * 0.04);
  vec3 col = vec3(0.0, 0.35, 0.45) * grid * fade * 0.35;
  float distFade = 1.0 - smoothstep(40.0, 80.0, length(v_worldPos - u_cameraPos));
  fragColor = vec4(col * distFade, grid * fade * 0.5);
}`;

export const MESH_VERT = `#version 300 es
precision highp float;
layout(location=0) in vec3 a_pos;
layout(location=1) in vec3 a_normal;
layout(location=2) in vec3 a_instancePos;
layout(location=3) in vec4 a_instanceColor;
uniform mat4 u_viewProj;
uniform mat4 u_model;
uniform vec3 u_devicePos;
uniform float u_wireframe;
uniform float u_debugMode; // 0=lit, 1=normals, 2=uv
out vec3 v_normal;
out vec3 v_color;
out vec3 v_worldPos;
void main() {
  vec3 worldPos = a_pos + a_instancePos + u_devicePos;
  v_worldPos = worldPos;
  v_normal = a_normal;
  v_color = a_instanceColor.rgb;
  if (u_debugMode > 0.5 && u_debugMode < 1.5) {
    v_color = normalize(a_normal) * 0.5 + 0.5;
  }
  gl_Position = u_viewProj * vec4(worldPos, 1.0);
}`;

export const MESH_FRAG = `#version 300 es
precision highp float;
in vec3 v_normal;
in vec3 v_color;
in vec3 v_worldPos;
out vec4 fragColor;
uniform vec3 u_lightPos;
uniform vec3 u_lightColor;
uniform vec3 u_fillDir;
uniform vec3 u_fillColor;
uniform vec3 u_rimColor;
uniform vec3 u_cameraPos;
uniform float u_emissive;
uniform float u_metallic;
uniform float u_roughness;
uniform float u_wireframe;

float hash31(vec3 p) {
  return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453);
}

float fbm(vec3 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 3; i++) {
    v += (hash31(floor(p * 3.0)) * 2.0 - 1.0) * a;
    p = p * 2.1 + vec3(1.7, 2.3, 0.9);
    a *= 0.5;
  }
  return v * 0.5 + 0.5;
}

vec3 fresnelSchlick(float cosT, vec3 f0) {
  return f0 + (1.0 - f0) * pow(clamp(1.0 - cosT, 0.0, 1.0), 5.0);
}

float distributionGGX(float NdotH, float rough) {
  float a = rough * rough;
  float a2 = a * a;
  float d = NdotH * NdotH * (a2 - 1.0) + 1.0;
  return a2 / (3.14159265 * d * d + 1e-5);
}

float geometrySmith(float NdotV, float NdotL, float rough) {
  float k = (rough + 1.0) * (rough + 1.0) / 8.0;
  return (NdotV / (NdotV * (1.0 - k) + k + 1e-5)) * (NdotL / (NdotL * (1.0 - k) + k + 1e-5));
}

vec3 evalPBR(vec3 N, vec3 V, vec3 albedo, float metallic, float roughness) {
  vec3 f0 = mix(vec3(0.04), albedo, metallic);
  vec3 Lk = normalize(u_lightPos - v_worldPos);
  vec3 Lf = normalize(u_fillDir);
  vec3 Hk = normalize(V + Lk);
  float NdotV = max(dot(N, V), 0.001);
  float NdotLk = max(dot(N, Lk), 0.0);
  float NdotLf = max(dot(N, Lf), 0.0);
  float NdotHk = max(dot(N, Hk), 0.0);
  float Dk = distributionGGX(NdotHk, roughness);
  float Gk = geometrySmith(NdotV, NdotLk, roughness);
  vec3 Fk = fresnelSchlick(max(dot(Hk, V), 0.0), f0);
  vec3 specK = (Dk * Gk * Fk) / (4.0 * NdotV * NdotLk + 0.001) * NdotLk;
  vec3 kDk = (1.0 - Fk) * (1.0 - metallic);
  vec3 diffK = albedo * kDk * NdotLk * u_lightColor;
  vec3 diffF = albedo * (1.0 - metallic) * NdotLf * u_fillColor * 0.42;
  vec3 R = reflect(-V, N);
  float upBlend = clamp(R.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 envCol = mix(vec3(0.18, 0.16, 0.14), vec3(0.55, 0.62, 0.78), upBlend);
  vec3 ibl = envCol * fresnelSchlick(NdotV, f0) * (1.0 - roughness * roughness) * 0.62;
  vec3 rim = u_rimColor * pow(1.0 - NdotV, 3.2) * 0.42;
  return diffK + diffF + specK * u_lightColor + ibl + rim + albedo * 0.07;
}

void main() {
  vec3 N = normalize(v_normal);
  vec3 V = normalize(u_cameraPos - v_worldPos);
  float micro = fbm(v_worldPos * 8.0);
  N = normalize(N + vec3(micro - 0.5) * 0.08);
  vec3 albedo = v_color;
  float rough = clamp(u_roughness + (micro - 0.5) * 0.08, 0.04, 1.0);
  vec3 col = evalPBR(N, V, albedo, u_metallic, rough);
  col += albedo * u_emissive * 2.4;
  if (u_wireframe > 0.5) col = mix(col, vec3(0.0, 1.0, 0.8), 0.35);
  float vig = 1.0 - dot((gl_FragCoord.xy / vec2(1920.0, 1080.0) - 0.5) * vec2(0.48, 0.58),
                        (gl_FragCoord.xy / vec2(1920.0, 1080.0) - 0.5) * vec2(0.48, 0.58));
  col *= mix(0.75, 1.0, clamp(vig, 0.0, 1.0));
  col = col / (col + vec3(0.85));
  fragColor = vec4(col, 1.0);
}`;

/** Detailed SEG roller — UV-aware instanced mesh with N/S polarity tinting. */
export const ROLLER_VERT = `#version 300 es
precision highp float;
layout(location=0) in vec3 a_pos;
layout(location=1) in vec3 a_normal;
layout(location=4) in vec2 a_uv;
layout(location=2) in vec3 a_instancePos;
layout(location=3) in vec4 a_instanceColor;
uniform mat4 u_viewProj;
uniform vec3 u_devicePos;
uniform float u_scaleXZ;
uniform float u_scaleY;
out vec3 v_normal;
out vec3 v_color;
out vec3 v_worldPos;
out vec2 v_uv;
void main() {
  vec3 scaled = vec3(a_pos.x * u_scaleXZ, a_pos.y * u_scaleY, a_pos.z * u_scaleXZ);
  vec3 worldPos = scaled + a_instancePos + u_devicePos;
  v_worldPos = worldPos;
  v_normal = normalize(vec3(a_normal.x / u_scaleXZ, a_normal.y / u_scaleY, a_normal.z / u_scaleXZ));
  v_color = a_instanceColor.rgb;
  v_uv = a_uv;
  gl_Position = u_viewProj * vec4(worldPos, 1.0);
}`;

export const ROLLER_FRAG = `#version 300 es
precision highp float;
in vec3 v_normal;
in vec3 v_color;
in vec3 v_worldPos;
in vec2 v_uv;
out vec4 fragColor;
uniform vec3 u_lightPos;
uniform vec3 u_cameraPos;
uniform vec3 u_fillDir;
uniform vec3 u_fillColor;
uniform vec3 u_rimColor;
uniform float u_emissive;
uniform float u_metallic;
uniform float u_roughness;
const float ROLLER_HEIGHT = 2.8;
const float ROLLER_SEGMENTS = 8.0;
const float ROLLER_GROOVE_WIDTH = 0.045;

float hash31(vec3 p) {
  return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453);
}
float fbm(vec3 p) {
  float v = 0.0; float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += (hash31(floor(p * 3.0)) * 2.0 - 1.0) * a;
    p = p * 2.1 + vec3(1.7, 2.3, 0.9); a *= 0.5;
  }
  return clamp(v * 0.5 + 0.5, 0.0, 1.0);
}
vec3 fresnelSchlick(float cosT, vec3 f0) {
  return f0 + (1.0 - f0) * pow(clamp(1.0 - cosT, 0.0, 1.0), 5.0);
}
float distributionGGX(float NdotH, float rough) {
  float a = rough * rough; float a2 = a * a;
  float d = NdotH * NdotH * (a2 - 1.0) + 1.0;
  return a2 / (3.14159265 * d * d + 1e-5);
}
float geometrySmith(float NdotV, float NdotL, float rough) {
  float k = (rough + 1.0) * (rough + 1.0) / 8.0;
  return (NdotV / (NdotV * (1.0 - k) + k + 1e-5)) * (NdotL / (NdotL * (1.0 - k) + k + 1e-5));
}

void main() {
  vec3 N = normalize(v_normal);
  vec3 V = normalize(u_cameraPos - v_worldPos);
  bool isCap = abs(N.y) > 0.85;
  vec3 baseColor = v_color;
  float metallic = u_metallic;
  float roughness = u_roughness;

  if (isCap) {
    float radial = length(v_worldPos.xz) / 0.75;
    if (radial < 0.30) baseColor = vec3(0.74, 0.76, 0.78);
    else if (radial < 0.52) baseColor = vec3(0.92, 0.90, 0.85);
    else if (radial < 0.74) baseColor = vec3(0.88, 0.89, 0.91);
    else baseColor = vec3(0.85, 0.55, 0.28);
    metallic = mix(metallic, 0.90, 0.5);
    roughness = mix(roughness, 0.20, 0.5);
  } else {
    float theta = atan(v_worldPos.z, v_worldPos.x);
    vec3 northCol = vec3(0.92, 0.58, 0.35);
    vec3 southCol = vec3(0.38, 0.45, 0.68);
    baseColor = mix(southCol, northCol, step(0.0, cos(theta)));
    baseColor = mix(baseColor, v_color, 0.45);
    if (length(v_worldPos.xz) > 0.76) {
      baseColor = mix(vec3(0.22, 0.24, 0.28), baseColor, 0.4);
      metallic = 0.42; roughness = 0.38;
    }
    float yRel = v_worldPos.y + ROLLER_HEIGHT * 0.5;
    float segmentPitch = ROLLER_HEIGHT / ROLLER_SEGMENTS;
    float cyclePos = fract(yRel / segmentPitch) * segmentPitch;
    float bandHeight = segmentPitch - ROLLER_GROOVE_WIDTH;
    float distToBoundary = min(cyclePos, abs(cyclePos - bandHeight));
    if (distToBoundary < ROLLER_GROOVE_WIDTH * 0.5) baseColor *= 0.48;
    float brush = fbm(vec3(v_worldPos.y * 6.0, theta * 2.0, 0.0));
    vec3 upRef = abs(N.y) > 0.94 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
    vec3 T = normalize(cross(upRef, N));
    N = normalize(N + T * (brush - 0.5) * 0.12);
  }

  float micro = fbm(v_worldPos * 5.0);
  baseColor *= 0.88 + micro * 0.14;
  roughness = clamp(roughness + (micro - 0.5) * 0.06, 0.04, 1.0);

  vec3 albedo = mix(baseColor, vec3(0.0), metallic);
  vec3 f0 = mix(vec3(0.04), baseColor, metallic);
  vec3 Lk = normalize(u_lightPos - v_worldPos);
  vec3 Lf = normalize(u_fillDir);
  vec3 Hk = normalize(V + Lk);
  float NdotV = max(dot(N, V), 0.001);
  float NdotLk = max(dot(N, Lk), 0.0);
  float NdotLf = max(dot(N, Lf), 0.0);
  float NdotHk = max(dot(N, Hk), 0.0);
  float Dk = distributionGGX(NdotHk, roughness);
  float Gk = geometrySmith(NdotV, NdotLk, roughness);
  vec3 Fk = fresnelSchlick(max(dot(Hk, V), 0.0), f0);
  vec3 spec = (Dk * Gk * Fk) / (4.0 * NdotV * NdotLk + 0.001) * NdotLk;
  vec3 kD = (1.0 - Fk) * (1.0 - metallic);
  vec3 diff = albedo * kD * NdotLk + albedo * (1.0 - metallic) * NdotLf * 0.42;
  vec3 R = reflect(-V, N);
  float upBlend = clamp(R.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 ibl = mix(vec3(0.12, 0.11, 0.09), vec3(0.48, 0.58, 0.74), upBlend);
  ibl *= fresnelSchlick(NdotV, f0) * (1.0 - roughness * roughness) * 0.68;
  vec3 rim = u_rimColor * pow(1.0 - NdotV, 3.2) * 0.45;
  vec3 col = diff + spec + ibl + rim + albedo * 0.10;
  col += baseColor * u_emissive * 2.8;
  col = col / (col + vec3(0.82));
  fragColor = vec4(col, 1.0);
}`;

export const PARTICLE_VERT = `#version 300 es
precision highp float;
layout(location=0) in vec3 a_pos;
layout(location=1) in float a_phase;
layout(location=2) in vec3 a_vel;
layout(location=3) in float a_aux;
uniform mat4 u_viewProj;
uniform vec3 u_devicePos;
uniform float u_mode;
uniform float u_debugParticles; // 0=glow, 1=size by id, 2=velocity heat
uniform float u_particleScale;
out vec2 v_uv;
out float v_phase;
out float v_speed;
out float v_aux;
out float v_debugId;
void main() {
  int corner = gl_VertexID % 4;
  vec2 corners[4] = vec2[4](vec2(-1,-1), vec2(1,-1), vec2(-1,1), vec2(1,1));
  vec2 c = corners[corner];
  v_uv = c;
  v_phase = a_phase;
  v_speed = length(a_vel);
  v_aux = a_aux;
  v_debugId = float(gl_InstanceID) / 10000.0;
  float size = 0.07 * u_particleScale;
  if (u_mode > 0.5 && u_mode < 1.5) size = 0.11 * u_particleScale;
  else if (u_mode >= 2.5 && u_mode < 4.5) size = 0.05 * u_particleScale;
  else if (u_mode >= 4.5) size = 0.09 * u_particleScale;
  if (u_debugParticles > 0.5 && u_debugParticles < 1.5) {
    size = 0.04 + fract(a_phase * 17.0) * 0.12;
  }
  vec3 right = vec3(u_viewProj[0][0], u_viewProj[1][0], u_viewProj[2][0]);
  vec3 up    = vec3(u_viewProj[0][1], u_viewProj[1][1], u_viewProj[2][1]);
  vec3 world = a_pos + u_devicePos + right * c.x * size + up * c.y * size;
  gl_Position = u_viewProj * vec4(world, 1.0);
}`;

export const PARTICLE_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
in float v_phase;
in float v_speed;
in float v_aux;
in float v_debugId;
out vec4 fragColor;
uniform float u_mode;
uniform vec3 u_tint;
uniform float u_debugParticles;
uniform float u_battery;
void main() {
  float d = length(v_uv);
  if (d > 1.0) discard;
  if (u_debugParticles > 1.5) {
    vec3 heat = mix(vec3(0.1,0.1,0.8), vec3(1.0,0.2,0.0), clamp(v_speed / 3.0, 0.0, 1.0));
    fragColor = vec4(heat, (1.0 - d) * 0.9);
    return;
  }
  if (u_debugParticles > 0.5 && u_debugParticles < 1.5) {
    float hue = fract(v_phase * 13.0 + v_debugId);
    fragColor = vec4(vec3(hue, 1.0 - hue, 0.5), (1.0 - d) * 0.85);
    return;
  }
  float alpha = (1.0 - d) * 0.85;
  vec3 col = u_tint;
  if (u_mode < 0.5) {
    col = mix(vec3(0.0, 0.7, 1.0), vec3(0.2, 1.0, 0.6), v_phase);
    col += vec3(0.0, 0.4, 0.6) * v_speed * 0.3;
  } else if (u_mode < 1.5) {
    col = vec3(0.3, 0.6, 1.0);
  } else if (u_mode < 2.5) {
    col = mix(vec3(0.6, 0.4, 1.0), vec3(1.0, 0.8, 0.3), abs(v_aux));
  } else if (u_mode < 4.5) {
    col = v_aux > 0.5 ? vec3(1.0, 0.95, 0.7) : vec3(1.0, 0.9, 0.2);
    alpha *= 0.7 + u_battery * 0.3;
  } else {
    col = vec3(0.75, 0.7, 0.85);
  }
  fragColor = vec4(col, alpha);
}`;
