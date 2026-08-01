// =============================================================
// homopolar_plant.cpp  –  Faraday-disc homopolar generator L–R + back-EMF
// (pure extraction, no logic changes vs sim_core.cpp)
// =============================================================

#include "../sim_core.h"
#include "plant_common.h"

void SEGSimulator::_stepHomopolar(float dt) {
    HomopolarState& h = _homopolar;
    float omega = h.omega;
    float current = h.currentA;
    float B = h.fieldT;
    float omegaTarget = h.drive * 3600.f * (PhysicsConstants::PI / 30.f);
    float tauDrive = h.tauDriveMax * h.drive
                   * (0.6f + 0.4f * std::tanh((omegaTarget - omega) * 2.f));
    float emf = 0.5f * B * omega * h.discRadiusM * h.discRadiusM;
    float tauLoad = current * B * h.discRadiusM * 0.5f;
    float dI = (emf - h.rOhm * current) / h.lHenry * dt;
    current = std::max(0.f, current + dI);
    float dOmega = (tauDrive - tauLoad - h.drag * omega) / h.inertia * dt;
    omega = std::max(0.f, omega + dOmega);
    h.omega = omega;
    h.angle += omega * dt;
    h.rpm = omega * 30.f / PhysicsConstants::PI;
    h.emfV = emf;
    h.currentA = current;
}
