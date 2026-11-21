#pragma once
// =============================================================
// circuit/circuit.h  –  Circuit Lab MNA transient solver (#256, ADR-0018)
//
// A small SPICE-like solver: Modified Nodal Analysis, one stamp per element,
// trapezoidal companion models (backward Euler on the first step and after
// every switch event / source corner, to damp the trapezoidal ringing),
// Newton–Raphson with junction-voltage limiting for the non-linear devices,
// and a dense LU with partial pivoting that reuses its symbolic
// factorisation while only values change.
//
//   lu.cpp         dense LU: analyse (pivot order + fill pattern) / refactor
//   stamps.cpp     every element's stamp, device models, readouts
//   newton.cpp     one time point: assemble → factor → solve → limit → converge
//   transient.cpp  step(h): internal steps, TR/BE, breakpoints, LTE, halving
//   circuit_sim.cpp netlist load, parameters, readout buffer, energy books
//
// WASM-only by design (ADR-0018): there is no TS twin. The netlist arrives as
// packed floats (layout in docs/CIRCUIT.md; built by src/circuit/netlist.ts NetBuilder):
//
//   [FORMAT_VERSION, nodeCount, elemCount, optionCount, options…,
//    per element: kind, terminalCount, terminals…, paramCount, params…]
//
// Node 0 is ground. Every number inside is double; only the transport is f32.
// No exceptions (sim_core builds with -fno-exceptions): load() returns an
// error code and errorText() says why.
// =============================================================

#include <cstdint>
#include <vector>

#include "lu.h"

namespace circuit {

constexpr int FORMAT_VERSION = 1;
constexpr int MAX_NODES = 96;       // user nodes incl. ground (the issue's "~40" with headroom)
constexpr int MAX_ELEMENTS = 256;
constexpr int MAX_TERMINALS = 4;
constexpr int MAX_PARAMS = 8;

/// Element kinds. The numeric values are the wire format — append only.
/// circuit_kind_name(i) exports the names so the TS table is checked against it.
enum class Kind : int {
    R = 0,   // resistor            (a, b)            r
    C = 1,   // capacitor           (a, b)            c, ic [V]
    L = 2,   // inductor            (a, b)            l, ic [A]          branch
    V = 3,   // voltage source      (p, n)            wave…              branch
    I = 4,   // current source      (p, n)            wave…  (flows p → n through the source)
    K = 5,   // mutual coupling     ()                lA, lB (element indices), k
    E = 6,   // VCVS                (p, n, cp, cn)    gain               branch
    G = 7,   // VCCS                (p, n, cp, cn)    gm  (flows p → n through the element)
    D = 8,   // diode               (anode, cathode)  is, n, rs
    S = 9,   // ideal switch        (a, b)            ron, roff, closed, period, duty, delay
    VM = 10, // voltmeter           (a, b)            —  (no stamp: reads va − vb)
    AM = 11, // ammeter             (a, b)            —  (a 0 V source)  branch
    M = 12,  // MOSFET level 1      (d, g, s)         polarity (+1 n / −1 p), vt, kp, lambda
};
constexpr int KIND_COUNT = 13;

/// Waveform of a V / I source: params[0] selects it, params[1…] are its numbers.
///   dc     [0, value]
///   sin    [1, offset, amplitude, freqHz, phaseDeg, delay, damping]   (SPICE SIN)
///   pulse  [2, v1, v2, delay, rise, fall, width, period]              (SPICE PULSE)
enum class Wave : int { Dc = 0, Sin = 1, Pulse = 2 };

const char* kind_name(int kind);
int kind_terminals(Kind k);
int kind_params(Kind k);

/// Solver options (packed after the header; absent → default).
struct Options {
    double maxStep{1e-4};   // s: internal step cap
    double minStep{1e-12};  // s: below this a failing step is an error
    double reltol{1e-4};    // Newton relative tolerance
    double vntol{1e-6};     // V: Newton absolute tolerance on node voltages
    double abstol{1e-9};    // A: Newton absolute tolerance on branch currents
    double gmin{1e-12};     // S: from every node to ground; across junctions at least 1e-9 (stamps.cpp)
    double maxNewton{60};   // iterations per time point
    double lteReltol{2e-4}; // local-truncation-error tolerance (fraction of each state's peak)
};
constexpr int OPTION_COUNT = 8;

/// Readout buffer (doubles; readoutPtr()). Header, then node voltages, then
/// one stride-READOUT_STRIDE row per element. The window columns integrate
/// (trapezoid) over the last step() call; everything else is the end point.
enum ReadoutHeader : int {
    RO_TIME = 0,
    RO_STATUS = 1,       // last step() return value
    RO_STEPS = 2,        // internal steps in the last step()
    RO_NEWTON = 3,       // Newton iterations in the last step()
    RO_REJECTED = 4,     // rejected / halved steps in the last step()
    RO_W_SOURCE = 5,     // J delivered by every active element (V, I, E, G) over the window
    RO_W_DISSIPATED = 6, // J absorbed by R, D, S, M over the window
    RO_STORED = 7,       // J stored in C, L, K now (½Cv², ½Li², M·i₁·i₂)
    RO_STORED_START = 8, // J stored at the start of the window
    RO_HEADER = 9
};
enum ReadoutElem : int {
    RE_I = 0,   // A, terminal a → b through the element
    RE_V = 1,   // V, va − vb
    RE_P = 2,   // W absorbed (v·i; negative while delivering)
    RE_WE = 3,  // J absorbed over the window
    RE_WQ = 4,  // C, ∫ i dt over the window
    RE_WI2 = 5, // A²·s, ∫ i² dt over the window
    READOUT_STRIDE = 6
};

/// stat(which) counters since load()/reset().
enum Stat : int {
    ST_STEPS = 0,
    ST_REJECTED = 1,
    ST_NEWTON = 2,
    ST_FACTORS = 3,       // numeric factorisations
    ST_ANALYSES = 4,      // full pivot searches (symbolic rebuilds)
    ST_REUSED = 5,        // solves that reused an unchanged factorisation
    ST_BE_STEPS = 6,      // backward-Euler steps (start, events, halving)
    ST_MIN_STEP = 7,      // s, smallest accepted step
    ST_MAX_STEP = 8,      // s, largest accepted step
    ST_UNKNOWNS = 9,
    ST_NONLINEAR = 10,    // non-linear element count
    ST_COUNT = 11
};

/// step() / load() results. Negative = error (errorText() has the detail).
enum Status : int {
    OK = 0,
    ERR_FORMAT = -1,
    ERR_LIMITS = -2,
    ERR_NODE = -3,
    ERR_PARAM = -4,
    ERR_SINGULAR = -5,
    ERR_NEWTON = -6,
    ERR_NOT_LOADED = -7,
    ERR_STEP = -8,
};

enum class Method : int { BE = 0, TR = 1 };

struct Element {
    Kind kind{Kind::R};
    int nt{0};
    int t[MAX_TERMINALS]{0, 0, 0, 0}; // terminal nodes (0 = ground)
    double p[MAX_PARAMS]{};            // current values (setParam; reset() keeps them)
    int branch{-1};                    // MNA row of the branch current (L, V, E, AM)
    int inner{-1};                     // D with rs > 0: internal junction node
    // State at the last accepted time point.
    double v{0}, i{0};
    double q{0};       // C: charge C·v; L: flux linkage λ (own + mutual)
    double dq{0};      // dq/dt at the last point (C: i, L: v)
    double dqPrev{0};  // dq/dt one point earlier (LTE predictor)
    double qPeak{0};   // largest |q| seen (LTE scale)
    double vj{0};      // D: junction voltage (Newton, limited); M: vgs
    double vj2{0};     // M: vds
    // Linear model of the step being solved (also what the readout uses, so
    // KCL — and with it Tellegen's energy balance — holds on the solution):
    //   C  i = gEq·v − iEq            D  i = gEq·v_junction + iEq
    //   M  i(d'→s') = gEq·v_d's' + gM·v_gs' + iEq   (d', s' after the swap)
    double gEq{0};
    double iEq{0};
    double gM{0};
    bool swapped{false}; // M: drain and source swapped (v_ds < 0)
    bool sw{false};    // S: closed at the last point
    bool on{false};    // D: forward-conducting (v_j > vcrit/2); M: channel on (v_gs' > vt)
    // Window integrals (trapezoid) over the current step() call.
    double wE{0}, wQ{0}, wI2{0};
};

class CircuitSim {
public:
    CircuitSim() = default;

    /// Build from the packed netlist; OK or a negative Status.
    int load(const float* packed, int count);
    const char* errorText() const { return _err; }
    bool loaded() const { return _loaded; }

    /// Back to t = 0: every state to its initial condition (C ic, L ic, 0
    /// elsewhere). Parameters keep their current values.
    void reset();

    /// Change one parameter (a port's EMF, a capacitor, a switch, …). A
    /// change that alters the matrix or opens/closes a switch schedules a
    /// backward-Euler restart. False on a bad index or an invalid value.
    bool setParam(int elem, int index, double value);
    double getParam(int elem, int index) const;

    /// Advance by h seconds (any number of internal steps). Returns the
    /// internal step count, or a negative Status (state stays at the last
    /// accepted point, which is ≤ the requested time).
    int step(double h);

    double time() const { return _t; }
    int nodeCount() const { return _nUser; }
    int elemCount() const { return static_cast<int>(_el.size()); }
    int unknownCount() const { return _n; }
    double nodeVoltage(int node) const;
    double elemCurrent(int e) const;
    double elemVoltage(int e) const;
    double elemPower(int e) const;
    double storedEnergy() const;
    double stat(int which) const;

    uintptr_t readoutPtr() const { return reinterpret_cast<uintptr_t>(_ro.data()); }
    int readoutCount() const { return static_cast<int>(_ro.size()); }
    /// f32 scratch the ABI stages load()'s netlist through.
    uintptr_t scratchPtr(int count);

private:
    friend struct Assembler;

    // ── netlist ──
    bool _loaded{false};
    char _err[160]{};
    Options _opt{};
    int _nUser{0};   // user nodes incl. ground
    int _nNodes{0};  // + internal nodes
    int _nBranch{0};
    int _n{0};       // unknowns = (_nNodes − 1) + _nBranch
    int _nNonlinear{0};
    std::vector<Element> _el;
    std::vector<int> _coupling; // K elements (indices into _el)

    // ── state ──
    double _t{0};
    std::vector<double> _x;      // solution at the last accepted point
    std::vector<double> _xTry;   // Newton iterate
    std::vector<double> _mat, _rhs;
    std::vector<double> _matFact; // the matrix the LU currently holds
    std::vector<char> _pattern;  // structural non-zeros of A
    DenseLU _lu;
    bool _haveFactor{false};
    double _hPrev{0};            // last accepted step (LTE predictor)
    double _hNext{0};            // proposed next step
    int _beSteps{1};             // backward-Euler steps still owed (start / events)
    bool _first{true};
    bool _regionChanged{false};  // a D / M changed region at the last accepted point

    // ── stats / readout ──
    double _stat[ST_COUNT]{};
    int _wSteps{0}, _wNewton{0}, _wRejected{0};
    double _wSource{0}, _wDiss{0}, _storedStart{0};
    std::vector<double> _ro;
    std::vector<float> _scratch;

    // circuit_sim.cpp
    int _fail(int code, const char* fmt, ...);
    int _parse(const float* p, int count);
    void _layout();
    void _resetState();
    void _writeReadout(int status);

    // stamps.cpp
    void _buildPattern();
    void _assemble(double t1, double h, Method m, bool dc);
    void _evalElement(Element& e, const std::vector<double>& x, double t1, double h, Method m, bool dc) const;
    double _sourceValue(const Element& e, double t) const;
    double _nodeV(const std::vector<double>& x, int node) const;
    bool _switchClosedAt(const Element& e, double t) const;

    // newton.cpp
    int _solvePoint(double t1, double h, Method m, int& iters);
    bool _factorAndSolve();
    bool _balanced() const;
    bool _limitDevices();
    bool _converged(double loosen) const;

    // transient.cpp
    double _nextBreakpoint(double after) const;
    void _accept(double t1, double h, Method m);
    double _lteRatio(double h) const;
    void _scheduleRestart() { _beSteps = 1; }
};

} // namespace circuit

/// Free-function exports (cpp/abi.json): kind names for the TS table check.
const char* circuit_kind_name(int kind);
int circuit_format_version();

using CircuitSim = circuit::CircuitSim;
