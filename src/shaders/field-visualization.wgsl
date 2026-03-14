//=============================================================================
// FIELD VISUALIZATION SHADERS
// SEG (Searl Effect Generator) Magnetic Field Rendering
//
// Features:
// - Field vectors rendered as instanced arrows
// - Color coding: cyan (low B) → yellow (medium) → magenta (high)
// - Flux density magnitude shown as opacity
// - Proper arrow orientation along B-field direction
//
// References:
// - Arrow rendering: Wolfram Alpha "3D vector field visualization"
// - Color gradients: Wolfram Alpha "heat map color scheme"
//=============================================================================

// ============================================
// Shared Structures and Constants
// ============================================

struct GlobalUniforms {
    viewProj: mat4x4f,
    time: f32,
    mode: f32,
    particleCount: f32,
    _pad: f32,
}

struct DeviceUniforms {
    position: vec3f,
    rotation: vec4f,  // quaternion
    scale: f32,
    ringIndex: f32,
    _pad: vec2f,
}

@binding(0) @group(0) var<uniform> globalUniforms: GlobalUniforms;
@binding(1) @group(0) var<uniform> deviceUniforms: DeviceUniforms;

// ============================================
// Field Arrow Rendering - Vertex Shader
// ============================================

// Arrow geometry vertex input
struct ArrowVertexInput {
    @location(0) position: vec3f,      // Local position within arrow geometry
    @location(1) normal: vec3f,        // Local normal
}

// Per-arrow instance data
struct ArrowInstanceInput {
    @location(2) origin: vec3f,        // Arrow start position
    @location(3) direction: vec3f,     // B-field direction (normalized)
    @location(4) magnitude: f32,       // |B| in Tesla
    @location(5) color: vec3f,         // Pre-computed color
}

struct ArrowVertexOutput {
    @builtin(position) position: vec4f,
    @location(0) worldPos: vec3f,
    @location(1) normal: vec3f,
    @location(2) color: vec3f,
    @location(3) magnitude: f32,
    @location(4) alpha: f32,
}

// Arrow dimensions
const ARROW_SHAFT_RADIUS: f32 = 0.02;
const ARROW_HEAD_RADIUS: f32 = 0.05;
const ARROW_HEAD_LENGTH: f32 = 0.15;
const ARROW_LENGTH_SCALE: f32 = 0.5;  // Scale factor for arrow length

// -----------------------------------------------------------------------------
// Build Rotation Matrix from Direction Vector
// Creates a rotation matrix that aligns (0,1,0) with the given direction
// -----------------------------------------------------------------------------
fn directionToRotationMatrix(dir: vec3f) -> mat3x3f {
    let up = vec3f(0.0, 1.0, 0.0);
    let nDir = normalize(dir);
    
    // If direction is close to up, return identity-like
    let dotProd = dot(up, nDir);
    if (dotProd > 0.9999) {
        return mat3x3f(
            vec3f(1.0, 0.0, 0.0),
            vec3f(0.0, 1.0, 0.0),
            vec3f(0.0, 0.0, 1.0)
        );
    }
    if (dotProd < -0.9999) {
        return mat3x3f(
            vec3f(-1.0, 0.0, 0.0),
            vec3f(0.0, -1.0, 0.0),
            vec3f(0.0, 0.0, 1.0)
        );
    }
    
    // Rotation axis
    let rotAxis = normalize(cross(up, nDir));
    let angle = acos(dotProd);
    
    // Rodrigues rotation formula
    let c = cos(angle);
    let s = sin(angle);
    let t = 1.0 - c;
    
    let x = rotAxis.x;
    let y = rotAxis.y;
    let z = rotAxis.z;
    
    return mat3x3f(
        vec3f(t*x*x + c,    t*x*y + s*z,  t*x*z - s*y),
        vec3f(t*x*y - s*z,  t*y*y + c,    t*y*z + s*x),
        vec3f(t*x*z + s*y,  t*y*z - s*x,  t*z*z + c)
    );
}

// -----------------------------------------------------------------------------
// Build Arrow Geometry in Local Space
// Returns world position for a vertex on the arrow
// -----------------------------------------------------------------------------
fn buildArrowVertex(
    localPos: vec3f,
    origin: vec3f,
    direction: vec3f,
    magnitude: f32
) -> vec3f {
    // Scale arrow length by magnitude (clamped)
    let arrowLength = clamp(magnitude * ARROW_LENGTH_SCALE, 0.1, 1.0);
    
    // Create rotation matrix
    let rotMatrix = directionToRotationMatrix(direction);
    
    // Scale local position
    var scaledPos = localPos;
    scaledPos.y *= arrowLength;  // Scale length
    scaledPos.x *= ARROW_SHAFT_RADIUS + (magnitude * 0.02);  // Scale thickness
    scaledPos.z *= ARROW_SHAFT_RADIUS + (magnitude * 0.02);
    
    // Rotate and translate
    return origin + rotMatrix * scaledPos;
}

@vertex
fn arrowVertexMain(
    vertex: ArrowVertexInput,
    instance: ArrowInstanceInput
) -> ArrowVertexOutput {
    var output: ArrowVertexOutput;
    
    // Build arrow vertex position
    let worldPos = buildArrowVertex(
        vertex.position,
        instance.origin,
        instance.direction,
        instance.magnitude
    );
    
    // Transform to clip space
    output.position = globalUniforms.viewProj * vec4f(worldPos, 1.0);
    output.worldPos = worldPos;
    
    // Transform normal
    let rotMatrix = directionToRotationMatrix(instance.direction);
    output.normal = normalize(rotMatrix * vertex.normal);
    
    // Pass color and magnitude
    output.color = instance.color;
    output.magnitude = instance.magnitude;
    
    // Opacity based on field strength
    output.alpha = 0.3 + 0.5 * clamp(instance.magnitude / 3.0, 0.0, 1.0);
    
    return output;
}

// ============================================
// Field Arrow Rendering - Fragment Shader
// ============================================

@fragment
fn arrowFragmentMain(input: ArrowVertexOutput) -> @location(0) vec4f {
    // Normalize normal
    let n = normalize(input.normal);
    
    // View direction
    let viewDir = normalize(vec3f(
        cos(globalUniforms.time * 0.1) * 16.0,
        4.0,
        sin(globalUniforms.time * 0.1) * 16.0
    ) - input.worldPos);
    
    // Simple lighting
    let lightDir = normalize(vec3f(0.5, 1.0, 0.3));
    let diff = max(dot(n, lightDir), 0.0);
    
    // Specular
    let halfDir = normalize(lightDir + viewDir);
    let spec = pow(max(dot(n, halfDir), 0.0), 32.0);
    
    // Fresnel glow
    let fresnel = pow(1.0 - abs(dot(n, viewDir)), 2.0);
    
    // Combine lighting with field color
    let ambient = 0.3;
    let lighting = ambient + diff * 0.6 + spec * 0.3;
    
    let finalColor = input.color * lighting + input.color * fresnel * 0.5;
    
    return vec4f(finalColor, input.alpha);
}

// ============================================
// Field Vector Grid - Compute Shader
// Generates instanced arrow data on a 3D grid
// ============================================

struct FieldArrowData {
    origin: vec3f,
    _pad1: f32,
    direction: vec3f,
    _pad2: f32,
    magnitude: f32,
    colorR: f32,
    colorG: f32,
    colorB: f32,
    _pad3: f32,
}

@binding(2) @group(0) var<storage, read_write> arrowData: array<FieldArrowData>;

// Physical constants for field calculation
const PI: f32 = 3.14159265359;
const MU_0: f32 = 1.25663706212e-6;
const ROLLER_MOMENT: f32 = 18.5;

const INNER_RING_COUNT: i32 = 8;
const MIDDLE_RING_COUNT: i32 = 12;
const OUTER_RING_COUNT: i32 = 16;

const INNER_RADIUS: f32 = 2.5;
const MIDDLE_RADIUS: f32 = 4.0;
const OUTER_RADIUS: f32 = 5.5;

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

fn fieldMagnitudeToColor(Bmag: f32) -> vec3f {
    let t = clamp(Bmag / 3.0, 0.0, 1.0);
    
    if (t < 0.5) {
        let s = t * 2.0;
        return vec3f(s, 1.0, 1.0 - s);
    } else {
        let s = (t - 0.5) * 2.0;
        return vec3f(1.0, 1.0 - s, s);
    }
}

// Grid configuration
const GRID_X: i32 = 10;
const GRID_Y: i32 = 6;
const GRID_Z: i32 = 10;
const TOTAL_ARROWS: i32 = 600;  // 10 × 6 × 10

@compute @workgroup_size(64)
fn generateFieldArrows(@builtin(global_invocation_id) id: vec3u) {
    let idx = i32(id.x);
    
    if (idx >= TOTAL_ARROWS) {
        return;
    }
    
    // Calculate 3D grid position
    let x = idx % GRID_X;
    let y = (idx / GRID_X) % GRID_Y;
    let z = idx / (GRID_X * GRID_Y);
    
    // Map to world space (centered around origin)
    // X: -6 to +6, Y: -3 to +3, Z: -6 to +6
    let worldPos = vec3f(
        (f32(x) / f32(GRID_X - 1) - 0.5) * 12.0,
        (f32(y) / f32(GRID_Y - 1) - 0.5) * 6.0,
        (f32(z) / f32(GRID_Z - 1) - 0.5) * 12.0
    );
    
    // Calculate field at this position
    let B = calculateToroidalField(worldPos, globalUniforms.time);
    let Bmag = length(B);
    
    // Only create arrows for non-zero fields
    if (Bmag > 1.0e-6) {
        let direction = B / Bmag;
        let color = fieldMagnitudeToColor(Bmag);
        
        arrowData[idx] = FieldArrowData(
            worldPos,
            0.0,
            direction,
            0.0,
            Bmag,
            color.r,
            color.g,
            color.b,
            0.0
        );
    } else {
        // Zero field - hide arrow
        arrowData[idx] = FieldArrowData(
            vec3f(0.0),
            0.0,
            vec3f(0.0, 1.0, 0.0),
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0
        );
    }
}

// ============================================
// Field Heatmap - Fragment Shader
// Renders field magnitude as a colored overlay
// ============================================

struct HeatmapVertexOutput {
    @builtin(position) position: vec4f,
    @location(0) worldPos: vec3f,
    @location(1) uv: vec2f,
}

@vertex
fn heatmapVertexMain(
    @builtin(vertex_index) vertIdx: u32
) -> HeatmapVertexOutput {
    var output: HeatmapVertexOutput;
    
    // Full-screen quad
    let pos = vec2f(
        f32(vertIdx % 2u) * 2.0 - 1.0,  // x: -1 or 1
        f32(vertIdx / 2u) * 2.0 - 1.0   // y: -1 or 1
    );
    
    output.position = vec4f(pos, 0.0, 1.0);
    output.uv = pos * 0.5 + 0.5;
    
    return output;
}

@fragment
fn heatmapFragmentMain(input: HeatmapVertexOutput) -> @location(0) vec4f {
    // Sample field at multiple points for anti-aliasing
    let time = globalUniforms.time;
    
    // Map UV to world space at y=0 plane (toroidal plane)
    let worldPos = vec3f(
        (input.uv.x - 0.5) * 16.0,
        0.0,
        (input.uv.y - 0.5) * 16.0
    );
    
    // Calculate field
    let B = calculateToroidalField(worldPos, time);
    let Bmag = length(B);
    
    // Color mapping
    let color = fieldMagnitudeToColor(Bmag);
    
    // Opacity based on field strength (stronger = more opaque)
    let alpha = clamp(Bmag / 2.0, 0.0, 0.5);
    
    return vec4f(color, alpha);
}

// ============================================
// Field Line Segment Rendering
// Renders pre-computed field line segments
// ============================================

struct FieldLineSegment {
    startPos: vec3f,
    endPos: vec3f,
    strength: f32,
    age: f32,
}

@binding(3) @group(0) var<storage, read> fieldLines: array<FieldLineSegment>;

struct LineVertexOutput {
    @builtin(position) position: vec4f,
    @location(0) color: vec3f,
    @location(1) alpha: f32,
}

@vertex
fn fieldLineVertexMain(
    @builtin(vertex_index) vertIdx: u32,
    @builtin(instance_index) instanceIdx: u32
) -> LineVertexOutput {
    var output: LineVertexOutput;
    
    // Get segment data
    let segment = fieldLines[instanceIdx];
    
    // Choose start or end position based on vertex index
    let worldPos = select(segment.endPos, segment.startPos, vertIdx == 0u);
    
    output.position = globalUniforms.viewProj * vec4f(worldPos, 1.0);
    
    // Color based on field strength
    output.color = fieldMagnitudeToColor(segment.strength);
    
    // Animated alpha based on age
    let pulse = 0.7 + 0.3 * sin(segment.age * 6.28318530718);
    output.alpha = (0.3 + 0.5 * clamp(segment.strength / 3.0, 0.0, 1.0)) * pulse;
    
    return output;
}

@fragment
fn fieldLineFragmentMain(input: LineVertexOutput) -> @location(0) vec4f {
    return vec4f(input.color, input.alpha);
}

// ============================================
// Utility: Billboard Arrow for Field Vectors
// Simple billboarded arrow pointing in B-field direction
// ============================================

struct BillboardInstance {
    @location(0) position: vec3f,
    @location(1) direction: vec3f,
    @location(2) magnitude: f32,
}

@vertex
fn billboardArrowVertex(
    @builtin(vertex_index) vertIdx: u32,
    instance: BillboardInstance
) -> ArrowVertexOutput {
    var output: ArrowVertexOutput;
    
    // Create a simple billboard quad
    let size = 0.1 + instance.magnitude * 0.05;
    let corners = array<vec2f, 4>(
        vec2f(-1.0, -1.0),
        vec2f(1.0, -1.0),
        vec2f(-1.0, 1.0),
        vec2f(1.0, 1.0)
    );
    
    // For a proper billboard, we'd need the view matrix
    // Here we just create a simple oriented quad
    let corner = corners[vertIdx] * size;
    
    // Offset position by corner
    let worldPos = instance.position + vec3f(corner.x, corner.y, 0.0);
    
    output.position = globalUniforms.viewProj * vec4f(worldPos, 1.0);
    output.worldPos = worldPos;
    output.normal = vec3f(0.0, 0.0, 1.0);
    output.color = fieldMagnitudeToColor(instance.magnitude);
    output.magnitude = instance.magnitude;
    output.alpha = 0.6 + 0.3 * clamp(instance.magnitude / 3.0, 0.0, 1.0);
    
    return output;
}

// ============================================
// Debug: Simple Vector Visualization
// Renders lines showing B-field direction
// ============================================

@vertex
fn debugVectorVertex(
    @builtin(vertex_index) vertIdx: u32,
    @location(0) origin: vec3f,
    @location(1) vector: vec3f
) -> @builtin(position) vec4f {
    let worldPos = select(origin + vector, origin, vertIdx == 0u);
    return globalUniforms.viewProj * vec4f(worldPos, 1.0);
}

@fragment
fn debugVectorFragment(
    @location(0) @interpolate(flat) magnitude: f32
) -> @location(0) vec4f {
    let color = fieldMagnitudeToColor(magnitude);
    return vec4f(color, 1.0);
}
