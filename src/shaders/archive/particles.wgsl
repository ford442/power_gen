// LEGACY — flux-line field draw duplicate. Not the interactive GpuParticle path.
// Canonical: generators/field-line-shaders.js, common/particle.wgsl
// Kept for reference; validated by check:wgsl but do not wire into MultiDeviceShaders.

#include "generated/constants.wgsl"

struct FluxSegment {
    startX: f32,
    startY: f32,
    startZ: f32,
    endX: f32,
    endY: f32,
    endZ: f32,
    strength: f32,
    age: f32,
}

struct FluxUniforms {
    time: f32,
    deltaTime: f32,
    integrationStep: f32,
    lineOpacity: f32,
    seedRadius: f32,
    followStrength: f32,
    _pad: f32,
}

struct RingParams {
    radius: f32,
    speed: f32,
}

struct FieldLineVertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) color: vec3<f32>,
    @location(1) alpha: f32,
    @location(2) fieldStrength: f32,
}

const MU_0_: f32 = MU_0;
const ROLLER_MOMENT: f32 = 18.5f;
const INNER_RING_COUNT: i32 = 8i;
const MIDDLE_RING_COUNT: i32 = 12i;
const OUTER_RING_COUNT: i32 = 16i;
const INNER_RADIUS: f32 = 2.5f;
const MIDDLE_RADIUS: f32 = 4f;
const OUTER_RADIUS: f32 = 5.5f;
const FLUX_LINES_PER_RING: i32 = 36i;
const TOTAL_FLUX_LINES: i32 = 108i;
const SEGMENTS_PER_LINE: i32 = 100i;
const TOTAL_SEGMENTS: i32 = 10800i;
const INTEGRATION_STEP: f32 = 0.02f;
const MAX_FIELD_AGE: f32 = 100f;

@group(0) @binding(0) 
var<storage, read_write> fluxSegments: array<FluxSegment>;
@group(0) @binding(1) 
var<uniform> fluxUniforms: FluxUniforms;

fn magneticDipoleField(observationPoint: vec3<f32>, dipolePosition: vec3<f32>, magneticMoment: vec3<f32>) -> vec3<f32> {
    let r = (observationPoint - dipolePosition);
    let dist = length(r);
    if (dist < 0.001f) {
        return vec3(0f);
    }
    let rHat = normalize(r);
    let mDotR = dot(magneticMoment, rHat);
    let rCubed = ((dist * dist) * dist);
    let factor = (0.000000099999994f / rCubed);
    return (factor * (((3f * mDotR) * rHat) - magneticMoment));
}

fn getRollerMagneticState(ringIndex: i32, rollerIndex: i32, time: f32, outPosition: ptr<function, vec3<f32>>, outMoment: ptr<function, vec3<f32>>) {
    var ringCount: i32;
    var ringRadius: f32;
    var rotationSpeed: f32;

    switch ringIndex {
        case 0: {
            ringCount = INNER_RING_COUNT;
            ringRadius = INNER_RADIUS;
            rotationSpeed = 2f;
        }
        case 1: {
            ringCount = MIDDLE_RING_COUNT;
            ringRadius = MIDDLE_RADIUS;
            rotationSpeed = 1f;
        }
        case 2: {
            ringCount = OUTER_RING_COUNT;
            ringRadius = OUTER_RADIUS;
            rotationSpeed = 0.5f;
        }
        default: {
            ringCount = MIDDLE_RING_COUNT;
            ringRadius = MIDDLE_RADIUS;
            rotationSpeed = 1f;
        }
    }
    let _e22 = ringCount;
    let baseAngle = (f32(rollerIndex) * (6.2831855f / f32(_e22)));
    let _e28 = rotationSpeed;
    let angle = (baseAngle + ((time * 0.5f) * _e28));
    let _e32 = ringRadius;
    let _e35 = ringRadius;
    (*outPosition) = vec3<f32>((cos(angle) * _e32), 0f, (sin(angle) * _e35));
    (*outMoment) = vec3<f32>((-(sin(angle)) * ROLLER_MOMENT), 0f, (cos(angle) * ROLLER_MOMENT));
    return;
}

fn calculateToroidalField(pos: vec3<f32>, time_1: f32) -> vec3<f32> {
    var totalField: vec3<f32> = vec3(0f);
    var ring: i32 = 0i;
    var rollerCount: i32;
    var i_2: i32;
    var rollerPos: vec3<f32>;
    var rollerMoment: vec3<f32>;

    loop {
        let _e7 = ring;
        if (_e7 < 3i) {
        } else {
            break;
        }
        {
            let _e11 = ring;
            switch _e11 {
                case 0: {
                    rollerCount = INNER_RING_COUNT;
                }
                case 1: {
                    rollerCount = MIDDLE_RING_COUNT;
                }
                case 2: {
                    rollerCount = OUTER_RING_COUNT;
                }
                default: {
                    rollerCount = MIDDLE_RING_COUNT;
                }
            }
            i_2 = 0i;
            loop {
                let _e18 = i_2;
                let _e19 = rollerCount;
                if (_e18 < _e19) {
                } else {
                    break;
                }
                {
                    let _e23 = ring;
                    let _e24 = i_2;
                    getRollerMagneticState(_e23, _e24, time_1, (&rollerPos), (&rollerMoment));
                    let _e25 = totalField;
                    let _e26 = rollerPos;
                    let _e27 = rollerMoment;
                    let _e28 = magneticDipoleField(pos, _e26, _e27);
                    totalField = (_e25 + _e28);
                }
                continuing {
                    let _e31 = i_2;
                    i_2 = (_e31 + 1i);
                }
            }
        }
        continuing {
            let _e34 = ring;
            ring = (_e34 + 1i);
        }
    }
    let _e36 = totalField;
    return _e36;
}

fn rk4Step(pos_1: vec3<f32>, time_2: f32, h: f32, direction: f32) -> vec3<f32> {
    let _e4 = calculateToroidalField(pos_1, time_2);
    let B1mag = length(_e4);
    if (B1mag < 0.0000000001f) {
        return pos_1;
    }
    let k1_ = (((h * direction) * _e4) / vec3(B1mag));
    let _e15 = calculateToroidalField((pos_1 + (k1_ * 0.5f)), time_2);
    let B2mag = length(_e15);
    if (B2mag < 0.0000000001f) {
        return (pos_1 + k1_);
    }
    let k2_ = (((h * direction) * _e15) / vec3(B2mag));
    let _e27 = calculateToroidalField((pos_1 + (k2_ * 0.5f)), time_2);
    let B3mag = length(_e27);
    if (B3mag < 0.0000000001f) {
        return (pos_1 + k2_);
    }
    let k3_ = (((h * direction) * _e27) / vec3(B3mag));
    let _e37 = calculateToroidalField((pos_1 + k3_), time_2);
    let B4mag = length(_e37);
    if (B4mag < 0.0000000001f) {
        return (pos_1 + k3_);
    }
    let k4_ = (((h * direction) * _e37) / vec3(B4mag));
    return (pos_1 + ((((k1_ + (2f * k2_)) + (2f * k3_)) + k4_) / vec3(6f)));
}

fn eulerStep(pos_2: vec3<f32>, time_3: f32, h_1: f32, direction_1: f32) -> vec3<f32> {
    let _e4 = calculateToroidalField(pos_2, time_3);
    let Bmag_2 = length(_e4);
    if (Bmag_2 < 0.0000000001f) {
        return pos_2;
    }
    return (pos_2 + (((h_1 * direction_1) * _e4) / vec3(Bmag_2)));
}

fn getFluxLineSeed(lineIndex: i32, time_4: f32) -> vec3<f32> {
    var ringCount_1: i32;
    var ringRadius_1: f32;
    var rotationSpeed_1: f32;

    let ringIndex_2 = (lineIndex / FLUX_LINES_PER_RING);
    let indexInRing = (lineIndex % FLUX_LINES_PER_RING);
    switch ringIndex_2 {
        case 0: {
            ringCount_1 = INNER_RING_COUNT;
            ringRadius_1 = INNER_RADIUS;
            rotationSpeed_1 = 2f;
        }
        case 1: {
            ringCount_1 = MIDDLE_RING_COUNT;
            ringRadius_1 = MIDDLE_RADIUS;
            rotationSpeed_1 = 1f;
        }
        case 2: {
            ringCount_1 = OUTER_RING_COUNT;
            ringRadius_1 = OUTER_RADIUS;
            rotationSpeed_1 = 0.5f;
        }
        default: {
            ringCount_1 = MIDDLE_RING_COUNT;
            ringRadius_1 = MIDDLE_RADIUS;
            rotationSpeed_1 = 1f;
        }
    }
    let _e21 = ringCount_1;
    let rollerIndex_1 = (indexInRing % _e21);
    let _e23 = ringCount_1;
    let seedOffset = f32((indexInRing / _e23));
    let _e28 = ringCount_1;
    let baseAngle_1 = (f32(rollerIndex_1) * (6.2831855f / f32(_e28)));
    let _e34 = rotationSpeed_1;
    let angle_1 = (baseAngle_1 + ((time_4 * 0.5f) * _e34));
    let _e38 = ringRadius_1;
    let _e41 = ringRadius_1;
    let rollerPos_1 = vec3<f32>((cos(angle_1) * _e38), 0f, (sin(angle_1) * _e41));
    let _e51 = ringCount_1;
    let seedAngle = (((seedOffset * 2f) * PI) / f32((FLUX_LINES_PER_RING / _e51)));
    let seedHeight = (sin((seedAngle * 3f)) * 0.05f);
    let offset = vec3<f32>((cos(seedAngle) * 0.06f), seedHeight, (sin(seedAngle) * 0.06f));
    return (rollerPos_1 + offset);
}

fn getRingParams(ringIndex_1: i32) -> RingParams {
    switch ringIndex_1 {
        case 0: {
            return RingParams(2.5f, 2f);
        }
        case 1: {
            return RingParams(4f, 1f);
        }
        case 2: {
            return RingParams(5.5f, 0.5f);
        }
        default: {
            return RingParams(4f, 1f);
        }
    }
}

fn fluxLinePoint(lineIndex_1: i32, u: f32, time_5: f32) -> vec3<f32> {
    let ringIndex_3 = (lineIndex_1 / FLUX_LINES_PER_RING);
    let idxInRing = (lineIndex_1 % FLUX_LINES_PER_RING);
    let _e7 = getRingParams(ringIndex_3);
    let tIdx = (idxInRing % 12i);
    let pIdx = (idxInRing / 12i);
    let phi0_ = ((f32(tIdx) * (6.2831855f / f32(12i))) + ((time_5 * 0.5f) * _e7.speed));
    let theta0_ = (f32(pIdx) * (6.2831855f / f32(3i)));
    let seedR = fluxUniforms.seedRadius;
    let minorR_1 = (seedR * (0.85f + (0.45f * f32(pIdx))));
    let _e39 = fluxUniforms.followStrength;
    let poloidalSpan = (((_e39 * (0.6f + (0.2f * f32(ringIndex_3)))) * 2f) * PI);
    let phi = (phi0_ + (u * 3.7699115f));
    let theta = (theta0_ + (u * poloidalSpan));
    let major = (_e7.radius + (minorR_1 * cos(theta)));
    return vec3<f32>((major * cos(phi)), (minorR_1 * sin(theta)), (major * sin(phi)));
}

fn fluxStrength(minorR: f32) -> f32 {
    return clamp((0.6f / (minorR + 0.08f)), 0.05f, 1.5f);
}

fn fieldStrengthToColor(Bmag: f32) -> vec3<f32> {
    let t = clamp((Bmag / 3f), 0f, 1f);
    if (t < 0.5f) {
        let s = (t * 2f);
        return vec3<f32>(s, 1f, (1f - s));
    } else {
        let s_1 = ((t - 0.5f) * 2f);
        return vec3<f32>(1f, (1f - s_1), s_1);
    }
}

fn calculateLineAlpha(Bmag_1: f32, age: f32) -> f32 {
    let strengthAlpha = clamp((Bmag_1 / 2f), 0.1f, 0.8f);
    let agePulse = (0.7f + (0.3f * sin((age * 6.2831855f))));
    let _e17 = fluxUniforms.lineOpacity;
    return ((strengthAlpha * agePulse) * _e17);
}

@compute @workgroup_size(64, 1, 1) 
fn traceBidirectional(@builtin(global_invocation_id) id: vec3<u32>) {
    var i: i32 = 0i;
    var i_1: i32 = 0i;
    var local: bool;

    let lineIndex_2 = i32(id.x);
    if (lineIndex_2 >= TOTAL_FLUX_LINES) {
        return;
    }
    let time_6 = fluxUniforms.time;
    let idxInRing_1 = (lineIndex_2 % FLUX_LINES_PER_RING);
    let pIdx_1 = (idxInRing_1 / 12i);
    let _e16 = fluxUniforms.seedRadius;
    let minorR_2 = (_e16 * (0.85f + (0.45f * f32(pIdx_1))));
    let _e23 = fluxStrength(minorR_2);
    loop {
        let _e26 = i;
        if (_e26 < 50i) {
        } else {
            break;
        }
        {
            let _e28 = i;
            let u0_ = (f32(_e28) * 0.01010101f);
            let _e31 = i;
            let u1_ = (f32((_e31 + 1i)) * 0.01010101f);
            let _e39 = i;
            let segIdx = (((lineIndex_2 * SEGMENTS_PER_LINE) + 50i) + _e39);
            if (segIdx >= TOTAL_SEGMENTS) {
                break;
            }
            let _e43 = fluxLinePoint(lineIndex_2, u0_, time_6);
            let _e44 = fluxLinePoint(lineIndex_2, u1_, time_6);
            let age_1 = fract(((time_6 * 0.5f) + (f32((segIdx % SEGMENTS_PER_LINE)) / 100f)));
            fluxSegments[segIdx] = FluxSegment(_e43.x, _e43.y, _e43.z, _e44.x, _e44.y, _e44.z, _e23, age_1);
        }
        continuing {
            let _e64 = i;
            i = (_e64 + 1i);
        }
    }
    loop {
        let _e68 = i_1;
        if (_e68 < 50i) {
        } else {
            break;
        }
        {
            let _e70 = i_1;
            let u0_1 = (-(f32(_e70)) * 0.01010101f);
            let _e74 = i_1;
            let u1_1 = (-(f32((_e74 + 1i))) * 0.01010101f);
            let _e85 = i_1;
            let segIdx_1 = ((((lineIndex_2 * SEGMENTS_PER_LINE) + 50i) - 1i) - _e85);
            if !((segIdx_1 < 0i)) {
                local = (segIdx_1 >= TOTAL_SEGMENTS);
            } else {
                local = true;
            }
            let _e95 = local;
            if _e95 {
                break;
            }
            let _e96 = fluxLinePoint(lineIndex_2, u1_1, time_6);
            let _e97 = fluxLinePoint(lineIndex_2, u0_1, time_6);
            let age_2 = fract(((time_6 * 0.5f) + (f32((segIdx_1 % SEGMENTS_PER_LINE)) / 100f)));
            fluxSegments[segIdx_1] = FluxSegment(_e96.x, _e96.y, _e96.z, _e97.x, _e97.y, _e97.z, _e23, age_2);
        }
        continuing {
            let _e117 = i_1;
            i_1 = (_e117 + 1i);
        }
    }
    return;
}
