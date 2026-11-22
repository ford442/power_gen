// =============================================================
// twin/ekf.cpp  –  TwinEstimator: the ABI face of twin::Ekf<RigPlant>
// (#257 §2). The filter itself is ekf.h; this file stages measurements and
// keeps one readout block the TS host reads zero-copy (layout in twin.h).
// =============================================================

#include "twin.h"

#include <cmath>
#include <limits>

using twin::Rig;
using RL = twin::ReadoutLayout;

namespace {
constexpr double kNaN = std::numeric_limits<double>::quiet_NaN();
template <class T>
bool in_range(int i, T n) { return i >= 0 && static_cast<std::size_t>(i) < static_cast<std::size_t>(n); }
} // namespace

TwinEstimator::TwinEstimator() {
    for (std::size_t j = 0; j < Rig::PARAM_SIZE; ++j) _ekf.theta[j] = Rig::PARAM_NOMINAL[j];
    _ekf.hMax = Rig::H_MAX;
    // At rest, ±1 rad/s and ±0.1 A until told otherwise.
    _sd0.fill(0.1);
    _sd0[Rig::X::omega] = 1.0;
    _z.fill(kNaN);
    reset();
}

int TwinEstimator::stateCount() const { return static_cast<int>(Rig::STATE_SIZE); }
int TwinEstimator::sensorCount() const { return static_cast<int>(Rig::SENSOR_SIZE); }
int TwinEstimator::paramCount() const { return static_cast<int>(Rig::PARAM_SIZE); }

bool TwinEstimator::setInitial(int i, double value, double sd) {
    if (!in_range(i, Rig::STATE_SIZE) || !std::isfinite(value) || !(sd > 0.0) || !std::isfinite(sd)) return false;
    _x0[static_cast<std::size_t>(i)] = value;
    _sd0[static_cast<std::size_t>(i)] = sd;
    return true;
}

void TwinEstimator::reset() {
    _ekf.reset(_x0, _sd0);
    _z.fill(kNaN);
    fillReadout();
}

bool TwinEstimator::setParam(int i, double value) {
    if (!in_range(i, Rig::PARAM_SIZE) || !(value > 0.0) || !std::isfinite(value)) return false;
    _ekf.theta[static_cast<std::size_t>(i)] = value;
    fillReadout();
    return true;
}
double TwinEstimator::getParam(int i) const {
    return in_range(i, Rig::PARAM_SIZE) ? _ekf.theta[static_cast<std::size_t>(i)] : kNaN;
}

bool TwinEstimator::setProcessNoise(int i, double q) {
    if (!in_range(i, Rig::STATE_SIZE) || !(q >= 0.0) || !std::isfinite(q)) return false;
    _ekf.q[static_cast<std::size_t>(i)] = q;
    return true;
}
double TwinEstimator::getProcessNoise(int i) const {
    return in_range(i, Rig::STATE_SIZE) ? _ekf.q[static_cast<std::size_t>(i)] : kNaN;
}

bool TwinEstimator::setSensorSigma(int c, double sigma) {
    if (!in_range(c, Rig::SENSOR_SIZE) || !(sigma > 0.0) || !std::isfinite(sigma)) return false;
    _ekf.sigma[static_cast<std::size_t>(c)] = sigma;
    return true;
}
double TwinEstimator::getSensorSigma(int c) const {
    return in_range(c, Rig::SENSOR_SIZE) ? _ekf.sigma[static_cast<std::size_t>(c)] : kNaN;
}

bool TwinEstimator::predict(double dt, double vDrive) {
    if (!std::isfinite(vDrive)) return false;
    _vLast = vDrive;
    const bool ok = _ekf.predict(dt, twin::RigInput{vDrive});
    fillReadout();
    return ok;
}

void TwinEstimator::setMeasurement(int c, double value) {
    if (in_range(c, Rig::SENSOR_SIZE)) _z[static_cast<std::size_t>(c)] = value;
}

double TwinEstimator::update() {
    const double nis = _ekf.update(_z, 0xffffffffu, twin::RigInput{_vLast});
    _z.fill(kNaN);
    fillReadout();
    return nis;
}

double TwinEstimator::time() const { return _ekf.t; }
double TwinEstimator::state(int i) const {
    return in_range(i, Rig::STATE_SIZE) ? _ekf.x[static_cast<std::size_t>(i)] : kNaN;
}
double TwinEstimator::cov(int i, int j) const {
    if (!in_range(i, Rig::STATE_SIZE) || !in_range(j, Rig::STATE_SIZE)) return kNaN;
    return _ekf.Pc[static_cast<std::size_t>(i) * Rig::STATE_SIZE + static_cast<std::size_t>(j)];
}

uintptr_t TwinEstimator::readoutPtr() const { return reinterpret_cast<uintptr_t>(_readout.data()); }
int TwinEstimator::readoutCount() const { return static_cast<int>(RL::COUNT); }

uintptr_t TwinEstimator::snapshotPtr() { return reinterpret_cast<uintptr_t>(_snapshot.data()); }
int TwinEstimator::snapshotCount() const { return static_cast<int>(_snapshot.size()); }
void TwinEstimator::save() { _ekf.save(std::span<double>(_snapshot)); }
bool TwinEstimator::load() {
    const bool ok = _ekf.load(std::span<const double>(_snapshot));
    fillReadout();
    return ok;
}

void TwinEstimator::fillReadout() {
    auto& r = _readout;
    const auto& e = _ekf;
    r[RL::VERSION] = twin::kReadoutVersion;
    r[RL::T] = e.t;
    r[RL::UPDATES] = e.updates;
    for (std::size_t i = 0; i < RL::N; ++i) r[RL::X + i] = e.x[i];
    for (std::size_t i = 0; i < RL::N * RL::N; ++i) r[RL::P + i] = e.Pc[i];
    for (std::size_t c = 0; c < RL::M; ++c) {
        r[RL::Y_PRED + c] = e.yPred[c];
        r[RL::Y_SIGMA + c] = e.ySigma[c];
        r[RL::NU + c] = e.nu[c];
        r[RL::NU_SIGMA + c] = e.nuSigma[c];
    }
    r[RL::NIS] = e.nis;
    r[RL::DOF] = e.dof;
    const auto w = e.window();
    r[RL::WIN_COUNT] = static_cast<double>(w.count);
    r[RL::WIN_NIS] = w.nisSum;
    r[RL::WIN_DOF] = w.dofSum;
    r[RL::CHI2_LO] = w.lo;
    r[RL::CHI2_HI] = w.hi;
    r[RL::CONSISTENT] = w.consistent ? 1.0 : 0.0;
    r[RL::DIAGNOSIS] = static_cast<double>(static_cast<int>(w.diagnosis));
    for (std::size_t c = 0; c < RL::M; ++c) {
        r[RL::WIN_MEAN + c] = w.mean[c];
        r[RL::WIN_RMS + c] = w.rms[c];
        r[RL::WIN_LAG1 + c] = w.lag1[c];
    }
    for (std::size_t j = 0; j < RL::NP; ++j) r[RL::THETA + j] = e.theta[j];
}
