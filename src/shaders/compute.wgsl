//=============================================================================
// PARTICLE PHYSICS COMPUTE SHADER
// SEG (Searl Effect Generator) - Magnetic Monopole Visualization
// 
// Physics Model:
// - Particles represent magnetic monopoles (conceptual visualization aid)
// - Force: F = qₘ·B (magnetic charge × field)
// - Velocity proportional to |B| along field lines
// - Particles follow magnetic field trajectories
//
// References:
// - Magnetic force on monopole: F = qₘB (hypothetical)
// - Field line following: v ∝ B/|B|
// - Wolfram Alpha "magnetic monopole force"
//=============================================================================

// ============================================
// Physical Constants (CODATA 2018)
// ============================================
const PI: f32 = 3.14159265359;

// Vacuum permeability: μ₀ ≈ 1.25663706212 × 10⁻⁶ N/A²
// Source: Wolfram Alpha "mu_0 value"
const MU_0: f32 = 1.25663706212e-6;

// Remanence of NdFeB N52 magnets
const BR_N52: f32 = 1.48;

// Magnetic moment per roller (A·m²)
// Wolfram-calculated from magnet dimensions and magnetization
const ROLLER_MOMENT: f32 = 18.5;

// ============================================
// SEG Ring Configuration
// ============================================
const INNER_RING_COUNT: i32 = 8;
const MIDDLE_RING_COUNT: i32 = 12;
const OUTER_RING_COUNT: i32 = 16;

const INNER_RADIUS: f32 = 2.5;
const MIDDLE_RADIUS: f32 = 4.0;
const OUTER_RADIUS: f32 = 5.5;

// ============================================
// Particle Physics Parameters
// ============================================

// Magnetic charge of conceptual monopole (for visualization)
// Note: True magnetic monopoles have not been observed
// This is a visualization parameter, not a physical constant
const MAGNETIC_CHARGE: f32 = 1.0;

// Velocity scaling: how fast particles move along field lines
const VELOCITY_SCALE: f32 = 2.0;

// Color mapping range for field magnitude (0-3 Tesla)
const MAX_FIELD_TESLA: f32 = 3.0;

// ============================================
// Buffer Bindings
// ============================================

// Particle data structure
// Packed as vec4f for alignment:
// x, y, z = position
// w = phase (for animation offset)
// velocity, fieldStrength, and color are derived from position
struct Particle {
    position: vec4f,    // xyz = world position, w = phase/time offset
    velocity: vec4f,    // xyz = velocity vector, w = field magnitude
    color: vec4f,       // rgb = color, a = alpha
}

@binding(0) @group(0) var<storage, read_write> particles: array<Particle>;

// Uniform buffer for simulation parameters
struct ComputeUniforms {
    time: f32,
    mode: f32,          // 0=SEG, 1=Heron, 2=Kelvin, 3=Solar
    particleCount: f32,
    deltaTime: f32,
    
    // SEG-specific parameters
    fieldLineFollow: f32,   // 0-1, how closely particles follow field lines
    speedMultiplier: f32,   // Global speed adjustment
    colorMode: f32,         // 0=field magnitude, 1=velocity, 2=ring-based
    
    // Additional physics parameters
    turbulence: f32,        // Random perturbation amount
    decayRate: f32,         // How quickly particles fade
    _pad: vec2f,
}

@binding(1) @group(0) var<uniform> uniforms: ComputeUniforms;

// ============================================
// Magnetic Field Calculation Functions
// ============================================

// -----------------------------------------------------------------------------
// Magnetic Dipole Field
// Formula: B = (μ₀/4π)[3(m·r̂)r̂ - m]/r³
// Source: Wolfram Alpha "magnetic dipole field formula"
// -----------------------------------------------------------------------------
fn magneticDipoleField(
    observationPoint: vec3f,
    dipolePosition: vec3f,
    magneticMoment: vec3f
) -> vec3f {
    let r = observationPoint - dipolePosition;
    let dist = length(r);
    
    if (dist < 0.001) {
        return vec3f(0.0);
    }
    
    let rHat = normalize(r);
    let mDotR = dot(magneticMoment, rHat);
    let prefactor = MU_0 / (4.0 * PI);
    let rCubed = dist * dist * dist;
    let factor = prefactor / rCubed;
    
    return factor * (3.0 * mDotR * rHat - magneticMoment);
}

// -----------------------------------------------------------------------------
// Get Roller Position and Magnetic Moment
// -----------------------------------------------------------------------------
fn getRollerMagneticState(
    ringIndex: i32,
    rollerIndex: i32,
    time: f32,
    outPosition: ptr<function, vec3f>,
    outMoment: ptr<function, vec3f>
) {
    var ringCount: i32;
    var ringRadius: f32;
    var rotationSpeed: f32;
    
    switch (ringIndex) {
        case 0: {
            ringCount = INNER_RING_COUNT;
            ringRadius = INNER_RADIUS;
            rotationSpeed = 2.0;
        }
        case 1: {
            ringCount = MIDDLE_RING_COUNT;
            ringRadius = MIDDLE_RADIUS;
            rotationSpeed = 1.0;
        }
        case 2: {
            ringCount = OUTER_RING_COUNT;
            ringRadius = OUTER_RADIUS;
            rotationSpeed = 0.5;
        }
        default: {
            ringCount = MIDDLE_RING_COUNT;
            ringRadius = MIDDLE_RADIUS;
            rotationSpeed = 1.0;
        }
    }
    
    let baseAngle = f32(rollerIndex) * (2.0 * PI / f32(ringCount));
    let angle = baseAngle + time * 0.5 * rotationSpeed;
    
    *outPosition = vec3f(
        cos(angle) * ringRadius,
        0.0,
        sin(angle) * ringRadius
    );
    
    *outMoment = vec3f(
        -sin(angle) * ROLLER_MOMENT,
        0.0,
        cos(angle) * ROLLER_MOMENT
    );
}

// -----------------------------------------------------------------------------
// Total Toroidal B-Field from All Rollers
// -----------------------------------------------------------------------------
fn calculateToroidalField(pos: vec3f, time: f32) -> vec3f {
    var totalField = vec3f(0.0);
    
    for (var ring: i32 = 0; ring < 3; ring++) {
        var rollerCount: i32;
        
        switch (ring) {
            case 0: { rollerCount = INNER_RING_COUNT; }
            case 1: { rollerCount = MIDDLE_RING_COUNT; }
            case 2: { rollerCount = OUTER_RING_COUNT; }
            default: { rollerCount = MIDDLE_RING_COUNT; }
        }
        
        for (var i: i32 = 0; i < rollerCount; i++) {
            var rollerPos: vec3f;
            var rollerMoment: vec3f;
            
            getRollerMagneticState(ring, i, time, &rollerPos, &rollerMoment);
            totalField += magneticDipoleField(pos, rollerPos, rollerMoment);
        }
    }
    
    return totalField;
}

// ============================================
// Color Mapping Functions
// ============================================

// -----------------------------------------------------------------------------
// Map Field Magnitude to Color
// Cyan (low B) → Yellow (medium) → Magenta (high)
// -----------------------------------------------------------------------------
fn fieldMagnitudeToColor(Bmag: f32) -> vec3f {
    let t = clamp(Bmag / MAX_FIELD_TESLA, 0.0, 1.0);
    
    if (t < 0.5) {
        // Cyan (0, 1, 1) to Yellow (1, 1, 0)
        let s = t * 2.0;
        return vec3f(s, 1.0, 1.0 - s);
    } else {
        // Yellow (1, 1, 0) to Magenta (1, 0, 1)
        let s = (t - 0.5) * 2.0;
        return vec3f(1.0, 1.0 - s, s);
    }
}

// -----------------------------------------------------------------------------
// Map Velocity to Color
// Blue (slow) → Green (medium) → Red (fast)
// -----------------------------------------------------------------------------
fn velocityToColor(velocity: f32) -> vec3f {
    let t = clamp(velocity / VELOCITY_SCALE, 0.0, 1.0);
    
    if (t < 0.5) {
        // Blue to Green
        let s = t * 2.0;
        return vec3f(0.0, s, 1.0 - s);
    } else {
        // Green to Red
        let s = (t - 0.5) * 2.0;
        return vec3f(s, 1.0 - s, 0.0);
    }
}

// -----------------------------------------------------------------------------
// Calculate Alpha Based on Field Strength
// -----------------------------------------------------------------------------
fn calculateAlpha(Bmag: f32, phase: f32, time: f32) -> f32 {
    // Base alpha from field strength
    let strengthAlpha = 0.3 + 0.5 * clamp(Bmag / MAX_FIELD_TESLA, 0.0, 1.0);
    
    // Pulsing effect based on phase
    let pulse = 0.8 + 0.2 * sin(time * 3.0 + phase * 6.28318530718);
    
    return strengthAlpha * pulse;
}

// ============================================
// Particle Update Functions for Each Mode
// ============================================

// -----------------------------------------------------------------------------
// SEG Mode: Particles Follow Magnetic Field Lines
// Physics: F = qₘ·B, velocity ∝ B/|B|
// -----------------------------------------------------------------------------
fn updateSEGMode(particle: ptr<function, Particle>, idx: u32, time: f32, dt: f32) {
    let pos = (*particle).position.xyz;
    let phase = (*particle).position.w;
    
    // Calculate magnetic field at current position
    let B = calculateToroidalField(pos, time);
    let Bmag = length(B);
    
    // Velocity is proportional to field strength along field line direction
    // v = v₀ × (B/|B|) × |B|^0.5 for non-linear speed
    var velocity: vec3f;
    if (Bmag > 1.0e-6) {
        let speed = VELOCITY_SCALE * uniforms.speedMultiplier * sqrt(Bmag);
        velocity = speed * B / Bmag;
    } else {
        // In zero-field region, drift outward
        velocity = normalize(pos) * 0.5;
    }
    
    // Add turbulence
    if (uniforms.turbulence > 0.0) {
        let noise = vec3f(
            sin(time * 4.0 + f32(idx) * 0.1),
            cos(time * 3.0 + f32(idx) * 0.2),
            sin(time * 5.0 + f32(idx) * 0.3)
        );
        velocity += noise * uniforms.turbulence;
    }
    
    // Update position
    var newPos = pos + velocity * dt;
    
    // Boundary check - reset if too far from device or too close to center
    let dist = length(vec2f(newPos.x, newPos.z));
    let height = abs(newPos.y);
    
    // Reset conditions:
    // 1. Beyond outer boundary (8m radius)
    // 2. Too close to center (inside inner ring)
    // 3. Too high or low
    if (dist > 8.0 || dist < 1.5 || height > 6.0) {
        // Reset to a random position near the rollers
        let ringIdx = i32(fract(f32(idx) * 0.618034) * 3.0);
        var ringRadius: f32;
        
        switch (ringIdx) {
            case 0: { ringRadius = INNER_RADIUS; }
            case 1: { ringRadius = MIDDLE_RADIUS; }
            case 2: { ringRadius = OUTER_RADIUS; }
            default: { ringRadius = MIDDLE_RADIUS; }
        }
        
        let theta = fract(f32(idx) * 0.314159) * 2.0 * PI;
        newPos = vec3f(
            cos(theta) * ringRadius * 1.2,
            (fract(f32(idx) * 0.123) - 0.5) * 2.0,
            sin(theta) * ringRadius * 1.2
        );
        
        // Reset phase
        (*particle).position.w = fract(phase + 0.1);
    }
    
    // Update particle data
    (*particle).position.x = newPos.x;
    (*particle).position.y = newPos.y;
    (*particle).position.z = newPos.z;
    
    // Store velocity and field magnitude
    (*particle).velocity = vec4f(velocity, Bmag);
    
    // Calculate color based on mode
    var color: vec3f;
    switch (u32(uniforms.colorMode)) {
        case 0u: { color = fieldMagnitudeToColor(Bmag); }
        case 1u: { color = velocityToColor(length(velocity)); }
        case 2u: {
            // Ring-based coloring
            if (dist < 3.0) {
                color = vec3f(1.0, 0.8, 0.2);  // Inner: Gold
            } else if (dist < 5.0) {
                color = vec3f(0.8, 0.9, 1.0);  // Middle: Silver
            } else {
                color = vec3f(1.0, 0.6, 0.2);  // Outer: Copper
            }
        }
        default: { color = fieldMagnitudeToColor(Bmag); }
    }
    
    let alpha = calculateAlpha(Bmag, phase, time);
    (*particle).color = vec4f(color, alpha);
}

// -----------------------------------------------------------------------------
// Heron's Fountain Mode: Fountain Flow Physics
// -----------------------------------------------------------------------------
fn updateHeronMode(particle: ptr<function, Particle>, idx: u32, time: f32, dt: f32) {
    var pos = (*particle).position.xyz;
    let phase = (*particle).position.w;
    
    // Upward velocity with slight spread
    pos.y += 0.05 * uniforms.speedMultiplier;
    pos.x += sin(time + phase * 10.0) * 0.02;
    pos.z += cos(time + phase * 10.0) * 0.02;
    
    // Reset at fountain base
    if (pos.y > 4.0) {
        pos.y = -2.0;
        let theta = fract(f32(idx) * 0.618) * 6.28;
        let r = fract(f32(idx) * 0.314) * 1.5;
        pos.x = cos(theta) * r;
        pos.z = sin(theta) * r;
    }
    
    (*particle).position = vec4f(pos, phase);
    
    // Blue water color
    let heightFactor = clamp((pos.y + 2.0) / 6.0, 0.0, 1.0);
    let color = mix(vec3f(0.0, 0.2, 0.6), vec3f(0.0, 0.6, 1.0), heightFactor);
    (*particle).velocity = vec4f(0.0, 0.05, 0.0, 0.0);
    (*particle).color = vec4f(color, 0.6);
}

// -----------------------------------------------------------------------------
// Kelvin's Thunderstorm Mode: Electric Discharge
// -----------------------------------------------------------------------------
fn updateKelvinMode(particle: ptr<function, Particle>, idx: u32, time: f32, dt: f32) {
    var pos = (*particle).position.xyz;
    let phase = (*particle).position.w;
    
    let dist = length(vec2f(pos.x, pos.z));
    
    if (dist < 0.1) {
        // Discharge and reset
        pos.x = (fract(f32(idx) * 0.123) - 0.5) * 8.0;
        pos.z = (fract(f32(idx) * 0.456) - 0.5) * 8.0;
        pos.y = 5.0 + fract(f32(idx) * 0.789) * 2.0;
    } else {
        pos.y -= 0.1 * uniforms.speedMultiplier;
        pos.x += (fract(sin(f32(idx) + time)) - 0.5) * 0.1;
        pos.z += (fract(cos(f32(idx) + time)) - 0.5) * 0.1;
    }
    
    (*particle).position = vec4f(pos, phase);
    
    // Purple electric color
    let electric = fract(sin(dot(pos.xz, vec2f(12.9898, 78.233))) * 43758.5453);
    let spark = step(0.98, electric);
    let color = mix(vec3f(0.4, 0.0, 0.6), vec3f(1.0, 0.5, 1.0), spark);
    
    (*particle).velocity = vec4f(0.0, -0.1, 0.0, 0.0);
    (*particle).color = vec4f(color, 0.7);
}

// -----------------------------------------------------------------------------
// Solar Mode: Photon Particles
// -----------------------------------------------------------------------------
fn updateSolarMode(particle: ptr<function, Particle>, idx: u32, time: f32, dt: f32) {
    let pos = (*particle).position.xyz;
    let phase = (*particle).position.w;
    
    let ledCount = 6u;
    let ledIdx = u32(fract(phase) * f32(ledCount));
    let ledAngle = f32(ledIdx) * 6.28318530718 / f32(ledCount);
    let ledPos = vec3f(cos(ledAngle) * 3.0, 3.5, sin(ledAngle) * 3.0);
    
    let targetPos = vec3f(
        (fract(f32(idx) * 0.618) - 0.5) * 6.0,
        0.0,
        (fract(f32(idx) * 0.314) - 0.5) * 4.0
    );
    
    let progress = fract(time * 0.5 + phase * 10.0);
    let t = clamp(progress * uniforms.speedMultiplier, 0.0, 1.0);
    
    let newPos = mix(ledPos, targetPos, t);
    
    if (progress > 0.98) {
        (*particle).position.w = fract(phase * 1.618 + 0.33);
    }
    
    (*particle).position.x = newPos.x;
    (*particle).position.y = newPos.y;
    (*particle).position.z = newPos.z;
    
    // Yellow photon color
    let intensity = 0.5 + 0.5 * sin(time * 2.0);
    let color = vec3f(1.0, 0.9, 0.2) * intensity;
    
    (*particle).velocity = vec4f(0.0, 0.0, 0.0, 0.0);
    (*particle).color = vec4f(color, 0.6 + intensity * 0.3);
}

// ============================================
// Main Compute Entry Point
// ============================================

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let idx = id.x;
    let count = u32(uniforms.particleCount);
    
    if (idx >= count) {
        return;
    }
    
    // Load particle
    var particle = particles[idx];
    let time = uniforms.time;
    let dt = uniforms.deltaTime;
    let mode = uniforms.mode;
    
    // Update based on mode
    if (mode < 0.5) {
        // SEG mode - magnetic field following
        updateSEGMode(&particle, idx, time, dt);
    } else if (mode < 1.5) {
        // Heron's Fountain mode
        updateHeronMode(&particle, idx, time, dt);
    } else if (mode < 2.5) {
        // Kelvin's Thunderstorm mode
        updateKelvinMode(&particle, idx, time, dt);
    } else {
        // Solar mode
        updateSolarMode(&particle, idx, time, dt);
    }
    
    // Store updated particle
    particles[idx] = particle;
}

// ============================================
// Alternative: Simple Mode (Original Behavior)
// ============================================

// Storage buffer for simple particle format (backward compatibility)
@binding(2) @group(0) var<storage, read_write> simpleParticles: array<vec4f>;

@compute @workgroup_size(64)
fn mainSimple(@builtin(global_invocation_id) id: vec3u) {
    let idx = id.x;
    let count = u32(uniforms.particleCount);
    
    if (idx >= count) {
        return;
    }
    
    var p = simpleParticles[idx];
    let time = uniforms.time;
    let mode = uniforms.mode;
    let dt = uniforms.deltaTime;
    
    if (mode < 0.5) {
        // SEG mode with real magnetic physics
        let B = calculateToroidalField(p.xyz, time);
        let Bmag = length(B);
        
        // Move along field line
        if (Bmag > 1.0e-6) {
            let speed = VELOCITY_SCALE * sqrt(Bmag);
            let newPos = p.xyz + (B / Bmag) * speed * dt;
            p = vec4f(newPos, p.w);
        }
        
        // Reset if too far
        let dist = length(p.xz);
        if (dist > 8.0 || dist < 1.0) {
            let theta = fract(f32(idx) * 0.61803398875) * 6.28318530718;
            let r = 2.5 + fract(f32(idx) * 0.31415) * 4.0;
            p.x = r * cos(theta);
            p.z = r * sin(theta);
            p.y = (fract(f32(idx) * 0.1234) - 0.5) * 4.0;
        }
    } else if (mode < 1.5) {
        // Heron mode
        p.y += 0.05 * uniforms.speedMultiplier;
        p.x += sin(time + p.w * 10.0) * 0.02;
        p.z += cos(time + p.w * 10.0) * 0.02;
        
        if (p.y > 4.0) {
            p.y = -2.0;
            let theta = fract(f32(idx) * 0.618) * 6.28;
            let r = fract(f32(idx) * 0.314) * 1.5;
            p.x = cos(theta) * r;
            p.z = sin(theta) * r;
        }
    } else if (mode < 2.5) {
        // Kelvin mode
        let dist = length(p.xz);
        if (dist < 0.1) {
            p.x = (fract(f32(idx) * 0.123) - 0.5) * 8.0;
            p.z = (fract(f32(idx) * 0.456) - 0.5) * 8.0;
            p.y = 5.0 + fract(f32(idx) * 0.789) * 2.0;
        } else {
            p.y -= 0.1 * uniforms.speedMultiplier;
            p.x += (fract(sin(f32(idx) + time)) - 0.5) * 0.1;
            p.z += (fract(cos(f32(idx) + time)) - 0.5) * 0.1;
        }
    } else {
        // Solar mode
        let ledCount = 6u;
        let ledIdx = u32(fract(p.w) * f32(ledCount));
        let ledAngle = f32(ledIdx) * 6.28318530718 / f32(ledCount);
        let ledPos = vec3f(cos(ledAngle) * 3.0, 3.5, sin(ledAngle) * 3.0);
        let targetPos = vec3f(
            (fract(f32(idx) * 0.618) - 0.5) * 6.0,
            0.0,
            (fract(f32(idx) * 0.314) - 0.5) * 4.0
        );
        let progress = fract(time * 0.5 + p.w * 10.0);
        let t = clamp(progress * uniforms.speedMultiplier, 0.0, 1.0);
        p.xyz = mix(ledPos, targetPos, t);
        if (progress > 0.98) {
            p.w = fract(p.w * 1.618 + 0.33);
        }
    }
    
    simpleParticles[idx] = p;
}
