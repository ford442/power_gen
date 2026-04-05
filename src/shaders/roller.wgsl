struct Uniforms {
  viewProj: mat4x4f,
  time: f32,
  mode: f32,
  particleCount: f32,
  _pad: f32,   // batteryCharge (solar) / 0.5 (other modes)
}

@binding(0) @group(0) var<uniform> uniforms: Uniforms;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) normal: vec3f,
  @location(1) worldPos: vec3f,
  @location(2) instanceId: f32,
}

// ─── Vertex shader ────────────────────────────────────────────────────────────
// Instance-index conventions (firstInstance offsets used in render loop):
//   0–65   : SEG rollers (3 rings)
//   0–5    : Heron vessels + tubes      (mode 1)
//   0–5    : Kelvin containers + rods   (mode 2)
//   0–6    : Solar LEDs + battery       (mode 3)
//   66     : SEG core sphere            (pass-through)
//   67     : SEG outer coil             (pass-through)
//   68–71  : SEG ring-separator plates  (pass-through)
//   100    : Kelvin left  induction ring (translate only)
//   101    : Kelvin right induction ring (translate only)
//   200    : Solar panel disc           (pass-through)
@vertex fn vertexMain(
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @builtin(instance_index) instanceIdx: u32
) -> VertexOutput {
  var output: VertexOutput;
  let globalIdx = f32(instanceIdx);
  let mode = uniforms.mode;
  var worldPos: vec3f;
  var worldNormal: vec3f = normal;

  // ── Special / pass-through geometry (high instance-index offsets) ──────────
  if (instanceIdx == 100u) {
    // Kelvin: left induction torus – just translate
    worldPos = position + vec3f(-2.5, 1.5, 0.0);
  } else if (instanceIdx == 101u) {
    // Kelvin: right induction torus
    worldPos = position + vec3f(2.5, 1.5, 0.0);
  } else if (instanceIdx >= 66u) {
    // Core sphere (66), outer coil (67), ring plates (68-71), solar disc (200+)
    worldPos = position;

  // ── SEG Mode: 3 concentric rings of spinning magnetic rollers ─────────────
  } else if (mode < 0.5) {
    var rollerCount: f32;
    var ringRadius: f32;
    var localIdx: f32;
    if (globalIdx < 12.0) {
      rollerCount = 12.0; ringRadius = 3.5; localIdx = globalIdx;
    } else if (globalIdx < 34.0) {
      rollerCount = 22.0; ringRadius = 5.5; localIdx = globalIdx - 12.0;
    } else {
      rollerCount = 32.0; ringRadius = 7.5; localIdx = globalIdx - 34.0;
    }
    let angle = localIdx * (6.28318530718 / rollerCount) + uniforms.time * 0.2;
    let center = vec3f(cos(angle) * ringRadius, 0.0, sin(angle) * ringRadius);
    let spinAngle = uniforms.time * 3.0 + globalIdx * 0.5;
    let cs = cos(spinAngle); let ss = sin(spinAngle);
    let rotPos = vec3f(position.x * cs - position.z * ss, position.y,
                       position.x * ss + position.z * cs);
    let ta = 0.1 * sin(uniforms.time + globalIdx);
    let ct = cos(ta); let st = sin(ta);
    let tiltedPos = vec3f(rotPos.x, rotPos.y * ct - rotPos.z * st,
                          rotPos.y * st + rotPos.z * ct);
    worldPos = tiltedPos + center;

  // ── Heron's Fountain Mode: stacked vessels + connecting tubes ─────────────
  // Cylinder native: radius 0.8, half-height 1.25 (total height 2.5)
  // 0: bottom reservoir   1: middle chamber   2: upper display basin
  // 3: centre tube        4: side drain tube  5: nozzle
  } else if (mode < 1.5) {
    var scale: vec3f = vec3f(1.0, 1.0, 1.0);
    var trans: vec3f = vec3f(0.0, 0.0, 0.0);
    switch(instanceIdx) {
      case 0u: { scale = vec3f(4.0,  0.60, 4.0);  trans = vec3f( 0.0, -3.5,  0.0); }
      case 1u: { scale = vec3f(2.5,  0.80, 2.5);  trans = vec3f( 0.0,  0.0,  0.0); }
      case 2u: { scale = vec3f(3.5,  0.18, 3.5);  trans = vec3f( 0.0,  4.5,  0.0); }
      case 3u: { scale = vec3f(0.15, 3.60, 0.15); trans = vec3f( 0.0,  0.5,  0.0); }
      case 4u: { scale = vec3f(0.12, 1.60, 0.12); trans = vec3f(-0.8, -1.5,  0.0); }
      case 5u: { scale = vec3f(0.15, 0.32, 0.15); trans = vec3f( 0.0,  5.6,  0.0); }
      default: {}
    }
    worldPos = position * scale + trans;
    worldNormal = normalize(normal / max(scale, vec3f(0.001)));

  // ── Kelvin's Thunderstorm Mode: two symmetric assemblies ──────────────────
  // 0–1: upper drip cans   2–3: lower collectors   4–5: vertical support rods
  } else if (mode < 2.5) {
    var scale: vec3f = vec3f(1.0, 1.0, 1.0);
    var trans: vec3f = vec3f(0.0, 0.0, 0.0);
    switch(instanceIdx) {
      case 0u: { scale = vec3f(0.50,  0.48, 0.50);  trans = vec3f(-2.5,  4.5, 0.0); }
      case 1u: { scale = vec3f(0.50,  0.48, 0.50);  trans = vec3f( 2.5,  4.5, 0.0); }
      case 2u: { scale = vec3f(1.25,  0.60, 1.25);  trans = vec3f(-2.5, -3.0, 0.0); }
      case 3u: { scale = vec3f(1.25,  0.60, 1.25);  trans = vec3f( 2.5, -3.0, 0.0); }
      case 4u: { scale = vec3f(0.10,  2.80, 0.10);  trans = vec3f(-2.5,  0.5, 0.0); }
      case 5u: { scale = vec3f(0.10,  2.80, 0.10);  trans = vec3f( 2.5,  0.5, 0.0); }
      default: {}
    }
    worldPos = position * scale + trans;
    worldNormal = normalize(normal / max(scale, vec3f(0.001)));

  // ── Solar / LED Mode: LED array aimed at solar panel ─────────────────────
  // 0–5: LED cylinders (tilted ~25° toward panel)   6: battery cylinder
  } else {
    var scale: vec3f = vec3f(1.0, 1.0, 1.0);
    var trans: vec3f = vec3f(0.0, 0.0, 0.0);
    var tiltX: f32 = 0.0;
    if (instanceIdx < 6u) {
      let ledX = (f32(instanceIdx) - 2.5) * 1.6;
      scale = vec3f(0.3125, 0.24, 0.3125);
      trans = vec3f(ledX, 3.5, 1.5);
      tiltX = -0.44;   // ≈ 25° tilt toward panel
    } else {
      scale = vec3f(1.0, 1.0, 0.6);
      trans = vec3f(6.0, -0.5, 0.0);
    }
    var sp = position * scale;
    if (tiltX < -0.1) {
      let cx = cos(tiltX); let sx = sin(tiltX);
      sp = vec3f(sp.x, sp.y * cx - sp.z * sx, sp.y * sx + sp.z * cx);
    }
    worldPos = sp + trans;
    worldNormal = normalize(normal / max(scale, vec3f(0.001)));
  }

  output.position = uniforms.viewProj * vec4f(worldPos, 1.0);
  output.normal = worldNormal;
  output.worldPos = worldPos;
  output.instanceId = globalIdx;
  return output;
}

// ─── Fragment shader ──────────────────────────────────────────────────────────
@fragment fn fragmentMain(
  @location(0) normal: vec3f,
  @location(1) worldPos: vec3f,
  @location(2) instanceId: f32
) -> @location(0) vec4f {
  let n = normalize(normal);
  let camPos = vec3f(cos(uniforms.time * 0.1) * 16.0, 4.0,
                     sin(uniforms.time * 0.1) * 16.0);
  let viewDir  = normalize(camPos - worldPos);
  let halfDir  = normalize(viewDir + vec3f(0.0, 1.0, 0.0));
  let spec     = pow(max(dot(n, halfDir), 0.0), 64.0);
  let fresnel  = pow(1.0 - abs(dot(n, viewDir)), 2.0);
  let mode     = uniforms.mode;
  let iId      = u32(instanceId);
  let charge   = clamp(uniforms._pad, 0.0, 1.0);
  var finalColor: vec3f;

  // ── Special high-index geometry ────────────────────────────────────────────
  if (iId == 66u) {
    // SEG core hub: dark iron/steel
    finalColor = vec3f(0.22, 0.22, 0.28) + vec3f(spec * 0.4);

  } else if (iId == 67u) {
    // SEG outer electromagnetic coil: glowing copper
    let pulse = 0.5 + 0.5 * sin(uniforms.time * 3.5);
    let coil  = mix(vec3f(0.55, 0.30, 0.08), vec3f(1.0, 0.72, 0.25), pulse);
    finalColor = coil + vec3f(0.0, 0.5, 0.7) * pulse * fresnel + vec3f(spec * 0.65);

  } else if (iId >= 68u && iId < 72u) {
    // SEG ring-separator plates: brushed silver with cyan edge glow
    let metallic = vec3f(0.62, 0.68, 0.76);
    finalColor = metallic + vec3f(0.0, 0.55, 0.85) * fresnel * 0.9 + vec3f(spec * 0.55);

  } else if (iId == 100u || iId == 101u) {
    // Kelvin induction rings: polished silver with electrostatic shimmer
    let elec = 0.5 + 0.5 * sin(uniforms.time * 6.0 + f32(iId) * 3.14);
    finalColor = vec3f(0.75, 0.78, 0.85)
               + vec3f(0.35, 0.0, 0.80) * elec * fresnel * 1.2
               + vec3f(spec * 0.72);

  } else if (iId >= 200u) {
    // Solar panel disc: dark-blue cells with grid lines
    let gx = step(0.91, fract(worldPos.x * 0.65));
    let gz = step(0.91, fract(worldPos.z * 0.65));
    let grid = max(gx, gz);
    let cell = vec3f(0.05, 0.09, 0.25);
    let line = vec3f(0.32, 0.52, 0.88);
    let solarGlow = charge * vec3f(0.0, 0.18, 0.45) * 0.7;
    finalColor = mix(cell, line, grid) + solarGlow + vec3f(spec * 0.22);

  // ── Mode-specific roller / structural geometry ─────────────────────────────
  } else if (mode < 0.5) {
    // SEG rollers: ring-coded metallic colour + magnetic field glow
    let fp = sin(worldPos.y * 4.0 + uniforms.time * 4.0) *
             cos(length(worldPos.xz) * 5.0 - uniforms.time * 3.0 + instanceId);
    var rc: vec3f; var bc: vec3f;
    if (instanceId < 12.0)       { rc = vec3f(1.0, 0.80, 0.20); bc = vec3f(0.80, 0.70, 0.40); }
    else if (instanceId < 34.0)  { rc = vec3f(0.85, 0.92, 1.0); bc = vec3f(0.70, 0.75, 0.82); }
    else                         { rc = vec3f(1.0, 0.58, 0.20); bc = vec3f(0.90, 0.52, 0.30); }
    let fglow = vec3f(0.0, 0.9, 1.0) * (fp * 0.5 + 0.5) * fresnel * 3.0;
    finalColor = bc + rc * 0.2 + fglow;

  } else if (mode < 1.5) {
    // Heron's Fountain structural elements
    let ripple = sin(worldPos.y * 6.0 + uniforms.time * 4.0) * 0.5 + 0.5;
    if (iId < 3u) {
      // Vessels: steel with water-fill gradient
      let metal = vec3f(0.28, 0.36, 0.42);
      let water = mix(vec3f(0.0, 0.10, 0.38), vec3f(0.0, 0.42, 0.75), ripple);
      let fill  = clamp((worldPos.y + 6.0) / 12.0, 0.0, 1.0);
      finalColor = mix(metal, water, fill * 0.65)
                 + fresnel * vec3f(0.08, 0.32, 0.60) * 0.7
                 + vec3f(spec * 0.40);
    } else if (iId < 5u) {
      // Connecting pipes: dark steel
      finalColor = vec3f(0.20, 0.23, 0.28) + vec3f(spec * 0.45);
    } else {
      // Nozzle: bright silver with pressure pulse
      let pg = 0.5 + 0.5 * sin(uniforms.time * 9.0);
      finalColor = vec3f(0.68, 0.78, 0.90)
                 + vec3f(0.0, 0.22, 0.62) * pg
                 + vec3f(spec * 0.65);
    }

  } else if (mode < 2.5) {
    // Kelvin's Thunderstorm structural elements
    let elec = 0.35 + 0.65 * abs(sin(uniforms.time * 7.0 + instanceId * 0.8));
    if (iId < 2u) {
      // Upper drip cans: silver
      finalColor = vec3f(0.58, 0.63, 0.70) + vec3f(spec * 0.55);
    } else if (iId < 4u) {
      // Collectors: copper-bronze with electrostatic charge glow
      let cop = vec3f(0.62, 0.36, 0.16);
      finalColor = cop + vec3f(0.45, 0.0, 0.82) * elec * fresnel * 0.9
                 + vec3f(spec * 0.50);
    } else {
      // Support rods: brushed dark steel
      finalColor = vec3f(0.30, 0.31, 0.36) + vec3f(spec * 0.35);
    }

  } else {
    // Solar / LED Mode structural elements
    if (iId < 6u) {
      // LEDs: warm yellow-white glow, intensity tied to battery charge
      let pulse = 0.65 + 0.35 * sin(uniforms.time * 5.0 + instanceId * 1.5);
      let led   = mix(vec3f(0.90, 0.62, 0.22), vec3f(1.0, 1.0, 0.85), pulse);
      finalColor = led * (0.45 + charge * 1.1) + vec3f(spec * 0.35);
    } else {
      // Battery cylinder: red→green gradient with charge
      let batt = mix(vec3f(0.75, 0.10, 0.10), vec3f(0.15, 0.75, 0.20), charge);
      let stripe = step(0.5, fract(worldPos.y * 1.5));
      finalColor = mix(batt, batt * 1.35, stripe * 0.3) + vec3f(spec * 0.4);
    }
  }

  return vec4f(finalColor, 1.0);
}