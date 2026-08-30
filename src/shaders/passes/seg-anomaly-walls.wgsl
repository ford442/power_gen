//=============================================================================
// ROSCHIN–GODIN MAGNETIC WALL SHELLS
// Extremely faint concentric vertical shells representing zones of increased
// magnetic flux around the SEG. Visible primarily through subtle refraction,
// shimmer, and a slight cyan-violet tint where atmospheric particles/dust
// accumulate. Drawn after the device with depth-write disabled.
//=============================================================================

struct Uniforms {
    viewProj: mat4x4f,
    time: f32,
    cameraPos: vec3f,
    speedMult: f32
}

struct WallParams {
    intensity: f32,      // 0..1 global wall envelope
    shellCount: f32,     // number of active shells
    innerRadius: f32,
    spacing: f32,
    shellThickness: f32,
    height: f32
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<uniform> params: WallParams;

struct VertexInput {
    @location(0) position: vec3f,
    @location(1) normal: vec3f,
    @location(2) uv: vec2f
}

struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) worldPos: vec3f,
    @location(1) normal: vec3f,
    @location(2) uv: vec2f,
    @location(3) radius: f32
}

fn hash2(p: vec2f) -> vec2f {
    return fract(sin(vec2f(dot(p, vec2f(127.1, 311.7)), dot(p, vec2f(269.5, 183.3)))) * 43758.5453);
}

fn fbm(p: vec2f) -> f32 {
    var v = 0.0;
    var a = 0.5;
    var pp = p;
    for (var i = 0; i < 4; i++) {
        v += a * sin(pp.x * 3.7 + pp.y * 2.3);
        pp = pp * 2.03 + vec2f(1.7, 2.3);
        a *= 0.5;
    }
    return v * 0.5 + 0.5;
}

@vertex
fn vsMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    let worldPos = input.position;
    output.position = uniforms.viewProj * vec4f(worldPos, 1.0);
    output.worldPos = worldPos;
    output.normal = input.normal;
    output.uv = input.uv;
    output.radius = length(worldPos.xz);
    return output;
}

@fragment
fn fsMain(input: VertexOutput) -> @location(0) vec4f {
    if (params.intensity <= 0.0) {
        discard;
    }

    let t = uniforms.time;
    let r = input.radius;
    let shellCount = i32(params.shellCount);

    // Distance to nearest active shell surface.
    var minShellDist = 1000.0;
    var nearestShell = 0.0;
    for (var i = 0; i < shellCount; i++) {
        let shellR = params.innerRadius + f32(i) * params.spacing;
        let d = abs(r - shellR);
        if (d < minShellDist) {
            minShellDist = d;
            nearestShell = shellR;
        }
    }

    // Thin shell falloff: strong near the shell radius, fading to nothing.
    let shellHalfThick = params.shellThickness * 0.5;
    let shellProfile = smoothstep(shellHalfThick, 0.0, minShellDist);
    if (shellProfile <= 0.0) {
        discard;
    }

    // Slow vertical shimmer using world-space UV + time.
    let shimmerUV = vec2f(input.uv.x * 4.0 + t * 0.03, input.uv.y * 2.0 + t * 0.05);
    let shimmer = fbm(shimmerUV) * 0.35 + 0.65;

    // Subtle Fresnel/view-angle brightness so the shells catch light at grazing angles.
    let viewDir = normalize(uniforms.cameraPos - input.worldPos);
    let fresnel = pow(1.0 - abs(dot(normalize(input.normal), viewDir)), 2.0);

    // Color: cyan-violet, extremely faint.
    let shellIndex = (nearestShell - params.innerRadius) / max(params.spacing, 0.001);
    let color = mix(
        vec3f(0.35, 0.78, 0.92), // inner: cyan
        vec3f(0.72, 0.45, 0.95), // outer: violet
        clamp(shellIndex / f32(max(shellCount - 1, 1)), 0.0, 1.0)
    );

    // Final opacity is intentionally very low: walls are atmospheric, not solid.
    let alpha = shellProfile * params.intensity * (0.025 + fresnel * 0.035) * shimmer;

    return vec4f(color * alpha, alpha);
}
