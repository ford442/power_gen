#pragma once
// Thermoelectric module run as a cooler, with a resolved leg.
//
// One equivalent 1-D leg carries the whole module (S = seebeck·couples V/K,
// R, K), cut into LEG_CELLS finite volumes; four lumped nodes close the ends:
//
//   [0] cold block ─ [1] cold plate ─ [2 … 2+N-1] leg cells ─ [N+2] hot plate ─ [N+3] heat sink ─ ambient
//        ↑ load W        ↑ Peltier −S·I·T                          ↑ Peltier +S·I·T          ↑ sinkWK
//
// Per cell: Fourier conduction to its neighbours, Joule heat I²R/N and, when
// the Seebeck coefficient is given a slope, the Thomson heat. Peltier heat is
// absorbed at the cold junction and released at the hot one. The discrete
// system conserves energy exactly: at steady state Q_h = Q_c + I·V.
//
// Linear in T for a fixed current and stiff (cell time constants are
// milliseconds against tens of seconds for the sink), so it runs on ros23
// (core/integrate.h). TS twin: src/devices/core/peltier-plant.ts. Classroom
// numbers: physics/constants.json → generated/constants.h.

#include "../../../generated/constants.h"
#include "../../../generated/plant-ode.h"

#include <cstddef>
#include <span>

struct PeltierState {
    static constexpr int LEG_CELLS = power_gen::PeltierConstants::LEG_CELLS;
    static constexpr int NODES = LEG_CELLS + 4;
    static constexpr int COLD_BLOCK = 0;
    static constexpr int COLD_PLATE = 1;
    static constexpr int FIRST_CELL = 2;
    static constexpr int HOT_PLATE = LEG_CELLS + 2;
    static constexpr int SINK = LEG_CELLS + 3;

    // Temperatures, K, cold end → hot end. Everything starts at ambient.
    float nodesK[NODES];
    float ambientK{power_gen::PeltierConstants::AMBIENT_K};
    float seebeck{power_gen::PeltierConstants::SEEBECK_VK};            // V/K per couple at seebeckRefK
    float seebeckSlope{power_gen::PeltierConstants::SEEBECK_SLOPE_VK2}; // d(seebeck)/dT per couple; 0 = no Thomson heat
    float seebeckRefK{power_gen::PeltierConstants::SEEBECK_REF_K};
    float couples{power_gen::PeltierConstants::COUPLES};
    float rInternalOhm{power_gen::PeltierConstants::R_INTERNAL_OHM};   // module, Ω
    float conductanceWK{power_gen::PeltierConstants::CONDUCTANCE_WK};  // module legs, W/K
    float legHeatCapJK{power_gen::PeltierConstants::LEG_HEAT_CAP_JK};
    float plateHeatCapJK{power_gen::PeltierConstants::PLATE_HEAT_CAP_JK};
    float coldBlockHeatCapJK{power_gen::PeltierConstants::COLD_BLOCK_HEAT_CAP_JK};
    float sinkHeatCapJK{power_gen::PeltierConstants::SINK_HEAT_CAP_JK};
    float blockContactWK{power_gen::PeltierConstants::BLOCK_CONTACT_WK};
    float sinkContactWK{power_gen::PeltierConstants::SINK_CONTACT_WK};
    float sinkWK{power_gen::PeltierConstants::SINK_WK};                // heat sink → ambient, W/K
    float coldLeakWK{power_gen::PeltierConstants::COLD_LEAK_WK};       // cold block → ambient, W/K
    float iMaxA{power_gen::PeltierConstants::I_MAX_A};                 // drive = 1 current
    float deltaTRefK{power_gen::PeltierConstants::DELTA_T_REF_K};
    // Setpoints
    float loadW{0.f};          // heat fed into the cold block, W
    float polarity{1.f};       // ≥ 0: cool the block; < 0: reversed current
    // Derived (outputs of the last step)
    float hotK{power_gen::PeltierConstants::AMBIENT_K};   // hot plate (sink side)
    float coldK{power_gen::PeltierConstants::AMBIENT_K};  // cold plate (load side)
    float deltaTK{0.f};        // hotK − coldK
    float currentA{0.f};       // signed
    float voltageV{0.f};       // terminal voltage, Seebeck + I·R
    float powerW{0.f};         // electrical input, I·V
    float cop{0.f};            // qcW / powerW
    float qcW{0.f};            // heat pumped out of the cold plate, W
    float qhW{0.f};            // heat delivered to the hot plate, W
    float drive{0.f};          // 0..1 current magnitude
    // Adaptive-integrator carry-over (core/integrate.h StepperState).
    float stepH{0.f};
    float stepErrOld{1e-4f};

    PeltierState() {
        for (float& t : nodesK) t = power_gen::PeltierConstants::AMBIENT_K;
    }
};

struct PeltierInput {
    float currentA{0.f}; // signed; held over one advance
    float loadW{0.f};
};

/// sim_core::Plant view over a PeltierState. x = nodesK.
struct PeltierPlant {
    using ode = power_gen::ode::Peltier;
    using input_type = PeltierInput;
    static constexpr std::size_t state_size = ode::STATE_SIZE;
    static constexpr std::size_t output_size = ode::OUTPUT_SIZE;
    static_assert(ode::STATE_SIZE == PeltierState::NODES, "physics/devices.json peltier ode.state must cover nodesK");

    explicit PeltierPlant(PeltierState& st) : s(st) {}

    /// The right-hand side on any scalar (float, or a core/dual.h Dual for
    /// ∂f/∂x). The float instantiation is the plant's arithmetic, term for term.
    template <class S>
    void derivs_t(double, std::span<const S> x, const PeltierInput& u, std::span<S> dxdt) const {
        constexpr int N = PeltierState::LEG_CELLS;
        constexpr int CB = PeltierState::COLD_BLOCK, CP = PeltierState::COLD_PLATE;
        constexpr int C0 = PeltierState::FIRST_CELL, HP = PeltierState::HOT_PLATE, SK = PeltierState::SINK;
        const float I = u.currentA;
        const float a0 = s.seebeck * s.couples;       // module Seebeck at seebeckRefK
        const float a1 = s.seebeckSlope * s.couples;  // its slope: S(T) = a0 + a1·(T − Tref)
        const float G = s.conductanceWK * static_cast<float>(N); // cell centre ↔ cell centre
        const float Gf = 2.f * G;                                // plate ↔ first / last cell centre
        const float qJoule = I * I * s.rInternalOhm / static_cast<float>(N);
        const float cCell = s.legHeatCapJK / static_cast<float>(N);
        const S Tcb = x[CB], Tcp = x[CP], Thp = x[HP], Tsk = x[SK];

        // Peltier heat: absorbed from the cold plate, released into the hot one.
        const S qPeltierC = (a0 + a1 * (Tcp - s.seebeckRefK)) * I * Tcp;
        const S qPeltierH = (a0 + a1 * (Thp - s.seebeckRefK)) * I * Thp;

        dxdt[CB] = (s.blockContactWK * (Tcp - Tcb) + s.coldLeakWK * (s.ambientK - Tcb) + u.loadW)
                 / s.coldBlockHeatCapJK;
        dxdt[CP] = (s.blockContactWK * (Tcb - Tcp) + Gf * (x[C0] - Tcp) - qPeltierC) / s.plateHeatCapJK;
        for (int i = 0; i < N; ++i) {
            const int k = C0 + i;
            const S T = x[k];
            // Face temperatures: the plates at the ends, the mean of two cells inside.
            const S faceC = (i == 0) ? Tcp : 0.5f * (x[k - 1] + T);
            const S faceH = (i == N - 1) ? Thp : 0.5f * (T + x[k + 1]);
            const S fromC = (i == 0) ? Gf * (Tcp - T) : G * (x[k - 1] - T);
            const S fromH = (i == N - 1) ? Gf * (Thp - T) : G * (x[k + 1] - T);
            // Thomson heat −I·∫T·dS over the cell = −a1·I·(T_h² − T_c²)/2 between its faces.
            const S qThomson = (-0.5f * a1 * I) * (faceH * faceH - faceC * faceC);
            dxdt[k] = (fromC + fromH + qJoule + qThomson) / cCell;
        }
        dxdt[HP] = (Gf * (x[HP - 1] - Thp) + s.sinkContactWK * (Tsk - Thp) + qPeltierH) / s.plateHeatCapJK;
        dxdt[SK] = (s.sinkContactWK * (Thp - Tsk) - s.sinkWK * (Tsk - s.ambientK)) / s.sinkHeatCapJK;
    }
    void derivs(double t, std::span<const float> x, const PeltierInput& u, std::span<float> dxdt) const {
        derivs_t<float>(t, x, u, dxdt);
    }
    /// ∂f/∂x written out: tridiagonal, the derivative of derivs_t term by
    /// term (sim_core::AnalyticJacobianPlant). Same expressions as
    /// `peltierJacobian` in src/devices/core/peltier-plant.ts.
    void jacobian(double, std::span<const float> x, const PeltierInput& u, std::span<float> J) const {
        constexpr int N = PeltierState::LEG_CELLS;
        constexpr int n = PeltierState::NODES;
        constexpr int CB = PeltierState::COLD_BLOCK, CP = PeltierState::COLD_PLATE;
        constexpr int C0 = PeltierState::FIRST_CELL, HP = PeltierState::HOT_PLATE, SK = PeltierState::SINK;
        const float I = u.currentA;
        const float a0 = s.seebeck * s.couples;
        const float a1 = s.seebeckSlope * s.couples;
        const float G = s.conductanceWK * static_cast<float>(N);
        const float Gf = 2.f * G;
        const float cCell = s.legHeatCapJK / static_cast<float>(N);
        for (int i = 0; i < n * n; ++i) J[i] = 0.f;
        // d/dT of (a0 + a1·(T − Tref))·I·T
        const auto dPeltier = [&](float T) { return I * (a0 + a1 * (2.f * T - s.seebeckRefK)); };

        J[CB * n + CB] = -(s.blockContactWK + s.coldLeakWK) / s.coldBlockHeatCapJK;
        J[CB * n + CP] = s.blockContactWK / s.coldBlockHeatCapJK;
        J[CP * n + CB] = s.blockContactWK / s.plateHeatCapJK;
        J[CP * n + CP] = (-s.blockContactWK - Gf - dPeltier(x[CP])) / s.plateHeatCapJK;
        J[CP * n + C0] = Gf / s.plateHeatCapJK;
        // Thomson heat −½·a1·I·(faceH² − faceC²): each face is a plate or a two-cell mean.
        const float th = -a1 * I;
        for (int i = 0; i < N; ++i) {
            const int k = C0 + i;
            const bool first = i == 0, last = i == N - 1;
            const float faceC = first ? x[CP] : 0.5f * (x[k - 1] + x[k]);
            const float faceH = last ? x[HP] : 0.5f * (x[k] + x[k + 1]);
            const float gC = first ? Gf : G;
            const float gH = last ? Gf : G;
            J[k * n + k - 1] = (gC - th * faceC * (first ? 1.f : 0.5f)) / cCell;
            J[k * n + k] = (-gC - gH + th * (faceH * (last ? 0.f : 0.5f) - faceC * (first ? 0.f : 0.5f))) / cCell;
            J[k * n + k + 1] = (gH + th * faceH * (last ? 1.f : 0.5f)) / cCell;
        }
        J[HP * n + HP - 1] = Gf / s.plateHeatCapJK;
        J[HP * n + HP] = (-Gf - s.sinkContactWK + dPeltier(x[HP])) / s.plateHeatCapJK;
        J[HP * n + SK] = s.sinkContactWK / s.plateHeatCapJK;
        J[SK * n + HP] = s.sinkContactWK / s.sinkHeatCapJK;
        J[SK * n + SK] = -(s.sinkContactWK + s.sinkWK) / s.sinkHeatCapJK;
    }
    /// y = [hotK, coldK, deltaTK, voltageV, powerW, cop, qcW, qhW] at x.
    void outputs(std::span<const float> x, const PeltierInput& u, std::span<float> y) const;
    void save(std::span<float> x) const;
    void load(std::span<const float> x);
    /// Every node stays within [ambient − clampBelow, ambient + clampAbove]:
    /// a reversed current into the insulated block has no other limit.
    bool constrain(std::span<float> x) const;

    PeltierState& s;
};
