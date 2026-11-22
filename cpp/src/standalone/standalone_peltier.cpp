// =============================================================
// standalone_peltier.cpp  –  --mode peltier-textbook
//
// The thermoelectric cooler against the textbook lumped results
// (Q_c = S·I·T_c − ½I²R − K·ΔT, Z = S²/RK). Prints every steady point so
// scripts/tests/peltier.test.mjs can apply the same four checks to this
// binary, the shipped WASM and the TS plant; asserts them here too, so
// `make native` alone catches a broken plant.
//
//   peltier.params  S=… R=… K=… Z=… iMax=… ambient=…
//   peltier.zero    drive=… I=… Tc=… Th=… dT=… V=… P=… Qc=… Qh=… cop=…   zero load
//   peltier.load    (same keys)                                           10 W load
//   peltier.reverse (same keys)                                           polarity −1
//   peltier.leg     I=… Tc=… Th=… cop=…        leg alone, plates held: COP(I) at fixed ΔT
//   peltier.thomson slope=… Qc=… Qh=… P=… resid=…
// =============================================================

#ifdef SIM_CORE_STANDALONE

#include "sim_core.h"
#include "standalone/standalone_modes.h"

#include <cmath>
#include <cstdio>
#include <vector>

namespace {

using PC = power_gen::PeltierConstants;

struct Steady { float drive, I, Tc, Th, dT, V, P, Qc, Qh, cop; };

/// Run the bench to steady state: 600 s, far past its ~20 s time constants.
Steady settle(float drive, float loadW, float polarity) {
    SEGSimulator sim;
    sim.setMode(SIM_MODE_PELTIER);
    sim.setDrive(drive);
    sim.setPeltierLoadW(loadW);
    sim.setPeltierPolarity(polarity);
    for (int i = 0; i < 2400; ++i) sim.step(0.25f, 0.f);
    return { drive, sim.getPeltierCurrent(), sim.getPeltierColdK(), sim.getPeltierHotK(), sim.getPeltierDeltaT(),
             sim.getPeltierVoltage(), sim.getPeltierPowerW(), sim.getPeltierQcW(), sim.getPeltierQhW(), sim.getPeltierCOP() };
}

void print(const char* tag, const Steady& s) {
    std::printf("%s drive=%.9g I=%.9g Tc=%.9g Th=%.9g dT=%.9g V=%.9g P=%.9g Qc=%.9g Qh=%.9g cop=%.9g\n", tag,
                static_cast<double>(s.drive), static_cast<double>(s.I), static_cast<double>(s.Tc),
                static_cast<double>(s.Th), static_cast<double>(s.dT), static_cast<double>(s.V),
                static_cast<double>(s.P), static_cast<double>(s.Qc), static_cast<double>(s.Qh),
                static_cast<double>(s.cop));
}

/// Integrate a bare state to steady state with the plant's own integrator.
void relax(PeltierState& st, const PeltierInput& u, double seconds, float* y) {
    PeltierPlant plant(st);
    float x[PeltierPlant::state_size];
    plant.save(x);
    sim_core::StepperState stepper{};
    const auto stats = sim_core::ros23_advance(plant, std::span<float>(x), u, seconds,
                                               power_gen::ode::Peltier::tolerance(), stepper);
    (void)stats;
    plant.load(x);
    plant.outputs(x, u, std::span<float>(y, PeltierPlant::output_size));
}

} // namespace

int run_peltier_textbook() {
    using PO = power_gen::ode::Peltier;
    const float S = PC::SEEBECK_VK * PC::COUPLES;
    const float R = PC::R_INTERNAL_OHM;
    const float K = PC::CONDUCTANCE_WK;
    const float Z = S * S / (R * K);
    std::printf("peltier.params S=%.9g R=%.9g K=%.9g Z=%.9g iMax=%.9g ambient=%.9g\n",
                static_cast<double>(S), static_cast<double>(R), static_cast<double>(K), static_cast<double>(Z),
                static_cast<double>(PC::I_MAX_A), static_cast<double>(PC::AMBIENT_K));
    int bad = 0;

    // 1 + 2. Zero load: every point sits on K·ΔT = S·I·T_c − ½I²R, whose peak
    // over I/T_c is ΔT/T_c² = Z/2 at I/T_c = S/R.
    float bestRatio = 0.f, bestX = 0.f;
    for (int i = 1; i <= 10; ++i) {
        const Steady s = settle(0.1f * static_cast<float>(i), 0.f, 1.f);
        print("peltier.zero", s);
        const float lumped = (S * s.I * s.Tc - 0.5f * s.I * s.I * R) / K;
        if (std::fabs(s.dT - lumped) > 0.01f * std::fabs(lumped) + 0.05f) {
            std::printf("FAIL: zero-load dT %.4f K is not the lumped %.4f K at I=%.3f A\n",
                        static_cast<double>(s.dT), static_cast<double>(lumped), static_cast<double>(s.I));
            ++bad;
        }
        if (std::fabs(s.Qh - s.Qc - s.P) > 1e-3f * std::fabs(s.Qh) + 1e-3f) {
            std::printf("FAIL: energy balance Qh %.5f != Qc %.5f + P %.5f\n",
                        static_cast<double>(s.Qh), static_cast<double>(s.Qc), static_cast<double>(s.P));
            ++bad;
        }
        const float ratio = s.dT / (s.Tc * s.Tc);
        if (ratio > bestRatio) { bestRatio = ratio; bestX = s.I / s.Tc; }
    }
    if (std::fabs(bestRatio - 0.5f * Z) > 0.03f * 0.5f * Z) {
        std::printf("FAIL: best dT/Tc^2 %.6g is not Z/2 = %.6g within 3 %%\n",
                    static_cast<double>(bestRatio), static_cast<double>(0.5f * Z));
        ++bad;
    }
    // The sweep is 0.8 A apart: the best grid point is within one step of S·T_c/R.
    if (std::fabs(bestX - S / R) > 0.2f * S / R) {
        std::printf("FAIL: best I/Tc %.5g is not near S/R = %.5g\n", static_cast<double>(bestX), static_cast<double>(S / R));
        ++bad;
    }

    // 3. A 10 W load: the reported COP is the lumped (S·I·T_c − ½I²R − K·ΔT) / (I·(S·ΔT + I·R)).
    for (int i = 1; i <= 10; ++i) {
        const Steady s = settle(0.1f * static_cast<float>(i), 10.f, 1.f);
        print("peltier.load", s);
        const float lumped = (S * s.I * s.Tc - 0.5f * s.I * s.I * R - K * s.dT) / (s.I * (S * s.dT + s.I * R));
        if (std::fabs(s.cop - lumped) > 0.01f * std::fabs(lumped) + 1e-3f) {
            std::printf("FAIL: COP %.5f is not the lumped %.5f at I=%.3f A\n",
                        static_cast<double>(s.cop), static_cast<double>(lumped), static_cast<double>(s.I));
            ++bad;
        }
        if (std::fabs(s.Qc - 10.f) > 0.01f) {
            std::printf("FAIL: steady Qc %.5f W is not the 10 W load\n", static_cast<double>(s.Qc));
            ++bad;
        }
        if (std::fabs(s.Qh - s.Qc - s.P) > 1e-3f * std::fabs(s.Qh) + 1e-3f) {
            std::printf("FAIL: energy balance Qh %.5f != Qc %.5f + P %.5f\n",
                        static_cast<double>(s.Qh), static_cast<double>(s.Qc), static_cast<double>(s.P));
            ++bad;
        }
    }

    // Reversed current: the load-side plate becomes the hot one.
    {
        const Steady s = settle(0.25f, 0.f, -1.f);
        print("peltier.reverse", s);
        if (!(s.I < 0.f && s.Tc > s.Th && s.Tc > PC::AMBIENT_K + 5.f)) {
            std::printf("FAIL: reversed current did not heat the load side\n");
            ++bad;
        }
    }

    // COP against current at a fixed ΔT: the leg alone, plates held at 270 K
    // and 300 K by an enormous heat capacity. Peak at I_φ = S·ΔT / (R·(√(1+Z·T_m) − 1)).
    {
        const float Tc = 270.f, Th = 300.f;
        float bestCop = -1e9f, bestI = 0.f;
        for (int i = 2; i <= 32; ++i) {
            PeltierState st;
            st.plateHeatCapJK = st.coldBlockHeatCapJK = st.sinkHeatCapJK = 1e12f;
            for (int n = 0; n < PeltierState::NODES; ++n) {
                const float f = static_cast<float>(n - PeltierState::FIRST_CELL) + 0.5f;
                st.nodesK[n] = n <= PeltierState::COLD_PLATE ? Tc
                             : n >= PeltierState::HOT_PLATE ? Th
                             : Tc + (Th - Tc) * f / static_cast<float>(PeltierState::LEG_CELLS);
            }
            const float I = 0.25f * static_cast<float>(i);
            float y[PeltierPlant::output_size];
            relax(st, PeltierInput{I, 0.f}, 8.0, y);
            std::printf("peltier.leg I=%.9g Tc=%.9g Th=%.9g cop=%.9g\n", static_cast<double>(I),
                        static_cast<double>(Tc), static_cast<double>(Th), static_cast<double>(y[PO::cop]));
            if (y[PO::cop] > bestCop) { bestCop = y[PO::cop]; bestI = I; }
        }
        const float m = std::sqrt(1.f + Z * 0.5f * (Tc + Th));
        const float iPhi = S * (Th - Tc) / (R * (m - 1.f));
        const float copMax = Tc / (Th - Tc) * (m - Th / Tc) / (m + 1.f);
        if (std::fabs(bestI - iPhi) > 0.25f || std::fabs(bestCop - copMax) > 0.02f * copMax) {
            std::printf("FAIL: leg COP peaks at %.3f A / %.4f, textbook %.3f A / %.4f\n", static_cast<double>(bestI),
                        static_cast<double>(bestCop), static_cast<double>(iPhi), static_cast<double>(copMax));
            ++bad;
        }
    }

    // Thomson term on: S varies with T, the EMF is ∫S dT, and energy still closes.
    {
        PeltierState st;
        st.seebeckSlope = 1.5e-6f;
        const PeltierInput u{4.f, 5.f};
        float y[PeltierPlant::output_size];
        relax(st, u, 600.0, y);
        const float resid = y[PO::qhW] - y[PO::qcW] - y[PO::powerW];
        std::printf("peltier.thomson slope=%.9g Qc=%.9g Qh=%.9g P=%.9g resid=%.9g\n",
                    static_cast<double>(st.seebeckSlope), static_cast<double>(y[PO::qcW]),
                    static_cast<double>(y[PO::qhW]), static_cast<double>(y[PO::powerW]), static_cast<double>(resid));
        if (std::fabs(resid) > 1e-3f * std::fabs(y[PO::qhW]) || std::fabs(y[PO::qcW] - 5.f) > 0.01f) {
            std::printf("FAIL: energy does not close with the Thomson term on\n");
            ++bad;
        }
    }

    if (bad) return 1;
    std::printf("peltier.textbook OK\n");
    return 0;
}

#endif // SIM_CORE_STANDALONE
