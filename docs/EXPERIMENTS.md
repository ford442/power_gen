# Scripted experiments

An experiment is a small JSON script — set knobs, ramp them, record catalog
telemetry, judge the result — that runs **live** on the lab you are looking at
or **offline** (headless, faster than real time, in a worker or in Node), and
as a **sweep** over a grid of knob values (epic #224 §3). Every run becomes a
`RecordedRun` in the [analysis panel](./ANALYSIS.md).

**Simulated, not metrology.** A passing `expect` says the simulated plant
behaves the way its equations say; it says nothing about a real bench.

| Piece | Module |
|-------|--------|
| Format (types) | `src/experiments/types.ts` |
| Validation | `src/experiments/validate.ts` |
| Knobs | `src/experiments/knobs.ts` |
| Record keys | `src/experiments/readers.ts` |
| Interpreter (one timeline, two clocks) | `src/experiments/interpreter.ts` |
| Verdicts (`expect`) | `src/experiments/expect.ts` (fits from `src/analysis/fit.ts`) |
| Headless bench | `src/experiments/bench.ts` |
| Offline runner + sweep summary | `src/experiments/offline.ts` |
| Worker | `src/workers/experiment-worker.ts` |
| Live runner | `src/experiments/live-runner.ts` (hooks `LabSession.experimentClock`) |
| Public API / sweep pool | `src/experiments/run.ts` |
| Reference experiments | `src/experiments/reference/*.experiment.json` |
| Panel | `src/experiments/experiment-panel.ts` |
| CI | `scripts/test-experiments.mjs` (`npm run test:experiments`) |

All of it is lazy: the entry chunk carries only the `window.lab` hooks, the
**Experiments** button and the `LabSession.experimentClock` slot.

## Running one

```js
await window.lab.listExperiments();                 // shipped experiments
await window.lab.runExperiment('lorentz-force-vs-field');            // offline (default)
await window.lab.runExperiment('lorentz-force-vs-field', { runner: 'live' });
await window.lab.runExperiment({ id: 'mine', title: '…', config: { mode: 'hall' }, steps: [/* … */] });
window.lab.openExperiment('transformer-turns-ratio');                // the panel
```

`runExperiment(idOrDef, opts)` resolves with the `RecordedRun` (for a sweep,
the summary table) and adds every run to the analysis store. Options:
`runner` (`'offline'` | `'live'`), `wasm` (C++ focus plant; default the
experiment's `wasmPhysics`, else the page's), `onProgress(0..1)`, `signal`
(`AbortSignal`), `store: false`.

The **Experiments** button (Telemetry Export row) opens the panel: pick an
experiment, **Run offline** / **Run live**, read the verdicts, **Open in
Analysis**. `?experiment=<id>` (or a share link carrying it) opens the panel on
that experiment at boot; a `.lab.json` with an `experiment` object adds it to
the panel.

## Format

```json
{
  "id": "lorentz-force-vs-field",
  "title": "Force on a current-carrying rail vs B",
  "description": "optional prose",
  "config": { "mode": "lorentz-sled", "wasmPhysics": true, "seed": 42 },
  "steps": [
    { "at": 0,  "set":    { "drive": 1, "lorentz-sled.fieldT": 0.05 } },
    { "at": 1,  "ramp":   { "lorentz-sled.fieldT": [0.05, 0.6] }, "over": 10 },
    { "at": 1,  "record": ["lorentzFieldT", "lorentzCurrentA", "lorentzForceN"], "hz": 30, "until": 11 },
    { "at": 11, "expect": { "fit": { "x": "lorentzFieldT", "y": "lorentzForceN", "model": "linear", "r2": { "gt": 0.98 } } } }
  ],
  "plots": [{ "x": "lorentzFieldT", "y": "lorentzForceN", "fit": "linear" }]
}
```

| Field | Meaning |
|-------|---------|
| `id` | `^[a-z0-9][a-z0-9-]{0,63}$`; a shipped file is `<id>.experiment.json` |
| `config` | [LabConfig](./LAB_CONFIG.md) fields, through the same coercion as the URL — an unknown or unparsable field is an **error**. `mode` (a catalog device) is required: it is the focus plant. `fieldCoupling` / `chargeCoupling` also step the coupling sources into the focus |
| `dt` | Offline step, s (default 1/60, the live substep at 1×; 1e-5 … 0.1). Live runs use the frame loop's substeps (cut at the next event, see below) |
| `duration` | Run length, s (default: the last step's end; cap 600) |
| `steps` | Each has `at` (s on the run clock) and exactly one of `set`, `ramp`, `record`, `expect` |
| `plots` | Hints for the analysis panel (`x`, `y`, optional `fit`) |
| `sweep`, `summary`, `summaryExpect` | See [Sweeps](#sweeps) |
| `snapshot` | Start from a saved operating point — a [plant snapshot](./SNAPSHOTS.md) object (`await window.lab.captureSnapshot()`). Offline it loads into the fresh bench (every device it steps, the operator — STARTed if it was idle — and the C++ focus plant, exactly when the snapshot was taken on that mode, else cross-loaded from the device keys); live it restores the lab before the config and steps apply. Without a `seed` in `config` the run takes the snapshot's. A snapshot that does not parse is an error; a C++ plant that refuses the vector (another build) keeps its own state and the run reports a warning |

### Steps

| Step | Shape | Notes |
|------|-------|-------|
| `set` | `{ "at", "set": { knob: value } }` | Written once, before the plant steps from `at`. Booleans take `true`/`false` or 1/0 |
| `ramp` | `{ "at", "ramp": { knob: [from, to] }, "over": s }` | Linear, written every batch from `at` to `at + over`; the end value is written once when the ramp ends. Switches cannot be ramped |
| `record` | `{ "at", "record": [keys], "hz"?: 30, "until"? }` | Samples on the run clock at `hz` (≤ 10 kHz), at most one row per batch (offline: per `dt`); rows carry the clock time they were taken at. Record steps may not overlap |
| `expect` | `{ "at", "expect": {…} \| [{…}, …] }` | Judged when the clock reaches `at`, over the rows recorded up to then (`from` / `until` narrow the window) |

Steps run in time order; at the same `at`, in file order.

### Knobs

| Knob | Writes | Range |
|------|--------|-------|
| `drive` | operator throttle (`segOperator.targetDrive`), the speed slider | 0 … 1 |
| `<deviceId>.<setpointId>` | every catalog setpoint (`physics/devices.json` `setpoints`): `pulse-coil.pulseCoilCharge`, `halbach-viz.halbachSegments`, `lorentz-sled.lorentzField`, `drop-tube.dropTubeSigma` | the setpoint's min … max (clamped, with a validation warning) |
| `transformer.leakage` | the transformer's leakage toggle (k = 0.97 → 0.72) | 0 / 1 |
| `hall.carrierMetal` | the Hall strip's carrier profile (semiconductor → metal) | 0 / 1 |

Aliases: `lorentz-sled.fieldT`, `halbach-viz.segments`, `pulse-coil.chargeV`,
`drop-tube.sigma`. A knob writes the same `physicsState` field through the same
helper as the operator control it stands for (live, through the control's
`window` API, so the slider follows); the C++ plant picks it up through
`syncWasmFocusKnobs` on the next substep. A knob must live on a device the run
steps.

### Record keys

Any catalog telemetry key (`physics/devices.json` `telemetryKeys`, listed with
units in [`TELEMETRY.md`](./TELEMETRY.md)) of a device the run steps — the
device's `physicsState` field, exactly what TelemetryHub publishes — plus the
SEG operator keys (`rpm`, `omega`, `corona`, `voltage`, `current`, `power`,
`fieldSim`, `energyDensity`) and any knob id (so a ramp's own setpoint can be
an axis). `t` is always the first column.

### `expect`

```json
{ "fit":   { "x": "…", "y": "…", "model": "linear" | "proportional" | "exponential",
             "r2": {…}, "slope": {…}, "intercept": {…}, "b": {…}, "from"?, "until"? } }
{ "stat":  { "key": "…", "of": "mean", "gt": 0, "from"?, "until"? } }
{ "ratio": { "num": "…", "den": "…", "of": "rms", "between": [0.3, 0.34] } }
```

- `fit`: `linear` is OLS with intercept; `proportional` is y = k·x through the
  origin (R² against the mean of y); `exponential` is y = a·e^(b·x) on ln y, and
  its `r2` is **log-space** (as in the analysis panel). At least one bound.
- `stat`: `of` ∈ `mean min max rms std p2p first last`.
- `ratio`: `of(num) / of(den)` — e.g. rms(V_s) / rms(V_p).
- Conditions: `gt`, `gte`, `lt`, `lte`, `between: [lo, hi]`, `approx` with `rel`
  (relative, default 1 %) and/or `tol` (absolute). NaN never passes.
- `label` overrides the generated verdict line.

## Two clocks, one interpreter

The interpreter owns no clock. A runner calls `applyDue(t)` before the plant
steps from run-time `t` and `observe(t)` after it reached `t`.

**Offline** steps a fresh `ExperimentBench` every `dt`: its own SEG operator,
its own devices, its own buses and — for a `wasmMode` focus with WASM on — its
own `sim_core` simulator. Each substep runs what a focused live frame runs, in
the same order: coupling sources (physics only) → charge then field bus → SEG
operator → focus plant (C++ with the knob sync and the shared
`applyModePlantToDevices` write-back, or the JS fallback). Devices without a
`wasmMode` (pulse-coil, halbach-viz, drop-tube) always step their TS plant.
The run starts from the plant's created state, with the operator STARTed.

**Live** hooks `LabSession.experimentClock`: `beforeStep(simSteps)` runs at the
top of `stepPlant` (before the buses and the C++ knob sync), `afterPublish()`
at the end of `publishFrame`. Run time is the sum of the substeps actually
stepped, so **pause** stops the experiment, **`.`** advances it a frame and
**slow-mo** stretches it — nothing reads a wall clock or a timer.
`beforeStep` may cut the frame's batch: it never steps past the timeline's next
event (a set, a ramp's start or end, a record tick, an expect — the
interpreter's `nextEvent(t)`) and never more than 0.1 s, re-split into equal
substeps of at most 1/60 s. So steps and samples land on their own times even
at 1 fps or 3×; a slow frame slows the run down instead of skipping through it
(an uncut batch keeps the frame's substeps). With the plant worker on, devices
hold the previous batch's result, so a sample lags its `t` by one batch. A live
run starts from the lab as it stands — set every knob the result depends on.

Operator actions win (ADR-0009): START / STOP / E-stop / reset / replay bump
`segOperator.epoch`, and a changed epoch, leaving the experiment's mode, or a
replay stops the run; the promise rejects with an `ExperimentStoppedError`
whose `run` holds what was recorded (the panel still adds it to Analysis).
Boot-only config (`wasmPhysics`, `plantWorker`, …) cannot change mid-session:
a live run reports it as a warning and its `backend` says what actually
stepped. Live config fields apply like a share link (couplings and seed
included).

`backend` on a run: `wasm` (C++ focus plant), `mixed` (C++ focus + JS coupling
sources), `js`.

## Sweeps

```json
"sweep": { "transformer.leakage": { "values": [0, 1] } },
"summary": { "from": 2, "until": 3, "of": "mean",
             "columns": { "vsOverVpRms": { "ratio": ["transformerVs", "transformerVp"], "of": "rms" } } },
"summaryExpect": [ { "stat": { "key": "vsOverVpRms", "of": "max", "approx": 0.3333, "rel": 0.1 } } ]
```

- Axes are `{ from, to, n }` or `{ values: [...] }`; several axes form a
  cartesian product (first axis slowest), capped at 64 runs.
- Each point is one offline run, one worker each, at most
  `hardwareConcurrency − 1` (≤ 8) in flight. The point's values are written at
  t = 0 after the t = 0 `set` steps, so they win over them.
- Each run collapses to one summary row: the sweep values, every recorded key
  reduced (`summary.of`, default `mean`) over the window (`summary.from` /
  `until`, default the run's last second), the derived `columns`, and `pass`
  (1 when every per-run `expect` passed). `summaryExpect` is judged on that
  table; the summary is itself a `RecordedRun` (no `t` column, `hz` 0).
- Sweeps run offline only.

## Tours

A tour step may `run` an experiment while it shows:

```json
{ "id": "force", "view": "lorentz-sled", "run": "lorentz-force-vs-field", … }
{ "id": "probe", "view": "hall", "run": { "steps": [ … ], "config": { "fieldCoupling": true } } }
```

A string names a shipped experiment; an object is a snippet whose `mode`
defaults to the step's `view` and `id` to `tour-<tour>-<step>`. The run is
live; the tour holds the step until it finishes, prints the verdicts, then
counts the step's `durationSec` from there. Leaving the step stops the run.
`test:experiments` checks every tour `run`.

## Reference experiments

Each runs in CI on **both** backends; the measured numbers of every verdict
must agree between the C++ plant and the JS fallback within 2e-3 relative.

| Experiment | Claim | Measured (both backends) |
|------------|-------|--------------------------|
| `lorentz-force-vs-field` | Ramping B 0.05 → 0.6 T at full supply, F = I·ℓ·B rises near-linearly with B (back-EMF B·ℓ·v trims I as the sled speeds up) | R² 0.998, slope 4.53 N/T, F_max 2.72 N |
| `homopolar-emf-vs-rpm` | EMF = ½·B·ω·r²: proportional to RPM with slope ½·B·r²·2π/60 = 5.645e-4 V/RPM (B 0.55 T, r 0.14 m). The 8 mΩ loop brakes the disc to ≈ 54 RPM at full drive | R² 0.99999, slope 5.636e-4 V/RPM (−0.15 %) |
| `transformer-turns-ratio` | Sweep over the leakage toggle: tightly coupled, rms(V_s)/rms(V_p) sits just under N_s/N_p = 1/3; leakage (k 0.72) drops it sharply. 1/2400 s step and 2400 Hz sampling so the 60 Hz waveform is resolved (at 1/60 s every sample lands on the same phase) | 0.304 (k 0.97), 0.135 (k 0.72) |
| `hall-voltage-vs-field` | With field coupling on, the Halbach array (4 → 24 segments) sets the Hall strip's B; at fixed current V_H = I·B·R_H/t, proportional to B with slope I·R_H/t | R² 1.000, slope 8.988 V/T (0.72 A × 6.24e-3 m³/C / 0.5 mm = 8.99) |

## Adding one

1. Write `src/experiments/reference/<id>.experiment.json`.
2. `npm run test:experiments -- --verbose` prints every verdict's measured
   numbers on both backends. Bounds should follow from the plant's equations
   (say which in `description`), not from whatever the run printed.
3. It shows up in the panel and in `window.lab.listExperiments()` with no
   registration step.
