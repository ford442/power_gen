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

struct KelvinConstants {
  static constexpr float E_BREAKDOWN_VM = 3000000.0f;
};

struct VdgConstants {
  static constexpr float SPHERE_RADIUS_M     = 0.14f;
  static constexpr float COLUMN_HEIGHT_M     = 1.05f;
  static constexpr float GAP_M               = 0.05f;
  static constexpr float BELT_MAX_MPS        = 6.0f;
  static constexpr float BELT_MAX_CURRENT_A  = 0.0000022f;
  static constexpr float LEAKAGE_R_OHM       = 50000000000000.0f;
  static constexpr float SPARK_DISCHARGE_FRAC = 0.05f;
  static constexpr float SPARK_DUR_S         = 0.15f;
  static constexpr float SPARK_RATE_WINDOW_S = 1.0f;
};

struct HallConstants {
  static constexpr float I_MAX_A        = 1.2f;
  static constexpr float B_MAX_T        = 0.65f;
  static constexpr float SMOOTHING_TAU  = 0.25f;
  static constexpr float N_SEMICONDUCTOR = 1e+21f;
  static constexpr float T_SEMICONDUCTOR_M = 0.0005f;
  static constexpr float N_METAL        = 8.5e+28f;
  static constexpr float T_METAL_M      = 0.0001f;
};

struct TransformerConstants {
  static constexpr float F_HZ      = 60.0f;
  static constexpr float NP        = 120.0f;
  static constexpr float NS        = 40.0f;
  static constexpr float L1_H      = 0.85f;
  static constexpr float L2_H      = 0.095f;
  static constexpr float K_IDEAL   = 0.97f;
  static constexpr float K_LEAKAGE = 0.72f;
  static constexpr float R1_OHM    = 1.8f;
  static constexpr float R2_OHM    = 0.45f;
  static constexpr float R_LOAD_OHM = 12.0f;
  static constexpr float V_PEAK    = 28.0f;
};

/** Simulated nameplate watts per SimMode (order-of-magnitude — not metrology). */
struct EnergyNetworkNameplates {
  static constexpr int MODE_COUNT = 12;
  static constexpr float WATTS[MODE_COUNT] = {
    2000.0f, 400.0f, 150.0f,
    300.0f, 120.0f, 350.0f,
    200.0f, 250.0f,
    110.0f, 60.0f, 30.0f,
    180.0f
  };
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
  static constexpr float E_CHARGE   = power_gen::PhysicalConstants::E_CHARGE;
}
