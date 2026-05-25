struct Uniforms {
  viewProj:       mat4x4f,
  time:           f32,
  mode:           f32,
  particleCount:  f32,
  battery:        f32,
  dt:             f32,
  segOmega:       f32,
  fieldStrength:  f32,
  heronVExit:     f32,
  heronHead:      f32,
  kelvinE:        f32,
  kelvinVoltageN: f32,
  kelvinSpark:    f32,
  solarN2:        f32,
  corona:         f32,
  simClock:       f32,
  spare:          f32,
}

struct DeviceUniforms {
  renderMode: f32,  // 0=rollers, 1=base, 2=stator, 3=wiring
  _pad: vec3f,
}

struct InstanceData {
  position: vec3f,
  data0: f32,
}

struct MaterialData {
  color: vec3f,
  emissive: f32,
}

@binding(0) @group(0) var<uniform> uniforms: Uniforms;
@binding(1) @group(0) var<uniform> deviceUniforms: DeviceUniforms;
@binding(2) @group(0) var<storage, read> instanceBuffer: array<InstanceData>;
@binding(3) @group(0) var<storage, read> materialBuffer: array<MaterialData>;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) normal: vec3f,
  @location(1) worldPos: vec3f,
  @location(2) instanceId: f32,
  @location(3) localY: f32,   // pre-transform local Y for pole banding
}

// ─── Vertex shader ────────────────────────────────────────────────────────────
// Instance-index conventions (firstInstance offsets used in render loop):
//   0–65   : SEG rollers (3 rings: 12+22+32)
//   0–5    : Heron vessels + tubes      (mode 1)
//   0–5    : Kelvin containers + rods   (mode 2)
//   0–6    : Solar LEDs + battery       (mode 3)
//   66     : SEG central stator hub disc (pass-through)
//   67     : SEG outer coil             (pass-through)
//   68–71  : SEG ring-separator plates  (pass-through)
//   72–74  : SEG orbital stator rings   (pass-through)
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
  let renderMode = u32(deviceUniforms.renderMode);
  output.localY = 0.0;  // default; overridden in SEG roller branch

  // ── Special / pass-through geometry (high instance-index offsets) ──────────
  if (instanceIdx == 100u) {
    // Kelvin: left induction torus – just translate
    worldPos = position + vec3f(-2.5, 1.5, 0.0);
  } else if (instanceIdx == 101u) {
    // Kelvin: right induction torus
    worldPos = position + vec3f(2.5, 1.5, 0.0);
  } else if (instanceIdx >= 66u) {
    // Core stator hub (66), outer coil (67), ring plates (68-71),
    // orbital stator rings (72-74), solar disc (200+)
    worldPos = position;

  // ── SEG Special Geometry: Base, Stator Rings, Wiring ────────────────────
  } else if (mode < 0.5 && renderMode > 0u) {
    if (renderMode == 1u) {
      // Base: flat square plate
      let scale = vec3f(8.2 * 0.5, 0.22 * 0.5, 8.2 * 0.5);
      let trans = vec3f(0.0, -0.35, 0.0);
      worldPos = position * scale + trans;
      worldNormal = normalize(normal / max(scale, vec3f(0.001)));
    } else if (renderMode == 2u) {
      // Stator rings: flat concentric copper rings
      let radii = array<f32, 3>(2.4, 4.1, 5.8);
      let radius = radii[instanceIdx];
      let thickness = 0.22 * 0.5;
      let height = 0.12 * f32(instanceIdx);
      // Scale cylinder to create ring geometry
      let scale = vec3f(radius, 0.05, radius);
      let trans = vec3f(0.0, height, 0.0);
      worldPos = position * scale + trans;
      worldNormal = normalize(normal / max(scale, vec3f(0.001)));
    } else if (renderMode == 3u) {
      // Wiring: vertical copper cables from base
      let wireAngle = f32(instanceIdx) / 8.0 * 6.28318530718;
      let wireRadius = 6.5;
      let wirePosX = cos(wireAngle) * wireRadius;
      let wirePosZ = sin(wireAngle) * wireRadius;
      let scale = vec3f(0.15 * 0.5, 2.0 * 0.5, 0.15 * 0.5);
      let trans = vec3f(wirePosX, 0.0, wirePosZ);
      worldPos = position * scale + trans;
      worldNormal = normalize(normal / max(scale, vec3f(0.001)));
    }

  // ── SEG Mode: 3 concentric rings of spinning magnetic rollers ─────────────
  } else if (mode < 0.5) {
    var rollerCount: f32;
    var ringRadius: f32;
    var localIdx: f32;
    var orbitSpeed: f32;
    var selfSpinSpeed: f32;
    if (globalIdx < 12.0) {
      rollerCount = 12.0; ringRadius = 3.5; localIdx = globalIdx;
      orbitSpeed = 0.38; selfSpinSpeed = 4.5;   // inner ring: fastest orbit
    } else if (globalIdx < 34.0) {
      rollerCount = 22.0; ringRadius = 5.5; localIdx = globalIdx - 12.0;
      orbitSpeed = 0.22; selfSpinSpeed = 3.0;   // middle ring
    } else {
      rollerCount = 32.0; ringRadius = 7.5; localIdx = globalIdx - 34.0;
      orbitSpeed = 0.13; selfSpinSpeed = 2.0;   // outer ring: slowest
    }
    // Per-roller speed jitter: subtle variation so motion feels organic, not perfectly mechanical
    let jitterHash = fract(sin(globalIdx * 127.3 + 53.7) * 43758.5453);
    let speedJitter = 1.0 + 0.04 * sin(uniforms.time * 1.3 + jitterHash * 12.7);
    // Startup ramp: animate from zero over the first ~3 s so rollers appear to spin up
    let startupRamp = min(uniforms.time * 0.33, 1.0);
    // Slight per-ring phase offset gives each ring a distinct "feel"
    let ringPhaseOffset = floor(globalIdx / 12.0) * 0.22;
    let angle = localIdx * (6.28318530718 / rollerCount) + uniforms.time * orbitSpeed * speedJitter * startupRamp + ringPhaseOffset;
    let center = vec3f(cos(angle) * ringRadius, 0.0, sin(angle) * ringRadius);
    let spinAngle = uniforms.time * selfSpinSpeed * speedJitter * startupRamp + globalIdx * 0.5;
    let cs = cos(spinAngle); let ss = sin(spinAngle);
    let rotPos = vec3f(position.x * cs - position.z * ss, position.y,
                       position.x * ss + position.z * cs);
    // Capture local Y before tilt for pole banding in fragment shader
    output.localY = position.y;
    let ta = 0.08 * sin(uniforms.time * 0.7 + globalIdx);
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
  @location(2) instanceId: f32,
  @location(3) localY: f32
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
  let charge   = clamp(uniforms.battery, 0.0, 1.0);
  let renderMode = u32(deviceUniforms.renderMode);
  var finalColor: vec3f;

  // ── SEG Special Geometry Materials ─────────────────────────────────────────
  if (mode < 0.5 && renderMode > 0u) {
    if (renderMode == 1u) {
      // Base: dark industrial matte black
      finalColor = vec3f(0.08, 0.08, 0.12) + vec3f(spec * 0.15);
    } else if (renderMode == 2u) {
      // Stator rings: brushed copper with specular highlights
      let copper = vec3f(0.85, 0.48, 0.25);
      let winding = sin(worldPos.x * 15.0) * 0.15 + sin(worldPos.z * 15.0) * 0.1;
      finalColor = copper * (0.8 + winding) + vec3f(spec * 0.5);
    } else if (renderMode == 3u) {
      // Wiring: copper cables
      finalColor = vec3f(0.75, 0.45, 0.25) + vec3f(spec * 0.35);
    }

  // ── Special high-index geometry ────────────────────────────────────────────
  } else if (iId == 66u) {
    // SEG central stator hub disc: brushed steel with magnetic pulse glow
    let pulse = 0.35 + 0.35 * sin(uniforms.time * 1.8);
    let steel = vec3f(0.52, 0.56, 0.65);
    let magGlow = vec3f(0.0, 0.55, 1.0) * pulse * fresnel * 1.1;
    finalColor = steel * 0.85 + magGlow + vec3f(spec * 0.65);

  } else if (iId == 67u) {
    // SEG outer electromagnetic coil: glowing copper
    let pulse = 0.5 + 0.5 * sin(uniforms.time * 3.5);
    let coil  = mix(vec3f(0.55, 0.30, 0.08), vec3f(1.0, 0.72, 0.25), pulse);
    finalColor = coil + vec3f(0.0, 0.5, 0.7) * pulse * fresnel + vec3f(spec * 0.65);

  } else if (iId >= 68u && iId < 72u) {
    // SEG ring-separator plates: brushed silver with cyan edge glow
    let metallic = vec3f(0.62, 0.68, 0.76);
    finalColor = metallic + vec3f(0.0, 0.55, 0.85) * fresnel * 0.9 + vec3f(spec * 0.55);

  } else if (iId >= 72u && iId < 75u) {
    // SEG orbital stator rings: brass-copper glow at the three roller ring radii
    let ringIdx = f32(iId - 72u);
    let pulse = 0.45 + 0.45 * sin(uniforms.time * 2.2 + ringIdx * 1.8);
    let brass = vec3f(0.78, 0.56, 0.22);
    // ringIdx / 2.0: normalise 0-2 range to 0-1 for the colour lerp (3 rings total)
    let energyGlow = mix(vec3f(0.0, 0.7, 1.0), vec3f(0.2, 1.0, 0.6), ringIdx / 2.0)
                   * pulse * fresnel * 1.6;
    // Coronal discharge: plasma halo that intensifies as the SEG approaches
    // terminal velocity (corona driven by angular velocity + voltage on CPU).
    let coronaGlow = vec3f(0.55, 0.85, 1.0) * uniforms.corona * (0.6 + 0.4 * pulse) * (0.5 + fresnel);
    finalColor = brass * (0.45 + pulse * 0.35) + energyGlow + coronaGlow + vec3f(spec * 0.55);

  } else if (iId == 100u || iId == 101u) {
    // Kelvin induction rings: polished silver with electrostatic shimmer that
    // brightens with bucket voltage and flashes white on discharge.
    let elec = 0.5 + 0.5 * sin(uniforms.time * 6.0 + f32(iId) * 3.14);
    finalColor = vec3f(0.75, 0.78, 0.85)
               + vec3f(0.35, 0.0, 0.80) * elec * fresnel * (0.6 + 1.6 * uniforms.kelvinVoltageN)
               + vec3f(0.90, 0.95, 1.0) * uniforms.kelvinSpark
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
    // SEG rollers: alternating magnetic pole bands (copper + neodymium layers)
    // Cylinder is generated with height 2.5 → half-height 1.25.
    // localY ranges from -1.25 to +1.25 (captured before orbital transform).
    const ROLLER_HALF_HEIGHT: f32 = 1.25;
    const ROLLER_HEIGHT: f32 = 2.5;
    let bandCount = 6.0;
    let normalizedV = clamp((localY + ROLLER_HALF_HEIGHT) / ROLLER_HEIGHT, 0.0, 1.0);
    let bandIdx = floor(normalizedV * bandCount);
    let isCopper = (i32(bandIdx) % 2) == 0;

    // Copper band: warm reddish-gold metallic
    let copperBase  = vec3f(0.88, 0.50, 0.22);
    // Neodymium band: cool silver-steel
    let neoBase     = vec3f(0.70, 0.73, 0.78);
    let bandColor   = select(neoBase, copperBase, isCopper);

    // Diffuse shading with key light
    let lightDir = normalize(vec3f(0.8, 2.0, 0.6));
    let diffuse  = max(dot(n, lightDir), 0.08);

    // Per-ring primary tint (subtle colour coding of rings)
    var ringTint: vec3f;
    if (instanceId < 12.0)      { ringTint = vec3f(1.00, 0.96, 0.80); }  // inner: gold
    else if (instanceId < 34.0) { ringTint = vec3f(0.88, 0.94, 1.00); }  // middle: cool silver
    else                        { ringTint = vec3f(1.00, 0.88, 0.72); }  // outer: warm copper

    let metallic   = bandColor * ringTint * (0.28 + diffuse * 0.72);

    // Fresnel cyan edge glow (magnetic field visible on roller edges),
    // amplified by the coronal discharge at high spin.
    let fieldGlow  = vec3f(0.1, 0.85, 1.0) * fresnel * (1.0 + 2.0 * uniforms.corona);

    // GREEN LED underglow: bottom-facing normals catch floor lighting
    let bottomGlow = max(0.0, -n.y) * 1.6;
    let greenGlow  = vec3f(0.0, 1.1, 0.55) * bottomGlow;

    // Specular highlight — strong metallic sheen
    let specHigh   = vec3f(spec * 0.9);

    finalColor = metallic + fieldGlow * 0.5 + greenGlow + specHigh;

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
      // Collectors: copper-bronze whose charge glow tracks bucket voltage,
      // with a white flash at the moment of dielectric breakdown.
      let cop = vec3f(0.62, 0.36, 0.16);
      finalColor = cop + vec3f(0.45, 0.0, 0.82) * elec * fresnel * (0.5 + 1.5 * uniforms.kelvinVoltageN)
                 + vec3f(0.90, 0.95, 1.0) * uniforms.kelvinSpark * 0.6
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