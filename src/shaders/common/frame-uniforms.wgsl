// =============================================================
// Global frame uniforms (binding 0 on most draw layouts)
//
// Host layout (multi-device-visualizer writeBuffer, first floats):
//   [0..15]  viewProj mat4
//   [16]     time
//   [17]     pad
//   [18..19] resolution
//   [20..22] cameraPos
//   [23]     speedMult
//   … lighting packs follow (shaders may declare a smaller prefix)
//
// WGSL aligns `cameraPos` after `time` to offset 80 (= float[20]),
// matching the host write. Do not insert fields without updating JS.
// =============================================================

struct Uniforms {
  viewProj: mat4x4f,
  time: f32,
  cameraPos: vec3f,
}
