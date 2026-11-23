// =============================================================
// heron_plant.cpp  –  Heron's Fountain plant (pure extraction, no logic
// changes vs sim_core.cpp)
// =============================================================

#include "../sim_core.h"
#include "plant_common.h"

using namespace plant_common;

namespace {
/// Friction-factor passes in the exit-speed solve (HERON_FRICTION_PASSES in src/heron-layout.ts).
constexpr int HERON_FRICTION_PASSES = 3;
} // namespace

void heron_particle_step(SimParticle& p, float vExit, float dt, float simTime) {
    // Ballistic droplets in SI, held in scene units: gravity and the launch
    // speed are divided by the bench's metres per scene unit, so a droplet
    // launched at v rises v²/2g metres. No drag, no separate scene gravity.
    constexpr float toScene = 1.f / power_gen::HeronConstants::METRES_PER_SCENE_UNIT;
    constexpr float g = PhysicsConstants::G * toScene;
    constexpr float nozzleY = 1.2f;
    p.vy -= g * dt;
    p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
    p.aux = std::max(0.f, p.aux - dt); // life
    if (p.y < nozzleY - 0.4f || p.aux <= 0.f) {
        // Back in the basin: leave the nozzle again.
        float a = p.phase * PhysicsConstants::TAU;
        float spray = 0.04f;
        p.x = std::cos(a) * 0.03f;
        p.y = nozzleY;
        p.z = std::sin(a) * 0.03f;
        float ve = std::max(0.2f, vExit) * toScene;
        p.vx = std::cos(a + 0.5f) * spray * ve;
        p.vy = ve;
        p.vz = std::sin(a + 0.5f) * spray * ve;
        p.aux = 1.5f + 0.5f * hash1(p.phase + simTime);
    }
}

void SEGSimulator::_stepHeron(float dt) {
    // H = v²/2g · (1/C_d² + f·(L/D)·(A_n/A_p)²): Bernoulli through the nozzle
    // plus pipe friction at the pipe's own speed (continuity). Same passes,
    // same order as computeHeronHydraulics in src/heron-layout.ts.
    HeronState& h = _heron;
    h.head = clampf(h.head + (h.pumpRate * h.drive - h.drainCoeff * h.vExit) * dt,
                    0.f, h.headMax);
    const float g = PhysicsConstants::G;
    const float nu = 1.0e-6f; // water kinematic viscosity
    const float D = std::max(h.pipeDiameterM, 1e-4f);
    const float L = h.pipeLengthM;
    const float head = std::max(h.head, 0.f);
    const float rn = 0.5f * h.nozzleDiameterM;
    const float areaNozzle = PhysicsConstants::PI * rn * rn;
    const float areaRatio = std::min(1.f, areaNozzle / (PhysicsConstants::PI * D * D * 0.25f));
    const float k0 = 1.f / (h.dischargeCoeff * h.dischargeCoeff);
    float v = std::sqrt(2.f * g * head / k0);
    float Re = 0.f;
    for (int pass = 0; pass < HERON_FRICTION_PASSES; ++pass) {
        Re = v * areaRatio * D / nu;
        const float f = swameeJainF(h.roughness, Re);
        v = std::sqrt(2.f * g * head / (k0 + f * (L / D) * areaRatio * areaRatio));
    }
    h.vExit = v;
    h.reynolds = Re;
    h.flowLmin = v * areaNozzle * 60000.f; // m³/s → L/min
    h.pressureKPa = 1000.f * g * head / 1000.f; // ρgh in kPa
}

void SEGSimulator::setHeronLayout(float headMaxM, float pipeLengthM, float pipeDiameterM, float nozzleDiameterM,
                                  float dischargeCoeff, float roughness, float pumpRate, float drainCoeff) {
    // A layout with a non-finite number in it is not a layout: keep the one in use.
    for (float x : { headMaxM, pipeLengthM, pipeDiameterM, nozzleDiameterM, dischargeCoeff, roughness, pumpRate, drainCoeff }) {
        if (!std::isfinite(x)) return;
    }
    HeronState& h = _heron;
    h.headMax = std::max(headMaxM, 0.01f);
    h.pipeLengthM = std::max(pipeLengthM, 0.f);
    h.pipeDiameterM = std::max(pipeDiameterM, 1e-4f);
    h.nozzleDiameterM = std::max(nozzleDiameterM, 1e-4f);
    h.dischargeCoeff = clampf(dischargeCoeff, 0.01f, 1.f);
    h.roughness = std::max(roughness, 0.f);
    h.pumpRate = pumpRate;
    h.drainCoeff = drainCoeff;
    h.head = clampf(h.head, 0.f, h.headMax);
}
