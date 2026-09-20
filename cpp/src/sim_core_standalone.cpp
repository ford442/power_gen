// =============================================================
// sim_core_standalone.cpp  –  native smoke-test driver + CSV export
// =============================================================

#ifdef SIM_CORE_STANDALONE

#include "sim_core.h"
#include "telemetry_export.h"

#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

static float clamp01f(float v) {
    return v < 0.f ? 0.f : (v > 1.f ? 1.f : v);
}

int export_seg_csv(
    const char* path, float durationSec, float sampleHz,
    float drive, float loadTorque, float fieldStrength, float loadOhm)
{
    SEGSimulator sim;
    sim.setMode(SIM_MODE_SEG);
    sim.setDrive(drive);
    sim.seedParticles(1000);

    FILE* f = std::fopen(path, "w");
    if (!f) return 1;

    // Full v2 header: SEG base columns + every catalog device column.
    std::fprintf(f, "%s,%s\n", TELEMETRY_CSV_BASE_HEADER, TELEMETRY_CSV_DEVICE_COLUMNS);

    // This driver runs the SEG plant only; other devices export as zeros.
    std::string deviceZeros;
    deviceZeros.reserve(TELEMETRY_CSV_DEVICE_COLUMN_COUNT * 2);
    for (int i = 0; i < TELEMETRY_CSV_DEVICE_COLUMN_COUNT; ++i) {
        deviceZeros += ",0";
    }

    const float physicsDt = 1.f / 60.f;
    const float sampleDt = 1.f / sampleHz;
    float simTime = 0.f;
    float accum = 0.f;
    int frameId = 0;
    int steps = 0;
    const int maxSteps = static_cast<int>(durationSec * 60.f) + 2;

    while (simTime < durationSec && steps < maxSteps) {
        sim.step(physicsDt, loadTorque);
        sim.stepParticles(physicsDt);
        simTime += physicsDt;
        accum += physicsDt;
        steps++;

        while (accum >= sampleDt && simTime <= durationSec + 1e-3f) {
            accum -= sampleDt;
            frameId++;
            const float tSample = simTime - accum;
            const float omega = sim.getOmega();
            const float segOmega = clamp01f(omega / 50.f);
            float rotationSpeed = segOmega * 100.f;
            if (rotationSpeed > 120.f) rotationSpeed = 120.f;
            const float corona = clamp01f((segOmega - 0.6f) / 0.4f);
            const float rpmInner = rotationSpeed * 30.f;
            const float voltage = rotationSpeed * fieldStrength * 2.5f;
            const float current = loadOhm > 0.f ? voltage / loadOhm : 0.f;
            const float power = sim.estimatePower(loadTorque);
            const float fieldSim = fieldStrength * (1.f + rotationSpeed / 200.f) * TELEMETRY_B_SURFACE_T;
            const float energyD = sim.magneticEnergyDensity();
            const float temp = 25.f + rotationSpeed * 0.3f + corona * 12.f;
            const float eff = drive > 0.f ? 85.f + (rotationSpeed / 100.f) * 10.f : 0.f;

            std::fprintf(f,
                "%.6f,%d,seg,seg,operational,%.2f,%.6f,%.6f,"
                "%.4f,%.6f,%.4f,%.6f,%.6e,"
                "%.4f,%d,%.2f,%.2f,0,%.1f,%s%s\n",
                tSample, frameId,
                rpmInner, segOmega, corona,
                voltage, current, power, fieldSim, energyD,
                drive, static_cast<int>(fieldStrength * 100.f), temp, eff, loadOhm,
                TELEMETRY_CSV_SEG_ONLY_TAIL, deviceZeros.c_str());
        }
    }

    std::fclose(f);
    return 0;
}

static int run_peltier_smoke() {
    SEGSimulator sim;
    sim.setMode(SIM_MODE_PELTIER);
    sim.setDrive(1.f);
    sim.seedParticles(500);
    const float dt = 1.f / 60.f;
    for (int i = 0; i < 3600; ++i) { // 60 s to let the stack heat up
        sim.step(dt, 0.f);
        if ((i & 7) == 0) sim.stepParticles(dt);
    }
    printf("Peltier Th=%.1f K  Tc=%.1f K  dT=%.1f K  V=%.3f V  I=%.3f A  P=%.3f W  eff=%.3f\n",
           sim.getPeltierHotK(), sim.getPeltierColdK(), sim.getPeltierDeltaT(),
           sim.getPeltierVoltage(), sim.getPeltierCurrent(),
           sim.getPeltierPowerW(), sim.getPeltierCOP());
    if (sim.getPeltierDeltaT() <= 1.f || sim.getPeltierPowerW() <= 0.f) {
        printf("FAIL: Peltier stack did not develop dT / power\n");
        return 1;
    }
    if (sim.getEnergyLevel() < 0.f || sim.getEnergyLevel() > 1.f) {
        printf("FAIL: Peltier energy level out of range\n");
        return 1;
    }
    printf("Peltier smoke OK (energyLevel=%.3f)\n", sim.getEnergyLevel());
    return 0;
}

static int run_mhd_smoke() {
    SEGSimulator sim;
    sim.setMode(SIM_MODE_MHD);
    sim.setDrive(0.9f);
    sim.seedParticles(500);
    const float dt = 1.f / 60.f;
    for (int i = 0; i < 600; ++i) {
        sim.step(dt, 0.f);
        sim.stepParticles(dt);
    }
    printf("MHD u=%.3f m/s  B=%.3f T  Ha=%.0f  V=%.4f V  I=%.3f A  P=%.4f W\n",
           sim.getMhdFlowU(), sim.getMhdBFieldT(), sim.getMhdHartmann(),
           sim.getMhdVoltage(), sim.getMhdCurrent(), sim.getMhdPowerW());
    if (sim.getMhdFlowU() <= 0.f || sim.getMhdVoltage() <= 0.f) {
        printf("FAIL: MHD channel did not develop flow / voltage\n");
        return 1;
    }
    if (sim.getEnergyLevel() < 0.f || sim.getEnergyLevel() > 1.f) {
        printf("FAIL: MHD energy level out of range\n");
        return 1;
    }
    printf("MHD smoke OK (energyLevel=%.3f)\n", sim.getEnergyLevel());
    return 0;
}

static int run_maglev_smoke() {
    SEGSimulator sim;
    sim.setMode(SIM_MODE_MAGLEV);
    sim.setDrive(0.85f);
    const float dt = 1.f / 60.f;
    for (int i = 0; i < 600; ++i) sim.step(dt, 0.f);
    printf("Maglev gap=%.4f m (%.2f mm)  B=%.3f T  lift=%.3f N  rpm=%.0f\n",
           sim.getMaglevGap(), sim.getMaglevGapMm(),
           sim.getMaglevFieldT(), sim.getMaglevLiftN(), sim.getMaglevRpm());
    if (sim.getMaglevGap() <= 0.f || sim.getMaglevFieldT() <= 0.f
        || !std::isfinite(sim.getMaglevGap()) || !std::isfinite(sim.getMaglevRpm())) {
        printf("FAIL: Maglev gap / field did not develop\n");
        return 1;
    }
    if (sim.getMaglevRpm() <= 0.f) {
        printf("FAIL: Maglev RPM stayed zero under drive\n");
        return 1;
    }
    if (!std::isfinite(sim.getEnergyLevel()) || sim.getEnergyLevel() < 0.f || sim.getEnergyLevel() > 1.f) {
        printf("FAIL: Maglev energy level out of range\n");
        return 1;
    }
    printf("Maglev smoke OK (energyLevel=%.3f)\n", sim.getEnergyLevel());
    return 0;
}

static int run_homopolar_smoke() {
    SEGSimulator sim;
    sim.setMode(SIM_MODE_HOMOPOLAR);
    sim.setDrive(0.9f);
    const float dt = 1.f / 60.f;
    for (int i = 0; i < 900; ++i) sim.step(dt, 0.f);
    printf("Homopolar rpm=%.1f  EMF=%.4f V  I=%.3f A  B=%.3f T\n",
           sim.getHomopolarRpm(), sim.getHomopolarEmfV(),
           sim.getHomopolarCurrentA(), sim.getHomopolarFieldT());
    if (sim.getHomopolarRpm() <= 0.f || sim.getHomopolarEmfV() <= 0.f) {
        printf("FAIL: Homopolar disc did not develop RPM / EMF\n");
        return 1;
    }
    if (sim.getHomopolarCurrentA() <= 0.f) {
        printf("FAIL: Homopolar current stayed zero\n");
        return 1;
    }
    printf("Homopolar smoke OK (energyLevel=%.3f)\n", sim.getEnergyLevel());
    return 0;
}

static int run_transformer_smoke() {
    SEGSimulator sim;
    sim.setMode(SIM_MODE_TRANSFORMER);
    sim.setDrive(0.9f);
    const float dt = 1.f / 60.f;
    const int steps = 60; // 1 s
    for (int i = 0; i < steps; ++i) {
        sim.step(dt, 0.f);
        const float i1 = sim.getTransformerI1();
        const float i2 = sim.getTransformerI2();
        const float v2 = sim.getTransformerV2();
        if (!std::isfinite(i1) || !std::isfinite(i2) || !std::isfinite(v2)) {
            printf("FAIL: transformer NaN at step %d (I1=%g I2=%g V2=%g)\n", i, i1, i2, v2);
            return 1;
        }
    }
    printf("Transformer I1=%.3f A  I2=%.3f A  V1=%.2f V  V2=%.2f V  k=%.2f  flux=%.3f\n",
           sim.getTransformerI1(), sim.getTransformerI2(),
           sim.getTransformerV1(), sim.getTransformerV2(),
           sim.getTransformerK(), sim.getTransformerFluxN());
    if (std::abs(sim.getTransformerI1()) < 1e-4f
        && std::abs(sim.getTransformerI2()) < 1e-4f
        && std::abs(sim.getTransformerV2()) < 1e-4f) {
        printf("FAIL: transformer plant did not develop I1/I2/V2 under drive\n");
        return 1;
    }
    if (!std::isfinite(sim.getEnergyLevel()) || sim.getEnergyLevel() < 0.f || sim.getEnergyLevel() > 1.f) {
        printf("FAIL: transformer energy level out of range\n");
        return 1;
    }
    printf("Transformer smoke OK (energyLevel=%.3f)\n", sim.getEnergyLevel());
    return 0;
}

static int run_vdg_smoke() {
    SEGSimulator sim;
    sim.setMode(SIM_MODE_VDG);
    sim.setDrive(1.0f);
    const float dt = 1.f / 60.f;
    const int steps = 300; // 5 s — long enough to charge past breakdown and spark at least once
    bool sawSpark = false;
    float prevCharge = sim.getVdgChargeC();
    for (int i = 0; i < steps; ++i) {
        sim.step(dt, 0.f);
        const float v = sim.getVdgVoltage();
        const float q = sim.getVdgChargeC();
        if (!std::isfinite(v) || !std::isfinite(q)) {
            printf("FAIL: vdg NaN at step %d (V=%g Q=%g)\n", i, v, q);
            return 1;
        }
        if (v < 0.f) {
            printf("FAIL: vdg voltage went negative at step %d (V=%g)\n", i, v);
            return 1;
        }
        // A spark discharges the sphere to sparkDischargeFrac (0.05) of its
        // charge in a single step — a >50% single-step drop is that event's
        // unambiguous fingerprint (robust to the 1s rolling sparkHz window).
        if (prevCharge > 1e-9f && q < prevCharge * 0.5f) sawSpark = true;
        prevCharge = q;
    }
    printf("VdG voltage=%.1f V  belt=%.2f m/s  charge=%.4g C  sparkHz=%.3f\n",
           sim.getVdgVoltage(), sim.getVdgBeltMps(), sim.getVdgChargeC(), sim.getVdgSparkHz());
    if (sim.getVdgBeltMps() <= 0.f) {
        printf("FAIL: VdG belt did not move under drive\n");
        return 1;
    }
    if (!sawSpark) {
        printf("FAIL: VdG sphere never discharged (no spark) in %d steps\n", steps);
        return 1;
    }
    if (!std::isfinite(sim.getEnergyLevel()) || sim.getEnergyLevel() < 0.f || sim.getEnergyLevel() > 1.f) {
        printf("FAIL: VdG energy level out of range\n");
        return 1;
    }
    printf("VdG smoke OK (energyLevel=%.3f)\n", sim.getEnergyLevel());
    return 0;
}

static int run_hall_smoke() {
    SEGSimulator sim;
    sim.setMode(SIM_MODE_HALL);
    sim.setDrive(0.8f);
    const float dt = 1.f / 60.f;
    for (int i = 0; i < 180; ++i) sim.step(dt, 0.f); // 3 s — settle the smoothed I/B

    const float vSemi = sim.getHallVoltage();
    const float iA = sim.getHallCurrent();
    const float bT = sim.getHallFieldT();
    printf("Hall (semiconductor) V_H=%.4g V  I=%.3f A  B=%.3f T  R_H=%.4g m^3/C\n",
           vSemi, iA, bT, sim.getHallCoeff());
    if (!std::isfinite(vSemi) || !std::isfinite(iA) || !std::isfinite(bT)) {
        printf("FAIL: hall NaN (semiconductor)\n");
        return 1;
    }
    if (iA <= 0.f || bT <= 0.f || vSemi <= 0.f) {
        printf("FAIL: Hall bench did not develop I/B/V_H under drive\n");
        return 1;
    }

    sim.setHallCarrierMetal(true);
    for (int i = 0; i < 60; ++i) sim.step(dt, 0.f);
    const float vMetal = sim.getHallVoltage();
    printf("Hall (metal) V_H=%.4g V  R_H=%.4g m^3/C\n", vMetal, sim.getHallCoeff());
    if (!std::isfinite(vMetal) || vMetal <= 0.f) {
        printf("FAIL: hall metal-carrier voltage invalid\n");
        return 1;
    }
    if (vMetal >= vSemi) {
        printf("FAIL: metal V_H (%.4g) should be far smaller than semiconductor V_H (%.4g)\n", vMetal, vSemi);
        return 1;
    }
    if (!std::isfinite(sim.getEnergyLevel()) || sim.getEnergyLevel() < 0.f || sim.getEnergyLevel() > 1.f) {
        printf("FAIL: Hall energy level out of range\n");
        return 1;
    }
    printf("Hall smoke OK (energyLevel=%.3f)\n", sim.getEnergyLevel());
    return 0;
}

static int run_lorentz_smoke() {
    SEGSimulator sim;
    sim.setMode(SIM_MODE_LORENTZ_SLED);
    sim.setDrive(0.8f);
    const float dt = 1.f / 60.f;
    for (int i = 0; i < 600; ++i) sim.step(dt, 0.f); // 10 s — reach terminal speed

    const float v = sim.getLorentzSledVms();
    const float iA = sim.getLorentzCurrentA();
    const float bT = sim.getLorentzFieldT();
    const float fN = sim.getLorentzForceN();
    const float xM = sim.getLorentzPositionM();
    printf("Lorentz sled v=%.3f m/s  I=%.2f A  B=%.2f T  F=%.3f N  x=%.3f m\n",
           v, iA, bT, fN, xM);
    if (!std::isfinite(v) || !std::isfinite(iA) || !std::isfinite(fN) || !std::isfinite(xM)) {
        printf("FAIL: lorentz sled NaN\n");
        return 1;
    }
    if (v <= 0.f || iA <= 0.f || fN <= 0.f) {
        printf("FAIL: sled did not accelerate under drive\n");
        return 1;
    }
    if (xM < 0.f || xM > 2.0f) {
        printf("FAIL: reported position %.3f outside the rail length\n", xM);
        return 1;
    }
    // Back-EMF must actually bite: the loop current has to sit below the
    // stall value V/R once the sled is moving.
    const float stallA = 0.8f * 12.f / 0.6f;
    if (iA >= stallA) {
        printf("FAIL: back-EMF absent (I=%.2f A >= stall %.2f A)\n", iA, stallA);
        return 1;
    }

    // Cross-check the integrator against the closed-form steady state:
    // (V - B*l*v)/R * B*l = mu*m*g + b*v  (tanh ~ 1 at speed).
    {
        const float bl = 0.8f * 0.25f;
        const float vSupply = 0.8f * 12.f;
        const float num = (vSupply * bl) / 0.6f - 0.25f * 0.15f * PhysicsConstants::G;
        const float den = (bl * bl) / 0.6f + 0.3f;
        const float vClosed = num / den;
        printf("Lorentz sled closed-form terminal v=%.3f m/s (sim %.3f)\n", vClosed, v);
        if (std::fabs(v - vClosed) > 0.05f * vClosed) {
            printf("FAIL: terminal speed %.3f differs from closed form %.3f by >5%%\n", v, vClosed);
            return 1;
        }
    }

    // Weaker field -> smaller force -> slower sled at the same drive.
    sim.setLorentzFieldT(0.2f);
    for (int i = 0; i < 600; ++i) sim.step(dt, 0.f);
    const float vWeak = sim.getLorentzSledVms();
    printf("Lorentz sled (B=0.2 T) v=%.3f m/s  F=%.3f N\n", vWeak, sim.getLorentzForceN());
    if (!std::isfinite(vWeak) || vWeak <= 0.f) {
        printf("FAIL: weak-field sled speed invalid\n");
        return 1;
    }
    if (vWeak >= v) {
        printf("FAIL: weaker field should give a slower sled (%.3f vs %.3f)\n", vWeak, v);
        return 1;
    }

    // Field clamp: never above fieldTMax, never negative.
    sim.setLorentzFieldT(99.f);
    if (sim.getLorentzFieldT() > 1.2f) {
        printf("FAIL: field not clamped to fieldTMax\n");
        return 1;
    }
    sim.setLorentzFieldT(-1.f);
    if (sim.getLorentzFieldT() < 0.f) {
        printf("FAIL: field not clamped at zero\n");
        return 1;
    }

    if (!std::isfinite(sim.getEnergyLevel()) || sim.getEnergyLevel() < 0.f || sim.getEnergyLevel() > 1.f) {
        printf("FAIL: Lorentz energy level out of range\n");
        return 1;
    }

    // Long-frame stability: a dropped frame must not blow the sled up. Both
    // stiff terms (R-L branch, back-EMF damping) are solved implicitly, so a
    // 1 s step has to stay finite and bounded.
    SEGSimulator big;
    big.setMode(SIM_MODE_LORENTZ_SLED);
    big.setDrive(1.0f);
    for (int i = 0; i < 20; ++i) big.step(1.0f, 0.f);
    const float vBig = big.getLorentzSledVms();
    const float iBig = big.getLorentzCurrentA();
    printf("Lorentz sled (dt=1 s x20) v=%.3f m/s  I=%.2f A\n", vBig, iBig);
    if (!std::isfinite(vBig) || !std::isfinite(iBig)) {
        printf("FAIL: long-frame integration produced NaN/Inf\n");
        return 1;
    }
    if (vBig < 0.f || vBig > 40.f || iBig < 0.f) {
        printf("FAIL: long-frame integration unstable (v=%.3f, I=%.2f)\n", vBig, iBig);
        return 1;
    }

    printf("Lorentz sled smoke OK (energyLevel=%.3f)\n", sim.getEnergyLevel());
    return 0;
}

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
    // Lab field coupling (ADR-0011). >= 0 pins the destination plant's B to
    // this setpoint, exactly as FieldNetwork does under ?fieldCoupling=1, so
    // the golden covers the coupled path on both plants too. Negative = the
    // device's own local rule (the default, and every pre-existing case).
    float       hallFieldCoupledT;
    float       lorentzFieldT;
};

// Frame counts are chosen so each plant has left its initial transient:
// the thermal stack has opened a gap, the disc and sled have reached
// terminal speed, and the VdG sphere has sparked at least once.
static const GoldenCase GOLDEN_CASES[] = {
    { SIM_MODE_PELTIER,      "peltier",      "peltier",      0.85f, 240, -1.f, -1.f },
    { SIM_MODE_MHD,          "mhd",          "mhd",          0.90f, 120, -1.f, -1.f },
    { SIM_MODE_MAGLEV,       "maglev",       "maglev",       0.60f, 120, -1.f, -1.f },
    { SIM_MODE_HOMOPOLAR,    "homopolar",    "homopolar",    0.90f, 240, -1.f, -1.f },
    { SIM_MODE_TRANSFORMER,  "transformer",  "transformer",  0.90f,  60, -1.f, -1.f },
    // 150, not 120: the spark-rate window closes every 1 s (60 frames) and
    // the two plants cross that boundary a frame apart (float32 vs float64
    // running sum of dt), so a multiple of 60 would compare sparkHz across
    // different windows.
    { SIM_MODE_VDG,          "vdg",          "vdg",          1.00f, 150, -1.f, -1.f },
    { SIM_MODE_HALL,         "hall",         "hall",         0.80f, 120, -1.f, -1.f },
    { SIM_MODE_LORENTZ_SLED, "lorentz-sled", "lorentz-sled", 0.80f, 240, -1.f, -1.f },
    // Field-coupled variants (ADR-0011): same plants, but B pinned to a source
    // device's estimate instead of the local rule. 0.31 T is inside the Hall
    // bench's 0.65 T range and *not* 0.8 x bMaxT, so a plant that ignored the
    // coupled setpoint and kept using drive would not accidentally agree.
    { SIM_MODE_HALL,         "hall-coupled", "hall",         0.80f, 120, 0.31f, -1.f },
    // 0.45 T stands in for a mid-drive MHD channel field; the default bench
    // value is 0.8 T, so the same "would not accidentally agree" argument holds.
    { SIM_MODE_LORENTZ_SLED, "lorentz-sled-coupled", "lorentz-sled", 0.80f, 240, -1.f, 0.45f },
};
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

static int run_golden() {
    const float dt = 1.f / 60.f;
    int bad = 0;

    for (int c = 0; c < GOLDEN_CASE_COUNT; ++c) {
        const GoldenCase& g = GOLDEN_CASES[c];
        SEGSimulator sim;
        sim.setMode(g.mode);
        sim.setDrive(g.drive);
        if (g.hallFieldCoupledT >= 0.f) sim.setHallFieldCoupledT(g.hallFieldCoupledT);
        if (g.lorentzFieldT >= 0.f) sim.setLorentzFieldT(g.lorentzFieldT);
        for (int i = 0; i < g.frames; ++i) sim.step(dt, 0.f);

        std::printf("golden.case %s device=%s drive=%.17g frames=%d dt=%.17g"
                    " hallFieldCoupledT=%.17g lorentzFieldT=%.17g\n",
                    g.id, g.device, static_cast<double>(g.drive), g.frames,
                    static_cast<double>(dt),
                    static_cast<double>(g.hallFieldCoupledT),
                    static_cast<double>(g.lorentzFieldT));

        switch (g.mode) {
            case SIM_MODE_PELTIER:
                bad |= golden_emit(g.id, "peltierHotK",    sim.getPeltierHotK());
                bad |= golden_emit(g.id, "peltierColdK",   sim.getPeltierColdK());
                bad |= golden_emit(g.id, "peltierDeltaT",  sim.getPeltierDeltaT());
                bad |= golden_emit(g.id, "peltierVoltage", sim.getPeltierVoltage());
                bad |= golden_emit(g.id, "peltierCurrent", sim.getPeltierCurrent());
                bad |= golden_emit(g.id, "peltierPowerW",  sim.getPeltierPowerW());
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
            default:
                std::fprintf(stderr, "FAIL: no golden emitter for mode %d\n", g.mode);
                return 1;
        }
    }

    if (bad) return 1;
    std::printf("golden.done cases=%d\n", GOLDEN_CASE_COUNT);
    return 0;
}

static int run_chores_smoke() {
    const float data[] = { 1.f, -2.f, 3.f, 0.f, 4.f };
    float out[5] = {};
    chores_reduce_f32(data, 5, out);
    printf("chores reduce sum=%.1f min=%.1f max=%.1f sumSq=%.1f n=%.0f\n",
           out[0], out[1], out[2], out[3], out[4]);
    if (std::fabs(out[0] - 6.f) > 1e-5f || std::fabs(out[1] + 2.f) > 1e-5f
        || std::fabs(out[2] - 4.f) > 1e-5f || std::fabs(out[3] - 30.f) > 1e-5f
        || std::fabs(out[4] - 5.f) > 1e-5f) {
        printf("FAIL: chores reduce golden mismatch\n");
        return 1;
    }
    float mapped[5] = {};
    chores_map_scale_f32(data, mapped, 5, 0.8f, 0.2f);
    if (std::fabs(mapped[0] - 1.0f) > 1e-5f || std::fabs(mapped[1] + 1.4f) > 1e-5f) {
        printf("FAIL: chores map golden mismatch (got %.3f %.3f)\n", mapped[0], mapped[1]);
        return 1;
    }
    printf("chores reduce/map goldens OK\n");
    return 0;
}

static int run_energy_network_smoke() {
    SEGSimulator sim;
    // Mirror ENERGY_PIPE_EDGES (from, to, maxW, eff, latency)
    const float edges[] = {
        0, 1, 1500.f, 1.f, 0.f,
        1, 2,  800.f, 1.f, 0.f,
        2, 0,  600.f, 1.f, 0.f,
        2, 4,  400.f, 1.f, 0.f,
        4, 3,  500.f, 1.f, 0.f,
        0, 5, 1200.f, 1.f, 0.f,
        5, 4,  700.f, 1.f, 0.f,
        3, 6,  450.f, 1.f, 0.f,
        6, 0,  550.f, 1.f, 0.f,
    };
    sim.setNetworkEdges(std::vector<float>(edges, edges + sizeof(edges) / sizeof(edges[0])));

    const float dt = 1.f / 60.f;
    const int steps = static_cast<int>(1.2f / dt); // ≥1 s
    std::vector<float> energyLevels(ENERGY_NETWORK_MODE_COUNT, 0.f);
    std::vector<int> enabled(ENERGY_NETWORK_MODE_COUNT, 1);

    for (int i = 0; i < steps; ++i) {
        // Advance a few mode plants and feed bus with synthetic levels
        sim.setMode(SIM_MODE_SEG);
        sim.setDrive(0.7f);
        sim.step(dt, 0.01f);
        energyLevels[SIM_MODE_SEG] = sim.getEnergyLevel();

        sim.setMode(SIM_MODE_HERON);
        sim.setDrive(0.8f);
        sim.step(dt, 0.f);
        energyLevels[SIM_MODE_HERON] = sim.getEnergyLevel();

        sim.setMode(SIM_MODE_KELVIN);
        sim.setDrive(0.9f);
        sim.step(dt, 0.f);
        energyLevels[SIM_MODE_KELVIN] = sim.getEnergyLevel();

        const float segPowerW = sim.estimatePower(0.01f);
        sim.updateEnergyNetwork(true, segPowerW, 88.f, energyLevels, enabled);

        const EnergyNetworkSummary sum = sim.getNetworkSummary();
        if (!std::isfinite(sum.labBudgetW) || !std::isfinite(sum.totalAllocatedW)
            || !std::isfinite(sum.residualW)) {
            printf("FAIL: energy bus NaN at step %d\n", i);
            return 1;
        }
        if (sum.labBudgetW < 0.f || sum.totalAllocatedW < 0.f) {
            printf("FAIL: negative bus watts at step %d\n", i);
            return 1;
        }
    }

    const EnergyNetworkSummary finalSum = sim.getNetworkSummary();
    printf("Energy bus: budget=%.1f W  allocated=%.1f W  residual=%.1f W  edges=%d\n",
           finalSum.labBudgetW, finalSum.totalAllocatedW, finalSum.residualW,
           sim.getNetworkEdgeCount());
    if (sim.getNetworkEdgeCount() != 9) {
        printf("FAIL: expected 9 network edges\n");
        return 1;
    }
    if (finalSum.totalAllocatedW <= 0.f) {
        printf("FAIL: no power allocated on coupled bus\n");
        return 1;
    }
    printf("Energy network smoke OK (%.1f s, %d steps)\n", steps * dt, steps);
    return 0;
}

static int run_catalog_smoke() {
    bool seen[SIM_MODE_COUNT]{};
    for (int i = 0; i < DEVICE_CATALOG_COUNT; i++) {
        const DeviceCatalogRow& r = DEVICE_CATALOG[i];
        if (r.wasmMode < 0) {
            printf("%s -> wasmMode none (shaderMode %d)\n", r.id, r.shaderMode);
            continue;
        }
        printf("%s -> wasmMode %d (shaderMode %d)\n", r.id, r.wasmMode, r.shaderMode);
        if (r.wasmMode >= SIM_MODE_COUNT) {
            fprintf(stderr, "FAIL: wasmMode out of range for %s\n", r.id);
            return 1;
        }
        if (seen[r.wasmMode]) {
            fprintf(stderr, "FAIL: duplicate wasmMode %d\n", r.wasmMode);
            return 1;
        }
        seen[r.wasmMode] = true;
    }
    for (int i = 0; i < SIM_MODE_COUNT; i++) {
        if (!seen[i]) {
            fprintf(stderr, "FAIL: wasmMode hole at %d\n", i);
            return 1;
        }
    }
    printf("catalog OK (%d devices, %d wasm plants, reserved", DEVICE_CATALOG_COUNT, SIM_MODE_COUNT);
    for (int i = 0; i < RESERVED_WASM_MODE_COUNT; i++) {
        printf(" %d", RESERVED_WASM_MODES[i]);
    }
    printf(")\n");
    return 0;
}

// --mode bench: report SEG RK4 roller step throughput (steps/s) and
// particle-replay throughput, as a plain "key=value" line CI can grep to
// track regressions from compile-flag changes (SIMD, LTO, etc.) over time.
static int run_bench_smoke() {
    SEGSimulator sim;
    const float dt = 1.f / 60.f;
    const int warmup = 2000;
    const int steps = 100000;
    for (int i = 0; i < warmup; ++i) sim.step(dt, 0.01f);

    auto t0 = std::chrono::steady_clock::now();
    for (int i = 0; i < steps; ++i) sim.step(dt, 0.01f);
    auto t1 = std::chrono::steady_clock::now();
    const double stepSec = std::chrono::duration<double>(t1 - t0).count();
    const double stepsPerSec = steps / stepSec;

    sim.seedParticles(2000);
    const int particleWarmup = 500;
    const int particleSteps = 5000;
    for (int i = 0; i < particleWarmup; ++i) sim.stepParticles(dt);

    auto t2 = std::chrono::steady_clock::now();
    for (int i = 0; i < particleSteps; ++i) sim.stepParticles(dt);
    auto t3 = std::chrono::steady_clock::now();
    const double particleSec = std::chrono::duration<double>(t3 - t2).count();
    const double particleStepsPerSec = particleSteps / particleSec;

    printf("bench_seg_steps_per_sec=%.0f\n", stepsPerSec);
    printf("bench_particle_steps_per_sec=%.0f\n", particleStepsPerSec);
    return 0;
}

int main(int argc, char** argv) {
    // --mode <peltier|mhd|…|catalog|bench|golden>: run one smoke test / report
    for (int i = 1; i < argc; ++i) {
        if (std::strcmp(argv[i], "--mode") == 0 && i + 1 < argc) {
            if (std::strcmp(argv[i + 1], "peltier") == 0) return run_peltier_smoke();
            if (std::strcmp(argv[i + 1], "mhd") == 0)     return run_mhd_smoke();
            if (std::strcmp(argv[i + 1], "maglev") == 0)  return run_maglev_smoke();
            if (std::strcmp(argv[i + 1], "homopolar") == 0) return run_homopolar_smoke();
            if (std::strcmp(argv[i + 1], "transformer") == 0) return run_transformer_smoke();
            if (std::strcmp(argv[i + 1], "vdg") == 0) return run_vdg_smoke();
            if (std::strcmp(argv[i + 1], "hall") == 0) return run_hall_smoke();
            if (std::strcmp(argv[i + 1], "lorentz-sled") == 0) return run_lorentz_smoke();
            if (std::strcmp(argv[i + 1], "chores") == 0) return run_chores_smoke();
            if (std::strcmp(argv[i + 1], "energy-network") == 0) return run_energy_network_smoke();
            if (std::strcmp(argv[i + 1], "catalog") == 0) return run_catalog_smoke();
            if (std::strcmp(argv[i + 1], "bench") == 0) return run_bench_smoke();
            if (std::strcmp(argv[i + 1], "golden") == 0) return run_golden();
            std::fprintf(stderr, "Unknown --mode %s (expected peltier|mhd|maglev|homopolar|transformer|vdg|hall|lorentz-sled|chores|energy-network|catalog|bench|golden)\n", argv[i + 1]);
            return 2;
        }
    }
    // --export-csv <seconds> [output.csv] [sample_hz]
    for (int i = 1; i < argc; ++i) {
        if (std::strcmp(argv[i], "--export-csv") == 0 && i + 1 < argc) {
            const float duration = std::atof(argv[i + 1]);
            const char* out = (i + 2 < argc && argv[i + 2][0] != '-') ? argv[i + 2] : "build/seg_telemetry.csv";
            const float hz = (i + 3 < argc) ? std::atof(argv[i + 3]) : 10.f;
            const int rc = export_seg_csv(out, duration, hz, 0.5f, 0.01f, 0.5f, 100.f);
            if (rc != 0) {
                std::fprintf(stderr, "Failed to write %s\n", out);
                return rc;
            }
            std::printf("Exported %g s SEG telemetry → %s @ %.1f Hz\n", duration, out, hz);
            return 0;
        }
    }

    printf("sim_core version: %s\n", sim_core_version());

    SEGSimulator sim;
    printf("Rollers: %d\n", sim.numRollers());

    // ── SEG path ──
    sim.setMode(SIM_MODE_SEG);
    sim.seedParticles(1000);
    float dt = 1.f / 60.f;
    for (int i = 0; i < 100; ++i) {
        sim.step(dt, 0.01f);
        sim.stepParticles(dt);
    }
    printf("SEG Omega after 100 steps: %.4f rad/s (%.1f RPM)\n",
           sim.getOmega(), sim.getRPM());
    printf("Magnetic energy density: %.4e J/m^3\n", sim.magneticEnergyDensity());
    printf("Estimated power (load 0.01 Nm): %.4f W\n", sim.estimatePower(0.01f));

    // ── Heron path ──
    sim.setMode(SIM_MODE_HERON);
    sim.setDrive(0.8f);
    for (int i = 0; i < 200; ++i) sim.step(dt, 0.f);
    printf("Heron head=%.3f m  vExit=%.3f m/s  Q=%.2f L/min  P=%.2f kPa\n",
           sim.getHeronHead(), sim.getHeronVExit(),
           sim.getHeronFlowLmin(), sim.getHeronPressureKPa());
    if (sim.getHeronHead() <= 0.f && sim.getHeronVExit() <= 0.f) {
        printf("FAIL: Heron state did not advance\n");
        return 1;
    }

    // ── Kelvin path ──
    sim.setMode(SIM_MODE_KELVIN);
    sim.setDrive(1.f);
    for (int i = 0; i < 400; ++i) sim.step(dt, 0.f);
    printf("Kelvin V=%.1f V  Vn=%.3f  E=%.2f  sparkT=%.3f\n",
           sim.getKelvinVoltage(), sim.getKelvinVoltageN(),
           sim.getKelvinE(), sim.getKelvinSparkTimer());
    if (sim.getKelvinVoltage() <= 0.f && sim.getKelvinVoltageN() <= 0.f) {
        printf("FAIL: Kelvin state did not advance\n");
        return 1;
    }

    // ── Solar path ──
    sim.setMode(SIM_MODE_SOLAR);
    sim.setDrive(1.f);
    float bat0 = sim.getSolarBattery();
    for (int i = 0; i < 300; ++i) sim.step(dt, 0.f);
    printf("Solar battery SOC: %.3f -> %.3f\n", bat0, sim.getSolarBattery());
    if (sim.getEnergyLevel() < 0.f || sim.getEnergyLevel() > 1.f) {
        printf("FAIL: Solar energy level out of range\n");
        return 1;
    }

    // ── Peltier + MHD + Quanta plugin paths ──
    if (run_peltier_smoke() != 0) return 1;
    if (run_mhd_smoke() != 0) return 1;
    if (run_maglev_smoke() != 0) return 1;
    if (run_homopolar_smoke() != 0) return 1;
    if (run_transformer_smoke() != 0) return 1;
    if (run_vdg_smoke() != 0) return 1;
    if (run_hall_smoke() != 0) return 1;
    if (run_lorentz_smoke() != 0) return 1;
    if (run_chores_smoke() != 0) return 1;
    if (run_energy_network_smoke() != 0) return 1;

    // Zero-copy packing smoke
    sim.setMode(SIM_MODE_SEG);
    sim.packRollerState();
    printf("Zero-copy: particlePtr=%zu floats=%d  rollerPtr=%zu floats=%d\n",
           (size_t)sim.getParticleBufferPtr(), sim.getParticleFloatCount(),
           (size_t)sim.getRollerStatePtr(), sim.getRollerStateFloatCount());
    if (sim.getRollerStateFloatCount() != 66 * 4) {
        printf("FAIL: unexpected roller export size\n");
        return 1;
    }
    if (sim.getParticleFloatCount() != 1000 * 8) {
        printf("FAIL: unexpected particle export size (got %d, expected %d)\n",
               sim.getParticleFloatCount(), 1000 * 8);
        return 1;
    }

    printf("All mode smoke tests OK\n");
    return 0;
}

#endif // SIM_CORE_STANDALONE
