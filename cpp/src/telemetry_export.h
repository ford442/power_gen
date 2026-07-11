#pragma once
// Shared CSV column schema — keep aligned with src/telemetry/telemetry-schema.js

static constexpr const char* TELEMETRY_CSV_HEADER =
    "time_s,frame_id,view,mode,status,rpm_inner,seg_omega,corona,"
    "voltage_v,current_a,power_w,field_sim_t,energy_density_j_m3,"
    "drive,excitation_pct,temperature_c,efficiency_pct,particle_flux,load_ohm";

static constexpr float TELEMETRY_B_SURFACE_T = 0.7048f;

// Implemented in sim_core.cpp (standalone build)
int export_seg_csv(
    const char* path, float durationSec, float sampleHz,
    float drive, float loadTorque, float fieldStrength, float loadOhm);
