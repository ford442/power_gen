export function getComputeShader() {
    return /* wgsl */ `
      struct ComputeUniforms {
        time: f32,
        mode: f32,
        particleCount: f32,
        speedMult: f32,
      }

      @binding(0) @group(0) var<storage, read_write> particles: array<vec4f>;
      @binding(1) @group(0) var<uniform> uniforms: ComputeUniforms;

      const PI: f32 = 3.14159265359;

      fn posSEG(phase: f32, t: f32, idx: u32) -> vec3f {
        let cycleT  = fract(t * 0.12 + phase);
        let radius  = 8.5 - cycleT * 8.0;
        let angle   = phase * 6.28318 + cycleT * 18.84956;
        let height  = sin(cycleT * 6.28318 * 2.0 + phase * 6.28318) * 2.8;

        // Harmonic turbulence: high-frequency jitter gives electrified, organic motion
        let jitter1    = sin(t * 7.3  + phase * 31.4) * 0.12;
        let jitter2    = cos(t * 11.7 + phase * 17.8) * 0.08;
        let jitter3    = sin(t * 5.1  + phase * 43.2) * 0.06;
        let turbAngle  = angle  + jitter2;
        let turbRadius = radius + sin(t * 3.7 + phase * 23.5) * (radius * 0.04);
        let turbHeight = height + jitter1 + jitter3;

        return vec3f(cos(turbAngle) * turbRadius, turbHeight, sin(turbAngle) * turbRadius);
      }

      fn posHeron(phase: f32, t: f32, idx: u32) -> vec3f {
        let cycleT  = fract(t * 0.22 + phase);
        let spread  = phase * 6.28318;
        let spreadR = fract(f32(idx) * 0.618034) * 0.55;
        var pos: vec3f;
        if (cycleT < 0.35) {
          let k = cycleT / 0.35;
          pos = vec3f(sin(spread) * spreadR * k * 1.4,
                      5.6 + k * 3.1 - k * k * 1.2,
                      cos(spread) * spreadR * k * 1.4);
        } else if (cycleT < 0.72) {
          let k = (cycleT - 0.35) / 0.37;
          pos = vec3f(sin(spread) * spreadR * (1.4 - k * 0.9),
                      8.5 - k * 4.2,
                      cos(spread) * spreadR * (1.4 - k * 0.9));
        } else {
          let k = (cycleT - 0.72) / 0.28;
          pos = vec3f(sin(spread) * spreadR * (0.5 - k * 0.5),
                      4.5 - k * 6.5,
                      cos(spread) * spreadR * (0.5 - k * 0.5));
        }
        return pos;
      }

      fn posKelvin(phase: f32, t: f32, idx: u32) -> vec3f {
        let cycleT = fract(t * 0.32 + phase);
        let side   = select(-1.0, 1.0, (idx & 1u) == 1u);
        let wobble = sin(t * 4.0 + phase * 20.0) * 0.09;
        var pos: vec3f;
        if (cycleT < 0.82) {
          let k = cycleT / 0.82;
          pos = vec3f(side * 2.5 + wobble, 5.5 - k * 8.8, wobble * 0.4);
        } else {
          let k = (cycleT - 0.82) / 0.18;
          pos = vec3f(side * 2.5 * (1.0 - k * 1.9), -3.2 + k * 1.4, 0.0);
        }
        return pos;
      }

      fn posSolar(phase: f32, t: f32, idx: u32, speedMult: f32) -> vec3f {
        let ledIdx = idx % 6u;
        let ledX   = (f32(ledIdx) - 2.5) * 1.6;
        let ledPos = vec3f(ledX, 3.5, 1.5);
        let panelX = (fract(f32(idx) * 0.61803) - 0.5) * 9.0;
        let panelZ = (fract(f32(idx) * 0.38490) - 0.5) * 9.0;
        let panelPos = vec3f(panelX, 0.05, panelZ);
        let speed = 1.0 + speedMult * 1.5;
        let life  = fract(t * speed * 0.18 + phase);
        return mix(ledPos, panelPos, min(life * 1.05, 1.0));
      }

      fn posPeltier(phase: f32, t: f32, idx: u32) -> vec3f {
        let isSetupA = (idx % 2u) == 0u;
        let xOffset = select(3.5, -3.5, isSetupA);
        let cycleT = fract(t * 0.4 + phase);
        var pos: vec3f;
        if (phase < 0.4) {
          let isBottom = isSetupA;
          let yStart = select(4.0, -4.0, isBottom);
          let currentY = mix(yStart, 0.0, cycleT);
          let px = xOffset + sin(phase * 123.45) * 1.5;
          let pz = cos(f32(idx) * 0.123) * 1.5;
          pos = vec3f(px, currentY, pz);
        } else if (phase < 0.8) {
          let isTop = isSetupA;
          let yStart = select(-4.0, 4.0, isTop);
          let currentY = mix(yStart, 0.0, cycleT);
          let px = xOffset + sin(phase * 123.45) * 1.5;
          let pz = cos(f32(idx) * 0.123) * 1.5;
          pos = vec3f(px, currentY, pz);
        } else {
          let angle = phase * 62.83 + f32(idx) * 0.1;
          let radius = 1.0 + cycleT * 3.0;
          let px = xOffset + cos(angle) * radius;
          let pz = sin(angle) * radius;
          let py = sin(t * 5.0 + phase * 20.0) * 0.15;
          pos = vec3f(px, py, pz);
        }
        return pos;
      }

      @compute @workgroup_size(64)
      fn main(@builtin(global_invocation_id) id: vec3u) {
        let idx = id.x;
        if (idx >= u32(uniforms.particleCount)) { return; }

        let p = particles[idx];
        let phase = p.w;
        let t = uniforms.time;
        let mode = uniforms.mode;

        var newPos: vec3f;
        if (mode < 0.5) {
          newPos = posSEG(phase, t, idx);
        } else if (mode < 1.5) {
          newPos = posHeron(phase, t, idx);
        } else if (mode < 2.5) {
          newPos = posKelvin(phase, t, idx);
        } else if (mode < 3.5) {
          newPos = posSolar(phase, t, idx, uniforms.speedMult);
        } else {
          newPos = posPeltier(phase, t, idx);
        }

        particles[idx] = vec4f(newPos, phase);
      }
    `;
  }

export function getSegRollerComputeShader() {
    return /* wgsl */ `
      struct RollerInstance {
        position:     vec3f,
        ringIndex:    f32,
        rotation:     vec4f,
        copperColor:  vec3f,
        greenEmissive: f32,
      }

      struct RollerUniforms {
        time:      f32,
        speedMult: f32,
        prototypePreset: f32,
        pad1:      f32,
      }

      struct SEGLayoutRing {
        count: f32,
        fullCount: f32,
        orbitRadius: f32,
        rollerRadius: f32,
        rollerHeight: f32,
        speed: f32,
        statorInner: f32,
        statorOuter: f32,
        rollerOffset: f32,
        _pad0: f32,
        _pad1: f32,
        _pad2: f32
      }

      struct SEGLayoutUniforms {
        worldScale: f32,
        ringCount: f32,
        totalRollers: f32,
        maxRollers: f32,
        refRollerRadius: f32,
        refRollerHeight: f32,
        statorHeight: f32,
        fluxLinesPerRing: f32,
        ring0: SEGLayoutRing,
        ring1: SEGLayoutRing,
        ring2: SEGLayoutRing
      }

      @group(0) @binding(0) var<storage, read_write> rollers: array<RollerInstance>;
      @group(0) @binding(1) var<uniform>             uniforms: RollerUniforms;
      @group(0) @binding(2) var<uniform>             segLayout: SEGLayoutUniforms;

      const PI: f32 = 3.14159265359;

      fn poleTint(ringIdx: u32, localI: u32, lab: bool) -> vec3f {
        let isNorth = ((localI + ringIdx) & 1u) == 0u;
        if (lab) {
          return select(vec3f(0.48, 0.50, 0.54), vec3f(0.78, 0.80, 0.82), isNorth);
        }
        return select(vec3f(0.38, 0.45, 0.68), vec3f(0.92, 0.58, 0.35), isNorth);
      }

      fn ringForFlatIndex(idx: u32) -> SEGLayoutRing {
        if (idx >= u32(segLayout.ring2.rollerOffset)) { return segLayout.ring2; }
        if (idx >= u32(segLayout.ring1.rollerOffset)) { return segLayout.ring1; }
        return segLayout.ring0;
      }

      fn localIndexInRing(idx: u32, ring: SEGLayoutRing) -> u32 {
        return idx - u32(ring.rollerOffset);
      }

      @compute @workgroup_size(64)
      fn main(@builtin(global_invocation_id) gid: vec3u) {
        let idx = gid.x;
        if (idx >= u32(segLayout.totalRollers)) { return; }

        let ring = ringForFlatIndex(idx);
        let localI = localIndexInRing(idx, ring);
        if (localI >= u32(ring.count)) { return; }

        var ringIdx: u32 = 0u;
        if (u32(ring.rollerOffset) == u32(segLayout.ring1.rollerOffset)) { ringIdx = 1u; }
        if (u32(ring.rollerOffset) == u32(segLayout.ring2.rollerOffset)) { ringIdx = 2u; }

        let count = u32(ring.count);
        let radius = ring.orbitRadius;
        let rollerR = ring.rollerRadius;
        let speed = ring.speed;
        let t = uniforms.time;
        let lab = uniforms.prototypePreset > 0.5;

        let startupRamp = min(t * (0.25 + f32(ringIdx) * 0.1), 1.0);
        let jitterSeed = f32(idx) * 127.3 + f32(ringIdx) * 53.7;
        let speedJitter = 1.0 + 0.04 * sin(t * 1.3 + sin(jitterSeed) * 12.7);

        let baseAngle = (f32(localI) / f32(count)) * PI * 2.0;
        let angle = baseAngle + t * 0.5 * speed * speedJitter * startupRamp + f32(ringIdx) * 0.22;

        let x = cos(angle) * radius;
        let z = sin(angle) * radius;

        let gearRatio = radius / max(rollerR, 1e-4);
        let selfRotAngle = angle * gearRatio * 0.5;
        let tangentAngle = angle + PI / 2.0;
        let rollAxisX = cos(tangentAngle);
        let rollAxisZ = sin(tangentAngle);
        let halfAngle = selfRotAngle / 2.0;

        let isNorth = ((localI + ringIdx) & 1u) == 0u;
        let baseEmit = select(0.0, 0.08, isNorth);
        let emissive = min(baseEmit * max(1.0, uniforms.speedMult * 0.5) + uniforms.speedMult * 0.02, 1.0);

        var r: RollerInstance;
        r.position = vec3f(x, 0.0, z);
        r.ringIndex = f32(ringIdx);
        r.rotation = vec4f(
          rollAxisX * sin(halfAngle),
          0.0,
          rollAxisZ * sin(halfAngle),
          cos(halfAngle)
        );
        r.copperColor = poleTint(ringIdx, localI, lab);
        r.greenEmissive = emissive;

        rollers[idx] = r;
      }
    `;
  }

export function getSegFieldAdvectShader() {
    return /* wgsl */ `
      struct FieldParticle {
        posX: f32,
        posY: f32,
        posZ: f32,
        velX: f32,
        velY: f32,
        velZ: f32,
        life: f32,
        strength: f32,
      }

      struct FieldUniforms {
        time:          f32,
        speedMult:     f32,
        particleCount: u32,
        pad:           f32,
      }

      @group(0) @binding(0) var<storage, read_write> particles: array<FieldParticle>;
      @group(0) @binding(1) var<uniform>             uniforms:  FieldUniforms;

      const PI: f32 = 3.14159265359;

      @compute @workgroup_size(64)
      fn main(@builtin(global_invocation_id) gid: vec3u) {
        let i = gid.x;
        if (i >= uniforms.particleCount) { return; }

        // uniforms.time is already the speed-scaled visualizer time
        let t      = uniforms.time;
        let sm     = uniforms.speedMult;
        let ringIdx = i % 3u;
        let r      = array<f32, 3>(2.5, 4.0, 5.5)[ringIdx];

        // Advect along the circular magnetic flux ring (mirrors CPU formula)
        let angle       = (f32(i) / f32(uniforms.particleCount)) * PI * 20.0
                        + t * (0.5 + f32(ringIdx) * 0.3);
        let heightOffset = sin(t * 0.5 + f32(i) * 0.1) * 0.8;

        let px = cos(angle) * r;
        let pz = sin(angle) * r;
        let py = heightOffset;

        // Velocity tangent to the ring
        let speed = 1.0 + f32(ringIdx) * 0.5;
        let vx = -sin(angle) * speed;
        let vy =  cos(t * 2.0 + f32(i) * 0.05) * 0.1;
        let vz =  cos(angle)  * speed;

        // Life and strength boosted at higher speeds for denser/brighter field lines
        let lifePulse = sin(t * 2.0 + f32(i) * 0.5) * 0.5 + 0.5;
        let life      = clamp(lifePulse * min(sm * 0.4 + 0.6, 1.0), 0.0, 1.0);
        let strength  = clamp(0.3 + 0.7 * sin(angle * 3.0 + t), 0.0, 1.0)
                      * min(1.0, 0.5 + sm * 0.15);

        var p: FieldParticle;
        p.posX = px;
        p.posY = py;
        p.posZ = pz;
        p.velX = vx;
        p.velY = vy;
        p.velZ = vz;
        p.life     = life;
        p.strength = strength;

        particles[i] = p;
      }
    `;
  }
