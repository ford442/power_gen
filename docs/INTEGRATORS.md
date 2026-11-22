# Shared ODE integrators

> #254 §1–§2. The numerical core that #255 (field volume), #256 (circuit
> solver) and #257 (EKF / system ID) build on.

Each C++ bench used to hand-write its own fixed-step loop. The jumping ring ran
~20,000 RK4 substeps per simulated second to keep a stiff RL loop stable. A
plant now implements one concept, and the integrator is a catalog field.

| | C++ | TS twin |
|---|---|---|
| Concept | `cpp/src/core/plant.h` (`sim_core::Plant`, `ConstrainedPlant`) | `OdePlant<U>` in `src/renderers/shared/integrate.ts` |
| Integrators | `cpp/src/core/integrate.h` | `src/renderers/shared/integrate.ts` |
| Per-plant layout | `generated/plant-ode.h` (`power_gen::ode::JumpingRing::heightM`, `tolerance()`) | `generated/plant-ode.ts` (`JumpingRingState.heightM`, `PLANT_ODE`) |
| Source | `physics/devices.json` → `integrator` + `ode` | same |

Educational lab integrators for small dense systems (≤ 16 states). They do no
event location; constraints are applied after each accepted step.

## The concept

```cpp
struct ThomsonPlant {                       // cpp/src/plant/thomson_plant.h
    using ode = power_gen::ode::JumpingRing; // generated: index enum, tolerances
    using input_type = ThomsonInput;         // held constant over one advance
    static constexpr std::size_t state_size = ode::STATE_SIZE;
    static constexpr std::size_t output_size = ode::OUTPUT_SIZE;

    void derivs(double t, std::span<const float> x, const ThomsonInput& u, std::span<float> dxdt) const;
    void outputs(std::span<const float> x, const ThomsonInput& u, std::span<float> y) const;
    void save(std::span<float> x) const;     // struct → x (generated index order)
    void load(std::span<const float> x);     // x → struct
    bool constrain(std::span<float> x) const; // rigid stops; true if it changed x
};
```

State is `float` because the plants store it that way and snapshots are float
vectors. Time is `double`, so a long run's clock and an AC drive's phase do not
lose resolution.

## The methods

| `integrator` | What | Carry-over (snapshotted) |
|---|---|---|
| `euler` | one explicit Euler step | — |
| `rk4` | classical RK4, in the exact expression order the hand-written plants used — porting a plant onto it is **bit-identical** (`--mode golden` did not move by one byte) | — |
| `dopri5` | adaptive Dormand–Prince 5(4) (Hairer's DOPRI5 coefficients), PI step control (β = 0.04), **dense output** (CONTD5) | `stepH`, `stepErrOld` |
| `ros23` | Shampine's L-stable Rosenbrock (2,3) — MATLAB's `ode23s`. C++: an **exact Jacobian by forward-mode autodiff** (`core/dual.h`, one dual evaluation per step, #257 / ADR-0019); the TS mirror keeps a forward-difference Jacobian (n more RHS per step) | `stepH`, `stepErrOld` |

**Dense output, so a frame boundary does not force a step boundary.** The
adaptive methods advance the plant over the frame `[0, dt]`. The step that
crosses `dt` runs to completion at the size the controller picked, and the
frame-end state is the method's own interpolant at θ = (dt − t)/h. That
step's end state is then dropped: the next frame starts from what the plant
shows. A snapshot therefore needs only the next step size and the controller's
last error, two floats rather than a lookahead buffer. Prototyping measured
this at ~3 % fewer RHS savings than keeping full lookahead state, and both beat
clipping the last step to the frame (which also leaves the PI controller
seeing short steps).

## Catalog

```json
"integrator": "dopri5",
"ode": {
  "state": ["primaryIA", "ringCurrentA", "velocityMps", "heightM"],
  "outputs": ["forceN", "couplingK"],
  "tolerance": {
    "rtol": 2e-4,
    "atol": { "primaryIA": 3.4e-3, "ringCurrentA": 0.16, "velocityMps": 1.7e-4, "heightM": 1.3e-5 }
  }
}
```

`npm run codegen:catalog` validates the block. Every `state` / `outputs` name
must be a `cpp` field of the device's `state` block, so whatever the integrator
works on is also what a snapshot saves. The block must also save `stepH` /
`stepErrOld`. The default is `rk4`. `atol` sits near `rtol` × each channel's
working amplitude.

`SEGSimulator::setIntegrator(m)` (0 euler, 1 rk4, 2 dopri5, 3 ros23, −1
catalog) and `physicsState.integratorOverride` on the TS side override the
method for benches and goldens. The override is not saved in snapshots.

## Ported plants

| Plant | Catalog | Why |
|---|---|---|
| `homopolar` | `euler` | Its historical scheme (one explicit step per frame, ω and I clamped at 0). Ported to prove the concept on the simplest plant; bit-identical. |
| `jumping-ring` | **`dopri5`** | The stiffest plant. Ported bit-identically on `rk4` first, then switched to dopri5 on purpose (re-baselined below). |

## Numbers

`sim_core_test --mode integrators`, jumping ring, its golden schedule (drive
0.85, 400 frames × 1/90 s), every method against the 20k-substep RK4 reference.
`err` is the maximum over frames of |x − ref| / max |ref|, per channel. AC
currents are compared against their peak, not against a sample near a zero
crossing.

| Method | RHS calls | vs reference | Ip | Ir | v | h |
|---|---|---|---|---|---|---|
| rk4 (reference, 5e-5 s substeps) | 356,800 | 1× | — | — | — | — |
| **dopri5** | **33,975** | **10.5×** | 1.3e-5 | 2.5e-4 | 3.1e-5 | 1.9e-5 |
| ros23 | 78,393 | 4.6× | 1.2e-3 | 1.3e-3 | 9.6e-4 | 1.1e-3 |
| euler (same substeps) | 89,200 | 4× | 9.6e-3 | 1.2e-2 | 3.5e-2 | 2.8e-2 |

`--mode integrators` fails the build if the catalog's adaptive method drops
below 10× or rises above 5e-4 (2× headroom over the measured 2.5e-4). The issue
asked for "about 1e-4": the ring current is the hardest channel at 2.5e-4, and
the mechanical state and primary current sit at 1–3e-5. Wall clock
(`--mode bench`, native) is 8× faster: 2,380 vs 307 simulated seconds per wall
second.

**Why not more than ~10×.** The ring's leakage loop has
τ = (1 − k²)·Lr / Rr ≈ 0.33 ms. Any explicit method's stability region caps the
step near h ≈ 1 ms, so dopri5 (6 RHS per step) bottoms out around 6,000–7,000
RHS per simulated second against the reference's 80,280. Tightening `rtol`
trades ratio for accuracy (rtol 1e-4: 9.6×, err 1.1e-4). A stiffness-capped
step (Hairer's ρ estimate) was tried and removed: it never bound, so the ~10 %
rejected steps are not the stability edge. The rigid-stop contact phases are
the likely cause, but that is not profiled.
ros23 does not have that limit, but it is second order: the 60 Hz drive needs
small steps for accuracy, and each step also pays for a Jacobian. Since #257
that Jacobian is one dual-number evaluation of `derivs` (exact, no RHS calls):
on the golden schedule ros23 went from 78,393 RHS (forward differences,
n + 1 per Jacobian) to **35,197 RHS + 10,799 dual Jacobians — 10.1×** fewer
RHS than the reference, at the same 1.3e-3 worst-channel error. `jac=` in
`--mode integrators` counts them; `--mode ad` checks every such Jacobian
against central differences (≤ 1e-3 relative in f32, ≤ 1e-6 in f64).
A plant is a `DifferentiablePlant` (`core/plant.h`) when its `derivs` is
templated on the scalar — every plant on the shared integrator is.

## Parity, both backends

- **`npm run test:golden`**: TS fallback ⇄ native C++ at the usual rel 2e-4,
  once per method (`jumping-ring@dopri5`, `homopolar@ros23`, …). The worst key is
  1.2e-4 on every method, the same margin the RK4 path always had. Float (C++)
  and double (TS) take the same adaptive path.
- **`npm run test:integrators`**: the native budget above; the TS mirror over
  the same schedules, with an RHS count within 3 % of native (same step
  sequence, not just nearby answers); analytic checks on both sides (harmonic
  oscillator through dense output, λ = 1e4 stiff linear where ros23 takes ≥ 20×
  fewer steps than dopri5, RK4's fourth-order convergence).
- **`npm run test:snapshots`**: save → load → step stays bit-identical on
  every mode (the stepper carry-over is in the vector), native and WASM, plus
  the JS → C++ cross-load.

## Porting a plant

1. Add the `ode` block (and `integrator`, default `rk4`) to the device in
   `physics/devices.json`, add `stepH` / `stepErrOld` to its `state` block (TS
   keys like `<prefix>StepH`, declared in `device-physics.ts`), and run
   `npm run codegen:catalog`.
2. Write the `<Name>Plant` view next to the state struct. Its `derivs` is the
   old RHS lambda, indexed by the generated enum. Keep the expression order if
   you want `rk4` to stay bit-identical.
3. In `_step<Name>`: `save` → dispatch on `_odeMethod(ode::INTEGRATOR)` → `load`
   → `outputs`. Mirror it in the TS step with `integratorFor(spec,
   state.integratorOverride)`.
4. Add golden cases per method (`standalone_golden.cpp`) and the plant to
   `--mode integrators`. `rk4_fixed` stays the default until a plant's golden is
   re-baselined on purpose.
