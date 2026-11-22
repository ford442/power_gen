// =============================================================
// twin/sysid.cpp  –  TwinSysId: the ABI face of twin::SysId<RigPlant>
// (#257 §3). The fit is sysid.h; this file is index checks and the trace
// buffer the analysis panel plots the fit from.
// =============================================================

#include "twin.h"

#include <cmath>
#include <limits>

using twin::Rig;

namespace {
constexpr double kNaN = std::numeric_limits<double>::quiet_NaN();
template <class T>
bool in_range(int i, T n) { return i >= 0 && static_cast<std::size_t>(i) < static_cast<std::size_t>(n); }
} // namespace

TwinSysId::TwinSysId() = default;

uintptr_t TwinSysId::dataPtr(int samples) {
    // A recorded run is at most a few minutes at ≤ 200 Hz; cap the buffer.
    const int n = samples < 0 ? 0 : (samples > 200000 ? 200000 : samples);
    return reinterpret_cast<uintptr_t>(_fit.dataPtr(static_cast<std::size_t>(n)));
}
int TwinSysId::load(int samples) { return samples < 0 ? 1 : _fit.load(static_cast<std::size_t>(samples)); }
const char* TwinSysId::errorText() const { return _fit.errorText(); }

bool TwinSysId::setParam(int i, double value) {
    if (!in_range(i, Rig::PARAM_SIZE) || !(value > 0.0) || !std::isfinite(value)) return false;
    _fit.theta[static_cast<std::size_t>(i)] = value;
    return true;
}
bool TwinSysId::setFit(int i, bool fit) {
    if (!in_range(i, Rig::PARAM_SIZE)) return false;
    _fit.fit[static_cast<std::size_t>(i)] = fit;
    return true;
}
bool TwinSysId::setInitialState(int j, double value) {
    if (!in_range(j, Rig::STATE_SIZE) || !std::isfinite(value)) return false;
    _fit.x0[static_cast<std::size_t>(j)] = value;
    return true;
}
void TwinSysId::setFitInitialState(bool fit) { _fit.fitX0 = fit; }
bool TwinSysId::setSensorSigma(int c, double sigma) {
    if (!in_range(c, Rig::SENSOR_SIZE) || !(sigma > 0.0) || !std::isfinite(sigma)) return false;
    _fit.sigma[static_cast<std::size_t>(c)] = sigma;
    return true;
}
void TwinSysId::setMaxIterations(int n) { _fit.maxIter = n < 1 ? 1 : (n > 1000 ? 1000 : n); }

int TwinSysId::start() { return static_cast<int>(_fit.start()); }
int TwinSysId::iterate() { return static_cast<int>(_fit.iterate()); }
int TwinSysId::status() const { return static_cast<int>(_fit.status()); }
int TwinSysId::iterations() const { return _fit.iterations(); }
double TwinSysId::cost() const { return _fit.cost(); }
double TwinSysId::lambda() const { return _fit.lambda(); }
int TwinSysId::residualCount() const { return static_cast<int>(_fit.residualCount()); }
double TwinSysId::reducedChi2() const { return _fit.reducedChi2(); }
double TwinSysId::condition() const { return _fit.condition(); }
double TwinSysId::residualAutocorr() const { return _fit.residualAutocorr(); }
uint32_t TwinSysId::warnings() const { return _fit.warnings(); }

double TwinSysId::param(int i) const { return in_range(i, Rig::PARAM_SIZE) ? _fit.param(static_cast<std::size_t>(i)) : kNaN; }
double TwinSysId::initialState(int j) const {
    return in_range(j, Rig::STATE_SIZE) ? _fit.initialState(static_cast<std::size_t>(j)) : kNaN;
}
double TwinSysId::covariance(int i, int j) const {
    if (!in_range(i, Rig::PARAM_SIZE) || !in_range(j, Rig::PARAM_SIZE)) return kNaN;
    return _fit.covariance(static_cast<std::size_t>(i), static_cast<std::size_t>(j));
}
double TwinSysId::r2(int c) const { return in_range(c, Rig::SENSOR_SIZE) ? _fit.r2(static_cast<std::size_t>(c)) : kNaN; }
double TwinSysId::rmsNormalized(int c) const {
    return in_range(c, Rig::SENSOR_SIZE) ? _fit.rmsNormalized(static_cast<std::size_t>(c)) : kNaN;
}

uintptr_t TwinSysId::fitPtr() {
    _trace.assign(_fit.count * Rig::SENSOR_SIZE, kNaN);
    if (_fit.count > 0 && _fit.status() != twin::FitStatus::Idle && _fit.status() != twin::FitStatus::Failed) {
        _fit.simulate(std::span<double>(_trace));
    }
    return reinterpret_cast<uintptr_t>(_trace.data());
}
int TwinSysId::fitCount() const { return static_cast<int>(_trace.size()); }
