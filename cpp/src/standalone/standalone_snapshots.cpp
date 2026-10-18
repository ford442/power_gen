// =============================================================
// standalone_snapshots.cpp  –  --mode snapshots (plant save/load is exact)
// =============================================================

#ifdef SIM_CORE_STANDALONE

#include "sim_core.h"
#include "standalone/standalone_modes.h"

#include <cstdio>
#include <cstring>
#include <vector>

// For every SimMode: run simulator A for M frames with every setter knob moved
// off its default, save, load the vector into a fresh simulator B, then step
// both N more frames. The two saved vectors (and the telemetry getters) must be
// bit-identical — a field the step reads but the catalog `state` block left
// out would start B from the struct default and diverge here. Also: a layout
// hash or count mismatch, and a non-finite value, are refused untouched.

namespace {

constexpr int SNAP_M = 90;
constexpr int SNAP_N = 90;
constexpr float SNAP_DT = 1.f / 60.f;

/** Moves every knob a restore has to carry (they are not defaults on B). */
void move_knobs(SEGSimulator& sim, int mode) {
    sim.setDrive(0.73f);
    if (mode == SIM_MODE_SEG) sim.setRingLoadTorques(0.004f, 0.009f, 0.013f);
    if (mode == SIM_MODE_KELVIN) sim.setKelvinSeedV(9000.f);
    if (mode == SIM_MODE_TRANSFORMER) sim.setTransformerLeakage(true);
    if (mode == SIM_MODE_HALL) {
        sim.setHallCarrierMetal(true);
        sim.setHallFieldCoupledT(0.27f);
    }
    if (mode == SIM_MODE_LORENTZ_SLED) sim.setLorentzFieldT(0.41f);
}

/** The per-frame call the app makes: step with the per-ring torques in effect. */
void advance(SEGSimulator& sim, int frames) {
    for (int i = 0; i < frames; ++i) sim.stepWithPerRingTorques(SNAP_DT);
}

std::vector<float> save(SEGSimulator& sim, int mode) {
    const int n = sim.plantSave(mode);
    const float* s = reinterpret_cast<const float*>(sim.getScratchPtr(n));
    return std::vector<float>(s, s + n);
}

bool load(SEGSimulator& sim, int mode, const std::vector<float>& v, uint32_t hash) {
    float* s = reinterpret_cast<float*>(sim.getScratchPtr(static_cast<int>(v.size())));
    std::memcpy(s, v.data(), v.size() * sizeof(float));
    return sim.plantLoad(mode, static_cast<int>(v.size()), hash);
}

bool bits_equal(float a, float b) { return std::memcmp(&a, &b, sizeof(float)) == 0; }

}  // namespace

int run_snapshots() {
    int bad = 0;
    auto fail = [&bad](const char* id, const char* what) {
        std::fprintf(stderr, "FAIL: snapshots %s: %s\n", id, what);
        bad = 1;
    };

    for (int r = 0; r < DEVICE_CATALOG_COUNT; ++r) {
        const int mode = DEVICE_CATALOG[r].wasmMode;
        if (mode < 0) continue;
        const char* id = DEVICE_CATALOG[r].id;

        SEGSimulator a;
        a.setMode(mode);
        move_knobs(a, mode);
        advance(a, SNAP_M);
        const std::vector<float> mid = save(a, mode);
        if (static_cast<int>(mid.size()) != a.plantStateSize(mode) || mid.empty()) {
            fail(id, "plantSave count != plantStateSize");
            continue;
        }

        SEGSimulator b;
        b.setMode(mode);
        // Refusals first: each must leave B exactly as constructed.
        const std::vector<float> fresh = save(b, mode);
        std::vector<float> nan = mid;
        nan[nan.size() / 2] = std::nanf("");
        std::vector<float> shortV(mid.begin(), mid.end() - 1);
        if (load(b, mode, mid, PLANT_STATE_LAYOUT_HASH ^ 1u)) fail(id, "accepted a layout-hash mismatch");
        if (load(b, mode, shortV, PLANT_STATE_LAYOUT_HASH)) fail(id, "accepted a short vector");
        if (load(b, mode, nan, PLANT_STATE_LAYOUT_HASH)) fail(id, "accepted a NaN");
        if (save(b, mode) != fresh) fail(id, "a refused load changed the plant");

        if (!load(b, mode, mid, PLANT_STATE_LAYOUT_HASH)) {
            fail(id, "plantLoad refused its own plantSave");
            continue;
        }
        const std::vector<float> reread = save(b, mode);
        if (reread.size() != mid.size()
            || std::memcmp(reread.data(), mid.data(), mid.size() * sizeof(float)) != 0) {
            fail(id, "save → load → save is not the identity");
        }

        advance(a, SNAP_N);
        advance(b, SNAP_N);
        const std::vector<float> va = save(a, mode);
        const std::vector<float> vb = save(b, mode);
        int diverged = -1;
        for (size_t i = 0; i < va.size(); ++i) {
            if (!bits_equal(va[i], vb[i])) { diverged = static_cast<int>(i); break; }
        }
        if (diverged >= 0) {
            std::fprintf(stderr, "FAIL: snapshots %s: diverged after %d frames at index %d (%.9g vs %.9g)\n",
                         id, SNAP_N, diverged, static_cast<double>(va[diverged]), static_cast<double>(vb[diverged]));
            bad = 1;
            continue;
        }
        // Outputs a step writes but never reads would not show up above.
        if (!bits_equal(a.getEnergyLevel(), b.getEnergyLevel())
            || !bits_equal(a.estimatePower(0.01f), b.estimatePower(0.01f))
            || !bits_equal(a.getTime(), b.getTime())
            || !bits_equal(a.getRPM(), b.getRPM())) {
            fail(id, "telemetry getters differ after the restored run");
            continue;
        }
        if (std::memcmp(mid.data(), va.data(), mid.size() * sizeof(float)) == 0) {
            fail(id, "the plant did not move in the second half (test proves nothing)");
            continue;
        }
        std::printf("snapshots.ok %s floats=%d frames=%d+%d\n", id, static_cast<int>(mid.size()), SNAP_M, SNAP_N);
    }

    // Unknown modes have no layout.
    SEGSimulator z;
    if (z.plantStateSize(-1) != 0 || z.plantStateSize(SIM_MODE_COUNT) != 0 || z.plantSave(SIM_MODE_COUNT) != 0) {
        fail("catalog", "an unknown mode reports a snapshot size");
    }

    if (bad) return 1;
    std::printf("snapshots.done modes=%d hash=0x%08x\n", SIM_MODE_COUNT, static_cast<unsigned>(PLANT_STATE_LAYOUT_HASH));
    return 0;
}

#endif // SIM_CORE_STANDALONE
