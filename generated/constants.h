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

struct PeltierConstants {
  static constexpr float SEEBECK_VK        = 0.00044f;
  static constexpr float COUPLES           = 127.0f;
  static constexpr float R_INTERNAL_OHM    = 2.5f;
  static constexpr float R_LOAD_OHM        = 2.5f;
  static constexpr float CONDUCTANCE_WK    = 0.5f;
  static constexpr float HEAT_CAP_HOT_JK   = 40.0f;
  static constexpr float HEAT_CAP_COLD_JK  = 60.0f;
  static constexpr float SINK_WK           = 1.6f;
  static constexpr float HEATER_MAX_W      = 60.0f;
  static constexpr float AMBIENT_K         = 293.0f;
  static constexpr float DELTA_T_REF_K     = 80.0f;
  static constexpr float CLAMP_BELOW_AMBIENT_K     = 5.0f;
  static constexpr float HOT_CLAMP_ABOVE_AMBIENT_K  = 250.0f;
  static constexpr float COLD_CLAMP_ABOVE_AMBIENT_K = 150.0f;
};

struct MhdConstants {
  static constexpr float PUMP_ACCEL_MS2 = 6.0f;
  static constexpr float LORENTZ_K      = 2.5f;
  static constexpr float FRICTION_K     = 0.8f;
  static constexpr float FLOW_U_MAX_MPS = 5.0f;
  static constexpr float WIDTH_M        = 0.1f;
  static constexpr float HALF_GAP_M     = 0.05f;
  static constexpr float SIGMA_SM       = 1000000.0f;
  static constexpr float RHO_KG_M3      = 870.0f;
  static constexpr float NU_M2S         = 8e-7f;
  static constexpr float R_INTERNAL_OHM = 0.05f;
  static constexpr float R_LOAD_OHM     = 0.05f;
  static constexpr float B_FIELD_BASE_T = 0.2f;
  static constexpr float B_FIELD_SPAN_T = 0.8f;
};

struct MaglevConstants {
  static constexpr float K_SPRING_NM      = 180.0f;
  static constexpr float C_DAMP_NSM       = 14.0f;
  static constexpr float MASS_KG          = 0.045f;
  static constexpr float GAP_INITIAL_M    = 0.018f;
  static constexpr float GAP_TARGET_BASE_M = 0.012f;
  static constexpr float GAP_TARGET_SPAN_M = 0.022f;
  static constexpr float GAP_MIN_M        = 0.004f;
  static constexpr float GAP_MAX_M        = 0.06f;
  static constexpr float LIFT_DRIVE_BASE  = 0.6f;
  static constexpr float LIFT_DRIVE_SPAN  = 0.4f;
  static constexpr float RPM_MAX          = 4200.0f;
  static constexpr float RPM_ERR_BASE     = 0.3f;
  static constexpr float RPM_ERR_SPAN     = 0.7f;
};

struct HomopolarConstants {
  static constexpr float DISC_RADIUS_M      = 0.14f;
  static constexpr float B_AXIAL_T          = 0.55f;
  static constexpr float R_OHM              = 0.008f;
  static constexpr float L_HENRY            = 0.0015f;
  static constexpr float INERTIA_KG_M2      = 0.002f;
  static constexpr float DRAG_NMS_PER_RAD   = 0.0008f;
  static constexpr float TAU_DRIVE_MAX_NM   = 0.15f;
  static constexpr float RPM_MAX            = 3600.0f;
  static constexpr float TAU_DRIVE_BASE     = 0.6f;
  static constexpr float TAU_DRIVE_SPAN     = 0.4f;
  static constexpr float TAU_DRIVE_TANH_GAIN = 2.0f;
};

struct LorentzSledConstants {
  static constexpr float RAIL_LENGTH_M        = 2.0f;
  static constexpr float RAIL_GAP_M           = 0.25f;
  static constexpr float SLED_MASS_KG         = 0.15f;
  static constexpr float SUPPLY_V_MAX         = 12.0f;
  static constexpr float CIRCUIT_R_OHM        = 0.6f;
  static constexpr float CIRCUIT_L_H          = 0.00006f;
  static constexpr float FRICTION_MU          = 0.25f;
  static constexpr float VISCOUS_DAMPING_NSM  = 0.3f;
  static constexpr float V_EPS_MPS            = 0.05f;
  static constexpr float FIELD_T_DEFAULT      = 0.8f;
  static constexpr float FIELD_T_MAX          = 1.2f;
  static constexpr float V_MAX_MPS            = 12.0f;
  static constexpr float I_MAX_A              = 22.0f;
};

/**
 * Thomson jumping ring — AC primary + shorted single-turn ring with height.
 * F_HZ is deliberately absent: the plant reads the lab mains frequency from
 * TransformerConstants::F_HZ so the two benches cannot drift apart.
 */
struct JumpingRingConstants {
  static constexpr float PRIMARY_L_H          = 0.022f;
  static constexpr float PRIMARY_R_OHM        = 1.6f;
  static constexpr float PRIMARY_V_PEAK       = 170.0f;
  static constexpr float RING_L_H             = 1.33e-7f;
  static constexpr float RING_R_OHM           = 0.00023f;
  static constexpr float RING_MASS_KG         = 0.02f;
  static constexpr float COUPLING_K0          = 0.65f;
  static constexpr float COUPLING_LAMBDA_M    = 0.045f;
  static constexpr float DRAG_NSM             = 0.25f;
  static constexpr float POLE_HEIGHT_M        = 0.15f;
  static constexpr float HEIGHT_REF_M         = 0.055f;
  static constexpr float I_PRIMARY_MAX_A      = 30.0f;
  static constexpr float I_RING_MAX_A         = 700.0f;
};

/** Simulated nameplate watts per SimMode (order-of-magnitude — not metrology). */
struct EnergyNetworkNameplates {
  static constexpr int MODE_COUNT = 13;
  static constexpr float WATTS[MODE_COUNT] = {
    2000.0f, 400.0f, 150.0f,
    300.0f, 120.0f, 350.0f,
    200.0f, 250.0f,
    110.0f, 60.0f, 30.0f,
    180.0f, 240.0f
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
