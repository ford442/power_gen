# ADR-0019: Calibrated digital twin — EKF and output-error sysid in sim_core, a shareable calibration profile

- **Status:** Accepted
- **Date:** 2026-11
- **Issue:** #257 (after #254 integrators, ADR-0015 snapshots; alongside #256)

## Context

The hardware twin compared raw sensor lines with the SEG sim ("shadow" mode).
That residual could not separate a wrong model from a noisy sensor. Closed loop
wrote the raw, late, noisy RPM sample into the plant, and the plant worker
integrated from its own ω because the override was applied after the post
(the known gap in AGENTS.md → Plant worker). The rig's numbers were catalog
guesses. Samples were stamped on arrival, so USB / BLE jitter showed up as
model error.

## Decision

1. **Forward-mode AD in sim_core** (`cpp/src/core/dual.h`). `Dual<T, N>` is
   templated on the scalar. A plant whose `derivs` is templated on the scalar
   is a `DifferentiablePlant` (`core/plant.h`). One evaluation on duals
   gives f, ∂f/∂x and, for a `ParametricPlant`, ∂f/∂θ.
   - **ros23.** Its Jacobian is now one dual evaluation (exact) instead of n
     forward differences. The jumping ring's golden schedule drops from
     78,393 RHS calls to 35,197 RHS calls plus 10,799 dual Jacobians (10.1×
     fewer than the reference instead of 4.6×).
   - **TS mirror.** It keeps forward differences; `test:golden` parity is
     unchanged.
   - **`--mode ad`.** Checks ∂f/∂x against central differences on every
     plant that uses the shared integrator (homopolar, jumping ring) and on
     the rig: at most 1e-3 relative in f32 and 1e-6 in f64, plus the rig's
     ∂f/∂θ and RK4 sensitivities.
   - **Scope.** The hand-written per-device steppers (SEG, Heron, …) have no
     Jacobian to replace and are not differentiable plants.
2. **The rig is a catalog block, not the SEG plant.** `physics/devices.json`
   `seg.twin` defines the following, and codegen writes
   `generated/twin-rig.{h,ts}`:
   - states ω and I, each with process noise q;
   - parameters J, b, R, L, k_e, each with nominal, min and max;
   - the drive map (`vPerRpm`, `vMax`);
   - the new `sensors` block: RPM, coil current and voltage, each with σ and
     units.

   The model is J·ω̇ = k_e·I − b·ω and L·İ = v − R·I − k_e·ω, with
   y = [ω·30/π, I, k_e·ω]. It is a lumped DC-machine equivalent. Commutation
   ripple, cogging, saturation and temperature are not in it; the process
   noise stands in for them.
3. **EKF** (`cpp/src/twin/ekf.h`, class `TwinEstimator`). All doubles.
   - **Predict.** Over the board-clock gap, the bench integrator (RK4,
     h ≤ `hMax`) runs on duals, so F is the exact Jacobian of the discrete
     map. Q_d = diag(q)·dt.
   - **Update.** Joseph form, over whichever channels the sample carries. A
     board without current or voltage sensing is filtered on RPM alone.
   - **Diagnosis.** A 100-update NIS window is compared with χ² bounds
     (Wilson–Hilferty, 95 %), with per-channel mean and lag-1 correlation of
     ν/σ:
     - inside the bounds: *consistent*;
     - high but white and unbiased: *sensor noisy*;
     - biased or correlated: *model mismatch*;
     - low: *overcautious*.

     This is how "model wrong" and "sensor noisy" come apart.
   - **Tuning.** The panel's Q and R multipliers scale the catalog figures.
4. **Estimate mode replaces shadow.** `'shadow'` is still accepted as an alias.
   - The residual gauge plots ν/σ against a ±3 band and shows χ²/dof and the
     diagnosis.
   - The analysis panel's "Twin (live)" view adds uPlot band series (ν/σ ±3,
     RPM and I ± 3σ, NIS/dof against its bounds), the covariance ellipse and
     the fit's cost curve.
   - **Closed loop writes the filtered ω.** It does so before the plant
     worker's post (`PlantWorkerFrame.beforePost`), before the in-loop step,
     and after the step for the display. The worker now integrates from the
     estimate, which closes the AGENTS.md gap.
5. **Sysid** (`cpp/src/twin/sysid.h`, class `TwinSysId`). Output-error
   Levenberg–Marquardt.
   - **Search space.** log θ, inside the catalog min/max, with x₀ fitted
     jointly.
   - **Gradients.** Forward sensitivities: `Dual<double, NP + N>` through
     the same RK4.
   - **Covariance.** A Newey–West HAC sandwich A⁻¹BA⁻¹ (Bartlett, 1.5 s
     bandwidth), floored at the classic s²(JᵀJ)⁻¹. Output-error residuals
     are autocorrelated (the process noise integrates): on the reference run
     the lag-1 ρ is 0.71 and the reduced χ² is 3.6. On that run the classic
     covariance under-reports σ several-fold. A longer bandwidth biased the
     long-run variance low; across seeds the sandwich puts the z-RMS of
     (θ̂ − θ)/σ̂ near 1.
   - **Warning bits.**
     - per parameter: relative σ > 25 %, or at a bound;
     - near-singular JᵀJ (`1 << 16`);
     - not converged (`1 << 17`);
     - R² < 0.9 (`1 << 18`).
6. **What the fit reads.** The issue asked for a `.lab.json` snapshot plus a
   telemetry CSV v2. The fit instead reads the twin's own recorded run
   (`TwinRunRecorder`, 120 s at the sample rate): per row, the board-clock t,
   the drive actually sent and the per-channel z.
   - **Why not CSV v2.** Its rows are frame-rate and host-clocked, and they
     carry the sim's values, not the latched drive. They would need
     resampling, and the input would be wrong at every step change.
   - **What the `.lab.json` carries.** The profile and the filter (item 9).
   - **Not done.** CSV import is a follow-up.
7. **One-click Calibrate.** If the kept run is not exciting enough (at least
   20 s, drive σ ≥ 1 V), a 12 × 2.5 s RPM staircase up to 900 RPM runs first.
   - **Through the bridge.** It is commanded with `bridge.setTarget`, so every
     clamp, the 20 Hz throttle, the watchdog and coast-on-disconnect apply.
   - **Aborts.** An operator button (epoch change), a disconnect or a manual
     coil override stops it.
   - **Physical links** ask for confirmation first.
   - **The fit.** It runs in the offline worker (`kind: 'sysid'`), with
     progress per iteration, and falls back to the main thread without
     `Worker`.
8. **The profile is a LabConfig field.**
   - **Format.** `twinProfile` =
     `tp1;h=<rig hash>;d=θ;s=relσ;c=corr;r=R²;x=χ²ᵣ;w=warnings;n=samples;T=s`.
   - **Where it travels.** It is shared and live: `#lab2=` links, `.lab.json`
     and `?twinProfile=`.
   - **What is refused.** Another rig's hash (any change to the catalog
     parameters, bounds or sensors), θ outside the bounds, a negative σ, a
     correlation outside [−1, 1].
9. **Snapshots (ADR-0015 amendment).** A plant snapshot gains an optional
   `twin` block.
   - **Contents.** `{ version: 1, values, profile, t }`, where `values` is the
     C++ layout `[v, N, NP, M, t, x, P, θ, q, σ, hMax]` and `t` is the board
     time of the last sample.
   - **Restore.** Bit-identical. The filter continues over the true gap on
     the same board clock, or over one nominal period otherwise.
   - **A bad block** is a warning and is skipped; the rest of the snapshot
     still loads.
10. **Protocol v3.** After a `V3` hello request the board sends
    `S t=<micros()> <v1 fields>`.
    - **Older hosts.** A v1 host (no `V`) and a v2 host (`V2`) keep the v1
      S lines; a v2 board answers `I v=2` to `V3`.
    - **Host clock.** `SampleClock` unwraps the 32-bit µs counter, bumps an
      epoch when the clock steps backward (a reset board) or the clock
      source changes, and falls back to the v1 ms field.
    - **BLE.** The firmware adds a NimBLE Nordic UART service behind
      `SEG_BLE`. The radio path feeds the same `LineAssembler` →
      `driver.onLine` path, and a disconnect calls `driver.linkLost()`. Its
      plumbing (`ble_link.h`: SPSC ring, disconnect latch, MTU chunking) is
      host-tested in `test:firmware-safety`. **The NimBLE glue itself is not
      compile-checked here** (no ESP32 toolchain).
11. **Mock rig.** `?mockHardware=1&mockParamError=e` is a `RigTruth`
    (`src/twin/rig-model.ts`):
    - θ = nominal × (1 ± e), alternating signs;
    - 1 ms RK4 with the catalog process noise;
    - the catalog sensor σ on every reading;
    - 125 Hz samples on its own µs clock.

**Safety layering.** The estimator and the fit only read. They never write a
coil command. The one new coil-affecting path is the staircase, and it is a
target through `bridge.setTarget`, the same call the sim's own target uses.
The bridge still owns every safety rule.

## What "calibrated" claims

- **It claims:** the lumped rig model's θ, fitted to this run, with a
  covariance that allows for correlated residuals. With that θ, the filter's
  innovations are χ²-consistent at the catalog noise figures.
- **It does not claim:**
  - Metrology or traceability. The panel keeps "simulated, not metrology".
  - Validity outside the excited range (0–900 RPM, |v| ≤ `vMax`) or across
    temperature.
  - That the SEG plant on screen is calibrated. Only the rig model the twin
    filters with is.
  - That any device's fidelity changed (AGENTS.md → Devices).
  - That a real board has been calibrated. So far only the mock has; a board
    over BLE is "when available".

## Consequences

**Measured.**

| Run | Result |
|-----|--------|
| `--mode twin` (native, 30 s staircase, ±20 %) | true θ: NIS/dof 1.000, 97 % of windows consistent |
| | nominal θ: NIS/dof 250, diagnosed mismatch |
| | fit: 5 iterations, worst parameter error 1.7 % (L), worst 2.6σ, min R² 0.998, no warnings |
| | RPM-only run: all five parameters flagged |
| `test:twin` (shipped WASM, headless live lab) | nominal: 0 % of innovations inside ±3σ, NIS/dof 808 |
| | after one Calibrate: 99.6 / 99.7 / 99.8 % inside (RPM / I / V), NIS/dof 1.04 |

**WASM size.** `sim_core.wasm` is 163,244 B (was 122,380 B), and the ABI has
220 exports.

**Tests.**
- `--mode ad` and `--mode twin` in `make native` and `native-san`
  (ASan / UBSan).
- `test:twin`, `test:twin-snapshot` and `test:transports` (v3 negotiation,
  µs unwrap, v2 boards).
- `wasm-abi` (the two classes).
- `test:firmware-safety` (v3 hello, BLE watchdog). It is by hand, not CI.

**Alternatives rejected.**
- **A joint state–parameter EKF** (θ in the state). θ drifts online, its
  identifiability is hard to judge, and calibration gets tangled with filter
  tuning. A batch fit with a covariance gives a profile someone can review.
- **A UKF.** AD already gives the exact Jacobian, and the rig is linear in x
  for a fixed θ.
- **An estimation library, or a TS fit.** The issue rules out external
  libraries. One C++ implementation can be tested natively under sanitizers.

## Follow-ups

- Bench a real board over BLE (connect, drive, walk out of range).
- Telemetry CSV v2 import for the fit.
- Temperature-dependent R.
- A current / back-EMF channel on the sketch.
