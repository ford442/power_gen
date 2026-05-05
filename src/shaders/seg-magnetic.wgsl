const PI: f32 = 3.14159265359;
const ROLLER_COUNT: f32 = 12.0;
const RING_RADIUS: f32 = 4.0;

fn calculateMagneticField(pos: vec3f, time: f32, rollerIndex: f32) -> vec3f {
    let angle = rollerIndex * (2.0 * PI / ROLLER_COUNT) + time * 0.5;
    let rollerPos = vec3f(cos(angle) * RING_RADIUS, 0.0, sin(angle) * RING_RADIUS);
    let delta = pos - rollerPos;
    let dist = length(delta);
    let dir = normalize(delta);
    let strength = 1.0 / (dist * dist + 0.1);
    let rotation = vec3f(dir.z, 0.0, -dir.x);
    return rotation * strength * sin(time * 3.0 + rollerIndex);
}

fn toroidalField(pos: vec3f, time: f32) -> f32 {
    let r = length(pos.xz);
    let theta = atan2(pos.z, pos.x);
    let majorField = sin(theta * 12.0 + time * 2.0) * exp(-pow(r - RING_RADIUS, 2.0) / 2.0);
    let verticalField = cos(pos.y * 2.0 + time * 4.0);
    return majorField * verticalField;
}

fn energyDensity(pos: vec3f, time: f32) -> f32 {
    let field = toroidalField(pos, time);
    return field * field * 0.5 + 0.1;
}
