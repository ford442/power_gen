#pragma once
// =============================================================
// twin/twin.h  –  the hardware twin's estimator and calibration, as the two
// classes the WASM ABI exports (#257, ADR-0019; cpp/abi.json → TwinEstimator
// "twin_", TwinSysId "sysid_").
//
//   rig_plant.h  the rig model (catalog "seg".twin), a ParametricPlant
//   ekf.h        Ekf<P>: predict / Joseph update / χ² window / snapshot
//   sysid.h      SysId<P>: Levenberg–Marquardt with forward sensitivities
//   ekf.cpp      TwinEstimator = Ekf<RigPlant> + a readout block
//   sysid.cpp    TwinSysId = SysId<RigPlant> + the run buffer
//
// Neither class can reach a coil: they read samples and the drive the host
// already sent (docs/hardware_connection.md → layering rule).
//
// TwinEstimator readout (readoutPtr(), doubles; N states, M sensors, P params
// from generated/twin-rig.h — src/twin/readout.ts mirrors the offsets):
//
//   [0] version  [1] t  [2] updates
//   x[N]  P[N·N]  yPred[M]  ySigma[M]  nu[M]  nuSigma[M]
//   nis  dof  winCount  winNis  winDof  chi2Lo  chi2Hi  consistent  diagnosis
//   winMean[M]  winRms[M]  winLag1[M]  theta[P]
// =============================================================

#include "ekf.h"
#include "sysid.h"

#include <array>
#include <cstddef>
#include <cstdint>
#include <vector>

namespace twin {

inline constexpr int kReadoutVersion = 1;

struct ReadoutLayout {
    static constexpr std::size_t N = Rig::STATE_SIZE, M = Rig::SENSOR_SIZE, NP = Rig::PARAM_SIZE;
    static constexpr std::size_t VERSION = 0, T = 1, UPDATES = 2;
    static constexpr std::size_t X = 3;
    static constexpr std::size_t P = X + N;
    static constexpr std::size_t Y_PRED = P + N * N;
    static constexpr std::size_t Y_SIGMA = Y_PRED + M;
    static constexpr std::size_t NU = Y_SIGMA + M;
    static constexpr std::size_t NU_SIGMA = NU + M;
    static constexpr std::size_t NIS = NU_SIGMA + M;
    static constexpr std::size_t DOF = NIS + 1;
    static constexpr std::size_t WIN_COUNT = DOF + 1;
    static constexpr std::size_t WIN_NIS = WIN_COUNT + 1;
    static constexpr std::size_t WIN_DOF = WIN_NIS + 1;
    static constexpr std::size_t CHI2_LO = WIN_DOF + 1;
    static constexpr std::size_t CHI2_HI = CHI2_LO + 1;
    static constexpr std::size_t CONSISTENT = CHI2_HI + 1;
    static constexpr std::size_t DIAGNOSIS = CONSISTENT + 1;
    static constexpr std::size_t WIN_MEAN = DIAGNOSIS + 1;
    static constexpr std::size_t WIN_RMS = WIN_MEAN + M;
    static constexpr std::size_t WIN_LAG1 = WIN_RMS + M;
    static constexpr std::size_t THETA = WIN_LAG1 + M;
    static constexpr std::size_t COUNT = THETA + NP;
};

} // namespace twin

/// The twin's EKF over the catalog rig (ABI class, prefix twin_).
class TwinEstimator {
public:
    TwinEstimator();

    int stateCount() const;
    int sensorCount() const;
    int paramCount() const;

    /// Initial x_i and its σ for the next reset().
    bool setInitial(int i, double value, double sd);
    /// x and P from setInitial; t = 0; the χ² window restarts.
    void reset();

    bool setParam(int i, double value);
    double getParam(int i) const;
    bool setProcessNoise(int i, double q);
    double getProcessNoise(int i) const;
    bool setSensorSigma(int c, double sigma);
    double getSensorSigma(int c) const;

    /// Time update over dt s with the board drive vDrive V held.
    bool predict(double dt, double vDrive);
    /// Stage sensor c's reading for the next update() (NaN = absent).
    void setMeasurement(int c, double value);
    /// Measurement update from the staged readings (then cleared). NIS, or −1.
    double update();

    double time() const;
    double state(int i) const;
    double cov(int i, int j) const;

    uintptr_t readoutPtr() const;
    int readoutCount() const;

    /// save() writes the snapshot block; load() restores from it.
    uintptr_t snapshotPtr();
    int snapshotCount() const;
    void save();
    bool load();

private:
    twin::Ekf<twin::RigPlant> _ekf;
    std::array<double, twin::Rig::STATE_SIZE> _x0{}, _sd0{};
    std::array<double, twin::Rig::SENSOR_SIZE> _z{};
    double _vLast{0.0};
    std::array<double, twin::ReadoutLayout::COUNT> _readout{};
    std::array<double, twin::Ekf<twin::RigPlant>::kSnapshotSize> _snapshot{};

    void fillReadout();
};

/// Calibration of the catalog rig from a recorded run (ABI class, prefix sysid_).
class TwinSysId {
public:
    TwinSysId();

    /// A buffer for samples × [t, v, z_0 … z_{M−1}] doubles; then load(samples).
    uintptr_t dataPtr(int samples);
    int load(int samples);
    const char* errorText() const;

    bool setParam(int i, double value);
    bool setFit(int i, bool fit);
    bool setInitialState(int j, double value);
    void setFitInitialState(bool fit);
    bool setSensorSigma(int c, double sigma);
    void setMaxIterations(int n);

    int start();
    int iterate();
    int status() const;
    int iterations() const;
    double cost() const;
    double lambda() const;
    int residualCount() const;
    double reducedChi2() const;
    double condition() const;
    double residualAutocorr() const;
    uint32_t warnings() const;

    double param(int i) const;
    double initialState(int j) const;
    double covariance(int i, int j) const;
    double r2(int c) const;
    double rmsNormalized(int c) const;

    /// The fit's simulated outputs, samples × M doubles (refreshed per call).
    uintptr_t fitPtr();
    int fitCount() const;

private:
    twin::SysId<twin::RigPlant> _fit;
    std::vector<double> _trace;
};
