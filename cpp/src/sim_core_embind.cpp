// =============================================================
// sim_core_embind.cpp  –  Emscripten / Embind surface (unchanged signatures)
// =============================================================

#ifdef __EMSCRIPTEN__

#include "sim_core.h"

#include <emscripten/bind.h>
#include <string>

using namespace emscripten;

EMSCRIPTEN_BINDINGS(sim_core) {
    value_object<EnergyNetworkSummary>("EnergyNetworkSummary")
        .field("couplingEnabled", &EnergyNetworkSummary::couplingEnabled)
        .field("labBudgetW", &EnergyNetworkSummary::labBudgetW)
        .field("totalAllocatedW", &EnergyNetworkSummary::totalAllocatedW)
        .field("residualW", &EnergyNetworkSummary::residualW);

    value_object<EnergyNetworkDevicePower>("EnergyNetworkDevicePower")
        .field("powerInW", &EnergyNetworkDevicePower::powerInW)
        .field("powerOutW", &EnergyNetworkDevicePower::powerOutW)
        .field("efficiency", &EnergyNetworkDevicePower::efficiency);

    register_vector<float>("FloatVector");
    register_vector<int>("IntVector");

    value_object<Vec3>("Vec3")
        .field("x", &Vec3::x)
        .field("y", &Vec3::y)
        .field("z", &Vec3::z);

    value_object<SimParticle>("SimParticle")
        .field("x", &SimParticle::x)
        .field("y", &SimParticle::y)
        .field("z", &SimParticle::z)
        .field("phase", &SimParticle::phase)
        .field("vx", &SimParticle::vx)
        .field("vy", &SimParticle::vy)
        .field("vz", &SimParticle::vz)
        .field("aux", &SimParticle::aux);

    function("magneticDipoleField", &magneticDipoleField);
    function("magneticDipoleForce", &magneticDipoleForce);
    function("axialBField", &axialBField);
    function("estimateHalbachFieldT", optional_override([](float gapM, float remanenceT) -> float {
        return estimateHalbachFieldT(gapM, remanenceT);
    }));
    function("sim_core_version", optional_override([]() -> std::string {
        return std::string(sim_core_version());
    }));
    function("chores_reduce_f32", &chores_reduce_f32_vec);
    function("chores_map_scale_f32", &chores_map_scale_f32_vec);

    class_<SEGSimulator>("SEGSimulator")
        .constructor()
        .function("step", &SEGSimulator::step)
        .function("seedParticles", &SEGSimulator::seedParticles)
        .function("stepParticles", &SEGSimulator::stepParticles)
        .function("getOmega", &SEGSimulator::getOmega)
        .function("getRPM", &SEGSimulator::getRPM)
        .function("getOmegaF64", &SEGSimulator::getOmegaF64)
        .function("getRPMF64", &SEGSimulator::getRPMF64)
        .function("getAngle", &SEGSimulator::getAngle)
        .function("numRollers", &SEGSimulator::numRollers)
        .function("numParticles", &SEGSimulator::numParticles)
        .function("getTime", &SEGSimulator::getTime)
        .function("sampleBField", &SEGSimulator::sampleBField)
        .function("rollerWorldPos", &SEGSimulator::rollerWorldPos)
        .function("estimatePower", &SEGSimulator::estimatePower)
        .function("magneticEnergyDensity", &SEGSimulator::magneticEnergyDensity)
        .function("getParticle", &SEGSimulator::getParticle)
        .function("getParticles", &SEGSimulator::getParticles)
        .function("setRingLoadTorque", &SEGSimulator::setRingLoadTorque)
        .function("setRingLoadTorques", &SEGSimulator::setRingLoadTorques)
        .function("stepWithPerRingTorques", &SEGSimulator::stepWithPerRingTorques)
        .function("setMode", &SEGSimulator::setMode)
        .function("getMode", &SEGSimulator::getMode)
        .function("setDrive", &SEGSimulator::setDrive)
        .function("getDrive", &SEGSimulator::getDrive)
        .function("getHeronHead", &SEGSimulator::getHeronHead)
        .function("getHeronVExit", &SEGSimulator::getHeronVExit)
        .function("getHeronFlowLmin", &SEGSimulator::getHeronFlowLmin)
        .function("getHeronPressureKPa", &SEGSimulator::getHeronPressureKPa)
        .function("getKelvinVoltage", &SEGSimulator::getKelvinVoltage)
        .function("getKelvinVoltageN", &SEGSimulator::getKelvinVoltageN)
        .function("getKelvinE", &SEGSimulator::getKelvinE)
        .function("getKelvinSparkTimer", &SEGSimulator::getKelvinSparkTimer)
        .function("getSolarBattery", &SEGSimulator::getSolarBattery)
        .function("getPeltierHotK", &SEGSimulator::getPeltierHotK)
        .function("getPeltierColdK", &SEGSimulator::getPeltierColdK)
        .function("getPeltierDeltaT", &SEGSimulator::getPeltierDeltaT)
        .function("getPeltierVoltage", &SEGSimulator::getPeltierVoltage)
        .function("getPeltierCurrent", &SEGSimulator::getPeltierCurrent)
        .function("getPeltierPowerW", &SEGSimulator::getPeltierPowerW)
        .function("getPeltierCOP", &SEGSimulator::getPeltierCOP)
        .function("getMhdFlowU", &SEGSimulator::getMhdFlowU)
        .function("getMhdBFieldT", &SEGSimulator::getMhdBFieldT)
        .function("getMhdHartmann", &SEGSimulator::getMhdHartmann)
        .function("getMhdVoltage", &SEGSimulator::getMhdVoltage)
        .function("getMhdCurrent", &SEGSimulator::getMhdCurrent)
        .function("getMhdPowerW", &SEGSimulator::getMhdPowerW)
        .function("getMaglevGap", &SEGSimulator::getMaglevGap)
        .function("getMaglevGapVel", &SEGSimulator::getMaglevGapVel)
        .function("getMaglevGapMm", &SEGSimulator::getMaglevGapMm)
        .function("getMaglevFieldT", &SEGSimulator::getMaglevFieldT)
        .function("getMaglevLiftN", &SEGSimulator::getMaglevLiftN)
        .function("getMaglevRpm", &SEGSimulator::getMaglevRpm)
        .function("getHomopolarOmega", &SEGSimulator::getHomopolarOmega)
        .function("getHomopolarAngle", &SEGSimulator::getHomopolarAngle)
        .function("getHomopolarRpm", &SEGSimulator::getHomopolarRpm)
        .function("getHomopolarEmfV", &SEGSimulator::getHomopolarEmfV)
        .function("getHomopolarCurrentA", &SEGSimulator::getHomopolarCurrentA)
        .function("getHomopolarFieldT", &SEGSimulator::getHomopolarFieldT)
        .function("getTransformerI1", &SEGSimulator::getTransformerI1)
        .function("getTransformerI2", &SEGSimulator::getTransformerI2)
        .function("getTransformerV1", &SEGSimulator::getTransformerV1)
        .function("getTransformerV2", &SEGSimulator::getTransformerV2)
        .function("getTransformerK", &SEGSimulator::getTransformerK)
        .function("getTransformerFluxN", &SEGSimulator::getTransformerFluxN)
        .function("getTransformerLeakage", &SEGSimulator::getTransformerLeakage)
        .function("setTransformerLeakage", &SEGSimulator::setTransformerLeakage)
        .function("getVdgVoltage", &SEGSimulator::getVdgVoltage)
        .function("getVdgBeltMps", &SEGSimulator::getVdgBeltMps)
        .function("getVdgChargeC", &SEGSimulator::getVdgChargeC)
        .function("getVdgSparkHz", &SEGSimulator::getVdgSparkHz)
        .function("getHallVoltage", &SEGSimulator::getHallVoltage)
        .function("getHallCurrent", &SEGSimulator::getHallCurrent)
        .function("getHallFieldT", &SEGSimulator::getHallFieldT)
        .function("getHallCoeff", &SEGSimulator::getHallCoeff)
        .function("getHallCarrierMetal", &SEGSimulator::getHallCarrierMetal)
        .function("setHallCarrierMetal", &SEGSimulator::setHallCarrierMetal)
        .function("getEnergyLevel", &SEGSimulator::getEnergyLevel)
        .function("setNetworkEdges", &SEGSimulator::setNetworkEdges)
        .function("getNetworkEdgeCount", &SEGSimulator::getNetworkEdgeCount)
        .function("updateEnergyNetwork", &SEGSimulator::updateEnergyNetwork)
        .function("getNetworkSummary", &SEGSimulator::getNetworkSummary)
        .function("getNetworkEdgeAllocatedW", &SEGSimulator::getNetworkEdgeAllocatedW)
        .function("getNetworkDevicePower", &SEGSimulator::getNetworkDevicePower)
        .function("getParticleBufferPtr", optional_override([](SEGSimulator& self) -> double {
            return static_cast<double>(self.getParticleBufferPtr());
        }))
        .function("getParticleFloatCount", &SEGSimulator::getParticleFloatCount)
        .function("getRollerStatePtr", optional_override([](SEGSimulator& self) -> double {
            return static_cast<double>(self.getRollerStatePtr());
        }))
        .function("getRollerStateFloatCount", &SEGSimulator::getRollerStateFloatCount)
        .function("packRollerState", &SEGSimulator::packRollerState)
        .class_function("version", optional_override([]() -> std::string {
            return std::string(SEGSimulator::version());
        }));
}

#endif // __EMSCRIPTEN__
