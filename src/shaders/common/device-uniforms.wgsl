// =============================================================
// Per-device uniforms (48 B = 12 × f32)
// Matches DeviceUniformManager / device-uniforms.js write order.
// =============================================================

struct DeviceUniforms {
  renderMode: f32,     // [0]
  posX: f32,           // [1]
  posY: f32,           // [2]
  posZ: f32,           // [3]
  rotation: vec4f,     // [4-7] quaternion
  timeScale: f32,      // [8] energy / time proxy
  ringIndex: f32,      // [9] mode index
  batteryCharge: f32,  // [10]
  isSolar: f32,        // [11]
}
