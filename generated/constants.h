// AUTO-GENERATED from physics/constants.json — do not edit.
// Regenerate: npm run codegen:constants
#pragma once

namespace power_gen {

struct PhysicalConstants {
  static constexpr float MU_0       = 1.2566370614e-7f;
  static constexpr float EPSILON_0  = 8.854187817e-12f;
  static constexpr float G          = 9.80665f;
  static constexpr float PI         = 3.141592653589793f;
  static constexpr float TAU        = 6.283185307179586f;
  static constexpr float Br_DEFAULT = 1.48f;
  static constexpr float MU_R       = 1.05f;
  static constexpr float E_CHARGE   = 1.602176634e-19f;
  static constexpr float K_B        = 1.380649e-23f;
  static constexpr float C          = 299792458.0f;
};

struct ParticleLayouts {
  static constexpr int GPU_PARTICLE_BYTES        = 16;
  static constexpr int SIM_PARTICLE_BYTES        = 32;
  static constexpr int PIPE_PARTICLE_BYTES       = 32;
  static constexpr int FIELD_LINE_PARTICLE_BYTES = 32;
  static constexpr int ROLLER_EXPORT_STRIDE      = 4;
  static_assert(GPU_PARTICLE_BYTES == 16, "GpuParticle must remain 16 bytes (vec3f + phase)");
  static_assert(SIM_PARTICLE_BYTES == 32, "SimParticle must remain 32 bytes (8 floats)");
};

struct WasmSegDefaults {
  static constexpr int RING_COUNTS[3]  = { 12, 22, 32 };
  static constexpr float RING_RADII[3] = { 3.5f, 5.5f, 7.5f };
  static constexpr int MAX_ROLLERS   = 66;
  static constexpr int MAX_PARTICLES = 50000;
};

} // namespace power_gen

// Back-compat alias used throughout sim_core.*
namespace PhysicsConstants {
  static constexpr float MU_0       = power_gen::PhysicalConstants::MU_0;
  static constexpr float EPSILON_0  = power_gen::PhysicalConstants::EPSILON_0;
  static constexpr float G          = power_gen::PhysicalConstants::G;
  static constexpr float PI         = power_gen::PhysicalConstants::PI;
  static constexpr float TAU        = power_gen::PhysicalConstants::TAU;
  static constexpr float Br_DEFAULT = power_gen::PhysicalConstants::Br_DEFAULT;
  static constexpr float MU_R       = power_gen::PhysicalConstants::MU_R;
}
