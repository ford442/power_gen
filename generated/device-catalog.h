// AUTO-GENERATED from physics/devices.json — do not edit.
// Regenerate: npm run codegen:catalog
#pragma once

enum SimMode {
    SIM_MODE_SEG = 0,
    SIM_MODE_HERON = 1,
    SIM_MODE_KELVIN = 2,
    SIM_MODE_SOLAR = 3,
    SIM_MODE_PELTIER = 4,
    SIM_MODE_MHD = 5,
    SIM_MODE_MAGLEV = 6,
    SIM_MODE_HOMOPOLAR = 7,
    SIM_MODE_TRANSFORMER = 8,
    SIM_MODE_VDG = 9,
    SIM_MODE_HALL = 10,
    SIM_MODE_LORENTZ_SLED = 11,
    SIM_MODE_JUMPING_RING = 12
};

static constexpr int SIM_MODE_COUNT = 13;

struct DeviceCatalogRow {
    const char* id;
    int shaderMode;
    int wasmMode; // -1 = JS-only (no SimMode plant)
};

static constexpr DeviceCatalogRow DEVICE_CATALOG[] = {
    { "seg", 0, 0 },
    { "heron", 1, 1 },
    { "kelvin", 2, 2 },
    { "solar", 3, 3 },
    { "peltier", 4, 4 },
    { "mhd", 5, 5 },
    { "maglev", 6, 6 },
    { "pulse-coil", 7, -1 },
    { "homopolar", 8, 7 },
    { "halbach-viz", 9, -1 },
    { "transformer", 10, 8 },
    { "vdg", 12, 9 },
    { "hall", 13, 10 },
    { "lorentz-sled", 14, 11 },
    { "jumping-ring", 15, 12 }
};

static constexpr int DEVICE_CATALOG_COUNT = 15;

static constexpr int RESERVED_WASM_MODES[] = { 0 };
static constexpr int RESERVED_WASM_MODE_COUNT = 0;

static_assert(SIM_MODE_COUNT == 13, "SIM_MODE_COUNT must match physics/devices.json wasm plants");

// Per-device telemetry CSV columns, catalog order. Native SEG-only export emits
// the base columns and leaves these empty (see cpp/src/telemetry_export.h).
static constexpr const char* TELEMETRY_CSV_DEVICE_COLUMNS =
    "heron_head,heron_head_max,heron_vexit,heron_flow_rate_lmin,heron_pressure_kpa,kelvin_v,kelvin_voltage_n,kelvin_vbreak,kelvin_e,kelvin_spark_timer,battery_charge,peltier_hot_k,peltier_cold_k,peltier_delta_t,peltier_voltage,peltier_current,peltier_power_w,peltier_cop,mhd_flow_u,mhd_bfield_t,mhd_hartmann,mhd_voltage,mhd_current,mhd_power_w,maglev_gap_mm,maglev_field_t,maglev_lift_n,maglev_rpm,pulse_coil_current_a,pulse_coil_vcap,pulse_coil_bpeak_t,pulse_coil_armature_mm,homopolar_rpm,homopolar_emf_v,homopolar_current_a,homopolar_field_t,halbach_segment_count,halbach_mag_angle_deg,halbach_peak_bt,halbach_period_m,halbach_dipole_force_n,transformer_vp,transformer_vs,transformer_ip_a,transformer_is_a,transformer_k,transformer_flux_n,vdg_voltage,vdg_belt_mps,vdg_charge_c,vdg_spark_hz,hall_voltage,hall_current,hall_field_t,hall_coeff,lorentz_sled_vms,lorentz_current_a,lorentz_field_t,lorentz_force_n,lorentz_position_m,ring_height_m,ring_current_a,ring_primary_ia,ring_force_n,ring_coupling_k";

static constexpr int TELEMETRY_CSV_DEVICE_COLUMN_COUNT = 65;
