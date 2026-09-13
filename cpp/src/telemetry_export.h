#pragma once
// Shared CSV column schema — keep aligned with src/telemetry/telemetry-schema.ts
//
// v2 layout: SEG/plant base columns, then one column per catalog telemetryKey
// (TELEMETRY_CSV_DEVICE_COLUMNS, generated from physics/devices.json).
// The native SEG-only export runs a single plant, so it emits real values for
// the SEG base columns and zero/empty placeholders for the twin, lab-bus and
// per-device columns — the file still parses as a full v2 telemetry CSV.

#include "../../generated/device-catalog.h"

static constexpr int TELEMETRY_CSV_VERSION = 2;

static constexpr const char* TELEMETRY_CSV_BASE_HEADER =
    "time_s,frame_id,view,mode,status,rpm_inner,seg_omega,corona,"
    "voltage_v,current_a,power_w,field_sim_t,energy_density_j_m3,"
    "drive,excitation_pct,temperature_c,efficiency_pct,particle_flux,load_ohm,"
    "hw_connected,hw_connection_state,phase_error_deg,rpm_error,"
    "voltage_error_v,current_error_a,energy_residual_w,energy_coupled";

// Base-column tail a SEG-only plant cannot fill: no hardware twin, no lab bus.
static constexpr const char* TELEMETRY_CSV_SEG_ONLY_TAIL = "0,disconnected,,,,,,0";

// Comma count + 1, so the generated column list and count cannot drift apart.
static constexpr int telemetry_csv_column_count(const char* s) {
    int n = 1;
    for (; *s; ++s) {
        if (*s == ',') ++n;
    }
    return n;
}

static_assert(
    telemetry_csv_column_count(TELEMETRY_CSV_DEVICE_COLUMNS)
        == TELEMETRY_CSV_DEVICE_COLUMN_COUNT,
    "generated device CSV column list disagrees with its count");

static constexpr float TELEMETRY_B_SURFACE_T = 0.7048f;

// Implemented in sim_core_standalone.cpp (standalone build)
int export_seg_csv(
    const char* path, float durationSec, float sampleHz,
    float drive, float loadTorque, float fieldStrength, float loadOhm);
