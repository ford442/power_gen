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
void main() {
  float t = clamp(v_uv.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 horizon = vec3(0.05, 0.12, 0.22);
  vec3 zenith  = vec3(0.01, 0.03, 0.08);
  vec3 col = mix(horizon, zenith, pow(t, 0.6));
  col += vec3(0.02, 0.04, 0.06) * sin(u_time * 0.2 + v_uv.x * 3.0);
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
uniform vec3 u_cameraPos;
uniform float u_emissive;
uniform float u_metallic;
uniform float u_roughness;
uniform float u_wireframe;
void main() {
  vec3 N = normalize(v_normal);
  vec3 L = normalize(u_lightPos - v_worldPos);
  vec3 V = normalize(u_cameraPos - v_worldPos);
  vec3 H = normalize(L + V);
  float NdotL = max(dot(N, L), 0.0);
  float spec = pow(max(dot(N, H), 0.0), mix(8.0, 64.0, 1.0 - u_roughness));
  vec3 diffuse = v_color * (0.15 + 0.85 * NdotL);
  vec3 specCol = mix(vec3(0.04), v_color, u_metallic) * spec;
  vec3 emissive = v_color * u_emissive * 2.0;
  vec3 col = diffuse + specCol + emissive;
  if (u_wireframe > 0.5) {
    col = mix(col, vec3(0.0, 1.0, 0.8), 0.35);
  }
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
