struct LightData {
    posOrDir: vec3f,
    _pad0: f32,
    color: vec3f,
    intensity: f32,
  }

  struct LightingConfig {
    key: LightData,
    fill: LightData,
    rim: LightData,
    ground: LightData,
    ambient: f32,
    envMapStrength: f32,
    shadowStrength: f32,
    _padEnd: f32,
  }
