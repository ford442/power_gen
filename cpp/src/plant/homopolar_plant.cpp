// =============================================================
// homopolar_plant.cpp  –  Faraday-disc homopolar generator L–R + back-EMF
//
//   L dI/dt = ½·B·ω·r² − R·I                 (disc EMF into the coil)
//   J dω/dt = τ_drive(ω) − ½·I·B·r − b·ω     (motor torque − Lorentz load)
//
// A sim_core::Plant (core/plant.h) stepped by the catalog's integrator —
// "euler", one explicit step per frame, which is what the TS twin
// (devices/quanta/homopolar-generator.ts) has always done. ω and I are
// clamped at zero after each step, as both plants always did.
// =============================================================

#include "../sim_core.h"
#include "plant_common.h"

#include <algorithm>
#include <cmath>

using HP = power_gen::ode::Homopolar;

void HomopolarPlant::outputs(std::span<const float> x, const HomopolarInput&, std::span<float> y) const {
    y[HP::emfV] = 0.5f * s.fieldT * x[HP::omega] * s.discRadiusM * s.discRadiusM;
}

void HomopolarPlant::save(std::span<float> x) const {
    x[HP::omega] = s.omega;
    x[HP::currentA] = s.currentA;
}

void HomopolarPlant::load(std::span<const float> x) {
    s.omega = x[HP::omega];
    s.currentA = x[HP::currentA];
}

bool HomopolarPlant::constrain(std::span<float> x) const {
    bool changed = false;
    for (std::size_t i : { std::size_t{HP::omega}, std::size_t{HP::currentA} }) {
        const float c = std::max(0.f, x[i]);
        changed = changed || c != x[i];
        x[i] = c;
    }
    return changed;
}

void SEGSimulator::_stepHomopolar(float dt) {
    HomopolarState& h = _homopolar;
    HomopolarPlant plant(h);
    const HomopolarInput u{h.drive};
    float x[HP::STATE_SIZE];
    plant.save(x);
    // The reported EMF is the one this step integrated from (start of step).
    float y[HP::OUTPUT_SIZE];
    plant.outputs(x, u, y);

    const sim_core::Integrator method = _odeMethod(HP::INTEGRATOR);
    switch (method) {
        case sim_core::Integrator::Euler:
            _odeStats += sim_core::euler_fixed(plant, 0.0, dt, std::span<float>(x), u);
            break;
        case sim_core::Integrator::Rk4:
            _odeStats += sim_core::rk4_fixed(plant, 0.0, dt, std::span<float>(x), u);
            break;
        default: {
            sim_core::StepperState st{h.stepH, h.stepErrOld};
            _odeStats += sim_core::advance_adaptive(method, plant, std::span<float>(x), u,
                                                    static_cast<double>(dt), HP::tolerance(), st);
            h.stepH = st.h;
            h.stepErrOld = st.errOld;
            break;
        }
    }
    plant.load(x);
    h.angle += h.omega * dt;
    h.rpm = h.omega * 30.f / PhysicsConstants::PI;
    h.emfV = y[HP::emfV];
}
