// AUTO-GENERATED from cpp/abi.json — do not edit.
// Regenerate: npm run codegen:wasm-abi   (scripts/codegen-wasm-abi.mjs)
//
// sim_core's whole JS ⇄ WASM surface as a flat C ABI (#254 §3): scalars in,
// scalars out. A struct return is copied into one static float block whose
// address is returned (the TS wrapper reads it straight back, before the next
// call); an array argument arrives as pointer + count in the class scratch.
// Compiled by `make native` too (EMSCRIPTEN_KEEPALIVE is empty there), so a
// signature drift in sim_core.h fails -Werror without emcc.

#include "sim_core.h"

#include <cstdint>

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#else
#define EMSCRIPTEN_KEEPALIVE
#endif

// Hash of every compiled input (scripts/sim-core-source-hash.mjs), passed by
// `make wasm`. The site build defines the same value; a mismatch means the
// shipped binary predates its sources (src/wasm/index.ts reports it).
#ifndef SIM_CORE_SOURCE_HASH
#define SIM_CORE_SOURCE_HASH "unknown"
#endif

namespace {
alignas(16) float g_abi_out[16];
inline uintptr_t out_ptr() { return reinterpret_cast<uintptr_t>(g_abi_out); }
} // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE uintptr_t sc_magneticDipoleField(float r_x, float r_y, float r_z, float m_x, float m_y, float m_z) {
    const Vec3 v = magneticDipoleField(Vec3{r_x, r_y, r_z}, Vec3{m_x, m_y, m_z});
    g_abi_out[0] = v.x;
    g_abi_out[1] = v.y;
    g_abi_out[2] = v.z;
    return out_ptr();
}

EMSCRIPTEN_KEEPALIVE uintptr_t sc_magneticDipoleForce(float pos1_x, float pos1_y, float pos1_z, float m1_x, float m1_y, float m1_z, float pos2_x, float pos2_y, float pos2_z, float m2_x, float m2_y, float m2_z) {
    const Vec3 v = magneticDipoleForce(Vec3{pos1_x, pos1_y, pos1_z}, Vec3{m1_x, m1_y, m1_z}, Vec3{pos2_x, pos2_y, pos2_z}, Vec3{m2_x, m2_y, m2_z});
    g_abi_out[0] = v.x;
    g_abi_out[1] = v.y;
    g_abi_out[2] = v.z;
    return out_ptr();
}

EMSCRIPTEN_KEEPALIVE float sc_axialBField(float z, float radius, float height, float Br) {
    return axialBField(z, radius, height, Br);
}

EMSCRIPTEN_KEEPALIVE float sc_estimateHalbachFieldT(float gapM, float remanenceT) {
    return estimateHalbachFieldT(gapM, remanenceT);
}

EMSCRIPTEN_KEEPALIVE const char* sc_sim_core_version() {
    return sim_core_version();
}

EMSCRIPTEN_KEEPALIVE const char* sc_sim_core_source_hash() {
    return SIM_CORE_SOURCE_HASH;
}

EMSCRIPTEN_KEEPALIVE uintptr_t sc_chores_scratch_ptr(int count) {
    return static_cast<uintptr_t>(chores_scratch_ptr(count));
}

EMSCRIPTEN_KEEPALIVE uintptr_t sc_chores_reduce_f32_scratch(int count) {
    const ChoresReduceResult v = chores_reduce_f32_scratch(count);
    g_abi_out[0] = v.sum;
    g_abi_out[1] = v.min;
    g_abi_out[2] = v.max;
    g_abi_out[3] = v.sumSq;
    g_abi_out[4] = v.count;
    return out_ptr();
}

EMSCRIPTEN_KEEPALIVE void sc_chores_map_scale_f32_scratch(int count, float scale, float bias) {
    chores_map_scale_f32_scratch(count, scale, bias);
}

EMSCRIPTEN_KEEPALIVE int sc_chores_fft_db_scratch(int count, int hann, float floorDb) {
    return chores_fft_db_scratch(count, hann != 0, floorDb);
}

EMSCRIPTEN_KEEPALIVE uint32_t sc_plant_state_layout_hash() {
    return PLANT_STATE_LAYOUT_HASH;
}

EMSCRIPTEN_KEEPALIVE const char* sc_circuit_kind_name(int kind) {
    return circuit_kind_name(kind);
}

EMSCRIPTEN_KEEPALIVE int sc_circuit_format_version() {
    return circuit_format_version();
}

EMSCRIPTEN_KEEPALIVE CircuitSim* circ_new() {
    return new CircuitSim();
}

EMSCRIPTEN_KEEPALIVE void circ_delete(CircuitSim* self) {
    delete self;
}

EMSCRIPTEN_KEEPALIVE int circ_load(CircuitSim* self, const float* packed, int packedCount) {
    return self->load(packed, packedCount);
}

EMSCRIPTEN_KEEPALIVE int circ_loaded(CircuitSim* self) {
    return (self->loaded()) ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE const char* circ_errorText(CircuitSim* self) {
    return self->errorText();
}

EMSCRIPTEN_KEEPALIVE void circ_reset(CircuitSim* self) {
    self->reset();
}

EMSCRIPTEN_KEEPALIVE int circ_setParam(CircuitSim* self, int elem, int index, double value) {
    return (self->setParam(elem, index, value)) ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE double circ_getParam(CircuitSim* self, int elem, int index) {
    return self->getParam(elem, index);
}

EMSCRIPTEN_KEEPALIVE int circ_step(CircuitSim* self, double h) {
    return self->step(h);
}

EMSCRIPTEN_KEEPALIVE double circ_time(CircuitSim* self) {
    return self->time();
}

EMSCRIPTEN_KEEPALIVE int circ_nodeCount(CircuitSim* self) {
    return self->nodeCount();
}

EMSCRIPTEN_KEEPALIVE int circ_elemCount(CircuitSim* self) {
    return self->elemCount();
}

EMSCRIPTEN_KEEPALIVE int circ_unknownCount(CircuitSim* self) {
    return self->unknownCount();
}

EMSCRIPTEN_KEEPALIVE double circ_nodeVoltage(CircuitSim* self, int node) {
    return self->nodeVoltage(node);
}

EMSCRIPTEN_KEEPALIVE double circ_elemCurrent(CircuitSim* self, int elem) {
    return self->elemCurrent(elem);
}

EMSCRIPTEN_KEEPALIVE double circ_elemVoltage(CircuitSim* self, int elem) {
    return self->elemVoltage(elem);
}

EMSCRIPTEN_KEEPALIVE double circ_elemPower(CircuitSim* self, int elem) {
    return self->elemPower(elem);
}

EMSCRIPTEN_KEEPALIVE double circ_storedEnergy(CircuitSim* self) {
    return self->storedEnergy();
}

EMSCRIPTEN_KEEPALIVE double circ_stat(CircuitSim* self, int which) {
    return self->stat(which);
}

EMSCRIPTEN_KEEPALIVE uintptr_t circ_readoutPtr(CircuitSim* self) {
    return static_cast<uintptr_t>(self->readoutPtr());
}

EMSCRIPTEN_KEEPALIVE int circ_readoutCount(CircuitSim* self) {
    return self->readoutCount();
}

EMSCRIPTEN_KEEPALIVE uintptr_t circ_scratchPtr(CircuitSim* self, int count) {
    return static_cast<uintptr_t>(self->scratchPtr(count));
}

EMSCRIPTEN_KEEPALIVE TwinEstimator* twin_new() {
    return new TwinEstimator();
}

EMSCRIPTEN_KEEPALIVE void twin_delete(TwinEstimator* self) {
    delete self;
}

EMSCRIPTEN_KEEPALIVE int twin_stateCount(TwinEstimator* self) {
    return self->stateCount();
}

EMSCRIPTEN_KEEPALIVE int twin_sensorCount(TwinEstimator* self) {
    return self->sensorCount();
}

EMSCRIPTEN_KEEPALIVE int twin_paramCount(TwinEstimator* self) {
    return self->paramCount();
}

EMSCRIPTEN_KEEPALIVE int twin_setInitial(TwinEstimator* self, int i, double value, double sd) {
    return (self->setInitial(i, value, sd)) ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE void twin_reset(TwinEstimator* self) {
    self->reset();
}

EMSCRIPTEN_KEEPALIVE int twin_setParam(TwinEstimator* self, int i, double value) {
    return (self->setParam(i, value)) ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE double twin_getParam(TwinEstimator* self, int i) {
    return self->getParam(i);
}

EMSCRIPTEN_KEEPALIVE int twin_setProcessNoise(TwinEstimator* self, int i, double q) {
    return (self->setProcessNoise(i, q)) ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE double twin_getProcessNoise(TwinEstimator* self, int i) {
    return self->getProcessNoise(i);
}

EMSCRIPTEN_KEEPALIVE int twin_setSensorSigma(TwinEstimator* self, int c, double sigma) {
    return (self->setSensorSigma(c, sigma)) ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE double twin_getSensorSigma(TwinEstimator* self, int c) {
    return self->getSensorSigma(c);
}

EMSCRIPTEN_KEEPALIVE int twin_predict(TwinEstimator* self, double dt, double vDrive) {
    return (self->predict(dt, vDrive)) ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE void twin_setMeasurement(TwinEstimator* self, int c, double value) {
    self->setMeasurement(c, value);
}

EMSCRIPTEN_KEEPALIVE double twin_update(TwinEstimator* self) {
    return self->update();
}

EMSCRIPTEN_KEEPALIVE double twin_time(TwinEstimator* self) {
    return self->time();
}

EMSCRIPTEN_KEEPALIVE double twin_state(TwinEstimator* self, int i) {
    return self->state(i);
}

EMSCRIPTEN_KEEPALIVE double twin_cov(TwinEstimator* self, int i, int j) {
    return self->cov(i, j);
}

EMSCRIPTEN_KEEPALIVE uintptr_t twin_readoutPtr(TwinEstimator* self) {
    return static_cast<uintptr_t>(self->readoutPtr());
}

EMSCRIPTEN_KEEPALIVE int twin_readoutCount(TwinEstimator* self) {
    return self->readoutCount();
}

EMSCRIPTEN_KEEPALIVE uintptr_t twin_snapshotPtr(TwinEstimator* self) {
    return static_cast<uintptr_t>(self->snapshotPtr());
}

EMSCRIPTEN_KEEPALIVE int twin_snapshotCount(TwinEstimator* self) {
    return self->snapshotCount();
}

EMSCRIPTEN_KEEPALIVE void twin_save(TwinEstimator* self) {
    self->save();
}

EMSCRIPTEN_KEEPALIVE int twin_load(TwinEstimator* self) {
    return (self->load()) ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE TwinSysId* sysid_new() {
    return new TwinSysId();
}

EMSCRIPTEN_KEEPALIVE void sysid_delete(TwinSysId* self) {
    delete self;
}

EMSCRIPTEN_KEEPALIVE uintptr_t sysid_dataPtr(TwinSysId* self, int samples) {
    return static_cast<uintptr_t>(self->dataPtr(samples));
}

EMSCRIPTEN_KEEPALIVE int sysid_load(TwinSysId* self, int samples) {
    return self->load(samples);
}

EMSCRIPTEN_KEEPALIVE const char* sysid_errorText(TwinSysId* self) {
    return self->errorText();
}

EMSCRIPTEN_KEEPALIVE int sysid_setParam(TwinSysId* self, int i, double value) {
    return (self->setParam(i, value)) ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE int sysid_setFit(TwinSysId* self, int i, int fit) {
    return (self->setFit(i, fit != 0)) ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE int sysid_setInitialState(TwinSysId* self, int j, double value) {
    return (self->setInitialState(j, value)) ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE void sysid_setFitInitialState(TwinSysId* self, int fit) {
    self->setFitInitialState(fit != 0);
}

EMSCRIPTEN_KEEPALIVE int sysid_setSensorSigma(TwinSysId* self, int c, double sigma) {
    return (self->setSensorSigma(c, sigma)) ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE void sysid_setMaxIterations(TwinSysId* self, int n) {
    self->setMaxIterations(n);
}

EMSCRIPTEN_KEEPALIVE int sysid_start(TwinSysId* self) {
    return self->start();
}

EMSCRIPTEN_KEEPALIVE int sysid_iterate(TwinSysId* self) {
    return self->iterate();
}

EMSCRIPTEN_KEEPALIVE int sysid_status(TwinSysId* self) {
    return self->status();
}

EMSCRIPTEN_KEEPALIVE int sysid_iterations(TwinSysId* self) {
    return self->iterations();
}

EMSCRIPTEN_KEEPALIVE double sysid_cost(TwinSysId* self) {
    return self->cost();
}

EMSCRIPTEN_KEEPALIVE double sysid_lambda(TwinSysId* self) {
    return self->lambda();
}

EMSCRIPTEN_KEEPALIVE int sysid_residualCount(TwinSysId* self) {
    return self->residualCount();
}

EMSCRIPTEN_KEEPALIVE double sysid_reducedChi2(TwinSysId* self) {
    return self->reducedChi2();
}

EMSCRIPTEN_KEEPALIVE double sysid_condition(TwinSysId* self) {
    return self->condition();
}

EMSCRIPTEN_KEEPALIVE double sysid_residualAutocorr(TwinSysId* self) {
    return self->residualAutocorr();
}

EMSCRIPTEN_KEEPALIVE uint32_t sysid_warnings(TwinSysId* self) {
    return self->warnings();
}

EMSCRIPTEN_KEEPALIVE double sysid_param(TwinSysId* self, int i) {
    return self->param(i);
}

EMSCRIPTEN_KEEPALIVE double sysid_initialState(TwinSysId* self, int j) {
    return self->initialState(j);
}

EMSCRIPTEN_KEEPALIVE double sysid_covariance(TwinSysId* self, int i, int j) {
    return self->covariance(i, j);
}

EMSCRIPTEN_KEEPALIVE double sysid_r2(TwinSysId* self, int c) {
    return self->r2(c);
}

EMSCRIPTEN_KEEPALIVE double sysid_rmsNormalized(TwinSysId* self, int c) {
    return self->rmsNormalized(c);
}

EMSCRIPTEN_KEEPALIVE uintptr_t sysid_fitPtr(TwinSysId* self) {
    return static_cast<uintptr_t>(self->fitPtr());
}

EMSCRIPTEN_KEEPALIVE int sysid_fitCount(TwinSysId* self) {
    return self->fitCount();
}

EMSCRIPTEN_KEEPALIVE FdtdTmzGrid* fdtd_new() {
    return new FdtdTmzGrid();
}

EMSCRIPTEN_KEEPALIVE void fdtd_delete(FdtdTmzGrid* self) {
    delete self;
}

EMSCRIPTEN_KEEPALIVE int fdtd_init(FdtdTmzGrid* self, int n, int pmlCells, float courant, float lossMax, float sourceRadius) {
    return (self->init(n, pmlCells, courant, lossMax, sourceRadius)) ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE int fdtd_size(FdtdTmzGrid* self) {
    return self->size();
}

EMSCRIPTEN_KEEPALIVE void fdtd_reset(FdtdTmzGrid* self) {
    self->reset();
}

EMSCRIPTEN_KEEPALIVE void fdtd_setSources(FdtdTmzGrid* self, const float* packed, int packedCount) {
    self->setSources(packed, packedCount);
}

EMSCRIPTEN_KEEPALIVE void fdtd_setMaterials(FdtdTmzGrid* self, const float* interleaved, int interleavedCount) {
    self->setMaterials(interleaved, interleavedCount);
}

EMSCRIPTEN_KEEPALIVE void fdtd_clearMaterials(FdtdTmzGrid* self) {
    self->clearMaterials();
}

EMSCRIPTEN_KEEPALIVE int fdtd_hasMaterials(FdtdTmzGrid* self) {
    return (self->hasMaterials()) ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE void fdtd_step(FdtdTmzGrid* self, int steps) {
    self->step(steps);
}

EMSCRIPTEN_KEEPALIVE double fdtd_interiorEnergy(FdtdTmzGrid* self) {
    return self->interiorEnergy();
}

EMSCRIPTEN_KEEPALIVE uintptr_t fdtd_ezPtr(FdtdTmzGrid* self) {
    return static_cast<uintptr_t>(self->ezPtr());
}

EMSCRIPTEN_KEEPALIVE uintptr_t fdtd_hxPtr(FdtdTmzGrid* self) {
    return static_cast<uintptr_t>(self->hxPtr());
}

EMSCRIPTEN_KEEPALIVE uintptr_t fdtd_hyPtr(FdtdTmzGrid* self) {
    return static_cast<uintptr_t>(self->hyPtr());
}

EMSCRIPTEN_KEEPALIVE uintptr_t fdtd_scratchPtr(FdtdTmzGrid* self, int count) {
    return static_cast<uintptr_t>(self->scratchPtr(count));
}

EMSCRIPTEN_KEEPALIVE SEGSimulator* seg_new() {
    return new SEGSimulator();
}

EMSCRIPTEN_KEEPALIVE void seg_delete(SEGSimulator* self) {
    delete self;
}

EMSCRIPTEN_KEEPALIVE const char* seg_version() {
    return SEGSimulator::version();
}

EMSCRIPTEN_KEEPALIVE void seg_step(SEGSimulator* self, float dt, float loadTorque) {
    self->step(dt, loadTorque);
}

EMSCRIPTEN_KEEPALIVE void seg_seedParticles(SEGSimulator* self, int count) {
    self->seedParticles(count);
}

EMSCRIPTEN_KEEPALIVE void seg_stepParticles(SEGSimulator* self, float dt) {
    self->stepParticles(dt);
}

EMSCRIPTEN_KEEPALIVE float seg_getOmega(SEGSimulator* self) {
    return self->getOmega();
}

EMSCRIPTEN_KEEPALIVE float seg_getRPM(SEGSimulator* self) {
    return self->getRPM();
}

EMSCRIPTEN_KEEPALIVE double seg_getOmegaF64(SEGSimulator* self) {
    return self->getOmegaF64();
}

EMSCRIPTEN_KEEPALIVE double seg_getRPMF64(SEGSimulator* self) {
    return self->getRPMF64();
}

EMSCRIPTEN_KEEPALIVE float seg_getAngle(SEGSimulator* self, int i) {
    return self->getAngle(i);
}

EMSCRIPTEN_KEEPALIVE int seg_numRollers(SEGSimulator* self) {
    return self->numRollers();
}

EMSCRIPTEN_KEEPALIVE int seg_numParticles(SEGSimulator* self) {
    return self->numParticles();
}

EMSCRIPTEN_KEEPALIVE float seg_getTime(SEGSimulator* self) {
    return self->getTime();
}

EMSCRIPTEN_KEEPALIVE uintptr_t seg_sampleBField(SEGSimulator* self, float worldPos_x, float worldPos_y, float worldPos_z) {
    const Vec3 v = self->sampleBField(Vec3{worldPos_x, worldPos_y, worldPos_z});
    g_abi_out[0] = v.x;
    g_abi_out[1] = v.y;
    g_abi_out[2] = v.z;
    return out_ptr();
}

EMSCRIPTEN_KEEPALIVE uintptr_t seg_rollerWorldPos(SEGSimulator* self, int i) {
    const Vec3 v = self->rollerWorldPos(i);
    g_abi_out[0] = v.x;
    g_abi_out[1] = v.y;
    g_abi_out[2] = v.z;
    return out_ptr();
}

EMSCRIPTEN_KEEPALIVE float seg_estimatePower(SEGSimulator* self, float loadTorque) {
    return self->estimatePower(loadTorque);
}

EMSCRIPTEN_KEEPALIVE float seg_magneticEnergyDensity(SEGSimulator* self) {
    return self->magneticEnergyDensity();
}

EMSCRIPTEN_KEEPALIVE uintptr_t seg_getParticle(SEGSimulator* self, int i) {
    const SimParticle v = self->getParticle(i);
    g_abi_out[0] = v.x;
    g_abi_out[1] = v.y;
    g_abi_out[2] = v.z;
    g_abi_out[3] = v.phase;
    g_abi_out[4] = v.vx;
    g_abi_out[5] = v.vy;
    g_abi_out[6] = v.vz;
    g_abi_out[7] = v.aux;
    return out_ptr();
}

EMSCRIPTEN_KEEPALIVE void seg_setRingLoadTorque(SEGSimulator* self, int ring, float torque) {
    self->setRingLoadTorque(ring, torque);
}

EMSCRIPTEN_KEEPALIVE void seg_setRingLoadTorques(SEGSimulator* self, float tInner, float tMiddle, float tOuter) {
    self->setRingLoadTorques(tInner, tMiddle, tOuter);
}

EMSCRIPTEN_KEEPALIVE void seg_stepWithPerRingTorques(SEGSimulator* self, float dt) {
    self->stepWithPerRingTorques(dt);
}

EMSCRIPTEN_KEEPALIVE void seg_setMode(SEGSimulator* self, int mode) {
    self->setMode(mode);
}

EMSCRIPTEN_KEEPALIVE int seg_getMode(SEGSimulator* self) {
    return self->getMode();
}

EMSCRIPTEN_KEEPALIVE void seg_setDrive(SEGSimulator* self, float drive) {
    self->setDrive(drive);
}

EMSCRIPTEN_KEEPALIVE float seg_getDrive(SEGSimulator* self) {
    return self->getDrive();
}

EMSCRIPTEN_KEEPALIVE float seg_getHeronHead(SEGSimulator* self) {
    return self->getHeronHead();
}

EMSCRIPTEN_KEEPALIVE float seg_getHeronVExit(SEGSimulator* self) {
    return self->getHeronVExit();
}

EMSCRIPTEN_KEEPALIVE float seg_getHeronFlowLmin(SEGSimulator* self) {
    return self->getHeronFlowLmin();
}

EMSCRIPTEN_KEEPALIVE float seg_getHeronPressureKPa(SEGSimulator* self) {
    return self->getHeronPressureKPa();
}

EMSCRIPTEN_KEEPALIVE float seg_getKelvinVoltage(SEGSimulator* self) {
    return self->getKelvinVoltage();
}

EMSCRIPTEN_KEEPALIVE float seg_getKelvinVoltageN(SEGSimulator* self) {
    return self->getKelvinVoltageN();
}

EMSCRIPTEN_KEEPALIVE float seg_getKelvinE(SEGSimulator* self) {
    return self->getKelvinE();
}

EMSCRIPTEN_KEEPALIVE float seg_getKelvinSparkTimer(SEGSimulator* self) {
    return self->getKelvinSparkTimer();
}

EMSCRIPTEN_KEEPALIVE float seg_getKelvinVbreak(SEGSimulator* self) {
    return self->getKelvinVbreak();
}

EMSCRIPTEN_KEEPALIVE float seg_getKelvinSeedV(SEGSimulator* self) {
    return self->getKelvinSeedV();
}

EMSCRIPTEN_KEEPALIVE void seg_setKelvinSeedV(SEGSimulator* self, float seedV) {
    self->setKelvinSeedV(seedV);
}

EMSCRIPTEN_KEEPALIVE float seg_getSolarBattery(SEGSimulator* self) {
    return self->getSolarBattery();
}

EMSCRIPTEN_KEEPALIVE float seg_getPeltierHotK(SEGSimulator* self) {
    return self->getPeltierHotK();
}

EMSCRIPTEN_KEEPALIVE float seg_getPeltierColdK(SEGSimulator* self) {
    return self->getPeltierColdK();
}

EMSCRIPTEN_KEEPALIVE float seg_getPeltierDeltaT(SEGSimulator* self) {
    return self->getPeltierDeltaT();
}

EMSCRIPTEN_KEEPALIVE float seg_getPeltierVoltage(SEGSimulator* self) {
    return self->getPeltierVoltage();
}

EMSCRIPTEN_KEEPALIVE float seg_getPeltierCurrent(SEGSimulator* self) {
    return self->getPeltierCurrent();
}

EMSCRIPTEN_KEEPALIVE float seg_getPeltierPowerW(SEGSimulator* self) {
    return self->getPeltierPowerW();
}

EMSCRIPTEN_KEEPALIVE float seg_getPeltierCOP(SEGSimulator* self) {
    return self->getPeltierCOP();
}

EMSCRIPTEN_KEEPALIVE float seg_getPeltierQcW(SEGSimulator* self) {
    return self->getPeltierQcW();
}

EMSCRIPTEN_KEEPALIVE float seg_getPeltierQhW(SEGSimulator* self) {
    return self->getPeltierQhW();
}

EMSCRIPTEN_KEEPALIVE float seg_getPeltierNodeK(SEGSimulator* self, int index) {
    return self->getPeltierNodeK(index);
}

EMSCRIPTEN_KEEPALIVE int seg_getPeltierNodeCount(SEGSimulator* self) {
    return self->getPeltierNodeCount();
}

EMSCRIPTEN_KEEPALIVE float seg_getPeltierLoadW(SEGSimulator* self) {
    return self->getPeltierLoadW();
}

EMSCRIPTEN_KEEPALIVE float seg_getPeltierPolarity(SEGSimulator* self) {
    return self->getPeltierPolarity();
}

EMSCRIPTEN_KEEPALIVE void seg_setPeltierLoadW(SEGSimulator* self, float watts) {
    self->setPeltierLoadW(watts);
}

EMSCRIPTEN_KEEPALIVE void seg_setPeltierPolarity(SEGSimulator* self, float sign) {
    self->setPeltierPolarity(sign);
}

EMSCRIPTEN_KEEPALIVE float seg_getMhdFlowU(SEGSimulator* self) {
    return self->getMhdFlowU();
}

EMSCRIPTEN_KEEPALIVE float seg_getMhdBFieldT(SEGSimulator* self) {
    return self->getMhdBFieldT();
}

EMSCRIPTEN_KEEPALIVE float seg_getMhdHartmann(SEGSimulator* self) {
    return self->getMhdHartmann();
}

EMSCRIPTEN_KEEPALIVE float seg_getMhdVoltage(SEGSimulator* self) {
    return self->getMhdVoltage();
}

EMSCRIPTEN_KEEPALIVE float seg_getMhdCurrent(SEGSimulator* self) {
    return self->getMhdCurrent();
}

EMSCRIPTEN_KEEPALIVE float seg_getMhdPowerW(SEGSimulator* self) {
    return self->getMhdPowerW();
}

EMSCRIPTEN_KEEPALIVE float seg_getMaglevGap(SEGSimulator* self) {
    return self->getMaglevGap();
}

EMSCRIPTEN_KEEPALIVE float seg_getMaglevGapVel(SEGSimulator* self) {
    return self->getMaglevGapVel();
}

EMSCRIPTEN_KEEPALIVE float seg_getMaglevGapMm(SEGSimulator* self) {
    return self->getMaglevGapMm();
}

EMSCRIPTEN_KEEPALIVE float seg_getMaglevFieldT(SEGSimulator* self) {
    return self->getMaglevFieldT();
}

EMSCRIPTEN_KEEPALIVE float seg_getMaglevLiftN(SEGSimulator* self) {
    return self->getMaglevLiftN();
}

EMSCRIPTEN_KEEPALIVE float seg_getMaglevRpm(SEGSimulator* self) {
    return self->getMaglevRpm();
}

EMSCRIPTEN_KEEPALIVE float seg_getHomopolarOmega(SEGSimulator* self) {
    return self->getHomopolarOmega();
}

EMSCRIPTEN_KEEPALIVE float seg_getHomopolarAngle(SEGSimulator* self) {
    return self->getHomopolarAngle();
}

EMSCRIPTEN_KEEPALIVE float seg_getHomopolarRpm(SEGSimulator* self) {
    return self->getHomopolarRpm();
}

EMSCRIPTEN_KEEPALIVE float seg_getHomopolarEmfV(SEGSimulator* self) {
    return self->getHomopolarEmfV();
}

EMSCRIPTEN_KEEPALIVE float seg_getHomopolarCurrentA(SEGSimulator* self) {
    return self->getHomopolarCurrentA();
}

EMSCRIPTEN_KEEPALIVE float seg_getHomopolarFieldT(SEGSimulator* self) {
    return self->getHomopolarFieldT();
}

EMSCRIPTEN_KEEPALIVE float seg_getTransformerI1(SEGSimulator* self) {
    return self->getTransformerI1();
}

EMSCRIPTEN_KEEPALIVE float seg_getTransformerI2(SEGSimulator* self) {
    return self->getTransformerI2();
}

EMSCRIPTEN_KEEPALIVE float seg_getTransformerV1(SEGSimulator* self) {
    return self->getTransformerV1();
}

EMSCRIPTEN_KEEPALIVE float seg_getTransformerV2(SEGSimulator* self) {
    return self->getTransformerV2();
}

EMSCRIPTEN_KEEPALIVE float seg_getTransformerK(SEGSimulator* self) {
    return self->getTransformerK();
}

EMSCRIPTEN_KEEPALIVE float seg_getTransformerFluxN(SEGSimulator* self) {
    return self->getTransformerFluxN();
}

EMSCRIPTEN_KEEPALIVE int seg_getTransformerLeakage(SEGSimulator* self) {
    return (self->getTransformerLeakage()) ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE void seg_setTransformerLeakage(SEGSimulator* self, int enabled) {
    self->setTransformerLeakage(enabled != 0);
}

EMSCRIPTEN_KEEPALIVE float seg_getVdgVoltage(SEGSimulator* self) {
    return self->getVdgVoltage();
}

EMSCRIPTEN_KEEPALIVE float seg_getVdgBeltMps(SEGSimulator* self) {
    return self->getVdgBeltMps();
}

EMSCRIPTEN_KEEPALIVE float seg_getVdgChargeC(SEGSimulator* self) {
    return self->getVdgChargeC();
}

EMSCRIPTEN_KEEPALIVE float seg_getVdgSparkHz(SEGSimulator* self) {
    return self->getVdgSparkHz();
}

EMSCRIPTEN_KEEPALIVE float seg_getHallVoltage(SEGSimulator* self) {
    return self->getHallVoltage();
}

EMSCRIPTEN_KEEPALIVE float seg_getHallCurrent(SEGSimulator* self) {
    return self->getHallCurrent();
}

EMSCRIPTEN_KEEPALIVE float seg_getHallFieldT(SEGSimulator* self) {
    return self->getHallFieldT();
}

EMSCRIPTEN_KEEPALIVE float seg_getHallCoeff(SEGSimulator* self) {
    return self->getHallCoeff();
}

EMSCRIPTEN_KEEPALIVE int seg_getHallCarrierMetal(SEGSimulator* self) {
    return (self->getHallCarrierMetal()) ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE void seg_setHallCarrierMetal(SEGSimulator* self, int metal) {
    self->setHallCarrierMetal(metal != 0);
}

EMSCRIPTEN_KEEPALIVE void seg_setHallFieldCoupledT(SEGSimulator* self, float fieldT) {
    self->setHallFieldCoupledT(fieldT);
}

EMSCRIPTEN_KEEPALIVE float seg_getLorentzSledVms(SEGSimulator* self) {
    return self->getLorentzSledVms();
}

EMSCRIPTEN_KEEPALIVE float seg_getLorentzCurrentA(SEGSimulator* self) {
    return self->getLorentzCurrentA();
}

EMSCRIPTEN_KEEPALIVE float seg_getLorentzFieldT(SEGSimulator* self) {
    return self->getLorentzFieldT();
}

EMSCRIPTEN_KEEPALIVE float seg_getLorentzForceN(SEGSimulator* self) {
    return self->getLorentzForceN();
}

EMSCRIPTEN_KEEPALIVE float seg_getLorentzPositionM(SEGSimulator* self) {
    return self->getLorentzPositionM();
}

EMSCRIPTEN_KEEPALIVE void seg_setLorentzFieldT(SEGSimulator* self, float fieldT) {
    self->setLorentzFieldT(fieldT);
}

EMSCRIPTEN_KEEPALIVE float seg_getRingHeightM(SEGSimulator* self) {
    return self->getRingHeightM();
}

EMSCRIPTEN_KEEPALIVE float seg_getRingCurrentA(SEGSimulator* self) {
    return self->getRingCurrentA();
}

EMSCRIPTEN_KEEPALIVE float seg_getRingPrimaryIA(SEGSimulator* self) {
    return self->getRingPrimaryIA();
}

EMSCRIPTEN_KEEPALIVE float seg_getRingForceN(SEGSimulator* self) {
    return self->getRingForceN();
}

EMSCRIPTEN_KEEPALIVE float seg_getRingCouplingK(SEGSimulator* self) {
    return self->getRingCouplingK();
}

EMSCRIPTEN_KEEPALIVE float seg_getRingVelocityMps(SEGSimulator* self) {
    return self->getRingVelocityMps();
}

EMSCRIPTEN_KEEPALIVE float seg_getEnergyLevel(SEGSimulator* self) {
    return self->getEnergyLevel();
}

EMSCRIPTEN_KEEPALIVE void seg_setNetworkEdges(SEGSimulator* self, const float* flatEdges, int flatEdgesCount) {
    self->setNetworkEdges(flatEdges, flatEdgesCount);
}

EMSCRIPTEN_KEEPALIVE int seg_getNetworkEdgeCount(SEGSimulator* self) {
    return self->getNetworkEdgeCount();
}

EMSCRIPTEN_KEEPALIVE uintptr_t seg_getScratchPtr(SEGSimulator* self, int count) {
    return static_cast<uintptr_t>(self->getScratchPtr(count));
}

EMSCRIPTEN_KEEPALIVE void seg_updateEnergyNetworkFromScratch(SEGSimulator* self, int couplingEnabled, float segPowerW, float segEfficiencyPct, int modeCount) {
    self->updateEnergyNetworkFromScratch(couplingEnabled != 0, segPowerW, segEfficiencyPct, modeCount);
}

EMSCRIPTEN_KEEPALIVE int seg_plantStateSize(SEGSimulator* self, int mode) {
    return self->plantStateSize(mode);
}

EMSCRIPTEN_KEEPALIVE int seg_plantSave(SEGSimulator* self, int mode) {
    return self->plantSave(mode);
}

EMSCRIPTEN_KEEPALIVE int seg_plantLoad(SEGSimulator* self, int mode, int count, uint32_t layoutHash) {
    return (self->plantLoad(mode, count, layoutHash)) ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE uintptr_t seg_getNetworkSummary(SEGSimulator* self) {
    const EnergyNetworkSummary v = self->getNetworkSummary();
    g_abi_out[0] = v.couplingEnabled ? 1.f : 0.f;
    g_abi_out[1] = v.labBudgetW;
    g_abi_out[2] = v.totalAllocatedW;
    g_abi_out[3] = v.residualW;
    return out_ptr();
}

EMSCRIPTEN_KEEPALIVE float seg_getNetworkEdgeAllocatedW(SEGSimulator* self, int edgeIndex) {
    return self->getNetworkEdgeAllocatedW(edgeIndex);
}

EMSCRIPTEN_KEEPALIVE uintptr_t seg_getNetworkDevicePower(SEGSimulator* self, int mode) {
    const EnergyNetworkDevicePower v = self->getNetworkDevicePower(mode);
    g_abi_out[0] = v.powerInW;
    g_abi_out[1] = v.powerOutW;
    g_abi_out[2] = v.efficiency;
    return out_ptr();
}

EMSCRIPTEN_KEEPALIVE uintptr_t seg_getParticleBufferPtr(SEGSimulator* self) {
    return static_cast<uintptr_t>(self->getParticleBufferPtr());
}

EMSCRIPTEN_KEEPALIVE int seg_getParticleFloatCount(SEGSimulator* self) {
    return self->getParticleFloatCount();
}

EMSCRIPTEN_KEEPALIVE uintptr_t seg_getRollerStatePtr(SEGSimulator* self) {
    return static_cast<uintptr_t>(self->getRollerStatePtr());
}

EMSCRIPTEN_KEEPALIVE int seg_getRollerStateFloatCount(SEGSimulator* self) {
    return self->getRollerStateFloatCount();
}

EMSCRIPTEN_KEEPALIVE void seg_packRollerState(SEGSimulator* self) {
    self->packRollerState();
}

EMSCRIPTEN_KEEPALIVE void seg_setIntegrator(SEGSimulator* self, int method) {
    self->setIntegrator(method);
}

EMSCRIPTEN_KEEPALIVE int seg_getIntegrator(SEGSimulator* self) {
    return self->getIntegrator();
}

EMSCRIPTEN_KEEPALIVE double seg_getOdeRhsEvals(SEGSimulator* self) {
    return self->getOdeRhsEvals();
}

EMSCRIPTEN_KEEPALIVE double seg_getOdeSteps(SEGSimulator* self) {
    return self->getOdeSteps();
}

EMSCRIPTEN_KEEPALIVE double seg_getOdeRejected(SEGSimulator* self) {
    return self->getOdeRejected();
}

EMSCRIPTEN_KEEPALIVE void seg_resetOdeStats(SEGSimulator* self) {
    self->resetOdeStats();
}

} // extern "C"
