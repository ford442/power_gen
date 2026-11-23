// =============================================================
// standalone_golden.cpp  –  --mode golden (JS fallback vs C++ plant reference values)
// =============================================================

#ifdef SIM_CORE_STANDALONE

#include "sim_core.h"
#include "standalone/standalone_modes.h"

#include <cstdio>
#include <cstring>

// --mode golden: replay every dual (JS fallback + C++ plant) device from a
// fixed seed and print its catalog telemetry keys, so scripts/test-js-wasm-
// golden.mjs can step the TypeScript fallback against the same schedule and
// diff the two. The schedule is printed alongside the values: the native run
// is authoritative for drive / frames / dt, and the Node side replays exactly
// what it reads back (dt is emitted at full double precision so the JS plant
// integrates the same float32-rounded 1/60 this binary used).
struct GoldenCase {
    int         mode;
    const char* id;      // case id — device id, plus a suffix for variants
    const char* device;  // catalog device whose telemetryKeys this case covers
    float       drive;
    int         frames;
    // Frame length. 1/60 for every device whose plant has no drive waveform of
    // its own; a mains-driven plant needs a dt that is *not* a whole number of
    // drive periods (see jumping-ring below) or every comparison lands on the
    // same phase.
    float       dt;
    // Lab field coupling (ADR-0011). >= 0 pins the destination plant's B to
    // this setpoint, exactly as FieldNetwork does under ?fieldCoupling=1, so
    // the golden covers the coupled path on both plants too. Negative = the
    // device's own local rule (the default, and every pre-existing case).
    float       hallFieldCoupledT;
    float       lorentzFieldT;
    // Lab charge coupling (ADR-0013). >= 0 seeds the Kelvin inductor with this
    // potential, exactly as ChargeNetwork does under ?chargeCoupling=1.
    // Negative = the isolated bench (the default, and every other case).
    float       kelvinSeedV;
    // Shared-integrator override (SEGSimulator::setIntegrator): -1 = the
    // catalog's method; otherwise 0 euler, 1 rk4, 2 dopri5, 3 ros23. The TS
    // side sets physicsState.integratorOverride to the same method, so every
    // integrator is held to JS ⇄ native parity, not just the default one.
    int         integrator = -1;
    // Peltier setpoints (catalog `peltierLoad` / `peltierPolarity`): heat fed
    // into the cold block, W, and the current direction (±1). The defaults
    // are the bench's own: no load, cooling.
    float       peltierLoadW = 0.f;
    float       peltierPolarity = 1.f;
    // Heron layout preset (a row of HERON_LAYOUTS); null for other devices.
    const char* heronLayout = nullptr;
    // Kelvin: share of the droplets' charge that lands (setKelvinCollectionEfficiency).
    // Negative = not measured, the plant's own 1 (every case but one).
    float       kelvinCollect = -1.f;
};

// Frame counts are chosen so each plant has left its initial transient:
// the thermal stack has opened a gap, the disc and sled have reached
// terminal speed, and the VdG sphere has sparked at least once.
static const GoldenCase GOLDEN_CASES[] = {
    // 15 s at 4 A: the block is tens of kelvin below ambient and still falling.
    { SIM_MODE_PELTIER,      "peltier",      "peltier",      0.50f, 900, 1.f / 60.f, -1.f, -1.f, -1.f },
    { SIM_MODE_MHD,          "mhd",          "mhd",          0.90f, 120, 1.f / 60.f, -1.f, -1.f, -1.f },
    { SIM_MODE_MAGLEV,       "maglev",       "maglev",       0.60f, 120, 1.f / 60.f, -1.f, -1.f, -1.f },
    { SIM_MODE_HOMOPOLAR,    "homopolar",    "homopolar",    0.90f, 240, 1.f / 60.f, -1.f, -1.f, -1.f },
    { SIM_MODE_TRANSFORMER,  "transformer",  "transformer",  0.90f,  60, 1.f / 60.f, -1.f, -1.f, -1.f },
    // 150, not 120: the spark-rate window closes every 1 s (60 frames) and
    // the two plants cross that boundary a frame apart (float32 vs float64
    // running sum of dt), so a multiple of 60 would compare sparkHz across
    // different windows.
    { SIM_MODE_VDG,          "vdg",          "vdg",          1.00f, 150, 1.f / 60.f, -1.f, -1.f, -1.f },
    { SIM_MODE_HALL,         "hall",         "hall",         0.80f, 120, 1.f / 60.f, -1.f, -1.f, -1.f },
    { SIM_MODE_LORENTZ_SLED, "lorentz-sled", "lorentz-sled", 0.80f, 240, 1.f / 60.f, -1.f, -1.f, -1.f },
    // dt = 1/90, not 1/60, and 400 frames rather than a multiple of 3.
    //
    // The ring is driven by the 60 Hz mains, so a 1/60 frame is exactly one
    // drive period: every comparison would land on the same phase — the one
    // where the supply voltage crosses zero. The ring is resistance-dominated
    // (omega*Lr/Rr ~ 0.2), so its current is very nearly in phase with that
    // voltage, and both ringCurrentA and the force it produces would be
    // sampled at ~1% of their own amplitude. Comparing two near-zero numbers
    // at a relative tolerance says nothing about whether the plants agree.
    // A 1/90 frame walks the sample around the cycle instead (3 frames per
    // period), and 400 frames leaves it a third of a period off the crossing.
    //
    // 400 x 1/90 = 4.4 s is ~20 mechanical settling times: the ring has left
    // the core, overshot, and converged on the hover height where the
    // cycle-averaged lift balances its weight, so the compared row sits on a
    // fixed point rather than on a transient.
    { SIM_MODE_JUMPING_RING, "jumping-ring", "jumping-ring", 0.85f, 400, 1.f / 90.f, -1.f, -1.f, -1.f },
    // Field-coupled variants (ADR-0011): same plants, but B pinned to a source
    // device's estimate instead of the local rule. 0.31 T is inside the Hall
    // bench's 0.65 T range and *not* 0.8 x bMaxT, so a plant that ignored the
    // coupled setpoint and kept using drive would not accidentally agree.
    { SIM_MODE_HALL,         "hall-coupled", "hall",         0.80f, 120, 1.f / 60.f, 0.31f, -1.f, -1.f },
    // 0.45 T stands in for a mid-drive MHD channel field; the default bench
    // value is 0.8 T, so the same "would not accidentally agree" argument holds.
    { SIM_MODE_LORENTZ_SLED, "lorentz-sled-coupled", "lorentz-sled", 0.80f, 240, 1.f / 60.f, -1.f, 0.45f, -1.f },
    // Kelvin, isolated and charge-seeded (ADR-0013). 90 frames at drive 0.5
    // stays below the 60 kV breakdown on both (≈11 kV vs ≈43 kV), so the
    // compared row is the charging curve rather than which frame a spark
    // lands on. 12 kV stands in for a VdG sphere at ~86 kV seen through r/d =
    // 0.14; it roughly quadruples V at 1.5 s, so a plant that ignored the seed
    // would not accidentally agree.
    { SIM_MODE_KELVIN,       "kelvin",        "kelvin",      0.50f,  90, 1.f / 60.f, -1.f, -1.f, -1.f },
    { SIM_MODE_KELVIN,       "kelvin-seeded", "kelvin",      0.50f,  90, 1.f / 60.f, -1.f, -1.f, 12000.f },
    // 40 % of the charge landing: V at 1.5 s is well under the full-collection
    // case's, so a plant that ignored the efficiency would not agree.
    { SIM_MODE_KELVIN,       "kelvin-collect", "kelvin",     0.50f,  90, 1.f / 60.f, -1.f, -1.f, -1.f, -1, 0.f, 1.f, nullptr, 0.4f },
    // Every method on every shared-integrator plant (docs/INTEGRATORS.md),
    // over the same schedule as the plant's default case.
    { SIM_MODE_JUMPING_RING, "jumping-ring@rk4",    "jumping-ring", 0.85f, 400, 1.f / 90.f, -1.f, -1.f, -1.f, 1 },
    { SIM_MODE_JUMPING_RING, "jumping-ring@dopri5", "jumping-ring", 0.85f, 400, 1.f / 90.f, -1.f, -1.f, -1.f, 2 },
    { SIM_MODE_JUMPING_RING, "jumping-ring@ros23",  "jumping-ring", 0.85f, 400, 1.f / 90.f, -1.f, -1.f, -1.f, 3 },
    { SIM_MODE_HOMOPOLAR,    "homopolar@rk4",       "homopolar",    0.90f, 240, 1.f / 60.f, -1.f, -1.f, -1.f, 1 },
    { SIM_MODE_HOMOPOLAR,    "homopolar@dopri5",    "homopolar",    0.90f, 240, 1.f / 60.f, -1.f, -1.f, -1.f, 2 },
    { SIM_MODE_HOMOPOLAR,    "homopolar@ros23",     "homopolar",    0.90f, 240, 1.f / 60.f, -1.f, -1.f, -1.f, 3 },
    // The cooler's two setpoints: a 12 W load on the block, and the current
    // reversed (the block heats). No case for an explicit override (@euler,
    // @rk4, @dopri5): on this stiff leg they take tens of thousands of
    // sub-millisecond steps, and adding ~1 mK increments to ~300 K float32
    // temperatures that often leaves tens of mK of rounding — the C++ side's
    // own noise, well above this test's 2e-4. A @dopri5 case agreed on one
    // compiler and moved Q_c by 0.06 W (0.2 %) on another that contracts
    // a·b + c into FMA. test:integrators holds those overrides to the error
    // budget on each side instead (docs/INTEGRATORS.md → Peltier).
    { SIM_MODE_PELTIER,      "peltier-loaded",      "peltier",      0.60f, 900, 1.f / 60.f, -1.f, -1.f, -1.f, -1, 12.f, 1.f },
    { SIM_MODE_PELTIER,      "peltier-reversed",    "peltier",      0.25f, 600, 1.f / 60.f, -1.f, -1.f, -1.f, -1, 0.f, -1.f },
    // Heron: a partial head on the classic preset (the pump balances the
    // drain below the ceiling), and the tower preset at full drive, where the
    // head sits on its ceiling. The tower's numbers are repeated in
    // HERON_LAYOUTS below; the TS side takes them from src/heron-layout.ts,
    // so the two tables are held to each other here.
    { SIM_MODE_HERON,        "heron",               "heron",        0.30f, 600, 1.f / 60.f, -1.f, -1.f, -1.f, -1, 0.f, 1.f, "classic" },
    { SIM_MODE_HERON,        "heron-tower",         "heron",        1.00f, 600, 1.f / 60.f, -1.f, -1.f, -1.f, -1, 0.f, 1.f, "tower" },
};

/// The layout presets the Heron cases run (src/heron-layout.ts PRESET_DEFS):
/// headMaxM, pipeLengthM, pipeDiameterM, nozzleDiameterM, dischargeCoeff,
/// roughness, pumpRate, drainCoeff.
struct HeronLayoutRow { const char* id; float v[8]; };
static const HeronLayoutRow HERON_LAYOUTS[] = {
    { "classic", { 4.5f, 4.0f, 0.08f, 0.04f, 0.35f, 0.02f, 2.2f, 0.30f } },
    { "tower",   { 6.5f, 7.2f, 0.05f, 0.03f, 0.32f, 0.018f, 1.6f, 0.22f } },
};

static const char* golden_integrator_name(int m) {
    return m < 0 ? "catalog" : sim_core::integrator_name(static_cast<sim_core::Integrator>(m));
}
static constexpr int GOLDEN_CASE_COUNT =
    static_cast<int>(sizeof(GOLDEN_CASES) / sizeof(GOLDEN_CASES[0]));

static int golden_emit(const char* id, const char* key, float value) {
    if (!std::isfinite(value)) {
        std::fprintf(stderr, "FAIL: %s.%s is not finite (%g)\n", id, key, value);
        return 1;
    }
    // %.17g of the double-promoted float round-trips the exact float32 value.
    std::printf("golden.value %s %s %.17g\n", id, key, static_cast<double>(value));
    return 0;
}

int run_golden() {
    int bad = 0;

    for (int c = 0; c < GOLDEN_CASE_COUNT; ++c) {
        const GoldenCase& g = GOLDEN_CASES[c];
        SEGSimulator sim;
        sim.setMode(g.mode);
        sim.setDrive(g.drive);
        if (g.hallFieldCoupledT >= 0.f) sim.setHallFieldCoupledT(g.hallFieldCoupledT);
        if (g.lorentzFieldT >= 0.f) sim.setLorentzFieldT(g.lorentzFieldT);
        if (g.kelvinSeedV >= 0.f) sim.setKelvinSeedV(g.kelvinSeedV);
        if (g.kelvinCollect >= 0.f) sim.setKelvinCollectionEfficiency(g.kelvinCollect);
        sim.setPeltierLoadW(g.peltierLoadW);
        sim.setPeltierPolarity(g.peltierPolarity);
        for (const HeronLayoutRow& row : HERON_LAYOUTS) {
            if (g.heronLayout && std::strcmp(g.heronLayout, row.id) == 0) {
                sim.setHeronLayout(row.v[0], row.v[1], row.v[2], row.v[3], row.v[4], row.v[5], row.v[6], row.v[7]);
            }
        }
        sim.setIntegrator(g.integrator);
        for (int i = 0; i < g.frames; ++i) sim.step(g.dt, 0.f);

        std::printf("golden.case %s device=%s drive=%.17g frames=%d dt=%.17g"
                    " hallFieldCoupledT=%.17g lorentzFieldT=%.17g kelvinSeedV=%.17g integrator=%s"
                    " peltierLoadW=%.17g peltierPolarity=%.17g heronLayout=%s kelvinCollect=%.17g\n",
                    g.id, g.device, static_cast<double>(g.drive), g.frames,
                    static_cast<double>(g.dt),
                    static_cast<double>(g.hallFieldCoupledT),
                    static_cast<double>(g.lorentzFieldT),
                    static_cast<double>(g.kelvinSeedV),
                    golden_integrator_name(g.integrator),
                    static_cast<double>(g.peltierLoadW),
                    static_cast<double>(g.peltierPolarity),
                    g.heronLayout ? g.heronLayout : "-",
                    static_cast<double>(g.kelvinCollect));

        switch (g.mode) {
            case SIM_MODE_HERON: {
                const float v = sim.getHeronVExit();
                bad |= golden_emit(g.id, "heronHead",         sim.getHeronHead());
                bad |= golden_emit(g.id, "heronHeadMax",      sim.getHeronHeadMax());
                bad |= golden_emit(g.id, "heronVExit",        v);
                bad |= golden_emit(g.id, "heronFlowRateLmin", sim.getHeronFlowLmin());
                bad |= golden_emit(g.id, "heronPressureKPa",  sim.getHeronPressureKPa());
                bad |= golden_emit(g.id, "heronJetIdealM",    v * v / (2.f * PhysicsConstants::G));
                // Read back from the liquid solver when one runs; no plant
                // simulates the liquid, so here it is the "not measured" 0.
                bad |= golden_emit(g.id, "heronJetHeightM",   0.f);
                break;
            }
            case SIM_MODE_KELVIN:
                bad |= golden_emit(g.id, "kelvinV",          sim.getKelvinVoltage());
                bad |= golden_emit(g.id, "kelvinVoltageN",   sim.getKelvinVoltageN());
                bad |= golden_emit(g.id, "kelvinVbreak",     sim.getKelvinVbreak());
                bad |= golden_emit(g.id, "kelvinE",          sim.getKelvinE());
                bad |= golden_emit(g.id, "kelvinSparkTimer", sim.getKelvinSparkTimer());
                break;
            case SIM_MODE_PELTIER:
                bad |= golden_emit(g.id, "peltierHotK",    sim.getPeltierHotK());
                bad |= golden_emit(g.id, "peltierColdK",   sim.getPeltierColdK());
                bad |= golden_emit(g.id, "peltierDeltaT",  sim.getPeltierDeltaT());
                bad |= golden_emit(g.id, "peltierVoltage", sim.getPeltierVoltage());
                bad |= golden_emit(g.id, "peltierCurrent", sim.getPeltierCurrent());
                bad |= golden_emit(g.id, "peltierPowerW",  sim.getPeltierPowerW());
                bad |= golden_emit(g.id, "peltierQcW",       sim.getPeltierQcW());
                bad |= golden_emit(g.id, "peltierQhW",       sim.getPeltierQhW());
                bad |= golden_emit(g.id, "peltierCOP",     sim.getPeltierCOP());
                break;
            case SIM_MODE_MHD:
                bad |= golden_emit(g.id, "mhdFlowU",    sim.getMhdFlowU());
                bad |= golden_emit(g.id, "mhdBFieldT",  sim.getMhdBFieldT());
                bad |= golden_emit(g.id, "mhdHartmann", sim.getMhdHartmann());
                bad |= golden_emit(g.id, "mhdVoltage",  sim.getMhdVoltage());
                bad |= golden_emit(g.id, "mhdCurrent",  sim.getMhdCurrent());
                bad |= golden_emit(g.id, "mhdPowerW",   sim.getMhdPowerW());
                break;
            case SIM_MODE_MAGLEV:
                bad |= golden_emit(g.id, "maglevGapMm",  sim.getMaglevGapMm());
                bad |= golden_emit(g.id, "maglevFieldT", sim.getMaglevFieldT());
                bad |= golden_emit(g.id, "maglevLiftN",  sim.getMaglevLiftN());
                bad |= golden_emit(g.id, "maglevRpm",    sim.getMaglevRpm());
                break;
            case SIM_MODE_HOMOPOLAR:
                bad |= golden_emit(g.id, "homopolarRpm",      sim.getHomopolarRpm());
                bad |= golden_emit(g.id, "homopolarEmfV",     sim.getHomopolarEmfV());
                bad |= golden_emit(g.id, "homopolarCurrentA", sim.getHomopolarCurrentA());
                bad |= golden_emit(g.id, "homopolarFieldT",   sim.getHomopolarFieldT());
                break;
            case SIM_MODE_TRANSFORMER:
                bad |= golden_emit(g.id, "transformerVp",    sim.getTransformerV1());
                bad |= golden_emit(g.id, "transformerVs",    sim.getTransformerV2());
                bad |= golden_emit(g.id, "transformerIpA",   sim.getTransformerI1());
                bad |= golden_emit(g.id, "transformerIsA",   sim.getTransformerI2());
                bad |= golden_emit(g.id, "transformerK",     sim.getTransformerK());
                bad |= golden_emit(g.id, "transformerFluxN", sim.getTransformerFluxN());
                break;
            case SIM_MODE_VDG:
                bad |= golden_emit(g.id, "vdgVoltage", sim.getVdgVoltage());
                bad |= golden_emit(g.id, "vdgBeltMps", sim.getVdgBeltMps());
                bad |= golden_emit(g.id, "vdgChargeC", sim.getVdgChargeC());
                bad |= golden_emit(g.id, "vdgSparkHz", sim.getVdgSparkHz());
                break;
            case SIM_MODE_HALL:
                bad |= golden_emit(g.id, "hallVoltage", sim.getHallVoltage());
                bad |= golden_emit(g.id, "hallCurrent", sim.getHallCurrent());
                bad |= golden_emit(g.id, "hallFieldT",  sim.getHallFieldT());
                bad |= golden_emit(g.id, "hallCoeff",   sim.getHallCoeff());
                break;
            case SIM_MODE_LORENTZ_SLED:
                bad |= golden_emit(g.id, "lorentzSledVms",  sim.getLorentzSledVms());
                bad |= golden_emit(g.id, "lorentzCurrentA", sim.getLorentzCurrentA());
                bad |= golden_emit(g.id, "lorentzFieldT",   sim.getLorentzFieldT());
                bad |= golden_emit(g.id, "lorentzForceN",   sim.getLorentzForceN());
                bad |= golden_emit(g.id, "lorentzPositionM", sim.getLorentzPositionM());
                break;
            case SIM_MODE_JUMPING_RING:
                bad |= golden_emit(g.id, "ringHeightM",    sim.getRingHeightM());
                bad |= golden_emit(g.id, "ringCurrentA",   sim.getRingCurrentA());
                bad |= golden_emit(g.id, "ringPrimaryIA",  sim.getRingPrimaryIA());
                bad |= golden_emit(g.id, "ringForceN",     sim.getRingForceN());
                bad |= golden_emit(g.id, "ringCouplingK",  sim.getRingCouplingK());
                break;
            default:
                std::fprintf(stderr, "FAIL: no golden emitter for mode %d\n", g.mode);
                return 1;
        }
    }

    if (bad) return 1;
    std::printf("golden.done cases=%d\n", GOLDEN_CASE_COUNT);
    return 0;
}

#endif // SIM_CORE_STANDALONE
