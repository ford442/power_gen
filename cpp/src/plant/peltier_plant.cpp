// =============================================================
// peltier_plant.cpp  –  thermoelectric cooler: 1-D resolved leg on the
// shared integrators (peltier_plant.h) + the bench's air parcels
// =============================================================

#include "../sim_core.h"
#include "plant_common.h"

#include <cmath>

using namespace plant_common;

void peltier_particle_step(SimParticle& p, float sinkN, float blockN, float dt, float /*simTime*/) {
    // Air beside the two end bodies: parcels with z ≥ 0 belong to the cold
    // block (above), the rest to the heat sink (below). A parcel drifts up
    // beside a body warmer than the room and down beside a colder one, at a
    // plume-like √|ΔT| rate, and re-enters at the other end of its 2.6-unit
    // run. sinkN / blockN are (T − T_ambient) / deltaTRefK, signed. The same
    // rule as posPeltier (particle-compute.wgsl) — illustrative, and the air
    // does not feed back into the plant.
    constexpr float BODY_Y = 2.5f, SPAN = 2.6f, HZ_AT_REF = 0.35f;
    const bool onBlock = p.z >= 0.f;
    const float n = onBlock ? blockN : sinkN;
    const float yBody = onBlock ? BODY_Y : -BODY_Y;
    const float rate = (n < 0.f ? -1.f : 1.f) * std::sqrt(std::min(1.f, std::fabs(n))) * HZ_AT_REF;
    p.vx = 0.f; p.vz = 0.f;
    p.vy = rate * SPAN;
    p.y += p.vy * dt;
    const float lo = yBody - 0.5f * SPAN;
    if (!std::isfinite(p.y)) p.y = yBody;
    else if (p.y > lo + SPAN) p.y -= SPAN;
    else if (p.y < lo) p.y += SPAN;
    p.aux = clampf(0.5f + 0.5f * n, 0.f, 1.f); // 0 cold … 1 warm
}

namespace {
using PP = power_gen::ode::Peltier;
using PC = power_gen::PeltierConstants;
/// Fixed-step overrides (euler / rk4) substep at this size: the leg cells
/// relax at up to ~1400 /s, so an explicit step must stay under 1.4 ms.
constexpr float H_FIXED_S = 5e-4f;
/// |COP| reported at most this; near zero input power the ratio is unbounded.
constexpr float COP_LIMIT = 100.f;
constexpr float P_MIN_W = 1e-3f;
} // namespace

void PeltierPlant::outputs(std::span<const float> x, const PeltierInput& u, std::span<float> y) const {
    constexpr int N = PeltierState::LEG_CELLS;
    const float Tcp = x[PeltierState::COLD_PLATE];
    const float Thp = x[PeltierState::HOT_PLATE];
    const float I = u.currentA;
    const float a0 = s.seebeck * s.couples;
    const float a1 = s.seebeckSlope * s.couples;
    const float Gf = 2.f * s.conductanceWK * static_cast<float>(N);
    const float dT = Thp - Tcp;
    // Open-circuit EMF ∫S dT across the leg, plus the ohmic drop.
    const float v = a0 * dT + a1 * (0.5f * (Thp * Thp - Tcp * Tcp) - s.seebeckRefK * dT) + I * s.rInternalOhm;
    const float p = I * v;
    // Heat leaving the cold plate into the leg / entering the hot plate from it.
    const float qc = (a0 + a1 * (Tcp - s.seebeckRefK)) * I * Tcp + Gf * (Tcp - x[PeltierState::FIRST_CELL]);
    const float qh = (a0 + a1 * (Thp - s.seebeckRefK)) * I * Thp + Gf * (x[PeltierState::HOT_PLATE - 1] - Thp);
    y[PP::hotK] = Thp;
    y[PP::coldK] = Tcp;
    y[PP::deltaTK] = dT;
    y[PP::voltageV] = v;
    y[PP::powerW] = p;
    y[PP::cop] = p > P_MIN_W ? clampf(qc / p, -COP_LIMIT, COP_LIMIT) : 0.f;
    y[PP::qcW] = qc;
    y[PP::qhW] = qh;
}

void PeltierPlant::save(std::span<float> x) const {
    for (int i = 0; i < PeltierState::NODES; ++i) x[static_cast<std::size_t>(i)] = s.nodesK[i];
}

void PeltierPlant::load(std::span<const float> x) {
    for (int i = 0; i < PeltierState::NODES; ++i) s.nodesK[i] = x[static_cast<std::size_t>(i)];
}

bool PeltierPlant::constrain(std::span<float> x) const {
    const float lo = s.ambientK - PC::CLAMP_BELOW_AMBIENT_K;
    const float hi = s.ambientK + PC::CLAMP_ABOVE_AMBIENT_K;
    bool changed = false;
    for (float& t : x) {
        const float c = clampf(t, lo, hi);
        changed = changed || c != t;
        t = c;
    }
    return changed;
}

void SEGSimulator::_stepPeltier(float dt) {
    // Current-driven cooler: the drive sets the current magnitude, the
    // polarity setpoint its direction, and the load setpoint feeds the cold
    // block. The 28 temperatures advance on the catalog integrator (ros23).
    PeltierState& s = _peltier;
    PeltierPlant plant(s);
    s.currentA = (s.polarity < 0.f ? -1.f : 1.f) * clampf(s.drive, 0.f, 1.f) * s.iMaxA;
    const PeltierInput u{s.currentA, clampf(s.loadW, 0.f, PC::LOAD_MAX_W)};
    float x[PP::STATE_SIZE];
    plant.save(x);

    const sim_core::Integrator method = _odeMethod(PP::INTEGRATOR);
    if (method == sim_core::Integrator::Euler || method == sim_core::Integrator::Rk4) {
        // Explicit and fixed: only stable in small substeps (a reference, not
        // the way to run this plant).
        const int nSub = std::max(1, static_cast<int>(std::ceil(dt / H_FIXED_S)));
        const float h = dt / static_cast<float>(nSub);
        for (int i = 0; i < nSub; ++i) {
            _odeStats += method == sim_core::Integrator::Euler
                ? sim_core::euler_fixed(plant, 0.0, h, std::span<float>(x), u)
                : sim_core::rk4_fixed(plant, 0.0, h, std::span<float>(x), u);
            plant.constrain(std::span<float>(x));
        }
    } else {
        sim_core::StepperState st{s.stepH, s.stepErrOld};
        _odeStats += sim_core::advance_adaptive(method, plant, std::span<float>(x), u,
                                                static_cast<double>(dt), PP::tolerance(), st);
        s.stepH = st.h;
        s.stepErrOld = st.errOld;
    }
    plant.load(x);

    float y[PP::OUTPUT_SIZE];
    plant.outputs(x, u, y);
    s.hotK = y[PP::hotK];
    s.coldK = y[PP::coldK];
    s.deltaTK = y[PP::deltaTK];
    s.voltageV = y[PP::voltageV];
    s.powerW = y[PP::powerW];
    s.cop = y[PP::cop];
    s.qcW = y[PP::qcW];
    s.qhW = y[PP::qhW];
}
