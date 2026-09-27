// =============================================================
// standalone_plant_smokes.cpp  –  per-plant native smokes (--mode peltier … jumping-ring)
// =============================================================

#ifdef SIM_CORE_STANDALONE

#include "sim_core.h"
#include "standalone/standalone_modes.h"

#include <cstdio>

int run_peltier_smoke() {
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

int run_mhd_smoke() {
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

int run_maglev_smoke() {
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

int run_homopolar_smoke() {
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

int run_transformer_smoke() {
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

int run_vdg_smoke() {
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

int run_hall_smoke() {
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

int run_lorentz_smoke() {
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

int run_jumping_ring_smoke() {
    SEGSimulator sim;
    sim.setMode(SIM_MODE_JUMPING_RING);
    sim.setDrive(0.9f);
    const float dt = 1.f / 60.f;
    for (int i = 0; i < 600; ++i) sim.step(dt, 0.f); // 10 s — settle at hover

    const float h = sim.getRingHeightM();
    const float ir = sim.getRingCurrentA();
    const float ip = sim.getRingPrimaryIA();
    const float f = sim.getRingForceN();
    const float k = sim.getRingCouplingK();
    printf("Jumping ring h=%.4f m  I_ring=%.1f A  I_p=%.2f A  F=%.3f N  k=%.3f\n",
           h, ir, ip, f, k);
    if (!std::isfinite(h) || !std::isfinite(ir) || !std::isfinite(ip)
        || !std::isfinite(f) || !std::isfinite(k)) {
        printf("FAIL: jumping ring NaN\n");
        return 1;
    }
    // The whole point of the bench: at a real drive the ring leaves the core.
    if (h <= 0.005f) {
        printf("FAIL: ring did not jump under drive (h=%.4f m)\n", h);
        return 1;
    }
    if (h > power_gen::JumpingRingConstants::POLE_HEIGHT_M) {
        printf("FAIL: ring above the pole stop (h=%.4f m)\n", h);
        return 1;
    }
    // k(h) must have fallen from k0 — that decay is why the ring hovers
    // instead of accelerating away.
    if (!(k < power_gen::JumpingRingConstants::COUPLING_K0)) {
        printf("FAIL: coupling did not fall with height (k=%.4f)\n", k);
        return 1;
    }
    if (std::abs(ir) < 1.f) {
        printf("FAIL: no ring current induced (%.3f A)\n", ir);
        return 1;
    }

    // Lenz, asserted rather than assumed. Both currents alternate, so a single
    // sample proves nothing; average their product over one mains period. The
    // ring current opposes the primary, so <Ip*Ir> is negative, and the force
    // (that product times a negative dM/dh) therefore points *up* on average.
    // Average the force over the same window for the same reason.
    const float subDt = 1.f / (power_gen::TransformerConstants::F_HZ * 10.f);
    double productSum = 0.0;
    double forceSum = 0.0;
    for (int i = 0; i < 10; ++i) {
        sim.step(subDt, 0.f);
        productSum += static_cast<double>(sim.getRingPrimaryIA())
                    * static_cast<double>(sim.getRingCurrentA());
        forceSum += static_cast<double>(sim.getRingForceN());
    }
    printf("Jumping ring cycle mean Ip*Ir=%.2f A^2  mean F=%.4f N (weight %.4f N)\n",
           productSum / 10.0, forceSum / 10.0,
           static_cast<double>(power_gen::JumpingRingConstants::RING_MASS_KG
                               * PhysicsConstants::G));
    if (!(productSum < 0.0)) {
        printf("FAIL: ring current does not oppose the primary (mean Ip*Ir=%.3f)\n",
               productSum / 10.0);
        return 1;
    }
    if (!(forceSum > 0.0)) {
        printf("FAIL: mean magnetic force on the ring is not upward (%.4f N)\n",
               forceSum / 10.0);
        return 1;
    }

    // Weak drive: below the lift threshold the ring must stay on the core
    // shoulder rather than sinking through it or jittering off.
    SEGSimulator weak;
    weak.setMode(SIM_MODE_JUMPING_RING);
    weak.setDrive(0.0f);
    for (int i = 0; i < 120; ++i) weak.step(dt, 0.f);
    const float hWeak = weak.getRingHeightM();
    printf("Jumping ring (drive=0) h=%.4f m\n", hWeak);
    if (hWeak != 0.f) {
        printf("FAIL: undriven ring left the core shoulder (h=%.6f m)\n", hWeak);
        return 1;
    }

    if (!std::isfinite(sim.getEnergyLevel()) || sim.getEnergyLevel() < 0.f
        || sim.getEnergyLevel() > 1.f) {
        printf("FAIL: jumping ring energy level out of range\n");
        return 1;
    }

    // Long-frame stability: a dropped frame is clamped and substepped, so a
    // 1 s step must stay finite and inside the pole.
    SEGSimulator big;
    big.setMode(SIM_MODE_JUMPING_RING);
    big.setDrive(1.0f);
    for (int i = 0; i < 20; ++i) big.step(1.0f, 0.f);
    const float hBig = big.getRingHeightM();
    const float irBig = big.getRingCurrentA();
    printf("Jumping ring (dt=1 s x20) h=%.4f m  I_ring=%.1f A\n", hBig, irBig);
    if (!std::isfinite(hBig) || !std::isfinite(irBig)) {
        printf("FAIL: long-frame integration produced NaN/Inf\n");
        return 1;
    }
    if (hBig < 0.f || hBig > power_gen::JumpingRingConstants::POLE_HEIGHT_M) {
        printf("FAIL: long-frame integration unstable (h=%.4f)\n", hBig);
        return 1;
    }

    printf("Jumping ring smoke OK (energyLevel=%.3f)\n", sim.getEnergyLevel());
    return 0;
}

#endif // SIM_CORE_STANDALONE
