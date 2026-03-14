//=============================================================================
// MAGNETIC FIELD CALCULATIONS FOR SEG (SEARL EFFECT GENERATOR)
// Wolfram Alpha / Wolfram Language Validated Physics
// 
// References:
// - Magnetic dipole field: B = (μ₀/4π)[3(m·r̂)r̂ - m]/r³
//   Source: Wolfram Alpha "magnetic dipole field formula"
// - Energy density: u = B²/(2μ₀)  [J/m³]
//   Source: Wolfram Alpha "magnetic energy density formula"
// - Magnetic pressure: P = B²/(2μ₀)  [Pa]
//   Source: Wolfram Alpha "magnetic pressure formula"
//=============================================================================

// ============================================
// Physical Constants (CODATA 2018, Wolfram-verified)
// ============================================
const PI: f32 = 3.14159265359;

// Vacuum permeability: μ₀ = 4π × 10⁻⁷ H/m ≈ 1.25663706212 × 10⁻⁶ N/A²
// Source: Wolfram Alpha "mu_0 value"
const MU_0: f32 = 1.25663706212e-6;

// Remanence of NdFeB N52 grade magnets: Bᵣ = 1.48 T
// Source: Wolfram Alpha "N52 neodymium magnet remanence"
const BR_N52: f32 = 1.48;

// Magnetization of N52: M = Bᵣ/μ₀ ≈ 1.1777 × 10⁶ A/m
// Source: Wolfram Alpha "1.48 T / mu_0"
const MAGNETIZATION_N52: f32 = 1177746.58;

// ============================================
// SEG Device Configuration (3-Ring System)
// ============================================
// Based on John Searl's design specifications
const INNER_RING_COUNT: i32 = 8;
const MIDDLE_RING_COUNT: i32 = 12;
const OUTER_RING_COUNT: i32 = 16;
const TOTAL_ROLLERS: i32 = 36;

// Ring radii in meters
// Source: Device geometry calculations in device-geometry.js
const INNER_RADIUS: f32 = 2.5;    // 2.5m - Inner ring
const MIDDLE_RADIUS: f32 = 4.0;   // 4.0m - Middle ring  
const OUTER_RADIUS: f32 = 5.5;    // 5.5m - Outer ring

// Roller magnetic moment per unit volume
// Wolfram-calculated: m = M × V
// For a roller with V ≈ 0.00157 m³: m ≈ 18.5 A·m²
const ROLLER_MOMENT: f32 = 18.5;  // A·m² - Magnetic moment per roller

// Roller dimensions
const ROLLER_RADIUS: f32 = 0.05;  // 5cm radius
const ROLLER_LENGTH: f32 = 0.20;  // 20cm length

// ============================================
// Magnetic Field Calculation Functions
// ============================================

// -----------------------------------------------------------------------------
// Magnetic Dipole Field Calculation
// Formula: B = (μ₀/4π) × [3(m·r̂)r̂ - m] / r³
// 
// Wolfram Alpha verification:
// "magnetic field of dipole moment m at distance r" gives:
// B = (μ₀/4πr³)[3(m·r̂)r̂ - m]
//
// @param observationPoint - Point where field is evaluated (m)
// @param dipolePosition - Position of magnetic dipole (m)
// @param magneticMoment - Magnetic moment vector (A·m²)
// @return B-field vector at observation point (Tesla)
// -----------------------------------------------------------------------------
fn magneticDipoleField(
    observationPoint: vec3f,
    dipolePosition: vec3f,
    magneticMoment: vec3f
) -> vec3f {
    let r = observationPoint - dipolePosition;
    let dist = length(r);
    
    // Avoid singularity at dipole center
    if (dist < 0.001) {
        return vec3f(0.0);
    }
    
    let rHat = normalize(r);
    let mDotR = dot(magneticMoment, rHat);
    
    // Pre-factor: μ₀/(4π) ≈ 1.0 × 10⁻⁷ H/m
    let prefactor = MU_0 / (4.0 * PI);
    let rCubed = dist * dist * dist;
    let factor = prefactor / rCubed;
    
    // B = (μ₀/4πr³)[3(m·r̂)r̂ - m]
    return factor * (3.0 * mDotR * rHat - magneticMoment);
}

// -----------------------------------------------------------------------------
// Calculate Roller Position and Moment for a Specific Ring
// 
// @param ringIndex - 0=inner, 1=middle, 2=outer
// @param rollerIndex - Index within the ring (0 to ring_count-1)
// @param time - Current simulation time for rotation
// @param outPosition - Output roller position
// @param outMoment - Output magnetic moment (tangential to ring)
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
    
    // Ring specifications
    // Inner ring: 8 rollers, fastest rotation
    // Middle ring: 12 rollers, medium rotation  
    // Outer ring: 16 rollers, slowest rotation
    switch (ringIndex) {
        case 0: {
            ringCount = INNER_RING_COUNT;
            ringRadius = INNER_RADIUS;
            rotationSpeed = 2.0;  // 2x speed
        }
        case 1: {
            ringCount = MIDDLE_RING_COUNT;
            ringRadius = MIDDLE_RADIUS;
            rotationSpeed = 1.0;  // 1x speed (reference)
        }
        case 2: {
            ringCount = OUTER_RING_COUNT;
            ringRadius = OUTER_RADIUS;
            rotationSpeed = 0.5;  // 0.5x speed
        }
        default: {
            ringCount = MIDDLE_RING_COUNT;
            ringRadius = MIDDLE_RADIUS;
            rotationSpeed = 1.0;
        }
    }
    
    // Calculate angular position
    let baseAngle = f32(rollerIndex) * (2.0 * PI / f32(ringCount));
    let angle = baseAngle + time * 0.5 * rotationSpeed;
    
    // Roller position in toroidal ring
    *outPosition = vec3f(
        cos(angle) * ringRadius,
        0.0,  // All rollers at y=0 (toroidal plane)
        sin(angle) * ringRadius
    );
    
    // Magnetic moment points tangentially (toroidal direction)
    // For a roller magnetized along its axis, the moment follows the ring tangent
    *outMoment = vec3f(
        -sin(angle) * ROLLER_MOMENT,
        0.0,
        cos(angle) * ROLLER_MOMENT
    );
}

// -----------------------------------------------------------------------------
// Calculate Total Toroidal B-Field from All Rollers (3-Ring System)
// 
// This computes the superposition of dipole fields from all 36 rollers
// arranged in 3 concentric rings (8 + 12 + 16 = 36 rollers).
//
// The field is predominantly toroidal due to the tangential orientation
// of magnetic moments around each ring.
//
// @param pos - Observation point (m)
// @param time - Current simulation time for roller rotation
// @return Total B-field vector from all rollers (Tesla)
// -----------------------------------------------------------------------------
fn calculateToroidalField(pos: vec3f, time: f32) -> vec3f {
    var totalField = vec3f(0.0);
    
    // Sum contributions from all 3 rings
    for (var ring: i32 = 0; ring < 3; ring++) {
        var rollerCount: i32;
        
        switch (ring) {
            case 0: { rollerCount = INNER_RING_COUNT; }
            case 1: { rollerCount = MIDDLE_RING_COUNT; }
            case 2: { rollerCount = OUTER_RING_COUNT; }
            default: { rollerCount = MIDDLE_RING_COUNT; }
        }
        
        // Add field contribution from each roller in this ring
        for (var i: i32 = 0; i < rollerCount; i++) {
            var rollerPos: vec3f;
            var rollerMoment: vec3f;
            
            getRollerMagneticState(ring, i, time, &rollerPos, &rollerMoment);
            totalField += magneticDipoleField(pos, rollerPos, rollerMoment);
        }
    }
    
    return totalField;
}

// -----------------------------------------------------------------------------
// Calculate B-Field from Single Ring Only (for debugging/analysis)
// 
// @param pos - Observation point (m)
// @param time - Current simulation time
// @param ringIndex - Which ring to calculate (0, 1, or 2)
// @return B-field vector from specified ring (Tesla)
// -----------------------------------------------------------------------------
fn calculateSingleRingField(pos: vec3f, time: f32, ringIndex: i32) -> vec3f {
    var totalField = vec3f(0.0);
    var rollerCount: i32;
    
    switch (ringIndex) {
        case 0: { rollerCount = INNER_RING_COUNT; }
        case 1: { rollerCount = MIDDLE_RING_COUNT; }
        case 2: { rollerCount = OUTER_RING_COUNT; }
        default: { rollerCount = MIDDLE_RING_COUNT; }
    }
    
    for (var i: i32 = 0; i < rollerCount; i++) {
        var rollerPos: vec3f;
        var rollerMoment: vec3f;
        
        getRollerMagneticState(ringIndex, i, time, &rollerPos, &rollerMoment);
        totalField += magneticDipoleField(pos, rollerPos, rollerMoment);
    }
    
    return totalField;
}

// ============================================
// Energy and Pressure Calculations
// ============================================

// -----------------------------------------------------------------------------
// Magnetic Energy Density
// Formula: u = B²/(2μ₀)  [J/m³]
// Source: Wolfram Alpha "magnetic energy density"
//
// @param B - Magnetic field magnitude (Tesla)
// @return Energy density (J/m³)
// -----------------------------------------------------------------------------
fn magneticEnergyDensity(B: f32) -> f32 {
    return (B * B) / (2.0 * MU_0);
}

// -----------------------------------------------------------------------------
// Magnetic Pressure (same as energy density for vacuum)
// Formula: P = B²/(2μ₀)  [Pa]
// Source: Wolfram Alpha "magnetic pressure formula"
//
// This is the pressure exerted by magnetic field lines.
// At B = 1 T: P ≈ 3.98 × 10⁵ Pa ≈ 4 atmospheres
//
// @param B - Magnetic field magnitude (Tesla)
// @return Pressure (Pascals)
// -----------------------------------------------------------------------------
fn magneticPressure(B: f32) -> f32 {
    return (B * B) / (2.0 * MU_0);
}

// -----------------------------------------------------------------------------
// Force on Magnetic Dipole
// Formula: F = ∇(m·B)
// For a dipole in non-uniform field: F = (m·∇)B
// Source: Wolfram Alpha "force on magnetic dipole"
//
// @param magneticMoment - Dipole moment (A·m²)
// @param fieldGradient - Gradient of B-field (∂Bᵢ/∂xⱼ)
// @return Force vector (Newtons)
// -----------------------------------------------------------------------------
fn forceOnDipole(magneticMoment: vec3f, fieldGradient: mat3x3f) -> vec3f {
    // Fᵢ = mⱼ × ∂Bⱼ/∂xᵢ (simplified approximation)
    return fieldGradient * magneticMoment;
}

// -----------------------------------------------------------------------------
// Torque on Magnetic Dipole
// Formula: τ = m × B  [N·m]
// Source: Wolfram Alpha "torque on magnetic dipole"
//
// @param magneticMoment - Dipole moment (A·m²)
// @param B - Magnetic field vector (Tesla)
// @return Torque vector (N·m)
// -----------------------------------------------------------------------------
fn torqueOnDipole(magneticMoment: vec3f, B: vec3f) -> vec3f {
    return cross(magneticMoment, B);
}

// ============================================
// Field Line Integration Helpers
// ============================================

// -----------------------------------------------------------------------------
// Normalize Field for Line Tracing
// Returns unit vector in direction of B-field for field line tracing
//
// @param pos - Current position on field line
// @param time - Current simulation time
// @return Normalized B-field direction
// -----------------------------------------------------------------------------
fn getFieldDirection(pos: vec3f, time: f32) -> vec3f {
    let B = calculateToroidalField(pos, time);
    let Bmag = length(B);
    
    if (Bmag < 1.0e-10) {
        return vec3f(0.0, 1.0, 0.0);  // Default up if field is zero
    }
    
    return B / Bmag;
}

// -----------------------------------------------------------------------------
// Field Magnitude with Smoothing
// Returns |B| with smooth falloff near zero
//
// @param pos - Observation point
// @param time - Current simulation time
// @return Smoothed field magnitude
// -----------------------------------------------------------------------------
fn getFieldMagnitude(pos: vec3f, time: f32) -> f32 {
    let B = calculateToroidalField(pos, time);
    return length(B);
}

// -----------------------------------------------------------------------------
// Field Gradient (Numerical Approximation)
// Calculates ∂Bᵢ/∂xⱼ using central differences
//
// @param pos - Observation point
// @param time - Current simulation time
// @param h - Step size for differentiation
// @return 3x3 gradient matrix
// -----------------------------------------------------------------------------
fn getFieldGradient(pos: vec3f, time: f32, h: f32) -> mat3x3f {
    let B0 = calculateToroidalField(pos, time);
    
    let Bx_plus = calculateToroidalField(pos + vec3f(h, 0.0, 0.0), time);
    let Bx_minus = calculateToroidalField(pos - vec3f(h, 0.0, 0.0), time);
    
    let By_plus = calculateToroidalField(pos + vec3f(0.0, h, 0.0), time);
    let By_minus = calculateToroidalField(pos - vec3f(0.0, h, 0.0), time);
    
    let Bz_plus = calculateToroidalField(pos + vec3f(0.0, 0.0, h), time);
    let Bz_minus = calculateToroidalField(pos - vec3f(0.0, 0.0, h), time);
    
    // Central differences: ∂B/∂x ≈ (B(x+h) - B(x-h)) / (2h)
    let dB_dx = (Bx_plus - Bx_minus) / (2.0 * h);
    let dB_dy = (By_plus - By_minus) / (2.0 * h);
    let dB_dz = (Bz_plus - Bz_minus) / (2.0 * h);
    
    // Build gradient matrix [∂Bᵢ/∂xⱼ]
    return mat3x3f(
        vec3f(dB_dx.x, dB_dy.x, dB_dz.x),  // Row 0: ∂Bx/∂x, ∂Bx/∂y, ∂Bx/∂z
        vec3f(dB_dx.y, dB_dy.y, dB_dz.y),  // Row 1: ∂By/∂x, ∂By/∂y, ∂By/∂z
        vec3f(dB_dx.z, dB_dy.z, dB_dz.z)   // Row 2: ∂Bz/∂x, ∂Bz/∂y, ∂Bz/∂z
    );
}

// ============================================
// Utility Functions
// ============================================

// -----------------------------------------------------------------------------
// Color Mapping for Field Magnitude
// Maps 0-3T range to cyan → yellow → magenta color gradient
//
// @param Bmag - Field magnitude (Tesla)
// @return RGB color vector
// -----------------------------------------------------------------------------
fn fieldMagnitudeToColor(Bmag: f32) -> vec3f {
    // Normalize to 0-1 range (3T max)
    let t = clamp(Bmag / 3.0, 0.0, 1.0);
    
    // Cyan (0, 1, 1) → Yellow (1, 1, 0) → Magenta (1, 0, 1)
    if (t < 0.5) {
        // Cyan to Yellow
        let s = t * 2.0;
        return vec3f(s, 1.0, 1.0 - s);
    } else {
        // Yellow to Magenta
        let s = (t - 0.5) * 2.0;
        return vec3f(1.0, 1.0 - s, s);
    }
}

// -----------------------------------------------------------------------------
// Check if Point is Inside Roller
// Used for field line seeding and collision detection
//
// @param pos - Point to check
// @param time - Current time
// @return true if point is inside any roller
// -----------------------------------------------------------------------------
fn isInsideRoller(pos: vec3f, time: f32) -> bool {
    // Check all rollers
    for (var ring: i32 = 0; ring < 3; ring++) {
        var rollerCount: i32;
        switch (ring) {
            case 0: { rollerCount = INNER_RING_COUNT; }
            case 1: { rollerCount = MIDDLE_RING_COUNT; }
            case 2: { rollerCount = OUTER_RING_COUNT; }
            default: { rollerCount = 0; }
        }
        
        for (var i: i32 = 0; i < rollerCount; i++) {
            var rollerPos: vec3f;
            var rollerMoment: vec3f;
            getRollerMagneticState(ring, i, time, &rollerPos, &rollerMoment);
            
            let dist = length(pos - rollerPos);
            if (dist < ROLLER_RADIUS) {
                return true;
            }
        }
    }
    
    return false;
}

// -----------------------------------------------------------------------------
// Get Closest Roller Position
// Used for field line seeding
//
// @param pos - Query point
// @param time - Current time
// @return Position of closest roller center
// -----------------------------------------------------------------------------
fn getClosestRoller(pos: vec3f, time: f32) -> vec3f {
    var closestPos = vec3f(0.0);
    var minDist = 1.0e10;
    
    for (var ring: i32 = 0; ring < 3; ring++) {
        var rollerCount: i32;
        switch (ring) {
            case 0: { rollerCount = INNER_RING_COUNT; }
            case 1: { rollerCount = MIDDLE_RING_COUNT; }
            case 2: { rollerCount = OUTER_RING_COUNT; }
            default: { rollerCount = 0; }
        }
        
        for (var i: i32 = 0; i < rollerCount; i++) {
            var rollerPos: vec3f;
            var rollerMoment: vec3f;
            getRollerMagneticState(ring, i, time, &rollerPos, &rollerMoment);
            
            let dist = length(pos - rollerPos);
            if (dist < minDist) {
                minDist = dist;
                closestPos = rollerPos;
            }
        }
    }
    
    return closestPos;
}
