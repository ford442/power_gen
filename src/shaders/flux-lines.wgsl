//=============================================================================
// MAGNETIC FLUX LINE TRACING COMPUTE SHADER
// SEG (Searl Effect Generator) Field Line Visualization
// 
// Uses 4th-order Runge-Kutta (RK4) integration for accurate field line tracing
// Field lines follow ∇×B = 0 (irrotational field paths)
//
// References:
// - Runge-Kutta 4th Order: Wolfram Alpha "RK4 integration method"
// - Magnetic Flux Lines: Wolfram Alpha "magnetic field line tracing"
//=============================================================================

// Include magnetic field calculation functions
// Note: In actual WebGPU usage, these would be combined via shader pre-processing
// or the implementation would be duplicated here

// ============================================
// Physical Constants (from magnetic-field.wgsl)
// ============================================
const PI: f32 = 3.14159265359;
const MU_0: f32 = 1.25663706212e-6;
const ROLLER_MOMENT: f32 = 18.5;  // A·m²

const INNER_RING_COUNT: i32 = 8;
const MIDDLE_RING_COUNT: i32 = 12;
const OUTER_RING_COUNT: i32 = 16;

const INNER_RADIUS: f32 = 2.5;
const MIDDLE_RADIUS: f32 = 4.0;
const OUTER_RADIUS: f32 = 5.5;

// ============================================
// Flux Line Configuration
// ============================================
const FLUX_LINES_PER_RING: i32 = 36;  // 36 lines per ring
const TOTAL_FLUX_LINES: i32 = 108;    // 3 rings × 36 lines
const SEGMENTS_PER_LINE: i32 = 100;   // Resolution of each line
const TOTAL_SEGMENTS: i32 = 10800;    // 108 lines × 100 segments

// Integration parameters
const INTEGRATION_STEP: f32 = 0.02;   // Step size for RK4 (meters)
const MAX_FIELD_AGE: f32 = 100.0;     // Max segments before reset

// ============================================
// Buffer Bindings
// ============================================

// Storage buffer for field line segments
// Each segment: (start_pos: vec3f, end_pos: vec3f, strength: f32, age: f32)
// Aligned to 32 bytes per segment for GPU efficiency
struct FluxSegment {
    startPos: vec3f,
    endPos: vec3f,
    strength: f32,  // Field magnitude at segment
    age: f32,       // Segment age for animation
}

@binding(0) @group(0) var<storage, read_write> fluxSegments: array<FluxSegment>;

// Uniform buffer for simulation parameters
struct FluxUniforms {
    time: f32,
    deltaTime: f32,
    integrationStep: f32,
    lineOpacity: f32,
    seedRadius: f32,      // Radius around rollers for seeding
    followStrength: f32,  // How closely lines follow B-field (0-1)
    _pad: f32,
}

@binding(1) @group(0) var<uniform> fluxUniforms: FluxUniforms;

// ============================================
// Magnetic Field Functions (Duplicated for Standalone)
// ============================================

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
// Runge-Kutta 4th Order Integration
// ============================================

// -----------------------------------------------------------------------------
// RK4 Step for Field Line Tracing
// 
// dy/dt = f(t, y) where f is the B-field direction
// k1 = h × f(tₙ, yₙ)
// k2 = h × f(tₙ + h/2, yₙ + k1/2)
// k3 = h × f(tₙ + h/2, yₙ + k2/2)
// k4 = h × f(tₙ + h, yₙ + k3)
// yₙ₊₁ = yₙ + (k1 + 2k2 + 2k3 + k4)/6
//
// Source: Wolfram Alpha "Runge-Kutta 4th order method"
//
// @param pos - Current position on field line
// @param time - Simulation time
// @param h - Step size
// @param direction - 1 for forward, -1 for backward along field line
// @return New position after RK4 step
// -----------------------------------------------------------------------------
fn rk4Step(pos: vec3f, time: f32, h: f32, direction: f32) -> vec3f {
    // Function f(t, y) = normalized B-field direction at position y
    
    // k1 = h × B(pos) / |B(pos)|
    let B1 = calculateToroidalField(pos, time);
    let B1mag = length(B1);
    if (B1mag < 1.0e-10) {
        return pos;
    }
    let k1 = h * direction * B1 / B1mag;
    
    // k2 = h × B(pos + k1/2) / |B(pos + k1/2)|
    let B2 = calculateToroidalField(pos + k1 * 0.5, time);
    let B2mag = length(B2);
    if (B2mag < 1.0e-10) {
        return pos + k1;
    }
    let k2 = h * direction * B2 / B2mag;
    
    // k3 = h × B(pos + k2/2) / |B(pos + k2/2)|
    let B3 = calculateToroidalField(pos + k2 * 0.5, time);
    let B3mag = length(B3);
    if (B3mag < 1.0e-10) {
        return pos + k2;
    }
    let k3 = h * direction * B3 / B3mag;
    
    // k4 = h × B(pos + k3) / |B(pos + k3)|
    let B4 = calculateToroidalField(pos + k3, time);
    let B4mag = length(B4);
    if (B4mag < 1.0e-10) {
        return pos + k3;
    }
    let k4 = h * direction * B4 / B4mag;
    
    // yₙ₊₁ = yₙ + (k1 + 2k2 + 2k3 + k4)/6
    return pos + (k1 + 2.0 * k2 + 2.0 * k3 + k4) / 6.0;
}

// -----------------------------------------------------------------------------
// Simple Euler Step (for comparison or fallback)
// Less accurate but faster than RK4
// -----------------------------------------------------------------------------
fn eulerStep(pos: vec3f, time: f32, h: f32, direction: f32) -> vec3f {
    let B = calculateToroidalField(pos, time);
    let Bmag = length(B);
    
    if (Bmag < 1.0e-10) {
        return pos;
    }
    
    return pos + h * direction * B / Bmag;
}

// ============================================
// Flux Line Seeding Functions
// ============================================

// -----------------------------------------------------------------------------
// Generate Seed Point for a Flux Line
// Seeds are distributed around roller surfaces for realistic field line origin
//
// @param lineIndex - Index of the flux line (0 to TOTAL_FLUX_LINES-1)
// @param segmentIndex - Index of segment along the line
// @param time - Current time
// @return Seed position for this field line
// -----------------------------------------------------------------------------
fn getFluxLineSeed(lineIndex: i32, time: f32) -> vec3f {
    // Determine which ring this line belongs to
    let ringIndex = lineIndex / FLUX_LINES_PER_RING;
    let indexInRing = lineIndex % FLUX_LINES_PER_RING;
    
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
    
    // Distribute seeds around each roller in the ring
    let rollerIndex = indexInRing % ringCount;
    let seedOffset = f32(indexInRing / ringCount);
    
    let baseAngle = f32(rollerIndex) * (2.0 * PI / f32(ringCount));
    let angle = baseAngle + time * 0.5 * rotationSpeed;
    
    // Roller center position
    let rollerPos = vec3f(
        cos(angle) * ringRadius,
        0.0,
        sin(angle) * ringRadius
    );
    
    // Seed offset from roller surface (slightly outside)
    let seedRadius = 0.06;  // Slightly larger than roller radius (0.05m)
    let seedAngle = seedOffset * 2.0 * PI / f32(FLUX_LINES_PER_RING / ringCount);
    let seedHeight = sin(seedAngle * 3.0) * 0.05;  // Vary height
    
    let offset = vec3f(
        cos(seedAngle) * seedRadius,
        seedHeight,
        sin(seedAngle) * seedRadius
    );
    
    return rollerPos + offset;
}

// ============================================
// Main Compute Shader Entry Point
// ============================================

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let globalIdx = i32(id.x);
    
    // Total work items = TOTAL_FLUX_LINES × SEGMENTS_PER_LINE
    if (globalIdx >= TOTAL_SEGMENTS) {
        return;
    }
    
    // Determine which flux line and segment this thread handles
    let lineIndex = globalIdx / SEGMENTS_PER_LINE;
    let segmentIndex = globalIdx % SEGMENTS_PER_LINE;
    
    let time = fluxUniforms.time;
    let h = fluxUniforms.integrationStep;
    
    // Calculate starting position for this segment
    var currentPos: vec3f;
    
    if (segmentIndex == 0) {
        // First segment: seed from roller surface
        currentPos = getFluxLineSeed(lineIndex, time);
    } else {
        // Subsequent segments: start from previous segment's end
        // Note: In a real implementation, we'd need to read from the previous segment
        // For simplicity, we integrate from seed for each segment (less efficient but works)
        currentPos = getFluxLineSeed(lineIndex, time);
        
        // Integrate to reach this segment's start position
        for (var i: i32 = 0; i < segmentIndex; i++) {
            currentPos = rk4Step(currentPos, time, h, 1.0);
        }
    }
    
    // Calculate field at current position
    let B = calculateToroidalField(currentPos, time);
    let Bmag = length(B);
    
    // Integrate to get end position of this segment
    let endPos = rk4Step(currentPos, time, h, 1.0);
    
    // Calculate age for animation (cycles 0-1 based on time)
    let age = fract(time * 0.5 + f32(segmentIndex) / f32(SEGMENTS_PER_LINE));
    
    // Store segment data
    let segment = FluxSegment(
        currentPos,
        endPos,
        Bmag,
        age
    );
    
    fluxSegments[globalIdx] = segment;
}

// ============================================
// Alternative: Bidirectional Field Line Tracing
// Traces both forward and backward from seed point for complete lines
// ============================================

@compute @workgroup_size(64)
fn traceBidirectional(@builtin(global_invocation_id) id: vec3u) {
    let lineIndex = i32(id.x);
    
    if (lineIndex >= TOTAL_FLUX_LINES) {
        return;
    }
    
    let time = fluxUniforms.time;
    let h = fluxUniforms.integrationStep;
    let halfSegments = SEGMENTS_PER_LINE / 2;
    
    // Start from seed point
    var centerPos = getFluxLineSeed(lineIndex, time);
    
    // Trace forward (positive direction along B-field)
    var forwardPos = centerPos;
    for (var i: i32 = 0; i < halfSegments; i++) {
        let segmentIdx = lineIndex * SEGMENTS_PER_LINE + halfSegments + i;
        if (segmentIdx >= TOTAL_SEGMENTS) { break; }
        
        let B = calculateToroidalField(forwardPos, time);
        let Bmag = length(B);
        
        let nextPos = rk4Step(forwardPos, time, h, 1.0);
        
        let age = fract(time * 0.5 + f32(i) / f32(halfSegments));
        
        fluxSegments[segmentIdx] = FluxSegment(
            forwardPos,
            nextPos,
            Bmag,
            age
        );
        
        forwardPos = nextPos;
    }
    
    // Trace backward (negative direction along B-field)
    var backwardPos = centerPos;
    for (var i: i32 = 0; i < halfSegments; i++) {
        let segmentIdx = lineIndex * SEGMENTS_PER_LINE + halfSegments - 1 - i;
        if (segmentIdx < 0 || segmentIdx >= TOTAL_SEGMENTS) { break; }
        
        let B = calculateToroidalField(backwardPos, time);
        let Bmag = length(B);
        
        let prevPos = rk4Step(backwardPos, time, h, -1.0);
        
        let age = fract(time * 0.5 + f32(i) / f32(halfSegments));
        
        // Note: For backward trace, startPos is the new point, endPos is current
        fluxSegments[segmentIdx] = FluxSegment(
            prevPos,
            backwardPos,
            Bmag,
            age
        );
        
        backwardPos = prevPos;
    }
}

// ============================================
// Vertex Output Structure for Rendering
// ============================================

struct FieldLineVertexOutput {
    @builtin(position) position: vec4f,
    @location(0) color: vec3f,
    @location(1) alpha: f32,
    @location(2) fieldStrength: f32,
}

// ============================================
// Rendering Helpers (for use in vertex shader)
// ============================================

// Color mapping: cyan (low B) → yellow (medium) → magenta (high)
fn fieldStrengthToColor(Bmag: f32) -> vec3f {
    // Normalize to 0-1 range (3T max)
    let t = clamp(Bmag / 3.0, 0.0, 1.0);
    
    if (t < 0.5) {
        let s = t * 2.0;
        return vec3f(s, 1.0, 1.0 - s);  // Cyan to Yellow
    } else {
        let s = (t - 0.5) * 2.0;
        return vec3f(1.0, 1.0 - s, s);  // Yellow to Magenta
    }
}

// Opacity based on field strength and age
fn calculateLineAlpha(Bmag: f32, age: f32) -> f32 {
    // Stronger fields = more opaque
    let strengthAlpha = clamp(Bmag / 2.0, 0.1, 0.8);
    
    // Age-based pulse effect
    let agePulse = 0.7 + 0.3 * sin(age * 6.28318530718);
    
    return strengthAlpha * agePulse * fluxUniforms.lineOpacity;
}
